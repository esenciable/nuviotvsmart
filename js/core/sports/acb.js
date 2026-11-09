// Liga Endesa (ACB): the FOURTH schedule source for the Sports screen — the
// Spanish league ESPN does not cover, straight from the official JSON API that
// acb.com's own site calls.
//
// Measured (owner-verified):
//   GET https://api2.acb.com/api/seasondata/Competition/matches
//       ?competitionId=1&isRoundSelected=true[&roundId=<id>]
//     headers: accept: application/json, x-apikey: <ACB_API_KEY>
//   -> 200 `application/json` (~26 KB) with `access-control-allow-origin: *`
//   and a preflight that allows `x-apikey`, so the TV can call it DIRECTLY:
//   no proxy, no CORS workaround, no Tizen widget trick. Without the header it
//   answers 401. `&roundId=<id>` switches round (`availableFilters.rounds[]` =
//   `{id, roundNumber, …}`, 6015..6048 = jornadas 1..34; the current one is
//   `selectedFilters.round`). `&round=` is SILENTLY IGNORED (200, current
//   round), so it is never sent.
//
// FOUR measured traps this mapping respects:
//   TRAP 1: `broadcastChannels` is a FLAT array of
//     `{broadcaster, imageLink, link, primary, order}` — NOT the
//     `{primary[], secondary[]}` object the old RSC payload carried. The old
//     mapping read the object shape and therefore dropped every channel in
//     silence. Here: keep `primary === true` and order by `order`.
//   TRAP 2: `matchStatus` measured over 144 matches of 16 rounds was only
//     `FINALIZED` (63), `NOT_STARTED` (72) and `NOT_SCHEDULED` (9). NO
//     in-progress value was ever observed, so none is invented: a row with any
//     other status is DROPPED rather than labelled live.
//   TRAP 3: `currentQuarter` (6 = overtime) is the period — it is NOT
//     hard-coded to 0 any more.
//   TRAP 4: `homeTeamId`/`awayTeamId` reference `teams[].id` by number
//     lookup, so the sides never come from array order.
//
// What this source does NOT have: a live state signal we trust, a venue field
// and team records. The mapping is honest about each of those: `live` is never
// true, `venue`/`record` are null, and a score is only rendered for a
// FINALIZED match.
//
// COST CONTRACT (owner TV: 1 GB class, 120 MB app cap):
//   - ONE request per round, bounded by the shared ESPN per-request budget
//     (ESPN_REQUEST_TIMEOUT_MS) through the shared `fetchJsonBounded`,
//   - the parsed round is cached per ROUND for 30 minutes (fixtures move
//     slowly; the visible day is re-filtered out of the cached list on every
//     call),
//   - a FAILED round is NEVER cached: the next load retries it, exactly like
//     the EuroLeague source (no retry loop is possible anyway — the screen
//     loads on demand, not on a timer),
//   - failure isolation: a failing ACB never touches the other sources — the
//     screen paints at most one muted line, and this module never throws.
import { ESPN_REQUEST_TIMEOUT_MS, fetchJsonBounded, normalizeNow } from "./espnScores.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const ACB_API_URL = "https://api2.acb.com/api/seasondata/Competition/matches";

// The published endpoint is per competition and competitionId 1 is Liga Endesa.
export const ACB_COMPETITION_ID = 1;

// The API key is PUBLIC — it is declared literally in acb.com's own
// `/_next/static/chunks/*.js` bundle — and REVOCABLE: if acb.com rotates it,
// this single constant is the only place to update.
export const ACB_API_KEY = "0dd94928-6f57-4c08-a3bd-b1b2f092976e";

// The muted-line label the screen shows when this source fails.
export const ACB_SOURCE_LABEL = "acb.com";

// The round's fixtures barely change and scores only flip once: the parsed
// round is revalidated at most once every 30 minutes.
export const ACB_CACHE_TTL_MS = 30 * 60 * 1000;

// A positive integer id (a round id or a team id), or null when the value is
// not usable: for a round the API then resolves the CURRENT round itself.
// Guards the query string and every id lookup against garbage.
function positiveIntId(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

// Pure: the measured request URL. No `roundId` asks for the current round;
// `&round=` is never emitted (the API answers 200 and ignores it).
export function acbMatchesUrl(roundId) {
  const base = `${ACB_API_URL}?competitionId=${ACB_COMPETITION_ID}&isRoundSelected=true`;
  const id = positiveIntId(roundId);
  return id == null ? base : `${base}&roundId=${id}`;
}

// Pure: the measured request headers (the key is mandatory: no key -> 401).
// A fresh object per request so a transport can never mutate the contract.
export function acbRequestHeaders() {
  return { accept: "application/json", "x-apikey": ACB_API_KEY };
}

// The round the payload actually answered for (`selectedFilters.round`), or
// null when the payload does not say.
function payloadRoundId(payload) {
  return positiveIntId(payload?.selectedFilters?.round);
}

// The payload's `teams[]` indexed by `id` (TRAP 4: matches reference teams by
// number, never by position).
function teamsIndex(teams) {
  const map = new Map();
  for (const team of Array.isArray(teams) ? teams : []) {
    const id = positiveIntId(team?.id);
    if (id != null) map.set(id, team);
  }
  return map;
}

function teamById(index, id) {
  const key = positiveIntId(id);
  return key == null ? null : (index.get(key) ?? null);
}

// One payload team -> the unified side object: `fullName` (fallback
// `shortName`) is the name, `abbreviatedName` the abbr, `primaryColorHex` the
// colour, `logo` the logo. No record exists in this source: honest null. The
// score stays null here and is filled below ONLY for a FINALIZED match.
function parseSide(team) {
  if (!team || typeof team !== "object") return null;
  const name = String(team.fullName ?? team.shortName ?? "").trim();
  if (!name) return null;
  return {
    name,
    abbr: String(team.abbreviatedName ?? "").trim(),
    score: null,
    record: null,
    color: String(team.primaryColorHex ?? "").trim() || null,
    logo: String(team.logo ?? "").trim() || null
  };
}

// The final score of one side: the match-level `homeScore`/`awayScore` — the
// first finite number wins; absent or garbage degrades to null (a score is
// NEVER invented).
function finalScore(match, key) {
  const num = Number(match?.[key]);
  return Number.isFinite(num) ? num : null;
}

// TRAP 1: `broadcastChannels` is a FLAT array. Keep the `primary === true`
// rows in `order` sequence (array position only breaks a tie), take
// `broadcaster`, dedupe. Absent -> [].
function broadcastNames(match) {
  const rows = Array.isArray(match?.broadcastChannels) ? match.broadcastChannels : [];
  const ordered = rows
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => entry?.primary === true)
    .sort((a, b) => {
      const left = Number.isFinite(Number(a.entry?.order)) ? Number(a.entry.order) : Infinity;
      const right = Number.isFinite(Number(b.entry?.order)) ? Number(b.entry.order) : Infinity;
      return left - right || a.position - b.position;
    });
  const names = [];
  for (const { entry } of ordered) {
    const name = String(entry?.broadcaster ?? "").trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// The two measured playable statuses of an unplayed match. Any OTHER status
// (TRAP 2: no live value was ever observed) is dropped, never labelled.
const SCHEDULED_STATUSES = ["NOT_STARTED", "NOT_SCHEDULED"];

// One ACB match -> the unified event shape the screen renders. Garbage rows
// are dropped, never thrown. States: FINALIZED -> post with final scores,
// NOT_STARTED / NOT_SCHEDULED -> pre with NO score; any OTHER status is
// DROPPED — a live state is never claimed that the payload does not state.
function matchToEvent(match, teams) {
  if (!match || typeof match !== "object") return null;
  const matchId = String(match.id ?? "").trim();
  if (!matchId) return null; // no stable id can be built
  const kickoffMs = Date.parse(String(match.startDateTime ?? "").trim());
  if (!Number.isFinite(kickoffMs)) return null; // never day-filterable
  const status = String(match.matchStatus ?? "")
    .trim()
    .toUpperCase();
  const finished = status === "FINALIZED";
  if (!finished && !SCHEDULED_STATUSES.includes(status)) return null;
  // Sides come from the measured `homeTeamId`/`awayTeamId` ids resolved
  // against the round's `teams[]` — NEVER from array order (TRAP 4).
  const home = parseSide(teamById(teams, match.homeTeamId));
  const away = parseSide(teamById(teams, match.awayTeamId));
  if (!home || !away) return null;
  if (finished) {
    home.score = finalScore(match, "homeScore");
    away.score = finalScore(match, "awayScore");
  }
  // TRAP 3: the period is the payload's `currentQuarter` (6 = overtime), not a
  // hard-coded 0. An absent/garbage quarter degrades to 0.
  const quarter = Number(match.currentQuarter);
  return {
    id: `acb:${matchId}`,
    slug: "acb",
    sportType: "basketball",
    leagueName: "Liga Endesa",
    leagueAbbr: "ACB",
    leagueLogo: "",
    // The API carries no venue field: null, like the other score-less source.
    venue: null,
    state: finished ? "post" : "pre",
    // Derived partition fields so buildSections consumes the event unchanged
    // (this source can never land in the EN VIVO section).
    status: finished ? "finished" : "scheduled",
    live: false,
    statusText: "",
    period: Number.isFinite(quarter) ? quarter : 0,
    clock: "",
    situation: "",
    kickoffMs,
    // S1 asks for "las cadenas de TV cuando la fuente las publica": the card
    // renderer does not paint it yet, but the API is the only place the
    // channels exist, so the unified event keeps carrying them (in the same
    // field the source has always used) instead of dropping a stated property.
    broadcast: broadcastNames(match),
    home,
    away
  };
}

// Pure: the measured payload -> the unified events of the round. Malformed
// rows are skipped; a payload without a `matches` array yields [].
export function parseAcbMatches(payload) {
  const rows = Array.isArray(payload?.matches) ? payload.matches : [];
  const teams = teamsIndex(payload?.teams);
  const events = [];
  for (const row of rows) {
    const parsed = matchToEvent(row, teams);
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

// Round cache, keyed by ROUND (`round:<id>`, never a single "current" entry so
// one jornada can never be served in place of another): { expiresAt, events }.
// A failed round is NEVER stored — the next load retries it, like EuroLeague.
const roundCache = new Map();

// The round the last successful payload reported; it makes the current-round
// request (no `roundId`) hit its own per-round entry on the next load.
let currentRoundId = null;

export function clearAcbCache() {
  roundCache.clear();
  currentRoundId = null;
}

function cacheKeyFor(roundId) {
  const id = positiveIntId(roundId == null ? currentRoundId : roundId);
  return id == null ? null : `round:${id}`;
}

function failureResult() {
  return { events: [], failed: 1, failedCompetitions: [ACB_SOURCE_LABEL] };
}

// One day round for the fourth source: the current round (or an explicit
// `roundId`), fetched once through the shared bounded JSON helper, cached per
// round for 30 minutes, filtered to the requested local day. NEVER throws: a
// failing ACB is reported in `failedCompetitions` and the other sources stay
// untouched (failure isolation). Returns { events, failed, failedCompetitions }.
export async function acbForDay({
  dayKey = "0",
  fetchImpl = null,
  now,
  force = false,
  roundId = null
} = {}) {
  const nowTs = normalizeNow(now);
  const nowFn = () => normalizeNow(now);
  const fetchFn =
    fetchImpl ||
    (typeof window !== "undefined" && typeof fetch === "function" ? fetch.bind(globalThis) : null);

  const key = cacheKeyFor(roundId);
  const cached = force || key == null ? null : roundCache.get(key);
  if (cached && cached.expiresAt > nowTs) {
    return {
      events: acbEventsForLocalDay(cached.events, { dayKey, now: nowTs }),
      failed: 0,
      failedCompetitions: []
    };
  }
  if (!fetchFn) {
    // No fetch available (node --test arms no default fetch): an honest
    // failure count, no network, no throw.
    return failureResult();
  }
  try {
    // `fetchJsonBounded` owns the timeout race and the body read (status
    // verdict included); it takes no init, so the mandatory `x-apikey` header
    // rides in through this thin transport shim.
    const withKey = (url, init) => fetchFn(url, { ...(init ?? {}), headers: acbRequestHeaders() });
    const payload = await fetchJsonBounded(
      withKey,
      acbMatchesUrl(roundId),
      ESPN_REQUEST_TIMEOUT_MS
    );
    const parsed = parseAcbMatches(payload);
    if (!parsed.length) {
      // No usable match: an unparsable/empty read, not an empty day (a real
      // round always carries matches). Not cached.
      return failureResult();
    }
    const reported = payloadRoundId(payload) ?? positiveIntId(roundId);
    if (reported != null) currentRoundId = reported;
    const storeKey = cacheKeyFor(reported) ?? key;
    if (storeKey) {
      roundCache.set(storeKey, { expiresAt: nowFn() + ACB_CACHE_TTL_MS, events: parsed });
    }
    return {
      events: acbEventsForLocalDay(parsed, { dayKey, now: nowFn() }),
      failed: 0,
      failedCompetitions: []
    };
  } catch (_) {
    // Failed source: NOT cached, never a throw into the caller.
    return failureResult();
  }
}
