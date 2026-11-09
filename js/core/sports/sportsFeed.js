// Sports feed: pure parsing/grouping helpers plus the ONLY two network calls
// the lightweight Sports screen makes — the events feed (60 s TTL + manual
// refresh) and the per-match stream resolution. Modelled on the measured
// Esencial Sport addon (owner-verified):
//   GET https://esencialsport.attendanceos.app/events.json
//     -> {generatedAt, count, events:[{id, matchId, sportType, title, leagueId,
//        leagueName, country, countryId, kickoffMs, live, status,
//        teams:[{side, name, logo}], sources}]}
//   GET .../stream/tv/<event.id>.json -> {streams:[...], failed, retryAfterMs}
//
// Two hard rules from the owner decision:
//   1. team logos are NEVER read (all channel images were removed from this
//      TV app for the Samsung 120 MB cap; sports must not reintroduce them).
//   2. The dead per-event stream field inside events.json (it 404s) is NEVER
//      read: playback always resolves through /stream/tv/<id>.json, one
//      attempt, no retries.

export const SPORTS_FEED_URL = "https://esencialsport.attendanceos.app/events.json";
export const SPORTS_FEED_BASE_URL = "https://esencialsport.attendanceos.app";
export const SPORTS_FEED_TTL_MS = 60000;
export const SPORTS_FETCH_TIMEOUT_MS = 10000;

// Real playback endpoint for one event. The dead per-event stream field in
// events.json is never used — only this route is.
export function streamEndpointUrl(eventId) {
  return `${SPORTS_FEED_BASE_URL}/stream/tv/${encodeURIComponent(String(eventId ?? ""))}.json`;
}

// Parsing -------------------------------------------------------------------

function finiteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseTeam(row) {
  if (!row || typeof row !== "object") return null;
  const name = String(row.name ?? "").trim();
  if (!name) return null;
  // score is optional: included only when the addon provides a real number.
  // Team logos are deliberately NOT read — the TV app carries no images.
  return { side: String(row.side ?? ""), name, score: finiteNumberOrNull(row.score) };
}

// Pure: events.json rows -> the UI model. Rows without an id are dropped
// (they can never be focused or resolved). Garbage payloads yield [].
export function parseEvents(payload) {
  const rows = Array.isArray(payload?.events) ? payload.events : [];
  const events = [];
  for (const row of rows) {
    const id = String(row?.id ?? "").trim();
    if (!id) continue;
    const status = String(row?.status ?? "")
      .trim()
      .toLowerCase();
    const teams = (Array.isArray(row?.teams) ? row.teams : []).map(parseTeam).filter(Boolean);
    events.push({
      id,
      title: String(row?.title ?? "").trim(),
      leagueName: String(row?.leagueName ?? "").trim(),
      sportType: String(row?.sportType ?? "").trim(),
      kickoffMs: finiteNumberOrNull(row?.kickoffMs) ?? 0,
      // `live` may be absent or null; the status string is the fallback truth.
      live: row?.live === true || (row?.live == null && status === "live"),
      status: status || (row?.live === true ? "live" : "scheduled"),
      teams
    });
  }
  return events;
}

// Sport labels ---------------------------------------------------------------

const SPORT_LABELS = {
  futbol: "Fútbol",
  fútbol: "Fútbol",
  soccer: "Fútbol",
  football: "Fútbol americano",
  "american-football": "Fútbol americano",
  baloncesto: "Baloncesto",
  basketball: "Baloncesto",
  tenis: "Tenis",
  tennis: "Tenis",
  balonmano: "Balonmano",
  handball: "Balonmano",
  voleibol: "Voleibol",
  volleyball: "Voleibol",
  beisbol: "Béisbol",
  béisbol: "Béisbol",
  baseball: "Béisbol",
  hockey: "Hockey",
  rugby: "Rugby",
  boxeo: "Boxeo",
  boxing: "Boxeo",
  mma: "MMA",
  ciclismo: "Ciclismo",
  cycling: "Ciclismo",
  motor: "Motor",
  motorsport: "Motor",
  cricket: "Cricket",
  golf: "Golf"
};

// Spanish label for a sportType; unknown types render as readable text
// ("futbol-americano" -> "Futbol americano") instead of a raw slug.
export function sportLabel(sportType) {
  const raw = String(sportType ?? "").trim();
  if (!raw) return "";
  const known = SPORT_LABELS[raw.toLowerCase()];
  if (known) return known;
  return raw.replace(/[-_]+/g, " ").replace(/^\p{L}/u, (ch) => ch.toUpperCase());
}

// Chip row: Todos first, then one chip per sportType present in the events,
// in first-appearance order (stable, no re-sort churn as data refreshes).
export function sportChips(events) {
  const chips = [{ id: "todos", label: "Todos", sportType: null }];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const type = String(event?.sportType ?? "").trim();
    if (!type || seen.has(type)) continue;
    seen.add(type);
    chips.push({ id: type, label: sportLabel(type), sportType: type });
  }
  return chips;
}

// Day grouping (Ayer / Hoy / Mañana) ----------------------------------------
// Calendar-day buckets in LOCAL time, compared by day start — never by a raw
// 24h offset, so a 23:59 match and a 00:01 match never land in the same day.

function startOfDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

// "yesterday" | "today" | "tomorrow". Events outside the three chips clamp
// into the nearest bucket so data never silently vanishes from the UI.
export function dayKeyForKickoff(kickoffMs, now = Date.now()) {
  const kickoff = Number(kickoffMs);
  if (!Number.isFinite(kickoff)) return "today";
  const day = startOfDay(kickoff);
  const today = startOfDay(now);
  if (day < today) return "yesterday";
  if (day === today) return "today";
  if (day === today + DAY_MS) return "tomorrow";
  return day < today + DAY_MS ? "today" : "tomorrow";
}

export function groupEventsByDay(events, now = Date.now()) {
  const groups = { yesterday: [], today: [], tomorrow: [] };
  for (const event of Array.isArray(events) ? events : []) {
    groups[dayKeyForKickoff(event?.kickoffMs, now)].push(event);
  }
  return groups;
}

// Live / upcoming / finished partition --------------------------------------

function byKickoffAsc(a, b) {
  return (Number(a?.kickoffMs) || 0) - (Number(b?.kickoffMs) || 0);
}

// live: the flag or the status; finished: the status; everything else is
// upcoming (an unknown status must never strand a match outside all sections).
export function partitionEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const live = [];
  const upcoming = [];
  const finished = [];
  for (const event of list) {
    if (event?.status === "finished") finished.push(event);
    else if (event?.live || event?.status === "live") live.push(event);
    else upcoming.push(event);
  }
  live.sort(byKickoffAsc);
  upcoming.sort(byKickoffAsc);
  // Finished reads most-recent-first: the matches the user just missed are on
  // top of the collapsed section.
  finished.sort((a, b) => byKickoffAsc(b, a));
  return { live, upcoming, finished };
}

// The screen's one vertical list, in fixed order. FINALIZADOS is last and
// collapsed by default (the screen owns the toggle).
export const SPORTS_SECTION_ORDER = ["live", "upcoming", "finished"];
export const SPORTS_SECTION_LABELS = {
  live: "EN VIVO",
  upcoming: "PRÓXIMOS",
  finished: "FINALIZADOS"
};

export function buildSections(events) {
  const partitioned = partitionEvents(events);
  return SPORTS_SECTION_ORDER.map((key) => ({
    key,
    label: SPORTS_SECTION_LABELS[key],
    events: partitioned[key],
    collapsedByDefault: key === "finished"
  }));
}

// Row time ------------------------------------------------------------------

export function formatKickoffTime(kickoffMs) {
  const ms = Number(kickoffMs);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Probe before hand-off (owner rule: never open a dead player) ---------------
// The addon's stream URLs arrive `verified: false` and were measured 404 even
// with a browser User-Agent. Before the player handoff every candidate URL
// gets ONE bounded request (≤6 s):
//   - a playlist URL (m3u8/m3u) must answer 2xx with a body starting #EXTM3U;
//   - any non-playlist URL only needs a 2xx.
// The candidates are probed CONCURRENTLY (one request each, no retries) so a
// match with several links never pays several timeouts in series, and EVERY
// stream that answers is returned — in the addon's original order — so the
// screen can offer them all instead of silently playing the first. If none
// answers the caller must NOT navigate. The probe only ever runs from an
// explicit Enter on a match.
export const SPORTS_PROBE_TIMEOUT_MS = 6000;

// A URL that claims to be an HLS/media playlist must prove it with #EXTM3U.
export function looksLikePlaylistUrl(url) {
  return /\.m3u8?\b/i.test(String(url || ""));
}

// The candidate stream objects with a usable url (garbage dropped, addon
// order kept). `verified`/`name`/`resolution` travel untouched so the picker
// can label each playable source exactly as the addon declared it.
function probeCandidates(streams) {
  return (Array.isArray(streams) ? streams : [])
    .map((stream) => (stream && String(stream.url ?? "").trim() ? stream : null))
    .filter(Boolean);
}

async function probeUrlOnce(fetchFn, url, timeoutMs) {
  let timer = null;
  try {
    const verdict = (async () => {
      const response = await fetchFn(url, {});
      // response.ok is exactly the 2xx acceptance rule.
      if (!response?.ok) return false;
      if (!looksLikePlaylistUrl(url)) return true;
      const body = await response.text();
      return String(body ?? "")
        .trimStart()
        .startsWith("#EXTM3U");
    })();
    // The whole verdict (fetch AND playlist body read) races the timer, so a
    // hanging response can never exceed the bound.
    return await Promise.race([
      verdict,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe timeout after ${timeoutMs}ms`)),
          Math.max(1, timeoutMs)
        );
      })
    ]);
  } catch (_) {
    return false; // timeout, network error, non-2xx: this stream is dead.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Probe EVERY resolved stream concurrently (one bounded attempt each, no
// retries) and return all that answer, in the addon's original order:
//   { playable: [stream, ...], tried, total }
// `playable` is empty when NO stream answered (no handoff). Same default-fetch
// arming as createSportsFeed: in node --test without an injected fetch this
// probes nothing and never touches the network.
export async function probePlayableStreams(
  streams,
  { fetchImpl = null, timeoutMs = SPORTS_PROBE_TIMEOUT_MS } = {}
) {
  const candidates = probeCandidates(streams);
  const fetchFn =
    fetchImpl ||
    (typeof window !== "undefined" && typeof fetch === "function" ? fetch.bind(globalThis) : null);
  if (!candidates.length || !fetchFn) {
    return { playable: [], tried: 0, total: candidates.length };
  }
  // All probes in flight at once; each one bounded by probeUrlOnce. The
  // verdicts keep the candidates' order, so `playable` is stable.
  const verdicts = await Promise.all(
    candidates.map(async (stream) =>
      (await probeUrlOnce(fetchFn, String(stream.url).trim(), timeoutMs)) ? stream : null
    )
  );
  return {
    playable: verdicts.filter(Boolean),
    tried: candidates.length,
    total: candidates.length
  };
}

// Feed instance --------------------------------------------------------------

// fetchJson with one bounded attempt: the fetch races a timer so a hanging
// request can never leave a spinner up forever. No retries anywhere.
async function fetchJsonOnce(fetchImpl, url, timeoutMs) {
  let timer = null;
  try {
    const response = await Promise.race([
      fetchImpl(url, {}),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout after ${timeoutMs}ms`)),
          Math.max(1, timeoutMs)
        );
      })
    ]);
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status ?? "unknown"}`);
    }
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createSportsFeed({
  fetchImpl = null,
  url = SPORTS_FEED_URL,
  ttlMs = SPORTS_FEED_TTL_MS,
  timeoutMs = SPORTS_FETCH_TIMEOUT_MS,
  now = () => Date.now()
} = {}) {
  // Like liveRepository: the default fetch arms only in a real browser/TV
  // context, so `node --test` can never touch the network by accident.
  const fetchFn =
    fetchImpl ||
    (typeof window !== "undefined" && typeof fetch === "function" ? fetch.bind(globalThis) : null);

  let cache = null; // { events, expiresAt }

  async function getEvents({ force = false } = {}) {
    if (!force && cache && cache.expiresAt > now()) {
      return { status: "ok", events: cache.events, fromCache: true };
    }
    if (!fetchFn) {
      return { status: "error", detail: "sportsFeed: no fetch available" };
    }
    try {
      const payload = await fetchJsonOnce(fetchFn, url, timeoutMs);
      const events = parseEvents(payload);
      cache = { events, expiresAt: now() + ttlMs };
      return { status: "ok", events };
    } catch (error) {
      return {
        status: "error",
        detail: String(error?.message || error || "sportsFeed: fetch failed")
      };
    }
  }

  // Manual Actualizar: one forced fetch, TTL ignored for this call.
  function refresh() {
    return getEvents({ force: true });
  }

  // One attempt only — no retry loops. Mapping:
  //   failed:true            -> {status:"pending", retryAfterMs}
  //   otherwise (200 JSON)   -> {status:"ok", streams}
  //   anything else          -> {status:"error", detail}
  async function resolveStreams(eventId) {
    const id = String(eventId ?? "").trim();
    if (!id) {
      return { status: "error", detail: "sportsFeed: event id is required" };
    }
    if (!fetchFn) {
      return { status: "error", detail: "sportsFeed: no fetch available" };
    }
    try {
      const payload = await fetchJsonOnce(fetchFn, streamEndpointUrl(id), timeoutMs);
      if (payload?.failed === true) {
        return {
          status: "pending",
          retryAfterMs: Math.max(0, finiteNumberOrNull(payload.retryAfterMs) ?? 0)
        };
      }
      const streams = Array.isArray(payload?.streams) ? payload.streams : [];
      return { status: "ok", streams };
    } catch (error) {
      return {
        status: "error",
        detail: String(error?.message || error || "sportsFeed: resolve failed")
      };
    }
  }

  function clearCache() {
    cache = null;
  }

  return { getEvents, refresh, resolveStreams, clearCache };
}
