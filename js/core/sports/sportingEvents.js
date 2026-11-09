// sporting-events.org: the SECOND schedule source for the Sports screen — the
// FOUR competitions ESPN does not cover (cricket, darts, rugby league,
// snooker). Measured with curl (owner-verified): the endpoint answers
// `https://sporting-events.org/data/<slug>.json` with HTTP 200 and
// `access-control-allow-origin: *`, so the TV can call it directly. The
// payload carries NO scores, NO team colours and NO logos:
//   {competition, generated, source, license, event_count,
//    events:[{match, date_utc:"2026-11-01", time_utc:"20:30",
//             fixture:"Boston Celtics at Orlando Magic",
//             home_team, away_team, ...}]}
// Owner scope decisions: the `nba` slug exists but is NEVER used (ESPN covers
// it and the file is a whole season, 554 KB); Formula 1 exists but ESPN covers
// it; euroleague/acb slugs do not exist and are out of scope (no proxy).
//
// COST CONTRACT (Samsung TV, 120 MB app budget):
//   - ONE request per slug, bounded by the ESPN round's request budget
//     (the same 2500 ms per-request timeout and ≤6 concurrent as
//     espnSchedule.js — four files fit inside the 6-wide burst),
//   - a payload above 64 KB is skipped and logged with its slug and size,
//   - fixtures barely change: each slug is revalidated at most once every
//     6 hours (long per-slug cache),
//   - a DOWN source is remembered briefly (failure TTL) so the screen's 60 s
//     rounds never turn into a retry loop,
//   - a failing slug is isolated: the other slugs still land, and the caller
//     (the screen) never sees a throw.
import { ESPN_MAX_CONCURRENT, ESPN_REQUEST_TIMEOUT_MS, normalizeNow } from "./espnScores.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const SPORTING_EVENTS_BASE_URL = "https://sporting-events.org/data";

// ONLY the four competitions ESPN lacks, with the display name the card shows
// (the app's language). Order is the fetch/display order, stable.
export const SPORTING_EVENTS_SLUGS = [
  { slug: "cricket", label: "Cricket" },
  { slug: "darts", label: "Dardos" },
  { slug: "rugby-league", label: "Rugby League" },
  { slug: "snooker", label: "Snooker" }
];

// A body above 64 KB is skipped (and logged with WHICH slug): the measured
// fixtures are tiny (≤3.6 KB) and a season-sized file like nba.json (554 KB)
// must never be pulled onto the TV.
export const SPORTING_EVENTS_MAX_BYTES = 64 * 1024;

// Fixtures barely change: each slug's payload is cached and revalidated at
// most once every 6 hours.
export const SPORTING_EVENTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// A failed/down source is remembered for 10 minutes: the screen's 60 s rounds
// must not become a retry loop, but one blip should not silence the source
// for the full 6 h window.
export const SPORTING_EVENTS_FAILURE_TTL_MS = 10 * 60 * 1000;

// No scores exist in this source: a fixture whose kickoff already passed
// stays visible for a few hours (3 h) and is otherwise dropped.
export const SPORTING_EVENTS_PASSED_GRACE_MS = 3 * 60 * 60 * 1000;

export function sportingEventsUrl(slug) {
  return `${SPORTING_EVENTS_BASE_URL}/${slug}.json`;
}

// date_utc ("2026-11-01") + time_utc ("20:30") -> the UTC instant in ms. The
// kickoff MOMENT is absolute (UTC); the LOCAL day it belongs to is decided at
// filter time by the device's timezone. A missing/broken pair yields 0.
export function sportingEventKickoffMs(row) {
  const date = String(row?.date_utc ?? "").trim();
  const time = String(row?.time_utc ?? "").trim();
  if (!date || !time) return 0;
  // The measured feed ships bare "HH:mm"; tolerate an explicit zone if one
  // ever appears, and treat a bare clock as UTC.
  const zoned = /(?:z|[+-]\d{2}:?\d{2})$/i.test(time);
  const ms = Date.parse(`${date}T${time}${zoned ? "" : "Z"}`);
  return Number.isFinite(ms) ? ms : 0;
}

// One feed row -> the SAME unified event shape the ESPN layer produces, so
// the card renders unchanged: buildSections places it under PRÓXIMOS
// (status "scheduled"), the status column shows the local kickoff time and
// the pre-game countdown, and the league column falls back to the slug text.
// Sides come from home_team/away_team ONLY (authoritative) — the
// "Away at Home" fixture string is NEVER parsed.
function sportingRowToEvent(row, slug, label) {
  if (!row || typeof row !== "object") return null;
  const match = String(row.match ?? "").trim();
  const homeName = String(row.home_team ?? "").trim();
  const awayName = String(row.away_team ?? "").trim();
  if (!match || !homeName || !awayName) return null;
  const kickoffMs = sportingEventKickoffMs(row);
  if (!kickoffMs) return null;
  return {
    id: `se:${slug}:${match}`,
    slug,
    sportType: slug,
    leagueName: label,
    leagueAbbr: "",
    leagueLogo: "",
    venue: null,
    state: "pre",
    // Derived partition fields so buildSections consumes the event unchanged.
    status: "scheduled",
    live: false,
    statusText: "",
    period: 0,
    clock: "",
    situation: "",
    kickoffMs,
    home: { name: homeName, score: null, record: null, color: null, logo: null, abbr: "" },
    away: { name: awayName, score: null, record: null, color: null, logo: null, abbr: "" }
  };
}

// Pure: a measured payload -> the unified events of that slug. Garbage rows
// are dropped, never thrown.
export function parseSportingEvents(payload, entry) {
  const rows = Array.isArray(payload?.events) ? payload.events : [];
  const slug = String(entry?.slug ?? "").trim();
  const label = String(entry?.label ?? "").trim();
  const events = [];
  for (const row of rows) {
    const parsed = sportingRowToEvent(row, slug, label);
    if (parsed) events.push(parsed);
  }
  return events;
}

// Pure day filter: keep the events whose kickoff falls on the REQUESTED LOCAL
// DAY (the device's timezone — the same Ayer/Hoy/Mañana dayKey semantics the
// ESPN layer uses) and that have not been passed for longer than the grace
// window. Kickoffs are absolute UTC instants; the local day bucket is
// computed from the device's clock.
function dayKeyOffset(dayKey) {
  if (dayKey === "yesterday") return -1;
  if (dayKey === "tomorrow") return 1;
  const num = Number(dayKey);
  return Number.isFinite(num) ? Math.trunc(num) : 0;
}

export function sportingEventsForLocalDay(events, { dayKey = "0", now } = {}) {
  const nowTs = normalizeNow(now);
  const base = new Date(nowTs + dayKeyOffset(dayKey) * DAY_MS);
  const dayStart = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
  const dayEnd = dayStart + DAY_MS;
  const oldestVisible = nowTs - SPORTING_EVENTS_PASSED_GRACE_MS;
  return (Array.isArray(events) ? events : []).filter((event) => {
    const kickoff = Number(event?.kickoffMs);
    if (!Number.isFinite(kickoff) || kickoff <= 0) return false;
    return kickoff >= dayStart && kickoff < dayEnd && kickoff >= oldestVisible;
  });
}

// Per-slug cache: { expiresAt, failed, events }. A success lives 6 h; a
// failure lives the shorter failure TTL (no retry loop, quick recovery).
const payloadCache = new Map();

export function clearSportingEventsCache() {
  payloadCache.clear();
}

// UTF-8 byte length of a text body (the guard is a BYTE budget, not chars).
function byteLength(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length; // very old TV without TextEncoder: chars ≈ bytes fallback
}

// One bounded text fetch: the verdict (fetch AND body read) races the
// per-request timer — the same budget the ESPN round uses. No retries.
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

// One day round for the second source: the four slugs, cached per slug
// (success 6 h, failure the failure TTL), size-guarded, filtered to the
// requested local day. NEVER throws: a failing slug is reported in
// `failedSlugs` and the other slugs still land. Four slugs fit inside the
// ESPN burst width (6), so the round's request budget holds without a pool.
// Returns { events, failed, failedSlugs }.
export async function sportingEventsForDay({ dayKey = "0", fetchImpl = null, now } = {}) {
  const nowFn = () => normalizeNow(now);
  const fetchFn =
    fetchImpl ||
    (typeof window !== "undefined" && typeof fetch === "function" ? fetch.bind(globalThis) : null);

  const events = [];
  const failedSlugs = [];

  if (!fetchFn) {
    // No fetch available (node --test arms no default fetch): an honest
    // failure count, no network, no throw.
    return {
      events,
      failed: SPORTING_EVENTS_SLUGS.length,
      failedSlugs: SPORTING_EVENTS_SLUGS.map((entry) => entry.slug)
    };
  }

  await Promise.all(
    SPORTING_EVENTS_SLUGS.map(async (entry) => {
      const nowTs = nowFn();
      const cached = payloadCache.get(entry.slug);
      if (cached && cached.expiresAt > nowTs) {
        if (cached.failed) {
          failedSlugs.push(entry.slug);
          return;
        }
        events.push(...sportingEventsForLocalDay(cached.events, { dayKey, now: nowTs }));
        return;
      }
      try {
        const text = await fetchTextBounded(
          fetchFn,
          sportingEventsUrl(entry.slug),
          ESPN_REQUEST_TIMEOUT_MS
        );
        const bytes = byteLength(text);
        if (bytes > SPORTING_EVENTS_MAX_BYTES) {
          // Season-sized file guard: skip it and say WHICH slug and size.
          console.warn(
            `sportingEvents: ${entry.slug}.json skipped (${bytes} bytes > ${SPORTING_EVENTS_MAX_BYTES} limit)`
          );
          payloadCache.set(entry.slug, {
            expiresAt: nowTs + SPORTING_EVENTS_FAILURE_TTL_MS,
            failed: true,
            events: []
          });
          failedSlugs.push(entry.slug);
          return;
        }
        const parsed = parseSportingEvents(JSON.parse(text), entry);
        payloadCache.set(entry.slug, {
          expiresAt: nowTs + SPORTING_EVENTS_CACHE_TTL_MS,
          failed: false,
          events: parsed
        });
        events.push(...sportingEventsForLocalDay(parsed, { dayKey, now: nowTs }));
      } catch (_) {
        // Failed slug: remembered briefly (no retry loop), never a throw.
        payloadCache.set(entry.slug, {
          expiresAt: nowTs + SPORTING_EVENTS_FAILURE_TTL_MS,
          failed: true,
          events: []
        });
        failedSlugs.push(entry.slug);
      }
    })
  );

  // Stable merge order regardless of which slug answered first.
  events.sort((a, b) => a.kickoffMs - b.kickoffMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    events,
    failed: failedSlugs.length,
    failedSlugs
  };
}
