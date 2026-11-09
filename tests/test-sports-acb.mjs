// Liga Endesa (ACB): unit contract for the acb.com/es/liga/partidos scrape —
// the Next.js RSC stream parser (manual quote scanner, NEVER a giant regex),
// the unified event mapping, the 1 MB body cap, the 30 min round cache and
// failure isolation. node --test runs fully OFFLINE: every fetch is injected,
// no network call is ever made.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Namespace import + local destructure: a missing export fails exactly the
// tests that need it instead of load-failing the whole file.
import * as acb from "../js/core/sports/acb.js";

const {
  ACB_PAGE_URL,
  ACB_MAX_BYTES,
  ACB_CACHE_TTL_MS,
  ACB_FAILURE_TTL_MS,
  parseAcbRound,
  acbEventsForLocalDay,
  acbForDay,
  clearAcbCache
} = acb;

const HOUR = 60 * 60 * 1000;
// Fixed local clock: 2026-01-15 12:00 local. Kickoffs are built around the
// SAME local day so the local-day window is observable.
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();

// An ISO instant N hours from local noon of the fixture day (UTC string, the
// shape startDateTime ships).
function isoAt(hourOffset) {
  return new Date(NOW + hourOffset * HOUR).toISOString();
}

// ---- The RSC fixture: reproduces the THREE measured realities --------------
//
// REALITY 1 (the escaping trap): the round JSON is EMBEDDED ESCAPED inside
// the chunk strings — the chunk text holds `\"teams\":` and `\"matches\":`,
// never the plain keys. Searching raw chunk text for `"teams":` finds ZERO
// occurrences (this is exactly why the first implementation failed every
// real request), so each chunk must be unescaped once before key search.
//
// REALITY 2: the FIRST `"teams":` after unescaping is a translation label
// ("teams":"Equipos") — the parser must skip it and find the ONE object that
// carries BOTH `teams` and `matches`.
//
// REALITY 3: a ~22 KB literal inside an unrelated row — a regex-based
// extractor blows the native engine's stack on it; the manual quote scanner
// must ride through (the literal even contains escaped quotes and braces).
//
// The round row is ALSO split across two `self.__next_f.push` chunks (rows
// span pushes) and carries `$3c:props:children:props:children:0:props:data:
// teams:N` refs against its `teams` array — exactly the measured page.

const TEAM_A = {
  id: 4460,
  fullName: "Real Madrid",
  shortName: "Real Madrid",
  abbreviatedName: "RMB",
  primaryColorHex: "#154284",
  textColorHex: "#999999",
  logo: "https://static.acb.com/img/www/clubes2026/202526RealMadridLogoPositivo.png"
};
const TEAM_B = {
  id: 4473,
  fullName: "Asisa Joventut",
  shortName: "Joventut",
  abbreviatedName: "JOV",
  primaryColorHex: "#2f8e62",
  textColorHex: "#999999",
  logo: "https://static.acb.com/img/www/clubes2026/202526JoventutLogoPositivo.png"
};
const TEAMS_REF_HOME = "$3c:props:children:props:children:0:props:data:teams:0";
const TEAMS_REF_AWAY = "$3c:props:children:props:children:0:props:data:teams:1";

const FINALIZED_MATCH = {
  id: 105429,
  homeTeam: TEAMS_REF_HOME,
  awayTeam: TEAMS_REF_AWAY,
  homeScore: 100,
  awayScore: 99,
  startDateTime: isoAt(2),
  matchStatus: "FINALIZED",
  isOnHalfTime: false,
  currentQuarter: 6,
  broadcastChannels: { primary: [{ name: "DAZN" }, { name: "Movistar Plus +" }] }
};

const NOT_STARTED_MATCH = {
  id: 105430,
  homeTeam: TEAMS_REF_AWAY,
  awayTeam: TEAMS_REF_HOME,
  startDateTime: isoAt(8),
  matchStatus: "NOT_STARTED",
  // "Más Deportes" is written with a ROW-LEVEL \uXXXX escape in the round
  // JSON (the measured payload shape); chunk-level escaping wraps it again.
  broadcastChannels: {
    primary: [{ name: "Más Deportes" }, { name: "ETB" }]
  }
};

// A status the payload never explained: the mapping must NOT claim a state
// for it (a live state is never invented) — the row is skipped.
const UNKNOWN_STATUS_MATCH = {
  id: 105431,
  homeTeam: TEAMS_REF_HOME,
  awayTeam: TEAMS_REF_AWAY,
  startDateTime: isoAt(10),
  matchStatus: "IN_PROGRESS",
  homeScore: 40,
  awayScore: 38
};

function roundObjectJson() {
  return JSON.stringify({
    currentRoundId: 6021, // competition-level: the round object carries it, the events do not
    teams: [TEAM_A, TEAM_B],
    matches: [FINALIZED_MATCH, NOT_STARTED_MATCH, UNKNOWN_STATUS_MATCH]
  });
}

// One JSON-string-style escaping pass (the INVERSE of what the module's
// scanner does to a chunk): turns plain row JSON into the escaped chunk text
// the real page carries (`"` -> `\"`, `\\` -> `\\\\`).
function escapeForChunkText(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    out += ch === "\\" ? "\\\\" : ch === '"' ? "\\\"" : ch;
  }
  return out;
}

// A single self.__next_f.push row wrapping one chunk text.
function pushChunk(chunkText) {
  return `self.__next_f.push([1,${JSON.stringify(chunkText)}]);`;
}

// The round row is split mid-JSON across two pushes (RSC rows span chunks).
// The chunk text is the ESCAPED round JSON — `\"teams\":` / `\"matches\":` —
// exactly the measured reality.
function roundRowPieces() {
  // The \uXXXX escape sits at the ROW-JSON level (one backslash), exactly
  // like a measured payload; escapeForChunkText wraps it once more.
  const row = `3c:${roundObjectJson()}`.replace("Más Deportes", "M\\u00e1s Deportes");
  const escaped = escapeForChunkText(row);
  const cut = escaped.indexOf("\\\"matches\\\"");
  return [escaped.slice(0, cut), escaped.slice(cut)];
}

// A fetch double answering URLs with TEXT bodies (the layer reads .text() —
// the size cap is observable). Entries: { text } | { boom: true }.
function textFetch(byUrl) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const responder = byUrl[String(url)];
    if (!responder) throw new Error(`unexpected url ${url}`);
    if (responder.boom) throw new Error("network down");
    return { ok: true, status: 200, text: async () => responder.text };
  };
  return { impl, calls };
}

// Builds the measured page shape: pushes whose string literal is the
// JS-escaped RSC chunk text.
function acbPageText({ withGarbageChunks = true } = {}) {
  const translationRow = `{"translation":{"teams":"Equipos","matches":"Partidos"}}`;
  const big = "x".repeat(22 * 1024);
  const bigRow = `4d:{"asset":"${big}","note":"a \\"quoted\\" { brace } literal"}`;
  const [roundA, roundB] = roundRowPieces();
  const chunks = [`2:I[1,[],""]`, translationRow, bigRow, roundA, roundB];
  if (withGarbageChunks) {
    // An unterminated string and a dangling escape: malformed chunks are
    // SKIPPED, never thrown.
    chunks.push(`self.__next_f.push([1,"unterminated chunk...`);
    chunks.push(`self.__next_f.push([1,"trailing backslash chunk \\`);
  }
  return chunks.map((c) => pushChunk(c)).join("\n");
}

describe("acb: page URL and cost constants", () => {
  test("the scrape targets the measured round page with the bounded budget", () => {
    assert.equal(ACB_PAGE_URL, "https://acb.com/es/liga/partidos");
    assert.equal(ACB_MAX_BYTES, 1024 * 1024, "a 1 MB body cap");
    assert.equal(ACB_CACHE_TTL_MS, 30 * 60 * 1000, "the round is cached 30 minutes");
    assert.equal(ACB_FAILURE_TTL_MS, 10 * 60 * 1000, "a failure is cached 10 minutes");
  });
});

describe("acb: the RSC parser — both traps, manual scanner, malformed chunks never throw", () => {
  test("the fixture reproduces the measured ESCAPED reality: keys appear as \\\"teams\\\": in the chunk strings", () => {
    const page = acbPageText();
    // The raw page carries the round JSON DOUBLY escaped (measured: the keys
    // literally appear as \\"teams\\\":) — a parser that searches raw chunk
    // text for the plain key finds ZERO occurrences and must fail RED.
    assert.ok(page.includes('\\\\\\\"teams\\\\\\\":'), "the escaped round key is present at page level");
    assert.ok(!page.includes('"teams":[{'), "the plain round key never leaks to page level");
  });

  test("TRAP 1 + TRAP 2: the translation-label teams and the 22 KB literal are ridden through; the round object is found", () => {
    const events = parseAcbRound(acbPageText());
    assert.equal(events.length, 2, "FINALIZED + NOT_STARTED land; the unknown status never does");
    assert.ok(events.every((ev) => ev.id.startsWith("acb:")));
  });

  test("rows split across two self.__next_f.push chunks reassemble", () => {
    // Only the two round halves, nothing else: the row is unusable unless
    // the pushes are concatenated.
    const [a, b] = roundRowPieces();
    const page = [a, b]
      .map((c) => `self.__next_f.push([1,${JSON.stringify(c)}]);`)
      .join("\n");
    const events = parseAcbRound(page);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((ev) => ev.id), ["acb:105429", "acb:105430"]);
  });

  test("malformed chunks (unterminated string, dangling escape) are skipped, never thrown", () => {
    const events = parseAcbRound(acbPageText({ withGarbageChunks: true }));
    assert.equal(events.length, 2, "the valid rows still parse beside the garbage");
    const nonsense = 'self.__next_f.push([1,"\\\\o/ no closing quote and no round object';
    assert.deepEqual(parseAcbRound(nonsense), [], "a page with no round object yields []");
    assert.deepEqual(parseAcbRound(""), []);
    assert.deepEqual(parseAcbRound("<!doctype html><html></html>"), []);
  });

  test("no giant regex is used anywhere in the module source (the 22 KB-literal trap)", () => {
    const source = readFileSync(
      new URL("../js/core/sports/acb.js", import.meta.url),
      "utf8"
    );
    // A regex over the payload is exactly the stack-overflow trap; the
    // module must scan with indexOf/charCode loops instead.
    assert.doesNotMatch(source, /\/(?![/*]).*\/[gimsuy]*\s*\.?(test|exec|match)\(/);
  });
});

describe("acb: the unified event mapping (sides, kickoff, scores, broadcast)", () => {
  test("FINALIZED -> post with its real scores; NOT_STARTED -> pre with NO score", () => {
    const events = parseAcbRound(acbPageText());
    const finished = events.find((ev) => ev.id === "acb:105429");
    const scheduled = events.find((ev) => ev.id === "acb:105430");
    assert.equal(finished.state, "post");
    assert.equal(finished.status, "finished");
    assert.equal(finished.home.score, 100);
    assert.equal(finished.away.score, 99);
    assert.equal(scheduled.state, "pre");
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.home.score, null, "no score is invented for a not-started match");
    assert.equal(scheduled.away.score, null);
  });

  test("sides resolve through the measured $3c:…:data:teams:N refs against the round object's teams array", () => {
    const events = parseAcbRound(acbPageText());
    const finished = events.find((ev) => ev.id === "acb:105429");
    const scheduled = events.find((ev) => ev.id === "acb:105430");
    // The ref index decides the side — NOT the array order of the match.
    assert.equal(finished.home.name, "Real Madrid");
    assert.equal(finished.away.name, "Asisa Joventut");
    assert.equal(scheduled.home.name, "Asisa Joventut", "the away ref of match 2 is teams:1");
    assert.equal(scheduled.away.name, "Real Madrid");
  });

  test("the real team fields map through: fullName, abbreviatedName, primaryColorHex, logo", () => {
    const events = parseAcbRound(acbPageText());
    const finished = events.find((ev) => ev.id === "acb:105429");
    assert.equal(finished.home.abbr, "RMB", "abbreviatedName is the abbr");
    assert.equal(finished.home.color, "#154284", "primaryColorHex is the colour");
    assert.equal(finished.home.logo, TEAM_A.logo, "logo is the logo");
    assert.equal(finished.away.abbr, "JOV");
    assert.equal(finished.away.color, "#2f8e62");
    assert.equal(finished.away.logo, TEAM_B.logo);
  });

  test("kickoff comes from startDateTime; every documented-absent field stays null", () => {
    const events = parseAcbRound(acbPageText());
    const finished = events.find((ev) => ev.id === "acb:105429");
    assert.equal(finished.kickoffMs, Date.parse(FINALIZED_MATCH.startDateTime));
    assert.equal(finished.leagueName, "Liga Endesa");
    assert.equal(finished.venue, null);
    assert.equal(finished.live, false, "a live state is NEVER invented");
    assert.equal(finished.period, 0);
    assert.deepEqual(
      { ...finished.home },
      {
        name: "Real Madrid",
        abbr: "RMB",
        score: 100,
        record: null,
        color: "#154284",
        logo: TEAM_A.logo
      }
    );
    assert.deepEqual(
      { ...finished.away },
      {
        name: "Asisa Joventut",
        abbr: "JOV",
        score: 99,
        record: null,
        color: "#2f8e62",
        logo: TEAM_B.logo
      }
    );
  });

  test("broadcastChannels.primary[].name lands in event.broadcast", () => {
    const events = parseAcbRound(acbPageText());
    const finished = events.find((ev) => ev.id === "acb:105429");
    const scheduled = events.find((ev) => ev.id === "acb:105430");
    assert.deepEqual(finished.broadcast, ["DAZN", "Movistar Plus +"]);
    assert.deepEqual(scheduled.broadcast, ["Más Deportes", "ETB"], "escaped \\uXXXX unescapes");
  });

  test("garbage rows are dropped, never thrown: a broken round object yields []", () => {
    assert.deepEqual(
      parseAcbRound(pushChunk(escapeForChunkText('3d:{"teams":[],"matches":"not an array"}'))),
      []
    );
    assert.deepEqual(
      parseAcbRound(pushChunk(escapeForChunkText('3d:{"teams":"Equipos","matches":[]}'))),
      [],
      "the translation-label shape is not a round"
    );
    assert.deepEqual(
      parseAcbRound(
        pushChunk(
          escapeForChunkText(
            '3d:{"matches":[{ "id":"1","startDateTime":"nope","matchStatus":"FINALIZED"}],"teams":[]}'
          )
        )
      ),
      []
    );
  });
});

describe("acb: local day filtering (the same local-day window as the rest of the screen)", () => {
  test("events land on the requested LOCAL day only", () => {
    const events = parseAcbRound(acbPageText());
    assert.equal(acbEventsForLocalDay(events, { dayKey: "0", now: NOW }).length, 2);
    assert.equal(acbEventsForLocalDay(events, { dayKey: "1", now: NOW }).length, 0);
    assert.equal(acbEventsForLocalDay(events, { dayKey: "-1", now: NOW }).length, 0);
  });
});

describe("acb: the day fetch — bounded budget, 1 MB cap, 30 min cache, failure isolation", () => {
  test("the round page is fetched once and mapped into unified events for the visible local day", async () => {
    clearAcbCache();
    const { impl, calls } = textFetch({ [ACB_PAGE_URL]: { text: acbPageText() } });
    const result = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => NOW });
    assert.deepEqual(calls, [ACB_PAGE_URL], "exactly one request, the measured page");
    assert.deepEqual(result.failedCompetitions, []);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.events.map((ev) => ev.id), ["acb:105429", "acb:105430"]);
  });

  test("the 30 min cache: a warm round is never re-downloaded; after 30 min it revalidates", async () => {
    clearAcbCache();
    const now = { t: NOW };
    const { impl, calls } = textFetch({ [ACB_PAGE_URL]: { text: acbPageText() } });
    await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 1);
    now.t += 10 * 60 * 1000; // +10 min, well inside 30
    const warm = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 1, "a warm cache makes zero requests");
    assert.equal(warm.events.length, 2, "the cached round is re-filtered per day");
    now.t += ACB_CACHE_TTL_MS + 1000; // past 30 min
    await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 2, "after 30 min the page revalidates");
  });

  test("the 1 MB cap: an oversized body is skipped and LOGGED, and the failure is cached 10 min", async () => {
    clearAcbCache();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
      const now = { t: NOW };
      const { impl, calls } = textFetch({
        [ACB_PAGE_URL]: { text: "x".repeat(ACB_MAX_BYTES + 1) }
      });
      const first = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
      assert.deepEqual(first.failedCompetitions, ["acb.com"]);
      assert.equal(first.events.length, 0);
      assert.ok(
        warnings.some((line) => line.includes("acb") && /\d{7,}/.test(line)),
        `the skip is logged with the size: ${JSON.stringify(warnings)}`
      );
      now.t += 60 * 1000;
      await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
      assert.equal(calls.length, 1, "the oversized failure is not retried inside 10 min");
      now.t += ACB_FAILURE_TTL_MS + 1000;
      await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
      assert.equal(calls.length, 2, "after the failure TTL the page is retried");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a failing fetch is isolated: no throw into the caller, failure cached 10 min, later retry lands", async () => {
    clearAcbCache();
    const now = { t: NOW };
    const byUrl = { [ACB_PAGE_URL]: { boom: true } };
    const { impl, calls } = textFetch(byUrl);
    const first = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.deepEqual(first.failedCompetitions, ["acb.com"]);
    assert.equal(first.failed, 1);
    assert.deepEqual(first.events, []);
    now.t += 60 * 1000;
    const second = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.equal(calls.length, 1, "the failure is not retried inside the 10 min TTL");
    assert.deepEqual(second.failedCompetitions, ["acb.com"]);
    now.t += ACB_FAILURE_TTL_MS + 1000;
    byUrl[ACB_PAGE_URL] = { text: acbPageText() };
    const third = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => now.t });
    assert.deepEqual(third.failedCompetitions, []);
    assert.equal(third.events.length, 2, "the recovered page lands");
  });

  test("an unparsable page is a failure, never a throw into the caller", async () => {
    clearAcbCache();
    const { impl } = textFetch({ [ACB_PAGE_URL]: { text: "<html>not the rsc stream</html>" } });
    const result = await acbForDay({ dayKey: "0", fetchImpl: impl, now: () => NOW });
    assert.deepEqual(result.failedCompetitions, ["acb.com"]);
    assert.deepEqual(result.events, []);
  });

  test("no fetch available (node --test arms no default fetch): an honest failure, no network, no throw", async () => {
    clearAcbCache();
    const result = await acbForDay({ dayKey: "0", now: () => NOW });
    assert.deepEqual(result.events, []);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.failedCompetitions, ["acb.com"]);
  });
});

describe("wiring: ACB appends after the EuroLeague rows through the guarded paint path", () => {
  const mountSource = readFileSync(
    new URL("../js/ui/screens/sports/sportsScreenMethods-01-mount-and-load.js", import.meta.url),
    "utf8"
  );

  test("loadSchedule fetches ACB AFTER the EuroLeague source, appending through the same paint path", () => {
    const euro = mountSource.indexOf("euroleagueForDay(");
    const acb = mountSource.indexOf("acbForDay(");
    assert.ok(euro >= 0 && acb > euro, "ACB rides after the EuroLeague rows");
    assert.match(
      mountSource,
      /this\.scheduleEvents\s*=\s*\[\.\.\.this\.scheduleEvents,\s*\.\.\.acb\.events\]/,
      "the append reuses the scheduleEvents paint path"
    );
  });

  test("the ACB load is guarded by canPaint() and its failure is one muted line inside the try", () => {
    const acbIdx = mountSource.indexOf("acbForDay(");
    assert.ok(acbIdx > 0);
    const start = mountSource.lastIndexOf("try {", acbIdx);
    const catchIdx = mountSource.indexOf("} catch", acbIdx);
    assert.ok(start >= 0 && start < acbIdx && catchIdx > acbIdx, "the ACB load is inside a try");
    const guarded = mountSource.slice(acbIdx, catchIdx).includes("canPaint()");
    assert.ok(guarded, "the ACB append is guarded by canPaint()");
    assert.match(mountSource.slice(catchIdx, catchIdx + 300), /renderSecondaryNotice/);
    assert.doesNotMatch(mountSource, /setInterval/);
  });
});
