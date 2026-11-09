// ESPN live scores: unit contract for the curated name→slug table, the
// bounded round fetch and the match rules. node --test runs fully OFFLINE:
// every fetch is injected, no network call is ever made.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

import {
  ESPN_MAX_SLUGS_PER_ROUND,
  ESPN_REQUEST_TIMEOUT_MS,
  ESPN_ROUND_BUDGET_MS,
  ESPN_CACHE_TTL_MS,
  LEAGUE_SLUGS,
  resolveLeagueSlug,
  espnScoreboardUrl,
  espnDateForDay,
  parseScoreboard,
  scoresForDay,
  matchScore,
  clearScoreCache
} from "../js/core/sports/espnScores.js";
import { parseEvents } from "../js/core/sports/sportsFeed.js";

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

describe("slug table: Spanish league names and aliases resolve to ESPN slugs", () => {
  const cases = [
    // US pro + college
    ["NFL", "football/nfl"],
    ["Fútbol Americano", "football/nfl"],
    ["NCAA Fútbol Americano", "football/college-football"],
    ["College Football", "football/college-football"],
    ["NBA", "basketball/nba"],
    ["WNBA", "basketball/wnba"],
    ["NCAA Baloncesto", "basketball/mens-college-basketball"],
    ["Baloncesto Universitario", "basketball/mens-college-basketball"],
    ["NHL", "hockey/nhl"],
    ["MLB", "baseball/mlb"],
    ["Béisbol MLB", "baseball/mlb"],
    // Soccer by name and obvious Spanish aliases
    ["Premier League", "soccer/eng.1"],
    ["Liga Premier de Inglaterra", "soccer/eng.1"],
    ["LaLiga", "soccer/esp.1"],
    ["La Liga EA Sports", "soccer/esp.1"],
    ["Liga de España", "soccer/esp.1"],
    ["Serie A", "soccer/ita.1"],
    ["Calcio Italia", "soccer/ita.1"],
    ["Bundesliga", "soccer/ger.1"],
    ["Ligue 1", "soccer/fra.1"],
    ["Liga MX", "soccer/mex.1"],
    ["Fútbol Mexicano", "soccer/mex.1"],
    ["MLS", "soccer/usa.1"],
    ["Major League Soccer", "soccer/usa.1"],
    ["UEFA Champions League", "soccer/uefa.champions"],
    ["Champions", "soccer/uefa.champions"],
    ["Europa League", "soccer/uefa.europa"],
    ["Copa Libertadores", "soccer/conmebol.libertadores"],
    ["Sudamericana", "soccer/conmebol.sudamericana"],
    ["Liga Profesional de Argentina", "soccer/arg.1"],
    ["Brasileirão Serie A", "soccer/bra.1"],
    ["Primera A Colombia", "soccer/col.1"],
    ["Primera División de Chile", "soccer/chi.1"],
    ["Mundial de Clubes", "soccer/fifa.world"],
    ["World Cup", "soccer/fifa.world"],
    ["UFC", "mma/ufc"],
    ["Fórmula 1", "racing/f1"],
    ["ATP", "tennis/atp"],
    ["WTA", "tennis/wta"],
    ["PGA", "golf/pga"]
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

  test("unmapped leagues resolve to null — they simply get no score", () => {
    assert.equal(resolveLeagueSlug("Balonmano"), null);
    assert.equal(resolveLeagueSlug("Cricket"), null);
    assert.equal(resolveLeagueSlug("Vóley Playa"), null);
    assert.equal(resolveLeagueSlug(""), null);
    assert.equal(resolveLeagueSlug(null), null);
  });
});

describe("the round: slug derivation, the 8-slug cap and the request budget", () => {
  test("constants: 8 slugs max, 1200 ms per request, an overall cap below the serial worst case", () => {
    assert.equal(ESPN_MAX_SLUGS_PER_ROUND, 8);
    assert.equal(ESPN_REQUEST_TIMEOUT_MS, 1200);
    assert.ok(ESPN_ROUND_BUDGET_MS < ESPN_MAX_SLUGS_PER_ROUND * ESPN_REQUEST_TIMEOUT_MS);
    assert.equal(ESPN_CACHE_TTL_MS, 60000);
  });

  test("distinct slugs only: one request per league, not per event", async () => {
    clearScoreCache();
    const { impl, calls } = recordingFetch({ events: [] });
    const events = [
      event({ id: "1", leagueName: "LaLiga", kickoffMs: NOW + 3 * 60 * MIN }),
      event({ id: "2", leagueName: "La Liga", kickoffMs: NOW + 4 * 60 * MIN }),
      event({ id: "3", leagueName: "Premier League", kickoffMs: NOW + 5 * 60 * MIN })
    ];
    const result = await scoresForDay({ dayKey: "today", events, fetchImpl: impl, now: () => NOW });
    assert.equal(calls.length, 2);
    assert.deepEqual(result.slugs.sort(), ["soccer/eng.1", "soccer/esp.1"]);
    assert.ok(calls.every((url) => url.startsWith("https://site.api.espn.com/apis/site/v2/sports/")));
  });

  test("the 8-slug cap: leagues beyond the cap are skipped and logged, the round still answers", async () => {
    clearScoreCache();
    const warn = mock.method(console, "warn", () => {});
    try {
      const { impl, calls } = recordingFetch({ events: [] });
      const leagues = ["NFL", "NBA", "NHL", "MLB", "LaLiga", "Premier League", "Bundesliga", "Serie A", "Ligue 1", "Liga MX"];
      const events = leagues.map((leagueName, i) =>
        event({ id: `e${i}`, leagueName, kickoffMs: NOW + (i + 1) * 30 * MIN })
      );
      const result = await scoresForDay({ dayKey: "today", events, fetchImpl: impl, now: () => NOW });
      assert.equal(calls.length, ESPN_MAX_SLUGS_PER_ROUND);
      assert.equal(result.slugs.length, ESPN_MAX_SLUGS_PER_ROUND);
      assert.deepEqual(result.skipped.sort(), ["Ligue 1", "Liga MX"].map((n) => resolveLeagueSlug(n)).sort());
      assert.ok(warn.mock.calls.length >= 1, "skipped leagues are logged");
    } finally {
      warn.mock.restore();
    }
  });

  test("no fetch available: an empty round, never a throw", async () => {
    clearScoreCache();
    const result = await scoresForDay({ dayKey: "today", events: [event({ id: "1", leagueName: "NFL", kickoffMs: NOW })] });
    assert.deepEqual(result.games, []);
  });
});

describe("ESPN scoreboard URL and date key", () => {
  test("one call per league and day: dates=yyyyMMdd&limit=1000", () => {
    const url = espnScoreboardUrl({ slug: "football/nfl" }, "20260115");
    assert.equal(url, "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260115&limit=1000");
  });

  test("college rows add groups (80 football, 50 basketball)", () => {
    assert.match(
      espnScoreboardUrl({ slug: "football/college-football", groups: 80 }, "20260115"),
      /&groups=80$/
    );
    assert.match(
      espnScoreboardUrl({ slug: "basketball/mens-college-basketball", groups: 50 }, "20260115"),
      /&groups=50$/
    );
  });

  test("date key for a dayKey: the day's events decide the ET yyyyMMdd date", () => {
    // 20:00 UTC = 15:00 in America/New_York on the same day.
    const events = [event({ id: "1", leagueName: "NFL", kickoffMs: Date.UTC(2026, 0, 15, 20, 0, 0) })];
    assert.equal(espnDateForDay({ dayKey: "today", events, now: NOW }), "20260115");
  });

  test("without events the dayKey offsets from now (Ayer -1, Mañana +1)", () => {
    // NOW is 2026-01-15 12:00 UTC = 07:00 ET on 2026-01-15.
    assert.equal(espnDateForDay({ dayKey: "today", events: [], now: NOW }), "20260115");
    assert.equal(espnDateForDay({ dayKey: "yesterday", events: [], now: NOW }), "20260114");
    assert.equal(espnDateForDay({ dayKey: "tomorrow", events: [], now: NOW }), "20260116");
  });
});

describe("parsing the ESPN scoreboard payload into the compact game shape", () => {
  const payload = {
    leagues: [{ name: "National Football League", abbreviation: "nfl" }],
    events: [
      {
        date: "2026-01-15T18:00Z",
        name: "Away Team at Home Team",
        competitions: [
          {
            date: "2026-01-15T18:00Z",
            situation: { downDistanceText: "3rd & 7" },
            competitors: [
              { homeAway: "home", team: { displayName: "Home Team" }, score: "24", records: [{ summary: "8-3" }] },
              { homeAway: "away", team: { displayName: "Away Team" }, score: "17", records: [{ summary: "5-6" }] }
            ],
            status: {
              clock: 900,
              displayClock: "15:00",
              period: 4,
              type: { state: "in", shortDetail: "Q4 15:00" }
            }
          }
        ],
        status: {
          clock: 900,
          displayClock: "15:00",
          period: 4,
          type: { state: "in", shortDetail: "Q4 15:00" }
        }
      },
      {
        date: "2026-01-15T23:30Z",
        competitions: [
          {
            competitors: [
              { homeAway: "home", team: { displayName: "Late Home" }, score: "0" },
              { homeAway: "away", team: { displayName: "Late Away" }, score: "0" }
            ],
            status: { type: { state: "pre", shortDetail: "Thu 6:30 PM" }, period: 0 }
          }
        ],
        status: { type: { state: "pre", shortDetail: "Thu 6:30 PM" } }
      },
      {
        date: "2026-01-15T02:00Z",
        competitions: [
          {
            competitors: [
              { homeAway: "home", team: { displayName: "Done Home" }, score: "3", records: [{ summary: "10-1" }] },
              { homeAway: "away", team: { displayName: "Done Away" }, score: "1", records: [{ summary: "4-7" }] }
            ],
            status: { type: { state: "post", shortDetail: "Final" } }
          }
        ],
        status: { type: { state: "post", shortDetail: "Final" } }
      }
    ]
  };

  test("live game: state, statusText, period, clock, situation and both sides", () => {
    const games = parseScoreboard(payload);
    assert.equal(games.length, 3);
    const live = games[0];
    // parseScoreboard never guesses the slug — the round attaches the slug it fetched.
    assert.equal(live.kickoffMs, Date.parse("2026-01-15T18:00Z"));
    assert.equal(live.state, "in");
    assert.equal(live.statusText, "Q4 15:00");
    assert.equal(live.period, 4);
    assert.equal(live.clock, "15:00");
    assert.equal(live.situation, "3rd & 7");
    assert.deepEqual(
      { name: live.home.name, score: live.home.score, record: live.home.record },
      { name: "Home Team", score: 24, record: "8-3" }
    );
    assert.deepEqual(
      { name: live.away.name, score: live.away.score, record: live.away.record },
      { name: "Away Team", score: 17, record: "5-6" }
    );
    const pre = games[1];
    assert.equal(pre.state, "pre");
    assert.equal(pre.situation, "");
    assert.equal(pre.home.record, "");
    const post = games[2];
    assert.equal(post.state, "post");
  });

  test("garbage payloads parse to an empty list, never a throw", () => {
    assert.deepEqual(parseScoreboard(null), []);
    assert.deepEqual(parseScoreboard({}), []);
    assert.deepEqual(parseScoreboard({ events: [{}] }), []);
  });
});

describe("the 60 s TTL cache and per-league failure isolation", () => {
  test("a second round inside the TTL does not refetch a league; the round returns what succeeded", async () => {
    clearScoreCache();
    const now = { t: NOW };
    const goodPayload = {
      events: [
        {
          date: "2026-01-15T18:00Z",
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { displayName: "Home Team" }, score: "10" },
                { homeAway: "away", team: { displayName: "Away Team" }, score: "7" }
              ],
              status: { type: { state: "in", shortDetail: "Q2" } }
            }
          ],
          status: { type: { state: "in", shortDetail: "Q2" } }
        }
      ]
    };
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (url.includes("soccer/esp.1")) throw new Error("boom"); // one league fails
      return { ok: true, status: 200, json: async () => goodPayload };
    };
    const events = [
      event({ id: "1", leagueName: "NFL", kickoffMs: NOW + 60 * MIN }),
      event({ id: "2", leagueName: "LaLiga", kickoffMs: NOW + 90 * MIN })
    ];
    const first = await scoresForDay({ dayKey: "today", events, fetchImpl, now: () => now.t });
    assert.equal(calls.length, 2);
    assert.equal(first.games.length, 1, "the failed league did not poison the round");
    assert.equal(first.games[0].home.score, 10);
    assert.equal(first.games[0].slug, "football/nfl", "the round attaches the slug it fetched");

    // Second round well inside the 60 s TTL: the good league is served from
    // cache; the FAILED league is retried (failures are never cached).
    now.t += 30 * 1000;
    const second = await scoresForDay({ dayKey: "today", events, fetchImpl, now: () => now.t });
    assert.equal(calls.length, 3, "only the failed league is refetched");
    assert.equal(second.games.length, 1);

    // After the TTL expires both leagues are fetched again.
    now.t += 61 * 1000;
    await scoresForDay({ dayKey: "today", events, fetchImpl, now: () => now.t });
    assert.equal(calls.length, 5);
  });

  test("the cache is per slug|date: a different day refetches", async () => {
    clearScoreCache();
    let t = NOW;
    const { impl, calls } = recordingFetch({
      events: [
        {
          date: "2026-01-15T18:00Z",
          competitions: [
            {
              competitors: [
                { homeAway: "home", team: { displayName: "H" }, score: "1" },
                { homeAway: "away", team: { displayName: "A" }, score: "0" }
              ],
              status: { type: { state: "final" } }
            }
          ],
          status: { type: { state: "post" } }
        }
      ]
    });
    const events = [event({ id: "1", leagueName: "NFL", kickoffMs: NOW + 60 * MIN })];
    await scoresForDay({ dayKey: "today", events, fetchImpl: impl, now: () => t });
    t += 61 * 1000;
    await scoresForDay({ dayKey: "tomorrow", events: [event({ id: "1", leagueName: "NFL", kickoffMs: NOW + 24 * 60 * MIN })], fetchImpl: impl, now: () => t });
    assert.equal(calls.length, 2);
    assert.ok(new Set(calls).size === 2, "the second call used a different date key");
  });
});

describe("matchScore: the rule the TV app uses", () => {
  const game = (over = {}) => ({
    slug: "football/nfl",
    kickoffMs: Date.UTC(2026, 0, 15, 18, 0, 0),
    state: "in",
    statusText: "Q4 15:00",
    period: 4,
    clock: "15:00",
    situation: "",
    home: { name: "Home Team", score: 24, record: "8-3" },
    away: { name: "Away Team", score: 17, record: "5-6" },
    ...over
  });

  test("kickoff within 20 minutes and both names matching -> the game", () => {
    const ev = event({
      id: "1",
      leagueName: "NFL",
      kickoffMs: game().kickoffMs + 10 * MIN,
      teams: [{ side: "home", name: "Home Team" }, { side: "away", name: "Away Team" }]
    });
    const matched = matchScore(ev, [game()]);
    assert.equal(matched?.home.score, 24);
    assert.equal(matched?.away.score, 17);
  });

  test("kickoff outside the 20 minute window -> null", () => {
    const ev = event({ id: "1", leagueName: "NFL", kickoffMs: game().kickoffMs + 25 * MIN });
    assert.equal(matchScore(ev, [game()]), null);
    const ev2 = event({ id: "1", leagueName: "NFL", kickoffMs: game().kickoffMs - 21 * MIN });
    assert.equal(matchScore(ev2, [game()]), null);
  });

  test("names match whole-word in either home/away order, after accent and punctuation folding", () => {
    const ev = event({
      id: "1",
      leagueName: "LaLiga",
      kickoffMs: game().kickoffMs,
      teams: [{ side: "home", name: "Atlético Madrid" }, { side: "away", name: "CA Osasuna" }]
    });
    const g = game({
      kickoffMs: ev.kickoffMs,
      home: { name: "Atletico de Madrid", score: 2, record: "" },
      away: { name: "CA Osasuna", score: 1, record: "" }
    });
    assert.ok(matchScore(ev, [g]));
  });

  test("a name that does not match -> null", () => {
    const ev = event({
      id: "1",
      leagueName: "NFL",
      kickoffMs: game().kickoffMs,
      teams: [{ side: "home", name: "Otro Equipo" }, { side: "away", name: "Away Team" }]
    });
    assert.equal(matchScore(ev, [game()]), null);
  });

  test("ambiguous: two games both match -> null (never guess)", () => {
    const ev = event({ id: "1", leagueName: "NFL", kickoffMs: game().kickoffMs });
    assert.equal(matchScore(ev, [game(), game()]), null);
  });

  test("no scores or garbage input -> null", () => {
    const ev = event({ id: "1", leagueName: "NFL", kickoffMs: game().kickoffMs });
    assert.equal(matchScore(ev, []), null);
    assert.equal(matchScore(ev, undefined), null);
    assert.equal(matchScore(null, [game()]), null);
  });
});
