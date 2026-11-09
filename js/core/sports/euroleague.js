// EuroLeague + EuroCup: the THIRD schedule source for the Sports screen — the
// two European competitions ESPN does not cover, straight from the official
// no-key API. Measured with curl (owner-verified):
//   GET https://api-live.euroleague.net/v2/competitions/{E|U}/seasons/{C<year>}/games
//     -> 200, `access-control-allow-origin: *` (the TV can call it directly),
//     ~380 games per season. Fields: identifier, gameCode, round, played,
//     utcDate, local{club{code,name,abbreviatedName,images.crest},score,partials},
//     road{...}. Competition E = EuroLeague, U = EuroCup.
//
// What this source does NOT have: a live state (there is no in-progress
// signal — `played` is the ONLY finished flag), team colours, records and a
// venue field. The mapping is honest about every one of those:
//   - played === true  -> state "post" / status "finished" with final scores,
//   - otherwise        -> state "pre"  / status "scheduled" with NO score
//     (a payload 0 on an unplayed game is never rendered),
//   - a game IN PROGRESS therefore stays "pre" with its kickoff time — a live
//     state is NEVER invented.
//
// COST CONTRACT (owner TV: 1 GB class, 120 MB app cap):
//   - ONE request per competition|season (2 today), each bounded by the SAME
//     per-request budget the ESPN round uses (ESPN_REQUEST_TIMEOUT_MS) and
//     inside the 6-wide burst width,
//   - the SEASON payload is cached per competition|season for 30 minutes: a
//     season's fixture list moves slowly, scores change only when `played`
//     flips, and the visible day is filtered out of the cached list on every
//   - a FAILED competition is never cached: the screen's next round retries
//     it, and the other competition is untouched (failure isolation).
import { ESPN_REQUEST_TIMEOUT_MS, fetchJsonBounded, normalizeNow } from "./espnScores.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const EUROLEAGUE_BASE_URL = "https://api-live.euroleague.net/v2/competitions";

// Exactly the two measured competitions, with the display name the card shows.
export const EUROLEAGUE_COMPETITIONS = [
  { code: "E", label: "EuroLeague" },
  { code: "U", label: "EuroCup" }
];

// A season's fixtures barely change and scores only flip once (`played`), so
// the season list is revalidated at most once every 30 minutes.
export const EUROLEAGUE_CACHE_TTL_MS = 30 * 60 * 1000;

// The season code is the competition letter + the year the season ENDS.
// A season runs Oct–Jun: from July onward the "current" season is the one
// ending NEXT year (a November 2026 date belongs to the 2026-27 season,
// "E2027"), while January–June still belong to the season ending this year
// (a January 2026 date is "E2026", the 2025-26 season).
export function euroleagueSeasonCode(competition, now = Date.now()) {
  const ts = normalizeNow(now);
  const date = new Date(ts);
  // A EuroLeague season is labelled by the year it STARTS (Sep-Jun). Measured:
  // in Nov 2026 the live season is E2026 (380 games) while E2027 answers with 0.
  const year = date.getMonth() >= 6 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(competition).trim().toUpperCase()}${year}`;
}

export function euroleagueGamesUrl(competition, season) {
  return `${EUROLEAGUE_BASE_URL}/${competition}/seasons/${season}/games`;
}

// One API side (local|road) -> the unified side object. The API is EXPLICIT
// about which side is home (`local`) and which is away (`road`), so the sides
// are NEVER derived from anything else. No colours and no records exist in
// this source: honest nulls, same card geometry.
function parseSide(side) {
  if (!side || typeof side !== "object") return null;
  const club = side.club ?? {};
  const name = String(club.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    abbr: String(club.abbreviatedName ?? "").trim(),
    score: null, // filled below ONLY when the game was played
    record: null,
    color: null,
    logo: String(club.images?.crest ?? "").trim()
  };
}

function competitionLabel(code) {
  const entry = EUROLEAGUE_COMPETITIONS.find((item) => item.code === code);
  return entry ? entry.label : String(code ?? "").trim();
}

// Pure: the season payload -> the unified events of that competition. Garbage
// rows are dropped, never thrown: a malformed payload yields [].
export function parseEuroleagueGames(payload, competition) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.games)
        ? payload.games
        : [];
  const code = String(competition ?? "")
    .trim()
    .toUpperCase();
  const label = competitionLabel(code);
  const events = [];
  for (const row of rows) {
    const gameCode = String(row?.gameCode ?? "").trim();
    if (!gameCode) continue; // no stable id can be built
    const kickoffMs = Date.parse(row?.utcDate ?? "");
    if (!Number.isFinite(kickoffMs)) continue; // never day-filterable
    const home = parseSide(row?.local);
    const away = parseSide(row?.road);
    if (!home || !away) continue;
    const played = row?.played === true;
    if (played) {
      const homeScore = Number(row?.local?.score);
      const awayScore = Number(row?.road?.score);
      home.score = Number.isFinite(homeScore) ? homeScore : null;
      away.score = Number.isFinite(awayScore) ? awayScore : null;
    }
    events.push({
      id: `el:${code}:${gameCode}`,
      slug: "euroleague",
      sportType: "basketball",
      leagueName: label,
      leagueAbbr: code,
      leagueLogo: "",
      // The API carries no venue field: null, like the other score-less source.
      venue: null,
      state: played ? "post" : "pre",
      // Derived partition fields so buildSections consumes the event unchanged
      // (this source can never land in the EN VIVO section).
      status: played ? "finished" : "scheduled",
      live: false,
      statusText: "",
      period: 0,
      clock: "",
      situation: "",
      kickoffMs,
      home,
      away
    });
  }
  return events;
}

// Local-day helpers — the SAME bucketing the rest of the screen uses
// (a dayKey is a numeric offset "-7".."7" or the legacy named offsets).
function dayKeyOffset(dayKey) {
  if (dayKey === "yesterday") return -1;
  if (dayKey === "tomorrow") return 1;
  const num = Number(dayKey);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

// Pure day filter: keep the events whose kickoff falls on the REQUESTED LOCAL
// DAY (the device's timezone — the same Ayer/Hoy/Mañana semantics). Unlike the
// scheduled-only sporting-events source there is NO grace window here: a
// finished game carries a real final score and must render (FINALIZADOS) on
// its own day, however long ago it tipped off.
export function euroleagueEventsForLocalDay(events, { dayKey = "0", now } = {}) {
  const nowTs = normalizeNow(now);
  const base = new Date(nowTs + dayKeyOffset(dayKey) * DAY_MS);
  const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
  const dayEnd = dayStart + DAY_MS;
  return (Array.isArray(events) ? events : []).filter((event) => {
    const kickoff = Number(event?.kickoffMs);
    return Number.isFinite(kickoff) && kickoff > 0 && kickoff >= dayStart && kickoff < dayEnd;
  });
}

// Season cache per competition|season: { expiresAt, events } (the FULL season,
// unfiltered — the day filter is applied at serve time). A failed competition
// is NEVER cached, so the next round retries it.
const seasonCache = new Map();

export function clearEuroleagueCache() {
  seasonCache.clear();
}

// One day round for the third source: both competitions concurrently (2
// requests fit inside the ESPN burst width), each bounded by the ESPN
// per-request budget, cached per competition|season for 30 min, filtered to
// the requested local day. NEVER throws: a failing competition is reported in
// `failedCompetitions` and the other still lands.
// `onProgress` receives each competition's OWN filtered rows as its answer
// lands (a delta, not cumulative) so the screen can append and repaint
// progressively, exactly like the ESPN round's onProgress.
// Returns { events, failed, failedCompetitions }.
export async function euroleagueForDay({
  dayKey = "0",
  fetchImpl = null,
  now,
  force = false,
  onProgress = null
} = {}) {
  const nowFn = () => normalizeNow(now);
  const nowTs = nowFn();
  const fetchFn =
    fetchImpl ||
    (typeof window !== "undefined" && typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const emit = typeof onProgress === "function" ? (rows) => onProgress(rows.slice()) : null;

  const events = [];
  const failedCompetitions = [];

  const loadCompetition = async (entry) => {
    const season = euroleagueSeasonCode(entry.code, nowTs);
    const key = `${entry.code}|${season}`;
    const cached = force ? null : seasonCache.get(key);
    if (cached && cached.expiresAt > nowTs) {
      const dayEvents = euroleagueEventsForLocalDay(cached.events, { dayKey, now: nowTs });
      events.push(...dayEvents);
      if (emit) emit(dayEvents);
      return;
    }
    if (!fetchFn) {
      // No fetch available (node --test arms no default fetch): an honest
      // failure count, no network, no throw.
      failedCompetitions.push(entry.code);
      return;
    }
    try {
      const payload = await fetchJsonBounded(
        fetchFn,
        euroleagueGamesUrl(entry.code, season),
        ESPN_REQUEST_TIMEOUT_MS
      );
      const parsed = parseEuroleagueGames(payload, entry.code);
      seasonCache.set(key, { expiresAt: nowFn() + EUROLEAGUE_CACHE_TTL_MS, events: parsed });
      const dayEvents = euroleagueEventsForLocalDay(parsed, { dayKey, now: nowFn() });
      events.push(...dayEvents);
      if (emit) emit(dayEvents);
    } catch (_) {
      // Failed competition: not cached (a later load retries it), never a
      // throw into the caller.
      failedCompetitions.push(entry.code);
    }
  };

  await Promise.all(EUROLEAGUE_COMPETITIONS.map(loadCompetition));

  // Stable merge order regardless of which competition answered first.
  events.sort((a, b) => a.kickoffMs - b.kickoffMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { events, failed: failedCompetitions.length, failedCompetitions };
}
