// ESPN unified events + schedule round: unit contract for the curated
// name→slug table, the full unified SportsEvent parse, the 8-league day
// round (live-first priority, 60 s TTL per league|date, failure isolation)
// and resolveStreamsForEvent (the addon is ONLY the stream source).
// node --test runs fully OFFLINE: every fetch is injected, no network call
// is ever made.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Namespace imports + local destructure: a missing export fails exactly the
// tests that need it instead of load-failing the whole file.
import * as espnScores from "../js/core/sports/espnScores.js";
import * as espnSchedule from "../js/core/sports/espnSchedule.js";
import { parseEvents } from "../js/core/sports/sportsFeed.js";
import { readFileSync } from "node:fs";

const {
  ESPN_MAX_CONCURRENT,
  ESPN_REQUEST_TIMEOUT_MS,
  ESPN_ROUND_BUDGET_MS,
  ESPN_SCHEDULE_TTL_MS,
  ESPN_LIVE_TTL_MS,
  ESPN_MATCH_WINDOW_MS,
  LEAGUE_SLUGS,
  resolveLeagueSlug,
  espnScoreboardUrl,
  espnDateForDay,
  parseScoreboard,
  normalizeTeamColor
} = espnScores;
const {
  espnScheduleForDay,
  recordLeagueActivity,
  findAddonEventForSportsEvent,
  resolveStreamsForEvent,
  clearScheduleCache
} = espnSchedule;

const MIN = 60 * 1000;

// A fetch double that answers every request with a fixed payload and records
// the URLs it saw.
function recordingFetch(payload = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => payload };
  };
  return { impl, calls };
}

function event({ id, leagueName, kickoffMs, teams }) {
  return parseEvents({
    events: [
      {
        id,
        leagueName,
        kickoffMs,
        live: false,
        status: "scheduled",
        teams: teams || [{ side: "home", name: "Equipo A" }, { side: "away", name: "Equipo B" }]
      }
    ]
  })[0];
}

// Fixed clock: 2026-01-15 12:00 UTC.
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY = "20260115";

// The MEASURED ESPN payload shape (verified with curl against
// site.api.espn.com for 2026-11-08): competitors are NOT ordered home-first —
// ESPN listed Patriots@Packers with the home team second, and the parse must
// derive sides from `homeAway`, never from array order.
const FULL_PAYLOAD = {
  leagues: [
    {
      name: "National Football League",
      abbreviation: "nfl",
      logos: [{ href: "https://a.espncdn.com/i/leaguelogos/nfl.png" }]
    }
  ],
  events: [
    {
      id: "401772515",
      date: "2026-01-15T18:00Z",
      competitions: [
        {
          date: "2026-01-15T18:00Z",
          situation: { downDistanceText: "2nd & 6 at NE 40" },
          // Array order: AWAY first, HOME second — deliberate.
          competitors: [
            {
              homeAway: "away",
              score: "27",
              team: {
                displayName: "New England Patriots",
                shortDisplayName: "Patriots",
                abbreviation: "NE",
                color: "C60C30",
                logo: "https://a.espncdn.com/i/teamlogos/nfl/500/ne.png"
              },
              records: [{ summary: "8-2" }]
            },
            {
              homeAway: "home",
              score: "45",
              team: {
                displayName: "Green Bay Packers",
                shortDisplayName: "Packers",
                abbreviation: "GB",
                color: "17851E",
                logo: "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png"
              },
              records: [{ summary: "8-2-2" }]
            }
          ],
          status: {
            displayClock: "3:01",
            period: 4,
            type: { state: "in", shortDetail: "3:01 - 4th" }
          }
        }
      ],
      status: { displayClock: "3:01", period: 4, type: { state: "in", shortDetail: "3:01 - 4th" } }
    }
  ]
};

describe("slug table: Spanish league names and aliases resolve to ESPN slugs", () => {
  const cases = [
    ["NFL", "football/nfl"],
    ["Fútbol Americano", "football/nfl"],
    ["NCAA Fútbol Americano", "football/college-football"],
    ["NBA", "basketball/nba"],
    ["NHL", "hockey/nhl"],
    ["MLB", "baseball/mlb"],
    ["Premier League", "soccer/eng.1"],
    ["LaLiga", "soccer/esp.1"],
    ["La Liga EA Sports", "soccer/esp.1"],
    ["Serie A", "soccer/ita.1"],
    ["Brasileirão Serie A", "soccer/bra.1"],
    ["UEFA Champions League", "soccer/uefa.champions"],
    ["Liga MX", "soccer/mex.1"],
    ["MLS", "soccer/usa.1"],
    ["UFC", "mma/ufc"],
    ["Fórmula 1", "racing/f1"]
  ];
  for (const [name, slug] of cases) {
    test(`"${name}" -> ${slug}`, () => {
      assert.equal(resolveLeagueSlug(name), slug);
    });
  }

  test("every table slug is unique and well-formed", () => {
    const slugs = LEAGUE_SLUGS.map((entry) => entry.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    for (const slug of slugs) {
      assert.match(slug, /^(football|basketball|hockey|baseball|soccer|mma|racing|tennis|golf)\/[a-z0-9.-]+$/);
    }
  });

  test("unmapped leagues resolve to null", () => {
    assert.equal(resolveLeagueSlug("Balonmano"), null);
    assert.equal(resolveLeagueSlug(""), null);
    assert.equal(resolveLeagueSlug(null), null);
  });
});

describe("constants: the burst budget and the two cache TTLs", () => {
  test("6 concurrent, 1200 ms per request, 10 min schedule TTL, 60 s live TTL, 20 min match window", () => {
    assert.equal(ESPN_MAX_CONCURRENT, 6);
    assert.equal(ESPN_REQUEST_TIMEOUT_MS, 1200);
    assert.equal(ESPN_SCHEDULE_TTL_MS, 10 * MIN);
    assert.equal(ESPN_LIVE_TTL_MS, 60 * 1000);
    assert.equal(ESPN_MATCH_WINDOW_MS, 20 * MIN);
    // The round budget must cover the FULL bounded burst: ceil(28 / 6) waves
    // of 1200 ms — the first load may never be cut short by the cap.
    assert.ok(
      ESPN_ROUND_BUDGET_MS >=
        Math.ceil(LEAGUE_SLUGS.length / ESPN_MAX_CONCURRENT) * ESPN_REQUEST_TIMEOUT_MS,
      "the round budget covers the full bounded burst"
    );
  });
});

describe("parseScoreboard: the full unified SportsEvent", () => {
  test("colours, logo, abbr, shortName, record, score, status and situation all parse", () => {
    const events = parseScoreboard(FULL_PAYLOAD, "football/nfl");
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.id, "401772515");
    assert.equal(ev.slug, "football/nfl");
    assert.equal(ev.sportType, "football");
    assert.equal(ev.leagueName, "National Football League");
    assert.equal(ev.leagueAbbr, "nfl");
    assert.equal(ev.leagueLogo, "https://a.espncdn.com/i/leaguelogos/nfl.png");
    assert.equal(ev.state, "in");
    assert.equal(ev.kickoffMs, Date.parse("2026-01-15T18:00Z"));
    assert.equal(ev.statusText, "3:01 - 4th");
    assert.equal(ev.period, 4);
    assert.equal(ev.clock, "3:01");
    assert.equal(ev.situation, "2nd & 6 at NE 40");
    // HOME side derived from homeAway — ESPN listed it SECOND in the array.
    assert.equal(ev.home.name, "Green Bay Packers");
    assert.equal(ev.home.shortName, "Packers");
    assert.equal(ev.home.abbr, "GB");
    assert.equal(ev.home.color, "#17851E", "bare ESPN hex gains the # prefix");
    assert.equal(ev.home.logo, "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png");
    assert.equal(ev.home.score, 45);
    assert.equal(ev.home.record, "8-2-2");
    assert.equal(ev.away.name, "New England Patriots");
    assert.equal(ev.away.color, "#C60C30");
    assert.equal(ev.away.score, 27);
    assert.equal(ev.away.record, "8-2");
    // Derived partition fields so buildSections can consume the event as-is.
    assert.equal(ev.live, true);
    assert.equal(ev.status, "live");
  });

  test("pre and post events parse with their own state; pre keeps a null-free status block", () => {
    const payload = {
      leagues: [{ name: "National Basketball Association", abbreviation: "nba" }],
      events: [
        {
          id: "pre-1",
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { displayName: "Home Team" }, score: "0" },
                { homeAway: "away", team: { displayName: "Away Team" }, score: "0" }
              ],
              status: { type: { state: "pre", shortDetail: "Thu 6:30 PM" }, period: 0 }
            }
          ],
          status: { type: { state: "pre", shortDetail: "Thu 6:30 PM" } }
        },
        {
          id: "post-1",
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { displayName: "Done Home" }, score: "3", records: [{ summary: "10-1" }] },
                { homeAway: "away", team: { displayName: "Done Away" }, score: "1" }
              ],
              status: { type: { state: "post", shortDetail: "Final" } }
            }
          ],
          status: { type: { state: "post", shortDetail: "Final" } }
        }
      ]
    };
    const events = parseScoreboard(payload, "basketball/nba");
    assert.equal(events.length, 2);
    assert.equal(events[0].state, "pre");
    assert.equal(events[0].leagueName, "National Basketball Association");
    assert.equal(events[0].live, false);
    assert.equal(events[0].status, "scheduled");
    assert.equal(events[1].state, "post");
    assert.equal(events[1].status, "finished");
  });

  test("missing/invalid colour and missing logo degrade to empty strings, never a throw", () => {
    const payload = {
      events: [
        {
          id: "x1",
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { displayName: "H", color: "GGGGGG" } },
                { homeAway: "away", team: { displayName: "A" } }
              ],
              status: { type: { state: "pre" } }
            }
          ],
          status: { type: { state: "pre" } }
        }
      ]
    };
    const ev = parseScoreboard(payload, "football/nfl")[0];
    assert.equal(ev.home.color, "");
    assert.equal(ev.away.color, "");
    assert.equal(ev.home.logo, "");
    assert.equal(ev.away.abbr, "");
    assert.equal(ev.home.record, "");
  });

  test("normalizeTeamColor: bare hex, #-prefixed hex, garbage and empty", () => {
    assert.equal(normalizeTeamColor("288A00"), "#288A00");
    assert.equal(normalizeTeamColor("#17851E"), "#17851E");
    assert.equal(normalizeTeamColor("GGGGGG"), "");
    assert.equal(normalizeTeamColor(""), "");
    assert.equal(normalizeTeamColor(undefined), "");
    assert.equal(normalizeTeamColor("288A0"), "");
  });

  test("garbage payloads parse to an empty list, never a throw", () => {
    assert.deepEqual(parseScoreboard(null), []);
    assert.deepEqual(parseScoreboard({}), []);
    assert.deepEqual(parseScoreboard({ events: [{}] }), []);
  });
});

describe("ESPN scoreboard URL and date key", () => {
  test("one call per league and day: dates=yyyyMMdd&limit=1000", () => {
    const url = espnScoreboardUrl({ slug: "football/nfl" }, DAY);
    assert.equal(url, "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260115&limit=1000");
  });

  test("college rows add groups (80 football, 50 basketball)", () => {
    assert.match(espnScoreboardUrl({ slug: "football/college-football", groups: 80 }, DAY), /&groups=80$/);
    assert.match(espnScoreboardUrl({ slug: "basketball/mens-college-basketball", groups: 50 }, DAY), /&groups=50$/);
  });

  test("date key for a dayKey: the visible day in America/New_York (the UTC date is the failure mode to avoid)", () => {
    // 20:00 UTC = 15:00 in America/New_York on the same day.
    assert.equal(espnDateForDay({ dayKey: "today", events: [], now: Date.UTC(2026, 0, 15, 20, 0, 0) }), DAY);
    // Late-evening UTC must still resolve to the ET date, not the next UTC day.
    assert.equal(espnDateForDay({ dayKey: "today", events: [], now: Date.UTC(2026, 0, 15, 3, 0, 0) }), "20260114");
  });

  test("without events the dayKey offsets from now (Ayer -1, Mañana +1)", () => {
    assert.equal(espnDateForDay({ dayKey: "today", events: [], now: NOW }), DAY);
    assert.equal(espnDateForDay({ dayKey: "yesterday", events: [], now: NOW }), "20260114");
    assert.equal(espnDateForDay({ dayKey: "tomorrow", events: [], now: NOW }), "20260116");
  });
});

// One parseable NBA payload per state, for the round-level tests.
const NBA_LEAGUE = { name: "National Basketball Association", abbreviation: "nba" };
const NBA_PRE_PAYLOAD = {
  leagues: [NBA_LEAGUE],
  events: [
    {
      id: "nba-pre-1",
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "Home Team" } },
            { homeAway: "away", team: { displayName: "Away Team" } }
          ],
          status: { type: { state: "pre", shortDetail: "Thu 6:30 PM" } }
        }
      ],
      status: { type: { state: "pre", shortDetail: "Thu 6:30 PM" } }
    }
  ]
};
const NBA_LIVE_PAYLOAD = {
  leagues: [NBA_LEAGUE],
  events: [
    {
      id: "nba-live-1",
      competitions: [
        {
          competitors: [
            { homeAway: "home", team: { displayName: "Home Team" }, score: "55" },
            { homeAway: "away", team: { displayName: "Away Team" }, score: "50" }
          ],
          status: { type: { state: "in", shortDetail: "6:24" }, period: 3 }
        }
      ],
      status: { type: { state: "in", shortDetail: "6:24" }, period: 3 }
    }
  ]
};

describe("the schedule round: full-day first load, bounded concurrency, two caches, failure isolation", () => {
  test("first load fetches EVERY mapped league for the day, exactly once", async () => {
    clearScheduleCache();
    const { impl, calls } = recordingFetch({ events: [] });
    const result = await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => NOW });
    assert.equal(result.dateKey, DAY);
    assert.equal(result.slugs.length, LEAGUE_SLUGS.length, "no cap: the full mapped table is the slate");
    assert.equal(calls.length, LEAGUE_SLUGS.length);
    const fetchedSlugs = calls.map((url) => url.split("/sports/")[1].split("/scoreboard")[0]);
    assert.equal(new Set(fetchedSlugs).size, LEAGUE_SLUGS.length, "no league is fetched twice");
    assert.equal(result.skipped.length, 0);
    assert.ok(calls.every((url) => url.startsWith("https://site.api.espn.com/apis/site/v2/sports/")));
    assert.ok(calls.every((url) => url.includes(`dates=${DAY}`)));
  });

  test("bounded concurrency: never more than 6 requests in flight", async () => {
    clearScheduleCache();
    let inFlight = 0;
    let peak = 0;
    const impl = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({ events: [] }) };
    };
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => NOW });
    assert.equal(peak, ESPN_MAX_CONCURRENT, "the burst runs 6 wide, never wider");
  });

  test("progressive emission: each league's rows are emitted as soon as it answers", async () => {
    clearScheduleCache();
    const seen = [];
    const impl = async (url) => {
      const slug = url.split("/sports/")[1].split("/scoreboard")[0];
      return {
        ok: true,
        status: 200,
        json: async () => (slug === "basketball/nba" ? NBA_PRE_PAYLOAD : { events: [] })
      };
    };
    const result = await espnScheduleForDay({
      dayKey: "today",
      fetchImpl: impl,
      now: () => NOW,
      onProgress: (events) => seen.push(events.length)
    });
    assert.equal(seen.length, LEAGUE_SLUGS.length, "one emission per league, as each answers");
    assert.ok(seen.every((count, i) => i === 0 || count >= seen[i - 1]), "the list only grows");
    assert.equal(seen[seen.length - 1], result.events.length);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].slug, "basketball/nba");
  });

  test("the 10 min schedule cache is honoured: a second pass inside the window makes zero requests", async () => {
    clearScheduleCache();
    const now = { t: NOW };
    const { impl, calls } = recordingFetch({ events: [] });
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length);
    now.t += 30 * 1000;
    const warm = await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length, "a warm day schedule is never re-downloaded");
    assert.deepEqual(warm.events, []);
    now.t += ESPN_SCHEDULE_TTL_MS + 1000;
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 2 * LEAGUE_SLUGS.length, "after the schedule TTL the full day refetches");
  });

  test("the cache is per league|date: a different day refetches", async () => {
    clearScheduleCache();
    const { impl, calls } = recordingFetch({ events: [] });
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => NOW });
    await espnScheduleForDay({ dayKey: "tomorrow", fetchImpl: impl, now: () => NOW });
    assert.equal(calls.length, 2 * LEAGUE_SLUGS.length);
    assert.ok(calls.some((url) => url.includes("dates=20260116")));
  });

  test("the 60 s live refresh touches ONLY leagues with a live event; the day's schedule stays cached", async () => {
    clearScheduleCache();
    const now = { t: NOW };
    const calls = [];
    const impl = async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => (String(url).includes("basketball/nba") ? NBA_LIVE_PAYLOAD : { events: [] })
      };
    };
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length);
    // +30 s: the live league's 60 s live cache is still warm — zero requests.
    now.t += 30 * 1000;
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length, "a warm live cache is not refetched either");
    // +61 s more: the live TTL expired — exactly one request, the live league.
    now.t += 61 * 1000;
    const refreshed = await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length + 1, "exactly one request: the live league's scores");
    assert.match(calls[calls.length - 1], /basketball\/nba/);
    assert.equal(refreshed.events.length, 1, "the refreshed live event is served");
    // +61 s more: the live TTL expired again — one more live refetch, and
    // still nothing else (the 10 min schedule cache holds the day).
    now.t += 61 * 1000;
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length + 2, "each expired live window refreshes once");
    assert.match(calls[calls.length - 1], /basketball\/nba/);
  });

  test("a league whose live match ends stops refreshing", async () => {
    clearScheduleCache();
    const now = { t: NOW };
    let nbaState = "in";
    const payload = () => ({
      leagues: [NBA_LEAGUE],
      events: [
        {
          id: "nba-live-1",
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { displayName: "Home Team" }, score: "55" },
                { homeAway: "away", team: { displayName: "Away Team" }, score: "50" }
              ],
              status: {
                type: { state: nbaState, shortDetail: nbaState === "post" ? "Final" : "6:24" },
                period: 3
              }
            }
          ],
          status: {
            type: { state: nbaState, shortDetail: nbaState === "post" ? "Final" : "6:24" },
            period: 3
          }
        }
      ]
    });
    const calls = [];
    const impl = async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => (String(url).includes("basketball/nba") ? payload() : { events: [] })
      };
    };
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    now.t += 61 * 1000;
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length + 1, "the live league refreshes once");
    nbaState = "post";
    now.t += 61 * 1000;
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length + 2, "the refresh that saw the final lands");
    now.t += 61 * 1000;
    await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, LEAGUE_SLUGS.length + 2, "no live match: no more refreshes");
  });

  test("per-league failure isolation with a partial result: failures are reported and retried, cached leagues keep serving", async () => {
    clearScheduleCache();
    const now = { t: NOW };
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes("football/nfl") || String(url).includes("soccer/eng.1")) throw new Error("boom");
      return {
        ok: true,
        status: 200,
        json: async () => (String(url).includes("basketball/nba") ? NBA_PRE_PAYLOAD : { events: [] })
      };
    };
    const first = await espnScheduleForDay({ dayKey: "today", fetchImpl, now: () => now.t });
    assert.equal(first.failed, 2, "the two failed leagues are reported");
    assert.equal(first.events.length, 1, "the successful leagues still land");
    assert.equal(first.events[0].slug, "basketball/nba");
    now.t += 30 * 1000;
    const before = calls.length;
    const second = await espnScheduleForDay({ dayKey: "today", fetchImpl, now: () => now.t });
    assert.equal(calls.length, before + 2, "ONLY the failed leagues retry inside the schedule window");
    assert.equal(second.failed, 2);
    assert.equal(second.events.length, 1);
  });

  test("no fetch available: cached events are served, the rest is an honest failure count, never a throw", async () => {
    clearScheduleCache();
    const result = await espnScheduleForDay({ dayKey: "today", now: () => NOW });
    assert.deepEqual(result.events, []);
    assert.equal(result.failed, LEAGUE_SLUGS.length);
  });

  test("a hanging league request is bounded by the per-request timeout, not forever", async () => {
    clearScheduleCache();
    // Only golf/pga (last in the curated table) hangs; the others answer
    // instantly, so the test does not pay a serial cascade of timeouts.
    const fetchImpl = async (url) => {
      if (String(url).includes("golf/pga")) return new Promise(() => {});
      return { ok: true, status: 200, json: async () => ({ events: [] }) };
    };
    const result = await espnScheduleForDay({ dayKey: "today", fetchImpl, now: () => NOW });
    assert.deepEqual(result.events, [], "the round returns instead of hanging");
  });

  test("leagues with a live event come first in the slate, whatever their curated position", async () => {
    clearScheduleCache();
    const liveArgEvent = {
      id: "arg-1",
      state: "in",
      kickoffMs: NOW + 30 * MIN,
      home: { name: "River Plate" },
      away: { name: "Boca Juniors" }
    };
    // The priority is learned from a previous round's parsed payloads — arg.1
    // sits at curated index 17, and the slate still puts it first.
    recordLeagueActivity(DAY, "soccer/arg.1", [liveArgEvent]);
    const calls = [];
    const impl = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ events: [] }) };
    };
    const result = await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => NOW });
    assert.equal(result.slugs[0], "soccer/arg.1", "the league with a live event is fetched first");
    assert.ok(calls[0].includes("soccer/arg.1"));
  });

  test("known non-live leagues order by earliest kickoff", async () => {
    clearScheduleCache();
    // NFL kicks off at +3h, NBA at +1h — both known and not live.
    recordLeagueActivity(DAY, "football/nfl", [{ state: "pre", kickoffMs: NOW + 3 * 60 * MIN }]);
    recordLeagueActivity(DAY, "basketball/nba", [{ state: "pre", kickoffMs: NOW + 1 * 60 * MIN }]);
    const { impl } = recordingFetch({ events: [] });
    const result = await espnScheduleForDay({ dayKey: "today", fetchImpl: impl, now: () => NOW });
    assert.ok(
      result.slugs.indexOf("basketball/nba") < result.slugs.indexOf("football/nfl"),
      "the earlier kickoff comes first among known non-live leagues"
    );
  });
});

describe("findAddonEventForSportsEvent: the addon is only the stream hint", () => {
  const kickoff = Date.UTC(2026, 0, 15, 18, 0, 0);
  const espnEvent = {
    id: "401772515",
    state: "pre",
    kickoffMs: kickoff,
    home: { name: "Green Bay Packers", score: null },
    away: { name: "New England Patriots", score: null }
  };

  test("both team names matching in either order + kickoff within 20 min -> the addon event", () => {
    const addonEvents = parseEvents({
      events: [
        {
          id: "evt-77",
          leagueName: "NFL",
          kickoffMs: kickoff + 10 * MIN,
          teams: [{ side: "home", name: "Packers" }, { side: "away", name: "Patriots" }]
        }
      ]
    });
    assert.equal(findAddonEventForSportsEvent(espnEvent, addonEvents)?.id, "evt-77");
    const swapped = parseEvents({
      events: [
        {
          id: "evt-78",
          leagueName: "NFL",
          kickoffMs: kickoff,
          teams: [{ side: "home", name: "Patriots" }, { side: "away", name: "Packers" }]
        }
      ]
    });
    assert.equal(findAddonEventForSportsEvent(espnEvent, swapped)?.id, "evt-78");
  });

  test("accent folding: Atlético matches Atletico", () => {
    const espn = { id: "e", state: "pre", kickoffMs: kickoff, home: { name: "Atlético de Madrid" }, away: { name: "CA Osasuna" } };
    const addonEvents = parseEvents({
      events: [
        {
          id: "evt-9",
          leagueName: "LaLiga",
          kickoffMs: kickoff,
          teams: [{ side: "home", name: "Atletico Madrid" }, { side: "away", name: "Osasuna" }]
        }
      ]
    });
    assert.equal(findAddonEventForSportsEvent(espn, addonEvents)?.id, "evt-9");
  });

  test("kickoff outside the 20 minute window -> null", () => {
    const far = parseEvents({
      events: [
        {
          id: "evt-far",
          leagueName: "NFL",
          kickoffMs: kickoff + ESPN_MATCH_WINDOW_MS + 60 * 1000,
          teams: [{ side: "home", name: "Packers" }, { side: "away", name: "Patriots" }]
        }
      ]
    });
    assert.equal(findAddonEventForSportsEvent(espnEvent, far), null);
  });

  test("a name that does not match -> null; ambiguous double match -> null; empty pool -> null", () => {
    const wrong = parseEvents({
      events: [
        {
          id: "evt-x",
          leagueName: "NFL",
          kickoffMs: kickoff,
          teams: [{ side: "home", name: "Otro Equipo" }, { side: "away", name: "Patriots" }]
        }
      ]
    });
    assert.equal(findAddonEventForSportsEvent(espnEvent, wrong), null);
    const both = [
      { id: "evt-1", leagueName: "NFL", kickoffMs: kickoff, teams: [{ name: "Packers" }, { name: "Patriots" }], sportType: "football", live: false, status: "scheduled" },
      { id: "evt-2", leagueName: "NFL", kickoffMs: kickoff, teams: [{ name: "Packers" }, { name: "Patriots" }], sportType: "football", live: false, status: "scheduled" }
    ];
    assert.equal(findAddonEventForSportsEvent(espnEvent, both), null);
    assert.equal(findAddonEventForSportsEvent(espnEvent, []), null);
    assert.equal(findAddonEventForSportsEvent(null, []), null);
  });
});

describe("resolveStreamsForEvent: matches the addon event and returns its /stream/tv/<id>.json result", () => {
  const kickoff = Date.UTC(2026, 0, 15, 18, 0, 0);
  const espnEvent = {
    id: "401772515",
    state: "pre",
    kickoffMs: kickoff,
    home: { name: "Green Bay Packers" },
    away: { name: "New England Patriots" }
  };
  const addonEvents = parseEvents({
    events: [
      {
        id: "evt-77",
        leagueName: "NFL",
        kickoffMs: kickoff,
        teams: [{ side: "home", name: "Packers" }, { side: "away", name: "Patriots" }]
      }
    ]
  });

  test("a match resolves through the addon event's id, exactly once", async () => {
    const calls = [];
    const result = await resolveStreamsForEvent(espnEvent, addonEvents, {
      resolveStreams: async (id) => {
        calls.push(id);
        return { status: "ok", streams: [{ url: "https://esencialsport.attendanceos.app/stream/tv/evt-77.m3u8" }] };
      }
    });
    assert.deepEqual(calls, ["evt-77"], "the ADDON event id hits /stream/tv/<id>.json, never the ESPN id");
    assert.equal(result.addonEvent.id, "evt-77");
    assert.equal(result.result.status, "ok");
    assert.match(result.result.streams[0].url, /evt-77/);
  });

  test("no addon match -> null and the resolver is NEVER called (no player can open)", async () => {
    let called = 0;
    const result = await resolveStreamsForEvent(espnEvent, [], {
      resolveStreams: async () => {
        called += 1;
        return { status: "ok", streams: [] };
      }
    });
    assert.equal(result, null);
    assert.equal(called, 0);
  });

  test("a failed addon resolution travels as the result — the caller decides the notice", async () => {
    const result = await resolveStreamsForEvent(espnEvent, addonEvents, {
      resolveStreams: async () => ({ status: "error", detail: "boom" })
    });
    assert.equal(result.result.status, "error");
  });
});

// The screen must not hide a partial first load: when some leagues failed but
// matches landed, one muted line carries the count (a quiet note, not an
// error state).
describe("the screen says a partial load quietly", () => {
  const mountSource = readFileSync(
    new URL("../js/ui/screens/sports/sportsScreenMethods-01-mount-and-load.js", import.meta.url),
    "utf8"
  );

  test("failed leagues on a load that still produced matches -> one muted line with the count", () => {
    assert.match(mountSource, /scheduleFailed/, "the failed count reaches the screen");
    assert.match(mountSource, /sports-partial-note/);
    assert.match(mountSource, /sin datos/);
    assert.match(mountSource, /espnScheduleForDay\(\{[\s\S]*?onProgress/, "the screen paints progressively");
  });
});
