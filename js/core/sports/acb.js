// Liga Endesa (ACB): the FOURTH schedule source for the Sports screen — the
// Spanish league ESPN does not cover, scraped from the official round page.
// Measured (owner-verified): `https://acb.com/es/liga/partidos` answers 200
// with a ~440 KB body and NO CORS headers — but the packaged Tizen widget
// declares `<access origin="*"/>` and its engine bypasses CORS (measured: a
// preflighted POST to a CORS-less host returned a readable 200), and Android
// used OkHttp, which also ignores CORS. So the scrape is viable; the cost is
// the parse.
//
// HOW THE PAGE IS SHAPED (measured against the live page, owner-verified):
// it is a Next.js App Router RSC stream — no `__NEXT_DATA__`, rows like
// `self.__next_f.push([1,"…"])` whose string literal holds RSC rows like
// `<hex id>:<json>`. Rows SPLIT across pushes, so the chunks are
// concatenated before parsing. THREE measured traps:
//   TRAP 0 (the escaping trap): the round JSON is EMBEDDED ESCAPED inside
//     the chunk strings — after the JS string literal is read, the chunk
//     text still holds `\"teams\":` / `\"matches\":`, never the plain keys.
//     Searching raw chunk text for `"teams":` finds ZERO occurrences (this
//     is exactly why the first implementation failed every real request),
//     so EVERY collected chunk is unescaped once (standard JSON string
//     escapes) before any key is searched.
//   TRAP 1: after unescaping, the first `"teams":` in the payload is a
//     translation label ("teams":"Equipos"). The parser finds, with bounded
//     scans, the ONE object carrying BOTH `teams` AND `matches`, then
//     resolves refs like `$3c:props:…:data:teams:N` (measured prefix `$3c:`,
//     NOT `$3d:`) against that object's `teams` array.
//   TRAP 2: extracting a ~22 KB string literal with a regex blows the native
//     regex engine's stack. The parser NEVER runs a regex over the payload —
//     every literal is read with a manual quote scanner (indexOf loops +
//     escape handling), and this module's source contains no regex at all.
//
// Fields (measured): team `fullName`/`shortName`, `abbreviatedName`,
// `primaryColorHex`, `textColorHex`, `logo`; match `id`, `homeTeam`/`awayTeam`
// (the `$3c:…:teams:N` refs), `homeScore`/`awayScore`, `startDateTime` (UTC),
// `matchStatus`, `currentQuarter` (6 = overtime),
// `broadcastChannels.primary[].name`.
// Statuses observed: `NOT_STARTED`, `FINALIZED`. `currentRoundId` belongs to
// the competition, not the page; the round comes from `?jornada=<id>` and
// with no query the page IS the current round.
//
// What this source does NOT have: a live state signal we trust (only the two
// statuses above were observed) and a venue field. The mapping is honest
// about every one of those — a state is NEVER claimed that the payload does
// not state, and an unobserved status row is dropped rather than mislabeled.
//
// COST CONTRACT (owner TV: 1 GB class, 120 MB app cap):
//   - ONE request per round (the current page), bounded by the SAME
//     per-request budget the ESPN round uses (ESPN_REQUEST_TIMEOUT_MS),
//   - a body above 1 MB is skipped and logged with its size,
//   - the parsed round is cached for 30 minutes (fixtures move slowly; the
//     visible day is re-filtered out of the cached list on every call),
//   - a FAILED or unparsable page is remembered for 10 minutes so the
//     screen's 60 s rounds never become a retry loop,
//   - failure isolation: a failing ACB never touches the other sources — the
//     screen paints at most one muted line, and this module never throws.
import { normalizeNow } from "./espnScores.js";

// ACB is one HTML page of ~440 KB served between 1.1 s and 7.2 s (measured three
// times) and it is fetched once per 30 minutes, so it gets its own budget instead
// of the ESPN round's 2500 ms, which failed intermittently in practice.
export const ACB_REQUEST_TIMEOUT_MS = 10000;

const DAY_MS = 24 * 60 * 60 * 1000;

export const ACB_PAGE_URL = "https://acb.com/es/liga/partidos";

// The muted-line label the screen shows when this source fails.
export const ACB_SOURCE_LABEL = "acb.com";

// A body above 1 MB is skipped (and logged with its size): the measured page
// is ~440 KB, so anything double that is a runaway response, not the round.
export const ACB_MAX_BYTES = 1024 * 1024;

// The round's fixtures barely change and scores only flip once: the parsed
// round is revalidated at most once every 30 minutes.
export const ACB_CACHE_TTL_MS = 30 * 60 * 1000;

// A failed/down source is remembered for 10 minutes: the screen's 60 s
// rounds must not become a retry loop, but one blip should not silence the
// source for the full 30 min window.
export const ACB_FAILURE_TTL_MS = 10 * 60 * 1000;

// Bounded-scan guards (TRAP 1's "depth-limited object"): at most 64
// `"teams":` candidates are inspected and a round object larger than 512 KB
// is not trusted.
const MAX_TEAM_CANDIDATES = 64;
const MAX_ROUND_OBJECT_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Manual quote scanner. NO REGEX ANYWHERE IN THIS FILE: extracting a 22 KB
// literal with a regex blows the native TV engine's stack (TRAP 2).
// ---------------------------------------------------------------------------

// One JSON-string-style unescape pass over a chunk's text (TRAP 0): the real
// page embeds its round JSON ESCAPED inside the chunk strings — the chunk
// text holds `\"teams\":` — so every collected chunk is unescaped exactly
// ONCE here before any key is searched. Handles the standard escapes: `\"`,
// `\\`, `\/`, `\n`, `\t`, `\r`, `\b`, `\f`, `\uXXXX`. An unknown escape
// keeps its backslash + char verbatim (no invention); a lone trailing
// backslash is kept too. Never throws.
function unescapeChunkText(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      out += ch; // lone trailing backslash: kept verbatim
      i += 1;
      continue;
    }
    if (next === "u") {
      // 4 hex digits, verified by charCode (NO regex in this file — TRAP 2).
      let hexOk = i + 6 <= text.length;
      for (let h = 0; hexOk && h < 4; h += 1) {
        const c = text.charCodeAt(i + 2 + h);
        const digit = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
        if (!digit) hexOk = false;
      }
      if (hexOk) {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      out += ch; // malformed \u: kept verbatim, never thrown
      i += 1;
      continue;
    }
    if (next === "n" || next === "t" || next === "r" || next === "b" || next === "f") {
      out +=
        next === "n"
          ? "\n"
          : next === "t"
            ? "\t"
            : next === "r"
              ? "\r"
              : next === "b"
                ? "\b"
                : "\f";
      i += 2;
      continue;
    }
    if (next === '"' || next === "\\" || next === "/") {
      out += next; // \" -> ", \\ -> \, \/ -> /
      i += 2;
      continue;
    }
    out += ch; // unknown escape: keep the backslash, reprocess the char
    i += 1;
  }
  return out;
}

// Reads one JS string literal starting at the opening quote. Returns
// { value, endIndex } (endIndex = index AFTER the closing quote), or null
// when the literal is malformed (unterminated, dangling escape) — callers
// SKIP malformed chunks, never throw.
function readStringLiteral(text, openQuoteIdx) {
  let out = "";
  let i = openQuoteIdx + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return { value: out, endIndex: i + 1 };
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) return null; // dangling backslash: malformed
      i += 2;
      if (next === "u") {
        // 4 hex digits, verified by charCode (NO regex in this file — TRAP 2).
        let hexOk = i + 4 <= text.length;
        for (let h = 0; hexOk && h < 4; h += 1) {
          const c = text.charCodeAt(i + h);
          const digit = (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
          if (!digit) hexOk = false;
        }
        if (!hexOk) return null; // malformed escape
        out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
        i += 4;
        continue;
      }
      out +=
        next === "n"
          ? "\n"
          : next === "t"
            ? "\t"
            : next === "r"
              ? "\r"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next; // \" \\ \/ and unknown escapes keep the char itself
      continue;
    }
    out += ch;
    i += 1;
  }
  return null; // unterminated literal: malformed chunk
}

// Collects the RSC chunk texts from every `self.__next_f.push([1,"…"])`,
// concatenating them in page order (RSC rows split across pushes). A
// malformed chunk is skipped, never thrown.
function collectChunkText(html) {
  const MARK = "self.__next_f.push(";
  let parts = "";
  let from = 0;
  while (true) {
    const pushIdx = html.indexOf(MARK, from);
    if (pushIdx < 0) break;
    from = pushIdx + MARK.length;
    // The payload shape is [1,"…"]: find the first string literal after the
    // opening bracket (the chars between — "[1," — hold no quotes).
    const openQuote = html.indexOf('"', from);
    if (openQuote < 0) break;
    const literal = readStringLiteral(html, openQuote);
    if (!literal) continue; // malformed chunk: skipped
    parts += unescapeChunkText(literal.value);
    from = literal.endIndex;
  }
  return parts;
}

// Forward scan: the index of the `}` matching the `{` at `start` (a string-
// aware brace walk), or -1 when unbalanced.
function matchObjectEnd(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const literal = readStringLiteral(text, i);
      if (!literal) return -1; // unbalanced string: not an object we can trust
      i = literal.endIndex;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

// Backward scan: the index of the `{` that opens the object containing
// `keyIdx` (a string-aware brace walk, skipping string literals backwards).
function findEnclosingObjectStart(text, keyIdx) {
  let depth = 0;
  let i = keyIdx - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '"') {
      // Walk back to the literal's OPENING quote: a closing quote preceded
      // by an even number of backslashes is a real string boundary.
      let j = i - 1;
      let opened = -1;
      while (j >= 0) {
        if (text[j] === '"') {
          let backslashes = 0;
          let k = j - 1;
          while (k >= 0 && text[k] === "\\") {
            backslashes += 1;
            k -= 1;
          }
          if (backslashes % 2 === 0) {
            opened = j;
            break;
          }
          j = k;
          continue;
        }
        j -= 1;
      }
      if (opened < 0) return -1; // unterminated string: not trustable
      i = opened;
      i -= 1;
      continue;
    }
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
    i -= 1;
  }
  return -1;
}

// TRAP 1: finds the ONE round object carrying BOTH `teams` (array) and
// `matches` (array). The first `"teams":` in the payload is a translation
// label ("teams":"Equipos"), so every occurrence is checked: the object must
// parse with both keys as arrays. Scans are bounded (MAX_TEAM_CANDIDATES
// occurrences, MAX_ROUND_OBJECT_BYTES per object). Returns the parsed object
// or null.
function findRoundObject(stream) {
  let from = 0;
  for (let n = 0; n < MAX_TEAM_CANDIDATES; n += 1) {
    const idx = stream.indexOf('"teams"', from);
    if (idx < 0) return null;
    from = idx + 7;
    // Cheap reject before any brace walk: the round's `teams` is an ARRAY.
    let k = stream.indexOf(":", idx);
    k += 1;
    while (k < stream.length && (stream[k] === " " || stream[k] === "\n" || stream[k] === "\t"))
      k += 1;
    if (stream[k] !== "[") continue;
    const start = findEnclosingObjectStart(stream, idx);
    if (start < 0) continue;
    const end = matchObjectEnd(stream, start);
    if (end < 0 || end - start > MAX_ROUND_OBJECT_BYTES) continue;
    try {
      const obj = JSON.parse(stream.slice(start, end + 1));
      if (Array.isArray(obj?.teams) && Array.isArray(obj?.matches)) return obj;
    } catch (_) {
      // Not the round object (or a torn row): try the next candidate.
    }
  }
  return null;
}

// `$3c:props:…:data:teams:N` -> the round object's teams[N] (the measured
// prefix is `$3c:`, NOT `$3d:`; any `<hex>:…:teams:N` shape resolves). A
// non-ref value (or a numeric index already) resolves directly when it is a
// plain number.
function resolveTeamRef(value, teams) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value < teams.length ? teams[value] : null;
  }
  const ref = String(value).trim();
  if (ref[0] !== "$") return null;
  const lastColon = ref.lastIndexOf(":");
  if (lastColon < 0) return null;
  if (!ref.slice(0, lastColon).endsWith(":teams")) return null;
  const idx = Number(ref.slice(lastColon + 1));
  if (!Number.isInteger(idx) || idx < 0 || idx >= teams.length) return null;
  return teams[idx] ?? null;
}

// One round side, from the MEASURED team fields: `fullName` (fallback
// `shortName`) is the name, `abbreviatedName` the abbr, `primaryColorHex` the
// colour, `logo` the logo. Score and record are NOT side-level fields (the
// score is filled below ONLY for a FINALIZED match, from match-level fields).
function parseSide(team) {
  if (!team || typeof team !== "object") return null;
  const name = String(team.fullName ?? team.shortName ?? "").trim();
  if (!name) return null;
  const abbr = String(team.abbreviatedName ?? "").trim();
  const color = String(team.primaryColorHex ?? "").trim();
  const logo = String(team.logo ?? "").trim();
  return { name, abbr, score: null, record: null, color: color || null, logo: logo || null };
}

// The final score of one side: the match-level `homeScore`/`awayScore` first,
// then the team object's own `score`/`points` — the first finite number
// wins; absent or garbage degrades to null (a score is NEVER invented).
function sideScore(match, sideKey, team) {
  const candidates = [match?.[`${sideKey}Score`], team?.score, team?.points];
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

// Broadcast channel names for the card footer's extra muted item (the way
// the native app shows them): `broadcastChannels.primary[].name`, plus the
// secondary list when present. Absent -> [].
function broadcastNames(match) {
  const names = [];
  const groups = [match?.broadcastChannels?.primary, match?.broadcastChannels?.secondary];
  for (const group of groups) {
    for (const entry of Array.isArray(group) ? group : []) {
      const name = String(entry?.name ?? "").trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

// One ACB match -> the unified event shape the screen renders. Garbage rows
// are dropped, never thrown. States: FINALIZED -> post with final scores,
// NOT_STARTED -> pre with NO score; any OTHER status is DROPPED — a live
// state is never claimed that the payload does not state.
function matchToEvent(match, teams) {
  if (!match || typeof match !== "object") return null;
  const matchId = String(match.matchId ?? match.id ?? "").trim();
  if (!matchId) return null; // no stable id can be built
  const kickoffMs = Date.parse(String(match.startDateTime ?? "").trim());
  if (!Number.isFinite(kickoffMs)) return null; // never day-filterable
  const status = String(match.matchStatus ?? "")
    .trim()
    .toUpperCase();
  if (status !== "FINALIZED" && status !== "NOT_STARTED") return null;
  const matchTeams = match.teams && typeof match.teams === "object" ? match.teams : {};
  // Sides come from the MEASURED match-level `homeTeam`/`awayTeam` refs
  // resolved against the round's teams array — NEVER from array order alone.
  // (The nested `teams:{home,away}` shape is kept as a fallback.)
  const homeTeam =
    resolveTeamRef(match.homeTeam, teams) ??
    resolveTeamRef(matchTeams.home, teams) ??
    resolveTeamRef(matchTeams.local, teams);
  const awayTeam =
    resolveTeamRef(match.awayTeam, teams) ??
    resolveTeamRef(matchTeams.away, teams) ??
    resolveTeamRef(matchTeams.road, teams) ??
    resolveTeamRef(matchTeams.visitor, teams);
  const home = parseSide(homeTeam);
  const away = parseSide(awayTeam);
  if (!home || !away) return null;
  const finished = status === "FINALIZED";
  if (finished) {
    home.score = sideScore(match, "home", homeTeam);
    away.score = sideScore(match, "away", awayTeam);
  }
  return {
    id: `acb:${matchId}`,
    slug: "acb",
    sportType: "basketball",
    leagueName: "Liga Endesa",
    leagueAbbr: "ACB",
    leagueLogo: "",
    // The scrape carries no venue field: null, like the other score-less source.
    venue: null,
    state: finished ? "post" : "pre",
    // Derived partition fields so buildSections consumes the event unchanged
    // (this source can never land in the EN VIVO section).
    status: finished ? "finished" : "scheduled",
    live: false,
    statusText: "",
    // currentQuarter (6 = overtime) is an in-game signal; with no trusted
    // live state claimed, the period stays 0 like the other non-live sources.
    period: 0,
    clock: "",
    situation: "",
    kickoffMs,
    // Broadcast channel names surfaced for the card footer's extra muted
    // item (the way the native app shows them). [] when absent.
    broadcast: broadcastNames(match),
    home,
    away
  };
}

// Pure: the measured page text -> the unified events of the round. Malformed
// chunks are skipped by the scanner; a page with no round object yields [].
export function parseAcbRound(pageText) {
  const stream = collectChunkText(String(pageText ?? ""));
  if (!stream) return [];
  const round = findRoundObject(stream);
  if (!round) return [];
  const events = [];
  for (const match of round.matches) {
    const parsed = matchToEvent(match, round.teams);
    if (parsed) events.push(parsed);
  }
  return events;
}

// Pure day filter: keep the events whose kickoff falls on the REQUESTED LOCAL
// DAY (the device's timezone — the same Ayer/Hoy/Mañana bucketing the rest of
// the screen uses). Like the EuroLeague source there is NO grace window: a
// finished game carries a real final score and must render (FINALIZADOS) on
// its own day.
function dayKeyOffset(dayKey) {
  if (dayKey === "yesterday") return -1;
  if (dayKey === "tomorrow") return 1;
  const num = Number(dayKey);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

export function acbEventsForLocalDay(events, { dayKey = "0", now } = {}) {
  const nowTs = normalizeNow(now);
  const base = new Date(nowTs + dayKeyOffset(dayKey) * DAY_MS);
  const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
  const dayEnd = dayStart + DAY_MS;
  return (Array.isArray(events) ? events : []).filter((event) => {
    const kickoff = Number(event?.kickoffMs);
    return Number.isFinite(kickoff) && kickoff > 0 && kickoff >= dayStart && kickoff < dayEnd;
  });
}

// Round cache: { expiresAt, failed, events }. A success lives 30 min; a
// failure (network, oversize, unparsable) lives the shorter failure TTL.
const roundCache = new Map();
const CACHE_KEY = "current";

export function clearAcbCache() {
  roundCache.clear();
}

// UTF-8 byte length of a text body (the guard is a BYTE budget, not chars).
function byteLength(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length; // very old TV without TextEncoder: chars ≈ bytes fallback
}

// One bounded text fetch: the verdict (fetch AND body read) races the
// per-request timer — the SAME budget the ESPN round uses. No retries.
async function fetchTextBounded(fetchFn, url, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchFn(url, {});
        if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
        return await response.text();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout after ${timeoutMs}ms`)),
          Math.max(1, timeoutMs)
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failureResult(nowTs) {
  roundCache.set(CACHE_KEY, {
    expiresAt: nowTs + ACB_FAILURE_TTL_MS,
    failed: true,
    events: []
  });
  return { events: [], failed: 1, failedCompetitions: [ACB_SOURCE_LABEL] };
}

// One day round for the fourth source: the current round page, bounded by the
// ESPN per-request budget, cached 30 min (success) / 10 min (failure), size-
// guarded at 1 MB, filtered to the requested local day. NEVER throws: a
// failing ACB is reported in `failedCompetitions` and the other sources stay
// untouched (failure isolation).
// Returns { events, failed, failedCompetitions }.
export async function acbForDay({ dayKey = "0", fetchImpl = null, now, force = false } = {}) {
  const nowTs = normalizeNow(now);
  const nowFn = () => normalizeNow(now);
  const fetchFn =
    fetchImpl ||
    (typeof window !== "undefined" && typeof fetch === "function" ? fetch.bind(globalThis) : null);

  const cached = force ? null : roundCache.get(CACHE_KEY);
  if (cached && cached.expiresAt > nowTs) {
    if (cached.failed) {
      return { events: [], failed: 1, failedCompetitions: [ACB_SOURCE_LABEL] };
    }
    return {
      events: acbEventsForLocalDay(cached.events, { dayKey, now: nowTs }),
      failed: 0,
      failedCompetitions: []
    };
  }
  if (!fetchFn) {
    // No fetch available (node --test arms no default fetch): an honest
    // failure count, no network, no throw.
    return { events: [], failed: 1, failedCompetitions: [ACB_SOURCE_LABEL] };
  }
  try {
    const text = await fetchTextBounded(fetchFn, ACB_PAGE_URL, ACB_REQUEST_TIMEOUT_MS);
    const bytes = byteLength(text);
    if (bytes > ACB_MAX_BYTES) {
      // Runaway-response guard: skip it and say the size.
      console.warn(`acb: page skipped (${bytes} bytes > ${ACB_MAX_BYTES} limit)`);
      return failureResult(nowFn());
    }
    const parsed = parseAcbRound(text);
    if (!parsed.length) {
      // No round object found: an unparsable page, not an empty day.
      return failureResult(nowFn());
    }
    roundCache.set(CACHE_KEY, {
      expiresAt: nowFn() + ACB_CACHE_TTL_MS,
      failed: false,
      events: parsed
    });
    return {
      events: acbEventsForLocalDay(parsed, { dayKey, now: nowFn() }),
      failed: 0,
      failedCompetitions: []
    };
  } catch (_) {
    // Failed source: remembered briefly (no retry loop), never a throw.
    return failureResult(nowFn());
  }
}
