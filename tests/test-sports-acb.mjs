// Liga Endesa (ACB): unit contract for the official JSON API that replaced the
// acb.com RSC scrape — the URL/header builders, the parser against a REAL
// payload captured from the live endpoint (tests/fixtures/acb-matches.json,
// copied verbatim from the measured run), the unified event mapping and the
// per-round 30 min cache. node --test runs fully OFFLINE: every fetch is
// injected, no network call is ever made.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Namespace import + local destructure: a missing export fails exactly the
// tests that need it instead of load-failing the whole file.
import * as acb from "../js/core/sports/acb.js";

const {
  ACB_API_URL,
  ACB_API_KEY,
  ACB_SOURCE_LABEL,
  ACB_CACHE_TTL_MS,
  acbMatchesUrl,
  acbRequestHeaders,
  parseAcbMatches,
  acbEventsForLocalDay,
  acbForDay,
  clearAcbCache
} = acb;

const ACB_SOURCE = readFileSync(new URL("../js/core/sports/acb.js", import.meta.url), "utf8");

// The REAL payload (26 KB, jornada 6021, 18 teams / 9 matches) captured from
// `GET https://api2.acb.com/api/seasondata/Competition/matches
//  ?competitionId=1&isRoundSelected=true`. Never hand-written: every
// expectation below is derived from these rows, so the fixture stays the
// source of truth.
const PAYLOAD = JSON.parse(
  readFileSync(new URL("./fixtures/acb-matches.json", import.meta.url), "utf8")
);
const ROUND = PAYLOAD.selectedFilters.round; // 6021

function clone(payload) {
  return JSON.parse(JSON.stringify(payload));
}

function localDayOf(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// A JSON fetch double: answers every URL with the payload and records the
// exact (url, init) pairs, so the header contract is observable.
function jsonFetch(payload = PAYLOAD) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (payload instanceof Error) throw payload;
    if (payload && payload.status && payload.ok === false) return payload;
    return { ok: true, status: 200, json: async () => clone(payload) };
  };
  return { impl, calls };
}

describe("acb: URL builder — roundId, never the silently-ignored round param", () => {
  test("the base request is the measured endpoint with the competition and the round filter", () => {
    assert.equal(ACB_API_URL, "https://api2.acb.com/api/seasondata/Competition/matches");
    const url = acbMatchesUrl();
    assert.ok(url.startsWith(`${ACB_API_URL}?`), url);
    assert.match(url, /[?&]competitionId=1(&|$)/, "competitionId=1 is Liga Endesa");
    assert.match(url, /[?&]isRoundSelected=true(&|$)/, "the round must be resolved server-side");
    assert.doesNotMatch(url, /roundId=/, "the current round sends NO roundId");
  });

  test("a roundId switches round; `round=` is never sent (it answers 200 and is ignored)", () => {
    const url = acbMatchesUrl(ROUND);
    assert.match(url, new RegExp(`[?&]roundId=${ROUND}(&|$)`), url);
    assert.doesNotMatch(url, /[?&]round=/, `the ignored param is never sent: ${url}`);
    assert.match(acbMatchesUrl(String(ROUND)), new RegExp(`roundId=${ROUND}(&|$)`));
    for (const garbage of [null, undefined, "", 0, -3, 1.5, "6021abc", NaN, " "]) {
      assert.doesNotMatch(acbMatchesUrl(garbage), /roundId=/, `rejected: ${String(garbage)}`);
    }
  });

  test("the key is one named, commented, revocable constant sent as x-apikey", () => {
    assert.equal(typeof ACB_API_KEY, "string");
    assert.match(ACB_API_KEY, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(acbRequestHeaders(), {
      accept: "application/json",
      "x-apikey": ACB_API_KEY
    });
    assert.notEqual(acbRequestHeaders(), acbRequestHeaders(), "a fresh object per request");
    // The key ships inside acb.com's own JS bundle, so it is public — and
    // revocable: the source must say so where the constant is declared.
    const at = ACB_SOURCE.indexOf("export const ACB_API_KEY");
    assert.ok(at > 0, "one named exported constant");
    const decl = ACB_SOURCE.slice(Math.max(0, at - 900), at + 200);
    assert.match(decl, /public/i, "the constant is documented as public");
    assert.match(decl, /revocab/i, "and as revocable");
  });
});

describe("acb: parser against the real payload — teams, scores, statuses, period, broadcast", () => {
  test("every match becomes one unified event, in payload order, with the acb:<matchId> id", () => {
    const events = parseAcbMatches(PAYLOAD);
    assert.equal(events.length, PAYLOAD.matches.length, "the fixture round is fully mapped");
    assert.deepEqual(
      events.map((ev) => ev.id),
      PAYLOAD.matches.map((match) => `acb:${match.id}`)
    );
    for (const event of events) {
      assert.equal(event.slug, "acb");
      assert.equal(event.sportType, "basketball");
      assert.equal(event.leagueName, "Liga Endesa");
      assert.equal(event.leagueAbbr, "ACB");
      assert.equal(event.leagueLogo, "");
      assert.equal(event.venue, null, "the API carries no venue");
      assert.equal(event.clock, "");
      assert.equal(event.situation, "");
      assert.equal(event.live, false, "a live state is NEVER invented");
    }
  });

  test("sides resolve through homeTeamId/awayTeamId against teams[].id — name, abbr, colour, logo", () => {
    const events = parseAcbMatches(PAYLOAD);
    const byId = new Map(PAYLOAD.teams.map((team) => [team.id, team]));
    events.forEach((event, index) => {
      const match = PAYLOAD.matches[index];
      const home = byId.get(match.homeTeamId);
      const away = byId.get(match.awayTeamId);
      assert.ok(home && away, `match ${match.id} references two known teams`);
      assert.equal(event.home.name, home.fullName.trim());
      assert.equal(event.home.abbr, home.abbreviatedName);
      assert.equal(event.home.color, home.primaryColorHex);
      assert.equal(event.home.logo, home.logo);
      assert.equal(event.home.record, null, "the API carries no record");
      assert.equal(event.away.name, away.fullName.trim());
      assert.equal(event.away.abbr, away.abbreviatedName);
      assert.equal(event.away.color, away.primaryColorHex);
      assert.equal(event.away.logo, away.logo);
      assert.equal(event.away.record, null);
      assert.notEqual(event.home.name, event.away.name, "the two sides are never the same team");
    });
  });

  test("FINALIZED -> post/finished with its real scores; kickoff from startDateTime", () => {
    const events = parseAcbMatches(PAYLOAD);
    events.forEach((event, index) => {
      const match = PAYLOAD.matches[index];
      assert.equal(match.matchStatus, "FINALIZED", "the captured round is a finished one");
      assert.equal(event.state, "post");
      assert.equal(event.status, "finished");
      assert.equal(event.home.score, match.homeScore);
      assert.equal(event.away.score, match.awayScore);
      assert.equal(event.kickoffMs, Date.parse(match.startDateTime));
    });
  });

  test("period comes from currentQuarter (6 = overtime), not a hard-coded 0", () => {
    const events = parseAcbMatches(PAYLOAD);
    events.forEach((event, index) => {
      assert.equal(event.period, PAYLOAD.matches[index].currentQuarter);
    });
    const overtime = events.filter((event) => event.period === 6);
    assert.ok(
      overtime.length >= 1,
      `the fixture holds an overtime match (currentQuarter 6): ${events.map((e) => e.period)}`
    );
  });

  test("NOT_STARTED and NOT_SCHEDULED -> pre/scheduled and not live, scores NEVER rendered", () => {
    // Derived from a REAL row (only matchStatus is flipped): the scores the
    // finalized payload carries stay in place, so the mapping must key on the
    // status — never on the presence of a number.
    const real = PAYLOAD.matches[0];
    assert.ok(Number.isFinite(real.homeScore));
    for (const status of ["NOT_STARTED", "NOT_SCHEDULED"]) {
      const payload = clone(PAYLOAD);
      payload.matches = [{ ...payload.matches[0], matchStatus: status }];
      const [event] = parseAcbMatches(payload);
      assert.ok(event, `${status} is a known status`);
      assert.equal(event.state, "pre", status);
      assert.equal(event.status, "scheduled", status);
      assert.equal(event.live, false, status);
      assert.equal(event.home.score, null, "a payload score is never rendered before the final");
      assert.equal(event.away.score, null);
      assert.equal(event.kickoffMs, Date.parse(real.startDateTime));
      assert.equal(event.period, real.currentQuarter, "the quarter still comes from the payload");
    }
  });

  test("an UNOBSERVED status is dropped, never labelled: no live string is invented", () => {
    for (const status of ["IN_PROGRESS", "LIVE", "HALFTIME", "", null, undefined]) {
      const payload = clone(PAYLOAD);
      payload.matches = [{ ...payload.matches[0], matchStatus: status }];
      assert.deepEqual(parseAcbMatches(payload), [], `dropped: ${String(status)}`);
    }
    const mixed = clone(PAYLOAD);
    mixed.matches = [
      { ...PAYLOAD.matches[0], matchStatus: "FINALIZED" },
      { ...PAYLOAD.matches[1], matchStatus: "IN_PROGRESS" }
    ];
    assert.deepEqual(
      parseAcbMatches(mixed).map((event) => event.id),
      [`acb:${PAYLOAD.matches[0].id}`],
      "the unknown row never costs the known ones"
    );
  });

  test("broadcastChannels is a FLAT array: primary broadcasters surface in `order` sequence", () => {
    // Measured trap: the API ships [{broadcaster,primary,order,…}], NOT the
    // {primary[],secondary[]} object the RSC scrape parsed — so the old
    // mapping silently dropped every channel.
    const flat = PAYLOAD.matches[0].broadcastChannels;
    assert.ok(Array.isArray(flat), "the fixture proves the flat shape");
    assert.ok(flat.every((entry) => typeof entry.broadcaster === "string"));

    const events = parseAcbMatches(PAYLOAD);
    events.forEach((event, index) => {
      const rows = PAYLOAD.matches[index].broadcastChannels ?? [];
      const expected = rows
        .map((entry, position) => ({ entry, position }))
        .filter(({ entry }) => entry.primary === true)
        .sort((a, b) => a.entry.order - b.entry.order || a.position - b.position)
        .map(({ entry }) => entry.broadcaster.trim());
      assert.deepEqual(event.broadcast, expected, `match ${PAYLOAD.matches[index].id}`);
    });
  });

  test("`order` wins over array position and non-primary channels are excluded", () => {
    // This real row: DAZN(1, primary), Movistar Plus +(5, NOT primary),
    // Orange(6), Vodafone TV(7), Vamos(2, primary but LAST in the array).
    const index = PAYLOAD.matches.findIndex((match) =>
      Array.isArray(match.broadcastChannels)
        ? match.broadcastChannels.some((e) => e.primary === false) &&
          match.broadcastChannels.some((e) => e.primary === true && e.order === 2)
        : false
    );
    assert.ok(index >= 0, "the fixture carries such a row");
    const match = PAYLOAD.matches[index];
    const event = parseAcbMatches(PAYLOAD)[index];
    assert.deepEqual(
      event.broadcast,
      ["DAZN", "Vamos", "Orange", "Vodafone TV"],
      `the primary-only channels in order: ${JSON.stringify(match.broadcastChannels.map((e) => `${e.broadcaster}:${e.primary}:${e.order}`))}`
    );
    assert.ok(
      !event.broadcast.includes("Movistar Plus +"),
      "the primary:false row is not a card channel"
    );
  });

  test("garbage degrades to [] and drops rows, never throws", () => {
    assert.deepEqual(parseAcbMatches(null), []);
    assert.deepEqual(parseAcbMatches({}), []);
    assert.deepEqual(parseAcbMatches({ teams: PAYLOAD.teams, matches: "nope" }), []);
    const badId = clone(PAYLOAD);
    badId.matches = [{ ...PAYLOAD.matches[0], id: null }];
    assert.deepEqual(parseAcbMatches(badId), [], "no stable id can be built");
    const badDate = clone(PAYLOAD);
    badDate.matches = [{ ...PAYLOAD.matches[0], startDateTime: "nope" }];
    assert.deepEqual(parseAcbMatches(badDate), [], "never day-filterable");
    const unknownTeam = clone(PAYLOAD);
    unknownTeam.matches = [{ ...PAYLOAD.matches[0], homeTeamId: 999999 }];
    assert.deepEqual(parseAcbMatches(unknownTeam), [], "an unresolvable side is dropped");
    const noTeams = clone(PAYLOAD);
    noTeams.teams = [];
    assert.deepEqual(parseAcbMatches(noTeams), []);
  });
});

describe("acb: local day filtering (the same local-day window as the rest of the screen)", () => {
  test("events land on the requested LOCAL day only", () => {
    const events = parseAcbMatches(PAYLOAD);
    const now = Date.parse(PAYLOAD.matches[0].startDateTime) + 60 * 60 * 1000;
    const today = localDayOf(now);
    const countOn = (dayStart) =>
      PAYLOAD.matches.filter((match) => localDayOf(Date.parse(match.startDateTime)) === dayStart)
        .length;
    assert.equal(
      acbEventsForLocalDay(events, { dayKey: "0", now }).length,
      countOn(today),
      "every fixture row of that local day"
    );
    assert.equal(
      acbEventsForLocalDay(events, { dayKey: "1", now }).length,
      countOn(today + 24 * 60 * 60 * 1000)
    );
    assert.equal(acbEventsForLocalDay(events, { dayKey: "-1", now }).length, 0);
    assert.deepEqual(acbEventsForLocalDay(null, { dayKey: "0", now }), []);
  });
});

describe("acb: the day fetch — bounded JSON, x-apikey, per-round cache, failures never cached", () => {
  test("one request with the api key, mapped into unified events for the visible local day", async () => {
    clearAcbCache();
    const { impl, calls } = jsonFetch();
    const now = Date.parse(PAYLOAD.matches[0].startDateTime) + 60 * 60 * 1000;
    const result = await acbForDay({ dayKey: "0", fetchImpl: impl, now });
    assert.equal(calls.length, 1, "one request per round");
    assert.equal(calls[0].url, acbMatchesUrl(), "the current round, no roundId");
    assert.equal(calls[0].init.headers["x-apikey"], ACB_API_KEY, "the request carries x-apikey");
    assert.equal(calls[0].init.headers.accept, "application/json");
    assert.equal(result.failed, 0);
    assert.deepEqual(result.failedCompetitions, []);
    assert.deepEqual(
      result.events.map((event) => event.id),
      acbEventsForLocalDay(parseAcbMatches(PAYLOAD), { dayKey: "0", now }).map((e) => e.id)
    );
  });

  test("the cache is keyed by ROUND: the current round is served warm, another round is fetched", async () => {
    clearAcbCache();
    const now = Date.parse(PAYLOAD.matches[0].startDateTime) + 60 * 60 * 1000;
    const { impl, calls } = jsonFetch();
    await acbForDay({ dayKey: "0", fetchImpl: impl, now });
    assert.equal(calls.length, 1);
    await acbForDay({ dayKey: "0", fetchImpl: impl, now }); // same round: the payload's roundId
    assert.equal(calls.length, 1, "a warm round makes zero requests");
    await acbForDay({ dayKey: "0", fetchImpl: impl, now, roundId: ROUND });
    assert.equal(calls.length, 1, "an explicit roundId hits the SAME per-round entry");
    await acbForDay({ dayKey: "0", fetchImpl: impl, now, roundId: 6022 });
    assert.equal(calls.length, 2, "another round is its own cache entry");
    assert.match(calls[1].url, /roundId=6022(&|$)/);
    await acbForDay({ dayKey: "0", fetchImpl: impl, now });
    assert.equal(calls.length, 2, "the current round is still warm");
    await acbForDay({ dayKey: "0", fetchImpl: impl, now, force: true });
    assert.equal(calls.length, 3, "force bypasses the cache");
  });

  test("the round is revalidated after 30 minutes and the day filter re-runs per call", async () => {
    clearAcbCache();
    const clock = { t: Date.parse(PAYLOAD.matches[0].startDateTime) + 60 * 60 * 1000 };
    const { impl, calls } = jsonFetch();
    await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => clock.t });
    assert.equal(calls.length, 1);
    assert.equal(ACB_CACHE_TTL_MS, 30 * 60 * 1000, "30 minutes");
    clock.t += ACB_CACHE_TTL_MS - 1000;
    await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => clock.t });
    assert.equal(calls.length, 1, "inside the TTL the round is never re-downloaded");
    clock.t += 2000;
    await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => clock.t });
    assert.equal(calls.length, 2, "past the TTL it revalidates");
  });

  test("a FAILURE is never cached: the very next round retries it", async () => {
    clearAcbCache();
    const clock = { t: Date.parse(PAYLOAD.matches[0].startDateTime) + 60 * 60 * 1000 };
    const calls = [];
    let fail = true;
    const impl = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (fail) throw new Error("network down");
      return { ok: true, status: 200, json: async () => clone(PAYLOAD) };
    };
    const first = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => clock.t });
    assert.equal(first.failed, 1);
    assert.deepEqual(first.failedCompetitions, [ACB_SOURCE_LABEL], "the muted acb.com line");
    assert.deepEqual(first.events, []);
    clock.t += 1000; // ONE second later, still far inside any failure window
    const second = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => clock.t });
    assert.equal(calls.length, 2, "the failure is NOT remembered: no failure cache");
    assert.deepEqual(second.failedCompetitions, [ACB_SOURCE_LABEL]);
    fail = false;
    const third = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => clock.t });
    assert.equal(calls.length, 3);
    assert.deepEqual(third.failedCompetitions, []);
    await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => clock.t });
    assert.equal(calls.length, 3, "the recovered round is cached from then on");
  });

  test("a 401 / an empty round is a failure, never a throw into the caller", async () => {
    clearAcbCache();
    const unauthorized = { ok: false, status: 401, json: async () => ({}) };
    const { impl } = jsonFetch(unauthorized);
    const result = await acbForDay({ dayKey: "0", fetchImpl: impl, now: Date.now() });
    assert.deepEqual(result.failedCompetitions, [ACB_SOURCE_LABEL]);
    assert.deepEqual(result.events, []);

    clearAcbCache();
    const empty = clone(PAYLOAD);
    empty.matches = [];
    const emptyFetch = jsonFetch(empty);
    const unparsable = await acbForDay({
      dayKey: "0",
      fetchImpl: emptyFetch.impl,
      now: Date.parse(PAYLOAD.matches[0].startDateTime) + 60 * 60 * 1000
    });
    assert.deepEqual(unparsable.failedCompetitions, [ACB_SOURCE_LABEL]);
  });

  test("no fetch available (node --test arms no default fetch): an honest failure, no throw", async () => {
    clearAcbCache();
    const result = await acbForDay({ dayKey: "0", now: Date.now() });
    assert.deepEqual(result.events, []);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.failedCompetitions, [ACB_SOURCE_LABEL]);
  });
});

describe("acb: the RSC scrape is DELETED, not left behind", () => {
  test("no chunk scanner, no page URL, no 1 MB cap, no bespoke text fetch", () => {
    assert.doesNotMatch(ACB_SOURCE, /__next_f/, "the RSC stream marker is gone");
    assert.doesNotMatch(ACB_SOURCE, /collectChunkText|unescapeChunkText|readStringLiteral/);
    assert.doesNotMatch(ACB_SOURCE, /findRoundObject|matchObjectEnd|findEnclosingObjectStart/);
    assert.doesNotMatch(ACB_SOURCE, /resolveTeamRef/, "team refs are ids now, not RSC paths");
    assert.doesNotMatch(ACB_SOURCE, /acb\.com\/es\/liga\/partidos/, "the scraped page is gone");
    assert.doesNotMatch(ACB_SOURCE, /ACB_PAGE_URL|ACB_MAX_BYTES|ACB_FAILURE_TTL_MS/);
    assert.doesNotMatch(ACB_SOURCE, /\.text\(\)/, "the bespoke text fetch is gone");
    assert.doesNotMatch(ACB_SOURCE, /response\.ok/, "the bounded JSON helper owns the verdict");
  });

  test("it is built on the shared bounded JSON fetch and the shared timeout", () => {
    const source = ACB_SOURCE;
    assert.match(source, /from "\.\/espnScores\.js"/);
    assert.match(source, /fetchJsonBounded/);
    assert.match(source, /ESPN_REQUEST_TIMEOUT_MS/);
    assert.doesNotMatch(source, /ACB_REQUEST_TIMEOUT_MS/, "no bespoke 10 s budget");
  });
});

describe("wiring: the screen keeps calling acbForDay through the guarded paint path", () => {
  const mountSource = readFileSync(
    new URL("../js/ui/screens/sports/sportsScreenMethods-01-mount-and-load.js", import.meta.url),
    "utf8"
  );

  test("the module's exported entry point is unchanged, so the screen needs no new call shape", () => {
    assert.equal(typeof acb.acbForDay, "function");
    assert.match(mountSource, /import \{ acbForDay \} from "\.\.\/\.\.\/\.\.\/core\/sports\/acb\.js";/);
    assert.match(mountSource, /await acbForDay\(\{ dayKey: this\.dayKey, force \}\)/);
  });

  test("the ACB load still rides after EuroLeague, guarded by canPaint() with one muted line", () => {
    const euro = mountSource.indexOf("euroleagueForDay(");
    const acbCall = mountSource.indexOf("acbForDay(");
    assert.ok(euro >= 0 && acbCall > euro, "ACB rides after the EuroLeague rows");
    assert.match(
      mountSource,
      /this\.scheduleEvents\s*=\s*\[\.\.\.this\.scheduleEvents,\s*\.\.\.acb\.events\]/,
      "the append reuses the scheduleEvents paint path"
    );
    const start = mountSource.lastIndexOf("try {", acbCall);
    const catchIdx = mountSource.indexOf("} catch", acbCall);
    assert.ok(start >= 0 && start < acbCall && catchIdx > acbCall, "the ACB load is inside a try");
    assert.ok(mountSource.slice(acbCall, catchIdx).includes("canPaint()"));
    assert.match(mountSource.slice(catchIdx, catchIdx + 300), /renderSecondaryNotice/);
    assert.doesNotMatch(mountSource, /setInterval/);
  });

  test("the screen comment does not still describe a scrape or a 1 MB body cap", () => {
    const start = mountSource.indexOf("FOURTH SCHEDULE SOURCE");
    const block = mountSource.slice(start, start + 1200);
    assert.doesNotMatch(block, /scrap/i, "the source is a JSON API now");
    assert.doesNotMatch(block, /1 MB/, "the 1 MB body cap went with the scrape");
  });
});
