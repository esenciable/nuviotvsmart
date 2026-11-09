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
import * as espnSchedule from "../js/core/sports/espnSchedule.js";import { parseEvents, buildSections } from "../js/core/sports/sportsFeed.js";
import * as sportingEvents from "../js/core/sports/sportingEvents.js";
import * as euroleague from "../js/core/sports/euroleague.js";
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
  buildDayWindow,
  DAY_WINDOW_RADIUS,
  normalizeTeamColor
} = espnScores;
const {
  espnScheduleForDay,
  recordLeagueActivity,
  findAddonEventForSportsEvent,
  resolveStreamsForEvent,
  clearScheduleCache
} = espnSchedule;
const {
  SPORTING_EVENTS_BASE_URL,
  SPORTING_EVENTS_SLUGS,
  SPORTING_EVENTS_MAX_BYTES,
  SPORTING_EVENTS_CACHE_TTL_MS,
  SPORTING_EVENTS_FAILURE_TTL_MS,
  sportingEventsUrl,
  sportingEventKickoffMs,
  parseSportingEvents,
  sportingEventsForLocalDay,
  sportingEventsForDay,
  clearSportingEventsCache
} = sportingEvents;

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
      // ESPN's cup slugs carry underscores (soccer/esp.copa_del_rey).
      assert.match(slug, /^(football|basketball|hockey|baseball|soccer|mma|racing|tennis|golf)\/[a-z0-9._-]+$/);
    }
  });

  test("unmapped leagues resolve to null", () => {
    assert.equal(resolveLeagueSlug("Balonmano"), null);
    assert.equal(resolveLeagueSlug(""), null);
    assert.equal(resolveLeagueSlug(null), null);
  });
});

describe("constants: the burst budget and the two cache TTLs", () => {
  test("6 concurrent, 2500 ms per request, 10 min schedule TTL, 60 s live TTL, 20 min match window", () => {
    assert.equal(ESPN_MAX_CONCURRENT, 6);
    assert.equal(ESPN_REQUEST_TIMEOUT_MS, 2500);
    assert.equal(ESPN_SCHEDULE_TTL_MS, 10 * MIN);
    assert.equal(ESPN_LIVE_TTL_MS, 60 * 1000);
    assert.equal(ESPN_MATCH_WINDOW_MS, 20 * MIN);
    // The round budget must cover the FULL bounded burst: ceil(28 / 6) waves
    // of 2500 ms — the first load may never be cut short by the cap.
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

// Cups, international competitions and domestic cups — Spanish AND English
// names (accent-folded, whole words). The reference Android TV app shows
// CONCACAF Nations League cards, so the curated table must reach them.
describe("cup and international slugs resolve in Spanish and English", () => {
  const cases = [
    ["CONCACAF Nations League", "soccer/concacaf.nations.league"],
    ["Liga de Naciones Concacaf", "soccer/concacaf.nations.league"],
    ["Concacaf Champions Cup", "soccer/concacaf.champions"],
    ["Copa de Campeones Concacaf", "soccer/concacaf.champions"],
    ["Gold Cup", "soccer/concacaf.gold"],
    ["Copa Oro", "soccer/concacaf.gold"],
    ["Copa América", "soccer/conmebol.america"],
    ["Eliminatorias Concacaf", "soccer/fifa.worldq.concacaf"],
    ["FIFA World Cup Qualifying - CONCACAF", "soccer/fifa.worldq.concacaf"],
    ["Eliminatorias UEFA", "soccer/fifa.worldq.uefa"],
    ["FIFA World Cup Qualifying - UEFA", "soccer/fifa.worldq.uefa"],
    ["Amistoso Internacional", "soccer/fifa.friendly"],
    ["International Friendly", "soccer/fifa.friendly"],
    ["Mundial Femenino", "soccer/fifa.wwc"],
    ["FIFA Women's World Cup", "soccer/fifa.wwc"],
    ["Mundial de Clubes", "soccer/fifa.cwc"],
    ["Eurocopa", "soccer/uefa.euro"],
    ["UEFA Nations League", "soccer/uefa.nations"],
    ["Liga de Naciones", "soccer/uefa.nations"],
    ["UEFA Women's Champions League", "soccer/uefa.wchampions"],
    ["Copa del Rey", "soccer/esp.copa_del_rey"],
    ["Coppa Italia", "soccer/ita.coppa_italia"],
    ["DFB Pokal", "soccer/ger.dfb_pokal"],
    ["Coupe de France", "soccer/fra.coupe_de_france"],
    ["FA Cup", "soccer/eng.fa"],
    ["Carabao Cup", "soccer/eng.league_cup"]
  ];
  for (const [name, slug] of cases) {
    test(`"${name}" -> ${slug}`, () => {
      assert.equal(resolveLeagueSlug(name), slug);
    });
  }

  test("the established competitions keep their slugs once the cups land", () => {
    assert.equal(resolveLeagueSlug("UEFA Champions League"), "soccer/uefa.champions");
    assert.equal(resolveLeagueSlug("Mundial"), "soccer/fifa.world");
    assert.equal(resolveLeagueSlug("World Cup"), "soccer/fifa.world");
    assert.equal(resolveLeagueSlug("LaLiga"), "soccer/esp.1");
    assert.equal(resolveLeagueSlug("Premier League"), "soccer/eng.1");
  });
});

describe("day window: 15 chips, 7 days back / today / 7 days forward", () => {
  test("DAY_WINDOW_RADIUS is 7 and buildDayWindow returns 15 chips", () => {
    assert.equal(DAY_WINDOW_RADIUS, 7);
    const chips = buildDayWindow(NOW);
    assert.equal(chips.length, 15);
    assert.deepEqual(
      chips.map((chip) => chip.id),
      ["-7", "-6", "-5", "-4", "-3", "-2", "-1", "0", "1", "2", "3", "4", "5", "6", "7"]
    );
  });

  test("labels: Ayer / Hoy / Mañana in the middle, weekday + day number around them", () => {
    // 2026-01-15 is a Thursday, so the window runs jue 8 .. jue 22 (local).
    const chips = buildDayWindow(NOW);
    assert.equal(chips[0].label, "jue 8");
    assert.equal(chips[5].label, "mar 13");
    assert.equal(chips[6].label, "Ayer");
    assert.equal(chips[7].label, "Hoy");
    assert.equal(chips[8].label, "Mañana");
    assert.equal(chips[9].label, "sáb 17");
    assert.equal(chips[14].label, "jue 22");
  });

  test("espnDateForDay honours the numeric day keys (per league|date caches stay keyed by ET date)", () => {
    assert.equal(espnDateForDay({ dayKey: "-7", events: [], now: NOW }), "20260108");
    assert.equal(espnDateForDay({ dayKey: "-1", events: [], now: NOW }), "20260114");
    assert.equal(espnDateForDay({ dayKey: "0", events: [], now: NOW }), DAY);
    assert.equal(espnDateForDay({ dayKey: "7", events: [], now: NOW }), "20260122");
    // The Ayer/Hoy/Mañana names keep working.
    assert.equal(espnDateForDay({ dayKey: "yesterday", events: [], now: NOW }), "20260114");
    assert.equal(espnDateForDay({ dayKey: "tomorrow", events: [], now: NOW }), "20260116");
  });

  test("the schedule round fetches a paged day with its own ET date", async () => {
    clearScheduleCache();
    const { impl, calls } = recordingFetch({ events: [] });
    await espnScheduleForDay({ dayKey: "7", fetchImpl: impl, now: () => NOW });
    assert.ok(calls.some((url) => url.includes("dates=20260122")));
    await espnScheduleForDay({ dayKey: "-7", fetchImpl: impl, now: () => NOW });
    assert.ok(calls.some((url) => url.includes("dates=20260108")));
  });
});

describe("parseScoreboard: venue", () => {
  test("the competition venue fullName is captured", () => {
    const payload = {
      events: [
        {
          id: "cur-1",
          competitions: [
            {
              venue: { fullName: "Stadion Ergilio Hato" },
              competitors: [
                { homeAway: "home", team: { displayName: "Curaçao" } },
                { homeAway: "away", team: { displayName: "Panama" } }
              ],
              status: { type: { state: "pre" } }
            }
          ],
          status: { type: { state: "pre" } }
        }
      ]
    };
    const ev = parseScoreboard(payload, "soccer/concacaf.nations.league")[0];
    assert.equal(ev.venue, "Stadion Ergilio Hato");
  });

  test("a missing venue degrades to an empty string, never a throw", () => {
    const payload = {
      events: [
        {
          id: "cur-2",
          competitions: [
            {
              venue: {},
              competitors: [
                { homeAway: "home", team: { displayName: "Panama" } },
                { homeAway: "away", team: { displayName: "Curaçao" } }
              ],
              status: { type: { state: "pre" } }
            }
          ],
          status: { type: { state: "pre" } }
        }
      ]
    };
    const ev = parseScoreboard(payload, "soccer/concacaf.nations.league")[0];
    assert.equal(ev.venue, "");
    assert.equal(parseScoreboard(null)[0], undefined);
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

// ===========================================================================
// sporting-events.org: the SECOND schedule source — the four competitions
// ESPN does not cover (cricket, darts, rugby league, snooker). No scores, no
// colours, no logos: every fixture is a scheduled card. All tests are OFFLINE:
// every fetch is injected as text bodies (the size guard reads before parsing).
// ===========================================================================

const SE_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const SE_DAY_MS = 24 * 60 * 60 * 1000;

// UTC wall-clock parts of an instant, as the feed's date_utc/time_utc fields.
// Re-parsed as UTC they reproduce the instant (seconds are 0), so tests are
// timezone-independent by construction.
function utcPartsFor(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date_utc: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time_utc: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  };
}

// A fetch double answering URLs with TEXT bodies (the layer reads .text() and
// parses JSON itself, so the size guard is observable). Entries: { text } |
// { text, status } | { boom: true }.
function textFetch(byUrl) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const responder = byUrl[String(url)];
    if (!responder) throw new Error(`unexpected url ${url}`);
    if (responder.boom) throw new Error("network down");
    return {
      ok: (responder.status ?? 200) >= 200 && (responder.status ?? 200) < 300,
      status: responder.status ?? 200,
      text: async () => responder.text
    };
  };
  return { impl, calls };
}

const CRICKET_ROW = {
  match: "ind-vs-aus-1",
  date_utc: "2026-01-15",
  time_utc: "20:30",
  // The fixture string is deliberately WRONG ("Away at Home" reversed): the
  // sides must come from home_team/away_team, never from this string.
  fixture: "Australia at India",
  home_team: "India",
  away_team: "Australia"
};

function cricketPayloadText() {
  return JSON.stringify({ competition: "Cricket", event_count: 1, events: [CRICKET_ROW] });
}

describe("sporting-events.org: the slug table is exactly the four competitions ESPN lacks", () => {
  test("cricket, darts, rugby-league, snooker — with Spanish display names — and NEVER nba/f1", () => {
    assert.deepEqual(
      SPORTING_EVENTS_SLUGS.map((entry) => entry.slug),
      ["cricket", "darts", "rugby-league", "snooker"]
    );
    assert.deepEqual(
      SPORTING_EVENTS_SLUGS.map((entry) => entry.label),
      ["Cricket", "Dardos", "Rugby League", "Snooker"]
    );
    assert.ok(!SPORTING_EVENTS_SLUGS.some((entry) => ["nba", "f1", "euroleague", "acb"].includes(entry.slug)));
  });

  test("the 64 KB size guard, the 6 h per-slug revalidation and the bounded failure TTL", () => {
    assert.equal(SPORTING_EVENTS_BASE_URL, "https://sporting-events.org/data");
    assert.equal(SPORTING_EVENTS_MAX_BYTES, 64 * 1024);
    assert.equal(SPORTING_EVENTS_CACHE_TTL_MS, 6 * 60 * 60 * 1000);
    assert.ok(SPORTING_EVENTS_FAILURE_TTL_MS > 0 && SPORTING_EVENTS_FAILURE_TTL_MS < SPORTING_EVENTS_CACHE_TTL_MS);
  });

  test("one measured endpoint per slug: /data/<slug>.json", () => {
    assert.equal(sportingEventsUrl("cricket"), "https://sporting-events.org/data/cricket.json");
    assert.equal(sportingEventsUrl("rugby-league"), "https://sporting-events.org/data/rugby-league.json");
  });
});

describe("sporting-events.org: kickoff from date_utc + time_utc (UTC), never guessed", () => {
  test("the pair parses as a UTC instant and is timezone-independent", () => {
    assert.equal(
      sportingEventKickoffMs({ date_utc: "2026-01-15", time_utc: "20:30" }),
      Date.parse("2026-01-15T20:30:00Z")
    );
    assert.equal(
      sportingEventKickoffMs({ date_utc: "2026-11-01", time_utc: "20:30:00" }),
      Date.parse("2026-11-01T20:30:00Z")
    );
  });

  test("a missing or broken pair yields 0 (the row is dropped later), never NaN", () => {
    assert.equal(sportingEventKickoffMs({}), 0);
    assert.equal(sportingEventKickoffMs({ date_utc: "2026-01-15" }), 0);
    assert.equal(sportingEventKickoffMs({ date_utc: "x", time_utc: "y" }), 0);
    assert.equal(sportingEventKickoffMs(null), 0);
  });
});

describe("sporting-events.org: fixture -> the SAME unified event shape ESPN produces", () => {
  test("sides come from home_team/away_team (authoritative); the 'Away at Home' string is ignored", () => {
    const events = parseSportingEvents(
      { events: [CRICKET_ROW] },
      { slug: "cricket", label: "Cricket" }
    );
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.id, "se:cricket:ind-vs-aus-1");
    assert.equal(ev.leagueName, "Cricket");
    assert.equal(ev.state, "pre");
    assert.equal(ev.status, "scheduled", "this source has no scores: always scheduled");
    assert.equal(ev.live, false);
    assert.equal(ev.kickoffMs, Date.parse("2026-01-15T20:30:00Z"));
    assert.equal(ev.venue, null);
    assert.equal(ev.home.name, "India", "home_team wins over the fixture string");
    assert.equal(ev.away.name, "Australia", "away_team wins over the fixture string");
    assert.notEqual(ev.home.name, "Australia", "the fixture string must never be parsed");
    // No scores/colours/logos exist here: honest nulls, same card geometry.
    assert.equal(ev.home.score, null);
    assert.equal(ev.home.record, null);
    assert.equal(ev.home.color, null);
    assert.equal(ev.home.logo, null);
    assert.equal(ev.home.abbr, "");
    assert.equal(ev.away.score, null);
    assert.equal(ev.away.record, null);
    assert.equal(ev.away.color, null);
    assert.equal(ev.away.logo, null);
  });

  test("a fixture whose kickoff already passed stays a scheduled 'pre' card within the grace window", () => {
    const passed = new Date(SE_NOW - 2 * 60 * 60 * 1000); // 2 h ago
    const row = {
      match: "late-fixture",
      ...utcPartsFor(passed.getTime()),
      fixture: "A at B",
      home_team: "A",
      away_team: "B"
    };
    const events = parseSportingEvents({ events: [row] }, { slug: "snooker", label: "Snooker" });
    assert.equal(events.length, 1);
    assert.equal(events[0].state, "pre");
    assert.equal(events[0].status, "scheduled");
    assert.equal(events[0].home.score, null);
  });

  test("garbage rows are dropped, never a throw", () => {
    const events = parseSportingEvents(
      {
        events: [
          { match: "m1", date_utc: "2026-01-15", time_utc: "20:30", home_team: "India" },
          { match: "m2", date_utc: "2026-01-15", time_utc: "20:30", away_team: "Australia" },
          { date_utc: "2026-01-15", time_utc: "20:30", home_team: "A", away_team: "B" },
          { match: "m4", date_utc: "bad", time_utc: "20:30", home_team: "A", away_team: "B" },
          null,
          "junk"
        ]
      },
      { slug: "cricket", label: "Cricket" }
    );
    assert.deepEqual(events, []);
    assert.deepEqual(parseSportingEvents(null, { slug: "cricket", label: "Cricket" }), []);
    assert.deepEqual(parseSportingEvents({}, { slug: "cricket", label: "Cricket" }), []);
  });

  test("the mapped events land in the SAME sections: PRÓXIMOS, never EN VIVO", () => {
    const events = parseSportingEvents(
      { events: [CRICKET_ROW] },
      { slug: "cricket", label: "Cricket" }
    );
    const sections = buildSections(events);
    assert.equal(sections.find((s) => s.key === "live").events.length, 0);
    assert.equal(sections.find((s) => s.key === "upcoming").events.length, 1);
    assert.equal(sections.find((s) => s.key === "finished").events.length, 0);
  });
});

describe("sporting-events.org: day filtering by the device's LOCAL date", () => {
  // Local-midnight helper: the day bucket of an instant, as a dayKey offset.
  function localDayOffset(ms, now) {
    const a = new Date(ms);
    const b = new Date(now);
    const startA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
    const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
    return Math.round((startA - startB) / SE_DAY_MS);
  }

  test("an event in the requested local day is kept; a neighbouring local day is not", () => {
    // Kickoff exactly at `now`: same local day by construction, whatever the TZ.
    const events = [{ kickoffMs: SE_NOW, id: "se:cricket:1" }];
    assert.equal(sportingEventsForLocalDay(events, { dayKey: "0", now: SE_NOW }).length, 1);
    // Tomorrow's local day: excluded from "0", included with dayKey "1".
    const tomorrow = new Date(SE_NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tmr = { kickoffMs: tomorrow.getTime(), id: "se:cricket:2" };
    assert.equal(sportingEventsForLocalDay([tmr], { dayKey: "0", now: SE_NOW }).length, 0);
    assert.equal(sportingEventsForLocalDay([tmr], { dayKey: "1", now: SE_NOW }).length, 1);
    // Yesterday's local day: excluded from "0"; numeric keys work.
    const yesterday = new Date(SE_NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const yst = { kickoffMs: yesterday.getTime(), id: "se:cricket:3" };
    assert.equal(sportingEventsForLocalDay([yst], { dayKey: "0", now: SE_NOW }).length, 0);
    // (a full calendar day back is always beyond the grace window, so "-1"
    // drops it too — see the next test)
    assert.equal(sportingEventsForLocalDay([yst], { dayKey: "-1", now: SE_NOW }).length, 0);
  });

  test("a passed kickoff stays visible a few hours, then is dropped", () => {
    const twoHoursAgo = SE_NOW - 2 * 60 * 60 * 1000;
    const fiveHoursAgo = SE_NOW - 5 * 60 * 60 * 1000;
    const keptDay = String(localDayOffset(twoHoursAgo, SE_NOW));
    // 2 h old: inside the grace window, still visible on its own local day.
    assert.equal(
      sportingEventsForLocalDay([{ kickoffMs: twoHoursAgo, id: "late" }], { dayKey: keptDay, now: SE_NOW }).length,
      1
    );
    // 5 h old: dropped even on its own local day.
    const oldDay = String(localDayOffset(fiveHoursAgo, SE_NOW));
    assert.equal(
      sportingEventsForLocalDay([{ kickoffMs: fiveHoursAgo, id: "older" }], { dayKey: oldDay, now: SE_NOW }).length,
      0
    );
  });

  test("date_utc + time_utc are bucketed by the DEVICE's local date, whatever timezone that is", () => {
    const { date_utc, time_utc } = utcPartsFor(SE_NOW);
    const kickoff = sportingEventKickoffMs({ date_utc, time_utc });
    assert.equal(kickoff, SE_NOW);
    // The parsed UTC instant is bucketed by its LOCAL date (the day the
    // device's clock shows), not by the UTC date. Everything here is derived
    // from the runtime timezone, so the check holds in any TZ.
    const events = [{ kickoffMs: kickoff, id: "se:darts:utc-boundary" }];
    assert.equal(sportingEventsForLocalDay(events, { dayKey: "0", now: SE_NOW }).length, 1);
    // And each local calendar day built on this machine's clock resolves to
    // its own numeric dayKey: a 06:00 local kickoff N days away is kept on
    // dayKey N and never leaks into "0". Past days are beyond the grace
    // window, so their fixtures stay dropped (the scheduled-source rule).
    for (const offset of [-3, -1, 1, 3]) {
      const ref = new Date(SE_NOW);
      ref.setDate(ref.getDate() + offset);
      const at = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 6, 0, 0).getTime();
      assert.equal(
        sportingEventsForLocalDay([{ kickoffMs: at, id: "k" }], { dayKey: String(offset), now: SE_NOW }).length,
        offset >= 0 ? 1 : 0,
        `offset ${offset}`
      );
      assert.equal(
        sportingEventsForLocalDay([{ kickoffMs: at, id: "k" }], { dayKey: "0", now: SE_NOW }).length,
        offset === 0 ? 1 : 0,
        `offset ${offset} never leaks into the current local day`
      );
    }
  });
});

describe("sporting-events.org: the day fetch — bounded budget, size guard, 6 h cache, failure isolation", () => {
  function fourPayloads({ cricket = cricketPayloadText(), big = false } = {}) {
    const { date_utc, time_utc } = utcPartsFor(SE_NOW);
    const row = (slug, n) =>
      JSON.stringify({
        event_count: 1,
        events: [{ match: `${slug}-${n}`, date_utc, time_utc, fixture: "A at B", home_team: "A", away_team: "B" }]
      });
    return {
      "https://sporting-events.org/data/cricket.json": { text: big ? "x".repeat(64 * 1024 + 1) : cricket },
      "https://sporting-events.org/data/darts.json": { text: row("darts", 1) },
      "https://sporting-events.org/data/rugby-league.json": { text: row("rugby-league", 1) },
      "https://sporting-events.org/data/snooker.json": { text: row("snooker", 1) }
    };
  }

  test("the four slugs are fetched once and mapped into unified events for the visible local day", async () => {
    clearSportingEventsCache();
    const { impl, calls } = textFetch(fourPayloads());
    const result = await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => SE_NOW });
    assert.equal(calls.length, 4, "exactly one request per slug");
    assert.deepEqual(result.failedSlugs, []);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      result.events.map((ev) => ev.id).sort(),
      [
        "se:cricket:ind-vs-aus-1",
        "se:darts:darts-1",
        "se:rugby-league:rugby-league-1",
        "se:snooker:snooker-1"
      ]
    );
    assert.deepEqual(
      SPORTING_EVENTS_SLUGS.map((entry) => entry.label).sort(),
      result.events.map((ev) => ev.leagueName).sort()
    );
  });

  test("the 6 h cache: a warm slug is never re-downloaded; after 6 h it revalidates", async () => {
    clearSportingEventsCache();
    const now = { t: SE_NOW };
    const { impl, calls } = textFetch(fourPayloads());
    await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 4);
    now.t += 30 * 60 * 1000; // +30 min, well inside 6 h
    const warm = await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 4, "a warm fixture cache makes zero requests");
    assert.equal(warm.events.length, 4);
    now.t += SPORTING_EVENTS_CACHE_TTL_MS + 1000; // past 6 h
    await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 8, "after 6 h the slugs revalidate");
  });

  test("the 64 KB size guard: an oversized payload is skipped and LOGGED, never parsed", async () => {
    clearSportingEventsCache();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
      const { impl, calls } = textFetch(fourPayloads({ big: true }));
      const result = await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => SE_NOW });
      assert.equal(calls.length, 4, "the oversized file was still requested once");
      assert.deepEqual(result.failedSlugs, ["cricket"]);
      assert.ok(!result.events.some((ev) => ev.id.startsWith("se:cricket:")), "the oversized payload contributed nothing");
      assert.equal(result.events.length, 3, "the other three slugs still land");
      assert.ok(
        warnings.some((line) => line.includes("cricket") && /\d{4,}/.test(line)),
        `the skip is logged with the slug and the size: ${JSON.stringify(warnings)}`
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a body of exactly 64 KB is accepted (only ABOVE the limit is skipped)", async () => {
    clearSportingEventsCache();
    const base = JSON.stringify({ events: [], pad: "" });
    const deficit = SPORTING_EVENTS_MAX_BYTES - new TextEncoder().encode(base).length;
    const exact = JSON.stringify({ events: [], pad: "x".repeat(deficit) });
    assert.equal(new TextEncoder().encode(exact).length, SPORTING_EVENTS_MAX_BYTES);
    const { impl } = textFetch({
      "https://sporting-events.org/data/cricket.json": { text: exact },
      "https://sporting-events.org/data/darts.json": { text: JSON.stringify({ events: [] }) },
      "https://sporting-events.org/data/rugby-league.json": { text: JSON.stringify({ events: [] }) },
      "https://sporting-events.org/data/snooker.json": { text: JSON.stringify({ events: [] }) }
    });
    const result = await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => SE_NOW });
    assert.deepEqual(result.failedSlugs, [], "64 KB exactly is inside the guard");
  });

  test("a failing file is isolated: the others still land, and the failure is NOT retried inside the TTL", async () => {
    clearSportingEventsCache();
    const now = { t: SE_NOW };
    const byUrl = fourPayloads();
    byUrl["https://sporting-events.org/data/cricket.json"] = { boom: true };
    const { impl, calls } = textFetch(byUrl);
    const first = await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.deepEqual(first.failedSlugs, ["cricket"]);
    assert.equal(first.failed, 1);
    assert.equal(first.events.length, 3, "the failing file never poisons the others");
    assert.ok(first.events.every((ev) => !ev.id.startsWith("se:cricket:")));
    // A failure is remembered briefly: the screen's 60 s rounds never retry-loop.
    now.t += 60 * 1000;
    const second = await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 4, "the failed slug is not retried inside the failure TTL");
    assert.deepEqual(second.failedSlugs, ["cricket"]);
    assert.equal(second.events.length, 3);
    now.t += SPORTING_EVENTS_FAILURE_TTL_MS + 1000;
    await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(
      calls.length,
      5,
      "after the failure TTL exactly ONE new attempt (the failed slug); the warm successes never refetch"
    );
  });

  test("a malformed JSON body is a failure, never a throw into the caller", async () => {
    clearSportingEventsCache();
    const byUrl = fourPayloads();
    byUrl["https://sporting-events.org/data/snooker.json"] = { text: "<html>not json</html>" };
    const { impl } = textFetch(byUrl);
    const result = await sportingEventsForDay({ dayKey: "0", fetchImpl: impl, now: () => SE_NOW });
    assert.deepEqual(result.failedSlugs, ["snooker"]);
    assert.equal(result.events.length, 3);
  });

  test("no fetch available (node --test arms no default fetch): an honest failure, no network, no throw", async () => {
    clearSportingEventsCache();
    const result = await sportingEventsForDay({ dayKey: "0", now: () => SE_NOW });
    assert.deepEqual(result.events, []);
    assert.equal(result.failed, 4);
    assert.deepEqual(result.failedSlugs, ["cricket", "darts", "rugby-league", "snooker"]);
  });
});

describe("wiring: the second source appends after the ESPN paint and its failure never touches the ESPN list", () => {
  const mountSource = readFileSync(
    new URL("../js/ui/screens/sports/sportsScreenMethods-01-mount-and-load.js", import.meta.url),
    "utf8"
  );

  test("loadSchedule fetches the secondary source AFTER the ESPN round painted", () => {
    assert.match(mountSource, /sportingEventsForDay/);
    const espnPaint = mountSource.indexOf("this.renderPartialNotice()");
    const secondary = mountSource.indexOf("sportingEventsForDay(");
    assert.ok(espnPaint >= 0, "the ESPN paint is in loadSchedule");
    assert.ok(secondary > espnPaint, "the secondary fetch rides after the ESPN paint");
    assert.match(mountSource, /this\.scheduleEvents\s*=\s*\[\.\.\.this\.scheduleEvents,\s*\.\.\.secondary\.events\]/);
  });

  test("a secondary failure is one muted line, guarded, with no retry loop", () => {
    assert.match(mountSource, /sports-secondary-note/);
    assert.match(mountSource, /fuente secundaria/i);
    // The secondary load is wrapped so a throw can never break the ESPN render.
    const start = mountSource.indexOf("try {", mountSource.indexOf("this.renderPartialNotice()"));
    const catchIdx = mountSource.indexOf("} catch", start);
    const secondaryIdx = mountSource.indexOf("sportingEventsForDay(");
    assert.ok(start >= 0 && catchIdx > start && secondaryIdx > start && secondaryIdx < catchIdx, "the secondary load is inside the try");
    // No polling/retry primitive appears anywhere in the screen's loader.
    assert.doesNotMatch(mountSource, /setInterval/);
  });
});

// ===========================================================================
// EuroLeague + EuroCup: the THIRD schedule source — the two European
// competitions ESPN lacks, from the official no-key API (owner-verified CORS
// `*`). Every game maps into the SAME unified event shape; the only real
// finished-signal is `played`, so the source NEVER reports a live state.
// All tests are OFFLINE: every fetch is injected.
// ===========================================================================

const {
  EUROLEAGUE_BASE_URL,
  EUROLEAGUE_COMPETITIONS,
  EUROLEAGUE_CACHE_TTL_MS,
  euroleagueGamesUrl,
  euroleagueSeasonCode,
  parseEuroleagueGames,
  euroleagueEventsForLocalDay,
  euroleagueForDay,
  clearEuroleagueCache
} = euroleague;

const EL_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const EL_DAY_MS = 24 * 60 * 60 * 1000;

// A fetch double answering URLs with JSON payloads (the euroleague layer reads
// .json() like the ESPN layer).
function jsonFetch(byUrl) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const responder = byUrl[String(url)];
    if (!responder) throw new Error(`unexpected url ${url}`);
    if (responder.boom) throw new Error("network down");
    return { ok: true, status: 200, json: async () => responder.payload };
  };
  return { impl, calls };
}

function elSide(code, name, abbr, crest, score) {
  return {
    club: { code, name, abbreviatedName: abbr, images: { crest } },
    score,
    partials: [{ points: 20 }]
  };
}

const EL_PLAYED_GAME = {
  identifier: "g-1",
  gameCode: "301",
  round: 20,
  played: true,
  utcDate: "2026-01-15T20:30:00Z",
  // local = home, road = away (the API is explicit; never the array order).
  local: elSide("RMB", "Real Madrid", "RMB", "https://el.cdn/crest/rmb.png", 85),
  road: elSide("FCB", "FC Barcelona", "FCB", "https://el.cdn/crest/fcb.png", 78)
};

// An UNPLAYED game whose payload still carries a (0) score: the mapping must
// never render it.
const EL_UPCOMING_GAME = {
  identifier: "g-2",
  gameCode: "302",
  round: 20,
  played: false,
  utcDate: "2026-01-15T18:00:00Z",
  local: elSide("PNA", "Panathinaikos", "PNA", "https://el.cdn/crest/pna.png", 0),
  road: elSide("OLY", "Olympiacos", "OLY", "https://el.cdn/crest/oly.png", 0)
};

const EL_E_URL = "https://api-live.euroleague.net/v2/competitions/E/seasons/E2025/games";
const EL_U_URL = "https://api-live.euroleague.net/v2/competitions/U/seasons/U2025/games";

function euroleaguePayloads() {
  return {
    [EL_E_URL]: { payload: { games: [EL_PLAYED_GAME, EL_UPCOMING_GAME] } },
    [EL_U_URL]: { payload: { games: [] } }
  };
}

describe("euroleague: endpoint, season code and cache constants", () => {
  test("the measured no-key endpoint per competition|season", () => {
    assert.equal(EUROLEAGUE_BASE_URL, "https://api-live.euroleague.net/v2/competitions");
    assert.equal(euroleagueGamesUrl("E", "E2025"), EL_E_URL);
    assert.equal(euroleagueGamesUrl("U", "U2025"), "https://api-live.euroleague.net/v2/competitions/U/seasons/U2025/games");
  });

  test("exactly the two competitions: E = EuroLeague, U = EuroCup", () => {
    assert.deepEqual(EUROLEAGUE_COMPETITIONS.map((entry) => entry.code), ["E", "U"]);
    assert.deepEqual(EUROLEAGUE_COMPETITIONS.map((entry) => entry.label), ["EuroLeague", "EuroCup"]);
  });

  // Measured against the live API: on 2026-11-08 the season in progress is E2026
  // (380 games) and E2027 answers with 0, so the label is the season's START year
  // (Sep-Jun), not the year it ends.
  test("the season code is the season's start year: Jan 2026 -> E2025, Nov 2026 -> E2026", () => {
    assert.equal(euroleagueSeasonCode("E", Date.UTC(2026, 0, 15)), "E2025");
    assert.equal(euroleagueSeasonCode("E", Date.UTC(2026, 5, 30)), "E2025", "June still belongs to the ending season");
    assert.equal(euroleagueSeasonCode("U", Date.UTC(2026, 10, 1)), "U2026", "November belongs to the season that started in July");
    assert.equal(euroleagueSeasonCode("E", () => Date.UTC(2026, 0, 15)), "E2025", "a function clock is accepted");
  });

  test("the cache is 30 minutes — a season's fixtures move slowly, only `played` flips", () => {
    assert.equal(EUROLEAGUE_CACHE_TTL_MS, 30 * MIN);
  });
});

describe("euroleague: game -> the SAME unified event shape the screen renders", () => {
  test("a played game: post with the final scores, sides from local/road, crest into logo", () => {
    const events = parseEuroleagueGames({ games: [EL_PLAYED_GAME] }, "E");
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.id, "el:E:301");
    assert.equal(ev.leagueName, "EuroLeague");
    assert.equal(ev.state, "post");
    assert.equal(ev.status, "finished");
    assert.equal(ev.live, false);
    assert.equal(ev.kickoffMs, Date.parse("2026-01-15T20:30:00Z"));
    assert.equal(ev.venue, null);
    assert.equal(ev.home.name, "Real Madrid", "home comes from `local` (the API is explicit)");
    assert.equal(ev.away.name, "FC Barcelona", "away comes from `road`");
    assert.equal(ev.home.score, 85);
    assert.equal(ev.away.score, 78);
    assert.equal(ev.home.abbr, "RMB");
    assert.equal(ev.home.logo, "https://el.cdn/crest/rmb.png");
    // No colours and no records exist in this source: honest nulls.
    assert.equal(ev.home.record, null);
    assert.equal(ev.home.color, null);
    assert.equal(ev.away.record, null);
    assert.equal(ev.away.color, null);
  });

  test("an unplayed game: pre with NO score, even when the payload carries a 0", () => {
    const events = parseEuroleagueGames({ games: [EL_UPCOMING_GAME] }, "E");
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.state, "pre");
    assert.equal(ev.status, "scheduled");
    assert.equal(ev.home.score, null, "a payload 0 on an unplayed game is never rendered");
    assert.equal(ev.away.score, null);
  });

  test("competition U maps to EuroCup and the id carries its code", () => {
    const events = parseEuroleagueGames({ games: [EL_PLAYED_GAME] }, "U");
    assert.equal(events[0].id, "el:U:301");
    assert.equal(events[0].leagueName, "EuroCup");
  });

  test("this source NEVER reports a live state: sections place finals under FINALIZADOS, the rest under PRÓXIMOS", () => {
    const events = parseEuroleagueGames({ games: [EL_PLAYED_GAME, EL_UPCOMING_GAME] }, "E");
    for (const ev of events) {
      assert.ok(ev.state === "pre" || ev.state === "post", `state ${ev.state} is never live`);
      assert.equal(ev.live, false);
      assert.notEqual(ev.status, "live");
    }
    const sections = buildSections(events);
    assert.equal(sections.find((s) => s.key === "live").events.length, 0);
    assert.equal(sections.find((s) => s.key === "upcoming").events.length, 1);
    assert.equal(sections.find((s) => s.key === "finished").events.length, 1);
  });

  test("garbage rows are dropped, never a throw", () => {
    assert.deepEqual(
      parseEuroleagueGames(
        {
          games: [
            { gameCode: "1", utcDate: "bad", played: false, local: EL_PLAYED_GAME.local, road: EL_PLAYED_GAME.road },
            { gameCode: "2", utcDate: "2026-01-15T20:30:00Z", played: false },
            { utcDate: "2026-01-15T20:30:00Z", played: false, local: EL_PLAYED_GAME.local, road: EL_PLAYED_GAME.road },
            null,
            "junk"
          ]
        },
        "E"
      ),
      []
    );
    assert.deepEqual(parseEuroleagueGames(null, "E"), []);
    assert.deepEqual(parseEuroleagueGames({}, "E"), []);
  });
});

describe("euroleague: local day filtering (the same local-day window as the rest of the screen)", () => {
  test("an event on the requested local day is kept; neighbouring days are not", () => {
    const events = [{ kickoffMs: EL_NOW, id: "el:E:1" }];
    assert.equal(euroleagueEventsForLocalDay(events, { dayKey: "0", now: EL_NOW }).length, 1);
    const tomorrow = new Date(EL_NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tmr = { kickoffMs: tomorrow.getTime(), id: "el:E:2" };
    assert.equal(euroleagueEventsForLocalDay([tmr], { dayKey: "0", now: EL_NOW }).length, 0);
    assert.equal(euroleagueEventsForLocalDay([tmr], { dayKey: "1", now: EL_NOW }).length, 1);
    const yesterday = new Date(EL_NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const yst = { kickoffMs: yesterday.getTime(), id: "el:E:3" };
    assert.equal(euroleagueEventsForLocalDay([yst], { dayKey: "0", now: EL_NOW }).length, 0);
    // A FINISHED game from yesterday must still render on its own day (it has
    // a real final score — no scheduled-source grace window here).
    assert.equal(euroleagueEventsForLocalDay([yst], { dayKey: "-1", now: EL_NOW }).length, 1);
  });

  test("an event without a valid kickoff is dropped", () => {
    assert.equal(euroleagueEventsForLocalDay([{ kickoffMs: 0, id: "x" }], { dayKey: "0", now: EL_NOW }).length, 0);
    assert.equal(euroleagueEventsForLocalDay([{ kickoffMs: NaN, id: "x" }], { dayKey: "0", now: EL_NOW }).length, 0);
  });
});

describe("euroleague: the day fetch — both competitions, 30 min cache, failure isolation", () => {
  test("both competitions are fetched once, mapped and merged for the visible local day", async () => {
    clearEuroleagueCache();
    const { impl, calls } = jsonFetch(euroleaguePayloads());
    const result = await euroleagueForDay({ dayKey: "0", fetchImpl: impl, now: () => EL_NOW });
    assert.equal(calls.length, 2, "one request per competition|season");
    assert.ok(calls.includes(EL_E_URL) && calls.includes(EL_U_URL));
    assert.deepEqual(result.failedCompetitions, []);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      result.events.map((ev) => ev.id).sort(),
      ["el:E:301", "el:E:302"]
    );
  });

  test("each competition's rows are emitted as soon as its answer lands (progressive)", async () => {
    clearEuroleagueCache();
    const emissions = [];
    const { impl } = jsonFetch(euroleaguePayloads());
    await euroleagueForDay({
      dayKey: "0",
      fetchImpl: impl,
      now: () => EL_NOW,
      onProgress: (rows) => emissions.push(rows.map((ev) => ev.id))
    });
    assert.equal(emissions.length, 2, "one emission per competition");
    assert.ok(emissions.some((ids) => ids.includes("el:E:301")));
  });

  test("the 30 min cache: a warm competition|season is never re-downloaded; after 30 min it revalidates", async () => {
    clearEuroleagueCache();
    const now = { t: EL_NOW };
    const { impl, calls } = jsonFetch(euroleaguePayloads());
    await euroleagueForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 2);
    now.t += 10 * 60 * 1000; // +10 min, well inside 30
    const warm = await euroleagueForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 2, "a warm cache makes zero requests");
    assert.equal(warm.events.length, 2, "the cached season is re-filtered per day");
    now.t += EUROLEAGUE_CACHE_TTL_MS + 1000; // past 30 min
    await euroleagueForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 4, "after 30 min both competitions revalidate");
  });

  test("a failing competition is isolated: the other still lands, and a later load retries it", async () => {
    clearEuroleagueCache();
    const now = { t: EL_NOW };
    const byUrl = euroleaguePayloads();
    byUrl[EL_E_URL] = { boom: true };
    const { impl, calls } = jsonFetch(byUrl);
    const first = await euroleagueForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.deepEqual(first.failedCompetitions, ["E"]);
    assert.equal(first.failed, 1);
    assert.deepEqual(first.events.map((ev) => ev.id), []);
    assert.equal(calls.length, 2, "the EuroCup request was still made");
    // A failure is never cached: the very next round retries only the failed
    // competition (the warm EuroCup season stays cached).
    now.t += 60 * 1000;
    const second = await euroleagueForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 3, "only EuroLeague is retried");
    assert.deepEqual(second.failedCompetitions, ["E"]);
    // Recovery: on the later load the previously failed competition lands.
    now.t += EUROLEAGUE_CACHE_TTL_MS + 1000;
    byUrl[EL_E_URL] = { payload: { games: [EL_PLAYED_GAME] } };
    const third = await euroleagueForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.deepEqual(third.failedCompetitions, []);
    assert.ok(third.events.some((ev) => ev.id === "el:E:301"));
  });

  test("no fetch available (node --test arms no default fetch): an honest failure, no network, no throw", async () => {
    clearEuroleagueCache();
    const result = await euroleagueForDay({ dayKey: "0", now: () => EL_NOW });
    assert.deepEqual(result.events, []);
    assert.equal(result.failed, 2);
    assert.deepEqual(result.failedCompetitions, ["E", "U"]);
  });

  test("a malformed JSON body is a failure for that competition, never a throw into the caller", async () => {
    clearEuroleagueCache();
    const { impl } = jsonFetch(euroleaguePayloads());
    const broken = async (url) => {
      if (String(url) === EL_U_URL) throw new Error("invalid json");
      return { ok: true, status: 200, json: async () => ({ games: [EL_PLAYED_GAME] }) };
    };
    const result = await euroleagueForDay({ dayKey: "0", fetchImpl: impl, now: () => EL_NOW });
    assert.equal(result.failed, 0);
    void broken;
  });
});

describe("wiring: EuroLeague appends after the ESPN slate and the sporting-events rows, muted failure", () => {
  const mountSource = readFileSync(
    new URL("../js/ui/screens/sports/sportsScreenMethods-01-mount-and-load.js", import.meta.url),
    "utf8"
  );

  test("loadSchedule fetches EuroLeague AFTER the sporting-events source, appending through the same paint path", () => {
    const espnPaint = mountSource.indexOf("this.renderPartialNotice()");
    const secondary = mountSource.indexOf("sportingEventsForDay(");
    const euro = mountSource.indexOf("euroleagueForDay(");
    assert.ok(espnPaint >= 0 && secondary > espnPaint && euro > secondary, "EuroLeague rides after both earlier sources");
    assert.match(mountSource, /this\.scheduleEvents\s*=\s*\[\.\.\.this\.scheduleEvents,\s*\.\.\.\w+\]/, "the append reuses the scheduleEvents paint path");
    assert.match(mountSource, /euroleagueForDay\(\{[\s\S]*?onProgress/, "the progressive paint path is used");
  });

  test("a EuroLeague failure is one muted line inside the guarded try, never an error state", () => {
    const callIdx = mountSource.indexOf("euroleagueForDay(");
    assert.ok(callIdx > 0);
    // The try that CONTAINS the call (search backwards), whose catch follows it.
    const start = mountSource.lastIndexOf("try {", callIdx);
    const catchIdx = mountSource.indexOf("} catch", callIdx);
    assert.ok(start >= 0 && start < callIdx && catchIdx > callIdx, "the EuroLeague load is inside a try");
    assert.match(mountSource.slice(catchIdx, catchIdx + 300), /renderSecondaryNotice/);
    assert.doesNotMatch(mountSource, /setInterval/);
  });
});
