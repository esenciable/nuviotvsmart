// ESPN schedule round: ESPN is THE schedule for the Sports screen. The FIRST
// load of a visible day fetches EVERY mapped league — the full curated table
// (28 leagues today), never a capped subset — with bounded concurrency (6 in
// flight), the unchanged per-request timeout and PROGRESSIVE results: each
// league's rows are emitted through `onProgress` as soon as it answers, so
// the cartelera fills visibly instead of waiting for the whole round. The
// addon feed is NOT a data source here: it is only the stream hint
// (findAddonEventForSportsEvent / resolveStreamsForEvent below).
//
// TWO caches with different purposes:
//   - SCHEDULE cache per league|date, 10 min TTL: a day's fixtures barely
//     change, and they are what fills the list.
//   - LIVE cache per league|date, 60 s TTL, only for leagues that currently
//     have a live match: the only thing that needs refreshing often.
// A first load therefore costs at most one request per mapped league (28
// today); every later refresh inside the schedule window costs at most one
// request per LIVE league. Failures are isolated per league, never cached,
// and retried on the next round; the failed count is returned so the screen
// can say so quietly instead of hiding it.
import {
  ESPN_LIVE_TTL_MS,
  ESPN_MAX_CONCURRENT,
  ESPN_MATCH_WINDOW_MS,
  ESPN_REQUEST_TIMEOUT_MS,
  ESPN_ROUND_BUDGET_MS,
  ESPN_SCHEDULE_TTL_MS,
  LEAGUE_SLUGS,
  espnDateForDay,
  espnScoreboardUrl,
  fetchJsonBounded,
  normalizeNow,
  parseScoreboard,
  teamNameMatches
} from "./espnScores.js";

// TWO TTL caches per league|date: { expiresAt, events }.
//   - scheduleCache: the day's fixtures (10 min) — what fills the list.
//   - liveCache: the freshest scores of a league that has a live match
//     (60 s) — the only thing refreshed often.
// A FAILED league is never cached, so the next round retries it.
const scheduleCache = new Map();
const liveCache = new Map();

// Learned priority per dateKey|slug: { live: 0|1, firstKickoff }.
const leaguePriority = new Map();

export function clearScheduleCache() {
  scheduleCache.clear();
  liveCache.clear();
  leaguePriority.clear();
}

// Does this league's payload currently carry a live match? Only such leagues
// get the 60 s live refresh.
function hasLiveEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => String(event?.state ?? "") === "in");
}

// Bounded worker pool: at most `limit` tasks in flight, ONE pass over the
// queue — every item handled exactly once, in queue order.
async function runBounded(items, limit, worker) {
  let index = 0;
  const size = Math.min(Math.max(1, limit), items.length);
  const runners = Array.from({ length: size }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

// Learn the round's priority facts for one league: whether it has a live
// event and its earliest kickoff (MAX when the league has no events). Called
// for every successfully parsed league; exported for tests.
export function recordLeagueActivity(dateKey, slug, events) {
  const list = Array.isArray(events) ? events : [];
  let firstKickoff = Number.MAX_SAFE_INTEGER;
  let live = 0;
  for (const event of list) {
    const kickoff = Number(event?.kickoffMs);
    if (Number.isFinite(kickoff) && kickoff > 0 && kickoff < firstKickoff) {
      firstKickoff = kickoff;
    }
    if (String(event?.state ?? "") === "in") live = 1;
  }
  leaguePriority.set(`${dateKey}|${slug}`, { live, firstKickoff });
}

// The day's slug order, four priority groups:
//   0. learned-live leagues (earliest kickoff first) — fetched every round,
//   1. learned leagues with a real kickoff (earliest first) — pre-game,
//   2. NEVER-FETCHED leagues, in curated order — the sweep: a league deep in
//      the table (soccer/arg.1) only becomes schedulable once it has had a
//      round, so unknowns take their turn ahead of known-empty ones,
//   3. known-empty leagues, in curated order — stable once the whole table
//      has been swept (nothing learned about them yet this day).
// Within a group the curated index breaks ties, so the slate is stable while
// the TTL is warm and the cap never thrashes.
export function orderedEntriesForDay(dateKey) {
  const scored = LEAGUE_SLUGS.map((entry, index) => {
    const priority = leaguePriority.get(`${dateKey}|${entry.slug}`);
    if (priority?.live === 1) {
      return { entry, group: 0, tie: priority.firstKickoff, index };
    }
    if (priority && priority.firstKickoff < Number.MAX_SAFE_INTEGER) {
      return { entry, group: 1, tie: priority.firstKickoff, index };
    }
    if (!priority) {
      return { entry, group: 2, tie: index, index };
    }
    return { entry, group: 3, tie: index, index };
  });
  scored.sort((a, b) => a.group - b.group || a.tie - b.tie || a.index - b.index);
  return scored.map((item) => item.entry);
}

// One schedule round for the visible day:
//   - derive the ET yyyyMMdd date for the day chip (America/New_York — the
//     UTC date shows an empty slate, measured),
//   - FIRST LOAD (cold caches): fetch EVERY mapped league in one bounded
//     burst (6 in flight, 1200 ms per request), emitting each league's rows
//     through `onProgress` as soon as it answers,
//   - LATER ROUNDS: the warm SCHEDULE cache (10 min) serves the day in place;
//     only leagues whose cached payload has a LIVE match refetch when their
//     60 s LIVE cache is cold,
//   - serve repeats from cache (failures are never cached),
//   - a failed league never poisons the round: whatever succeeded is
//     returned, and the failure is reported in `failed`.
// Returns { dateKey, slugs, skipped, failed, failedSlugs, events }.
export async function espnScheduleForDay({
  dayKey = "today",
  fetchImpl = null,
  now,
  force = false,
  onProgress = null
} = {}) {
  const nowFn = () => normalizeNow(now);
  const nowTs = nowFn();
  const dateKey = espnDateForDay({ dayKey, events: [], now: nowTs });

  const ordered = orderedEntriesForDay(dateKey);

  const fetchFn =
    fetchImpl ||
    (typeof window !== "undefined" && typeof fetch === "function" ? fetch.bind(globalThis) : null);

  const events = [];
  const bySlug = new Map();
  const failedSlugs = [];
  const skipped = [];

  // Replace one league's rows in the cumulative list (a live refresh brings
  // fresher versions of the same league's events).
  const ingest = (slug, parsed) => {
    const previous = bySlug.get(slug);
    if (previous && previous.length) {
      const drop = new Set(previous);
      for (let i = events.length - 1; i >= 0; i -= 1) {
        if (drop.has(events[i])) events.splice(i, 1);
      }
    }
    if (parsed.length) events.push(...parsed);
    bySlug.set(slug, parsed);
  };

  const emit = typeof onProgress === "function" ? () => onProgress(events.slice()) : null;

  // Classify the day's leagues: the warm SCHEDULE cache serves in place; a
  // league with a LIVE match refetches when its 60 s LIVE cache is cold;
  // everything else (first load, expired, previously failed) is a cold fetch.
  const cold = [];
  const liveRefresh = [];
  for (const entry of ordered) {
    const key = `${entry.slug}|${dateKey}`;
    const cached = force ? null : scheduleCache.get(key);
    if (cached && cached.expiresAt > nowTs) {
      ingest(entry.slug, cached.events);
      if (hasLiveEvent(cached.events)) {
        const live = liveCache.get(key);
        if (live && live.expiresAt > nowTs) ingest(entry.slug, live.events);
        else liveRefresh.push(entry);
      }
      continue;
    }
    cold.push(entry);
  }

  const roundStart = nowTs;
  const queue = [...cold, ...liveRefresh];
  if (queue.length) {
    if (!fetchFn) {
      // No fetch available: an honest failure count for every uncached
      // league — an empty result, never a throw.
      failedSlugs.push(...queue.map((entry) => entry.slug));
    } else {
      await runBounded(queue, ESPN_MAX_CONCURRENT, async (entry) => {
        if (nowFn() - roundStart >= ESPN_ROUND_BUDGET_MS) {
          skipped.push(entry.slug);
          return;
        }
        try {
          const payload = await fetchJsonBounded(
            fetchFn,
            espnScoreboardUrl(entry, dateKey),
            ESPN_REQUEST_TIMEOUT_MS
          );
          const parsed = parseScoreboard(payload, entry.slug);
          recordLeagueActivity(dateKey, entry.slug, parsed);
          scheduleCache.set(`${entry.slug}|${dateKey}`, {
            expiresAt: nowFn() + ESPN_SCHEDULE_TTL_MS,
            events: parsed
          });
          const liveKey = `${entry.slug}|${dateKey}`;
          if (hasLiveEvent(parsed)) {
            liveCache.set(liveKey, { expiresAt: nowFn() + ESPN_LIVE_TTL_MS, events: parsed });
          } else {
            liveCache.delete(liveKey);
          }
          ingest(entry.slug, parsed);
          if (emit) emit(); // progressive: the list fills league by league
        } catch (_) {
          // Failed league: not cached, does not poison the round.
          failedSlugs.push(entry.slug);
        }
      });
    }
  }

  if (skipped.length) {
    // Cost control is a deliberate contract: say WHICH leagues were dropped.
    console.warn(
      `espnSchedule: ${skipped.length} league(s) skipped (round budget ${ESPN_ROUND_BUDGET_MS}ms): ${skipped.join(", ")}`
    );
  }

  return {
    dateKey,
    slugs: ordered.map((entry) => entry.slug),
    skipped,
    failed: failedSlugs.length,
    failedSlugs,
    events
  };
}

// --- The addon is ONLY the stream source -----------------------------------

// The addon event that carries the stream for an ESPN SportsEvent: BOTH team
// names matching (accent/punctuation folded, whole-word containment, either
// home/away order) AND kickoff within 20 minutes. Exactly ONE candidate may
// match: zero (no link) or more than one (ambiguous) return null — never
// guess a stream.
export function findAddonEventForSportsEvent(sportsEvent, addonEvents) {
  const list = Array.isArray(addonEvents) ? addonEvents : [];
  const home = String(sportsEvent?.home?.name ?? "").trim();
  const away = String(sportsEvent?.away?.name ?? "").trim();
  if (!home || !away) return null;
  const kickoff = Number(sportsEvent?.kickoffMs);
  if (!Number.isFinite(kickoff)) return null;
  const matches = list.filter((event) => {
    const eventKickoff = Number(event?.kickoffMs);
    if (!Number.isFinite(eventKickoff)) return false;
    if (Math.abs(eventKickoff - kickoff) > ESPN_MATCH_WINDOW_MS) return false;
    const names = (Array.isArray(event?.teams) ? event.teams : [])
      .map((team) => String(team?.name ?? "").trim())
      .filter(Boolean);
    if (names.length < 2) return false;
    return (
      (teamNameMatches(names[0], home) && teamNameMatches(names[1], away)) ||
      (teamNameMatches(names[0], away) && teamNameMatches(names[1], home))
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

// resolveStreamsForEvent(event, addonEvents, { resolveStreams }): find the ONE
// addon event for the ESPN event (above) and resolve its
// `/stream/tv/<id>.json` result through the injected resolver (the screen
// passes the shared sportsRepository.resolveStreams — the probe + picker
// behaviour downstream is unchanged). No addon match -> null and the resolver
// is NEVER called: the caller shows "No hay enlace para este partido" and
// never opens a player.
export async function resolveStreamsForEvent(event, addonEvents, { resolveStreams } = {}) {
  const addonEvent = findAddonEventForSportsEvent(event, addonEvents);
  if (!addonEvent) return null;
  const result = resolveStreams ? await resolveStreams(addonEvent.id) : null;
  return { addonEvent, result };
}
