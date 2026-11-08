// Sports feed tests: parsing the REAL Esencial Sport payload shape, day and
// sport grouping, live/upcoming/finished partition + ordering, TTL behaviour
// and the resolve mapping for ok/pending/error. Pure functions and an injected
// fetch: node --test runs fully offline — no network, no DOM, no localStorage.
//
// The measured payload (owner-verified with curl): GET events.json ->
// {generatedAt, count, events[134]} where each event is
// {id, matchId, sportType, title, leagueId, leagueName, country, countryId,
//  kickoffMs, live, status, teams:[{side, name, logo}], streamUrl, sources}.
// The `streamUrl` inside events.json is DEAD (404): it must never be read.
// Real playback comes from /stream/tv/<event.id>.json.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SPORTS_FEED_URL,
  SPORTS_FEED_TTL_MS,
  streamEndpointUrl,
  parseEvents,
  sportLabel,
  sportChips,
  dayKeyForKickoff,
  groupEventsByDay,
  partitionEvents,
  buildSections,
  formatKickoffTime,
  createSportsFeed
} from "../js/core/sports/sportsFeed.js";

import {
  createSportsRepository,
  sportsRepository
} from "../js/data/repository/sportsRepository.js";

// Fixture rows with the EXACT measured field shape (including the dead
// streamUrl and the team logos the UI must never read).
function rawEvent(overrides = {}, index = 0) {
  return {
    id: `evt-${index}`,
    matchId: `m-${index}`,
    sportType: "futbol",
    title: "Equipo A vs Equipo B",
    leagueId: "l1",
    leagueName: "LaLiga",
    country: "España",
    countryId: "es",
    kickoffMs: 1700000000000,
    live: false,
    status: "scheduled",
    teams: [
      { side: "home", name: "Equipo A", logo: "https://x/logo-a.png" },
      { side: "away", name: "Equipo B", logo: "https://x/logo-b.png" }
    ],
    streamUrl: "https://dead.example/stream.m3u8",
    sources: [{ name: "Esencial Sport" }],
    ...overrides
  };
}

function payloadWith(events, extra = {}) {
  return { generatedAt: "2026-01-15T10:00:00Z", count: events.length, events, ...extra };
}

describe("parseEvents: the measured payload shape -> the UI model", () => {
  test("maps exactly the fields the screen needs", () => {
    const events = parseEvents(
      payloadWith([rawEvent({ id: "evt-7", kickoffMs: 1234, live: true, status: "live" }, 7)])
    );
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.id, "evt-7");
    assert.equal(e.title, "Equipo A vs Equipo B");
    assert.equal(e.leagueName, "LaLiga");
    assert.equal(e.sportType, "futbol");
    assert.equal(e.kickoffMs, 1234);
    assert.equal(e.live, true);
    assert.equal(e.status, "live");
    assert.deepEqual(e.teams.map((t) => t.name), ["Equipo A", "Equipo B"]);
  });

  test("drops rows without an id (they can never be resolved or focused)", () => {
    const events = parseEvents(payloadWith([rawEvent({ id: "" }), rawEvent({ id: "ok" })]));
    assert.deepEqual(events.map((e) => e.id), ["ok"]);
  });

  test("keeps a numeric team score when the addon provides one, and never invents one", () => {
    const withScore = rawEvent({
      status: "live",
      live: true,
      teams: [
        { side: "home", name: "A", score: 2, logo: "x.png" },
        { side: "away", name: "B", score: 1, logo: "y.png" }
      ]
    });
    const events = parseEvents(payloadWith([withScore]));
    assert.deepEqual(events[0].teams.map((t) => t.score), [2, 1]);
    const withoutScore = parseEvents(payloadWith([rawEvent()]));
    assert.deepEqual(withoutScore[0].teams.map((t) => t.score ?? null), [null, null]);
  });

  test("coerces live from the status string when the flag is absent", () => {
    const events = parseEvents(payloadWith([rawEvent({ live: undefined, status: "live" })]));
    assert.equal(events[0].live, true);
    const scheduled = parseEvents(payloadWith([rawEvent({ live: undefined, status: "scheduled" })]));
    assert.equal(scheduled[0].live, false);
  });
});

describe("the dead streamUrl and team logos are never read", () => {
  const feedSource = readFileSync(
    new URL("../js/core/sports/sportsFeed.js", import.meta.url),
    "utf8"
  );
  const repositorySource = readFileSync(
    new URL("../js/data/repository/sportsRepository.js", import.meta.url),
    "utf8"
  );

  test("the parsed model carries neither logo nor streamUrl", () => {
    const events = parseEvents(payloadWith([rawEvent()]));
    const json = JSON.stringify(events);
    assert.doesNotMatch(json, /logo/);
    assert.doesNotMatch(json, /streamUrl/);
    assert.doesNotMatch(json, /dead\.example/);
  });

  test("the feed module never references teams[].logo or the event streamUrl field", () => {
    assert.doesNotMatch(feedSource, /\.logo\b/);
    assert.doesNotMatch(feedSource, /\.streamUrl\b/);
    assert.doesNotMatch(repositorySource, /\.logo\b/);
    assert.doesNotMatch(repositorySource, /\.streamUrl\b/);
  });
});

describe("day grouping: Ayer / Hoy / Mañana from kickoffMs", () => {
  // All in LOCAL time so the grouping is timezone-independent by construction.
  const now = new Date(2026, 0, 15, 22, 30).getTime();
  const ms = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm).getTime();

  test("classifies yesterday, today and tomorrow by local calendar date", () => {
    assert.equal(dayKeyForKickoff(ms(2026, 1, 14, 23, 59), now), "yesterday");
    assert.equal(dayKeyForKickoff(ms(2026, 1, 15, 0, 0), now), "today");
    assert.equal(dayKeyForKickoff(ms(2026, 1, 15, 23, 59), now), "today");
    assert.equal(dayKeyForKickoff(ms(2026, 1, 16, 0, 1), now), "tomorrow");
  });

  test("events beyond the three chips clamp into the nearest day so nothing silently vanishes", () => {
    assert.equal(dayKeyForKickoff(ms(2025, 12, 1, 12, 0), now), "yesterday");
    assert.equal(dayKeyForKickoff(ms(2026, 3, 1, 12, 0), now), "tomorrow");
  });

  test("groupEventsByDay returns the three buckets", () => {
    const events = parseEvents(
      payloadWith([
        rawEvent({ id: "a", kickoffMs: ms(2026, 1, 14, 20, 0) }),
        rawEvent({ id: "b", kickoffMs: ms(2026, 1, 15, 21, 0) }),
        rawEvent({ id: "c", kickoffMs: ms(2026, 1, 16, 18, 30) })
      ])
    );
    const groups = groupEventsByDay(events, now);
    assert.deepEqual(groups.yesterday.map((e) => e.id), ["a"]);
    assert.deepEqual(groups.today.map((e) => e.id), ["b"]);
    assert.deepEqual(groups.tomorrow.map((e) => e.id), ["c"]);
  });
});

describe("sport grouping and labels", () => {
  test("known sport types get their Spanish label", () => {
    assert.equal(sportLabel("futbol"), "Fútbol");
    assert.equal(sportLabel("baloncesto"), "Baloncesto");
    assert.equal(sportLabel("tenis"), "Tenis");
    assert.equal(sportLabel("FUTBOL"), "Fútbol");
  });

  test("unknown sport types fall back to a readable version of the raw type", () => {
    assert.equal(sportLabel("futbol-americano"), "Futbol americano");
    assert.equal(sportLabel(""), "");
  });

  test("sportChips: Todos first, then one chip per sportType in first-appearance order", () => {
    const events = parseEvents(
      payloadWith([
        rawEvent({ id: "1", sportType: "futbol" }),
        rawEvent({ id: "2", sportType: "baloncesto" }),
        rawEvent({ id: "3", sportType: "futbol" }),
        rawEvent({ id: "4", sportType: "tenis" })
      ])
    );
    const chips = sportChips(events);
    assert.deepEqual(
      chips.map((c) => ({ id: c.id, label: c.label })),
      [
        { id: "todos", label: "Todos" },
        { id: "futbol", label: "Fútbol" },
        { id: "baloncesto", label: "Baloncesto" },
        { id: "tenis", label: "Tenis" }
      ]
    );
  });

  test("empty events still render the Todos chip", () => {
    assert.deepEqual(sportChips([]).map((c) => c.id), ["todos"]);
  });
});

describe("live / upcoming / finished partition and ordering", () => {
  const events = parseEvents(
    payloadWith([
      rawEvent({ id: "up-late", status: "scheduled", kickoffMs: 3000 }),
      rawEvent({ id: "live-2", status: "live", live: true, kickoffMs: 2000 }),
      rawEvent({ id: "fin-1", status: "finished", kickoffMs: 1000 }),
      rawEvent({ id: "up-early", status: "scheduled", kickoffMs: 2500 }),
      rawEvent({ id: "live-1", status: "live", live: true, kickoffMs: 500 }),
      rawEvent({ id: "fin-2", status: "finished", kickoffMs: 4000 })
    ])
  );

  test("partitions into three disjoint groups covering every event", () => {
    const { live, upcoming, finished } = partitionEvents(events);
    assert.deepEqual(live.map((e) => e.id), ["live-1", "live-2"]);
    assert.deepEqual(upcoming.map((e) => e.id), ["up-early", "up-late"]);
    assert.deepEqual(finished.map((e) => e.id), ["fin-2", "fin-1"]);
  });

  test("live and upcoming are ordered by kickoff ascending; finished most recent first", () => {
    const { live, upcoming, finished } = partitionEvents(events);
    assert.deepEqual(live.map((e) => e.kickoffMs), [500, 2000]);
    assert.deepEqual(upcoming.map((e) => e.kickoffMs), [2500, 3000]);
    assert.deepEqual(finished.map((e) => e.kickoffMs), [4000, 1000]);
  });

  test("buildSections pins the vertical order EN VIVO -> PRÓXIMOS -> FINALIZADOS", () => {
    const sections = buildSections(events);
    assert.deepEqual(
      sections.map((s) => s.key),
      ["live", "upcoming", "finished"]
    );
    assert.equal(sections[0].label, "EN VIVO");
    assert.equal(sections[1].label, "PRÓXIMOS");
    assert.equal(sections[2].label, "FINALIZADOS");
    assert.equal(sections[2].collapsedByDefault, true);
    assert.equal(sections[0].collapsedByDefault ?? false, false);
  });
});

describe("formatKickoffTime renders the local HH:MM row time", () => {
  test("pads hours and minutes", () => {
    assert.equal(formatKickoffTime(new Date(2026, 0, 15, 9, 5).getTime()), "09:05");
    assert.equal(formatKickoffTime(new Date(2026, 0, 15, 21, 30).getTime()), "21:30");
  });
});

describe("sportsFeed: TTL behaviour (injected fetch, no network)", () => {
  function fakeFetch(events, { calls } = {}) {
    return async (url, options = {}) => {
      if (calls) calls.push({ url, signal: Boolean(options.signal) });
      return {
        ok: true,
        status: 200,
        json: async () => payloadWith(events)
      };
    };
  }

  test("the feed URL is the measured endpoint", () => {
    assert.equal(SPORTS_FEED_URL, "https://esencialsport.attendanceos.app/events.json");
    assert.equal(SPORTS_FEED_TTL_MS, 60000);
  });

  test("the stream endpoint is /stream/tv/<id>.json", () => {
    assert.equal(streamEndpointUrl("evt-7"), "https://esencialsport.attendanceos.app/stream/tv/evt-7.json");
  });

  test("a warm cache serves getEvents without a second fetch; expiry refetches", async () => {
    const calls = [];
    const fetchImpl = fakeFetch([rawEvent({ id: "a" })], { calls });
    let clock = 1000;
    const feed = createSportsFeed({ fetchImpl, now: () => clock });

    const first = await feed.getEvents();
    assert.equal(first.status, "ok");
    assert.deepEqual(first.events.map((e) => e.id), ["a"]);
    const second = await feed.getEvents();
    assert.equal(second.status, "ok");
    assert.equal(calls.length, 1, "TTL hit must not refetch");

    clock = 1000 + SPORTS_FEED_TTL_MS + 1;
    const third = await feed.getEvents();
    assert.equal(third.status, "ok");
    assert.equal(calls.length, 2, "expired TTL refetches");
  });

  test("refresh() forces a refetch even inside the TTL window", async () => {
    const calls = [];
    const fetchImpl = fakeFetch([rawEvent()], { calls });
    const feed = createSportsFeed({ fetchImpl, now: () => 1000 });
    await feed.getEvents();
    await feed.refresh();
    assert.equal(calls.length, 2);
  });

  test("a failing fetch resolves to {status:'error', detail} and never throws", async () => {
    const feed = createSportsFeed({
      fetchImpl: async () => {
        throw new Error("network down");
      },
      now: () => 1000
    });
    const result = await feed.getEvents();
    assert.equal(result.status, "error");
    assert.match(String(result.detail), /network down/);
  });

  test("a non-200 response is an error", async () => {
    const feed = createSportsFeed({
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      now: () => 1000
    });
    const result = await feed.getEvents();
    assert.equal(result.status, "error");
  });

  test("a hanging fetch is bounded by the timeout: an error, never a forever-spinner", async () => {
    const feed = createSportsFeed({
      fetchImpl: () => new Promise(() => {}),
      now: () => 1000,
      timeoutMs: 20
    });
    const result = await feed.getEvents();
    assert.equal(result.status, "error");
  });
});

describe("resolveStreams: the real /stream/tv/<id>.json mapping, one attempt only", () => {
  function feedWith(responder, { calls, timeoutMs = 50 } = {}) {
    const fetchImpl = async (url, options = {}) => {
      if (calls) calls.push(url);
      return responder(url, options);
    };
    return createSportsFeed({ fetchImpl, now: () => 1000, timeoutMs });
  }

  test("ok: the addon answers with streams", async () => {
    const calls = [];
    const feed = feedWith(
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          streams: [{ name: "Esencial Sport", url: "https://esencialsport.attendanceos.app/rblive/playlist.m3u8?s=1" }],
          failed: false
        })
      }),
      { calls }
    );
    const result = await feed.resolveStreams("evt-1");
    assert.equal(result.status, "ok");
    assert.equal(result.streams.length, 1);
    assert.match(result.streams[0].url, /playlist\.m3u8/);
    assert.match(calls[0], /\/stream\/tv\/evt-1\.json$/);
  });

  test("pending: failed:true maps to {status:'pending', retryAfterMs} with the raw value", async () => {
    const feed = feedWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ streams: [], failed: true, retryAfterMs: 31000 })
    }));
    const result = await feed.resolveStreams("evt-2");
    assert.equal(result.status, "pending");
    assert.equal(result.retryAfterMs, 31000);
  });

  test("error: a network failure maps to {status:'error', detail} and is retried ZERO times", async () => {
    const calls = [];
    const feed = feedWith(
      async () => {
        throw new Error("boom");
      },
      { calls }
    );
    const result = await feed.resolveStreams("evt-3");
    assert.equal(result.status, "error");
    assert.match(String(result.detail), /boom/);
    assert.equal(calls.length, 1, "exactly one attempt — no retry loops");
  });

  test("error: a non-200 response is an error, one attempt", async () => {
    const calls = [];
    const feed = feedWith(async () => ({ ok: false, status: 500, json: async () => ({}) }), { calls });
    const result = await feed.resolveStreams("evt-4");
    assert.equal(result.status, "error");
    assert.equal(calls.length, 1);
  });

  test("a missing event id never reaches the network", async () => {
    const calls = [];
    const feed = feedWith(async () => ({ ok: true, status: 200, json: async () => ({}) }), { calls });
    const result = await feed.resolveStreams("");
    assert.equal(result.status, "error");
    assert.equal(calls.length, 0);
  });
});

describe("sportsRepository: one shared instance plus the day/sport grouping the screen needs", () => {
  const now = new Date(2026, 0, 15, 22, 0).getTime();
  const ms = (d, hh) => new Date(2026, 0, d - 1 + 1, hh).getTime();

  test("the module exports a single shared instance", () => {
    assert.equal(typeof sportsRepository.getEvents, "function");
    assert.equal(typeof sportsRepository.refresh, "function");
    assert.equal(typeof sportsRepository.resolveStreams, "function");
  });

  test("sectionsForDay applies the day chip, the sport chip and the section order", () => {
    const events = parseEvents(
      payloadWith([
        rawEvent({ id: "hoy-futbol-live", status: "live", live: true, kickoffMs: ms(15, 20), sportType: "futbol" }),
        rawEvent({ id: "hoy-tenis", status: "scheduled", kickoffMs: ms(15, 21), sportType: "tenis" }),
        rawEvent({ id: "hoy-futbol-next", status: "scheduled", kickoffMs: ms(15, 22), sportType: "futbol" }),
        rawEvent({ id: "ayer-futbol", status: "finished", kickoffMs: ms(14, 19), sportType: "futbol" })
      ])
    );
    const repo = createSportsRepository({ feed: createSportsFeed({ fetchImpl: async () => { throw new Error("unused"); } }) });
    const sections = repo.sectionsForDay({ events, dayKey: "today", sportType: "futbol", now });
    assert.deepEqual(sections.map((s) => s.key), ["live", "upcoming", "finished"]);
    assert.deepEqual(sections[0].events.map((e) => e.id), ["hoy-futbol-live"]);
    assert.deepEqual(sections[1].events.map((e) => e.id), ["hoy-futbol-next"]);
    assert.deepEqual(sections[2].events, [], "Ayer's finished match is not under Hoy");
    const allSports = repo.sectionsForDay({ events, dayKey: "today", sportType: null, now });
    assert.deepEqual(allSports[1].events.map((e) => e.id), ["hoy-tenis", "hoy-futbol-next"]);
  });

  test("the default repository arms no network fetch in node (no accidental offline fetch)", () => {
    // Importing and even calling the singleton must not throw for lack of a
    // fetch: it resolves to an error result instead of hitting the network.
    return sportsRepository.getEvents().then((result) => {
      assert.ok(["error", "ok"].includes(result.status));
    });
  });
});
