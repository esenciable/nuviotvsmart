// ESPN layer: the curated name→slug table, the scoreboard URL/date helpers
// and the FULL unified SportsEvent parse. The schedule round itself lives in
// espnSchedule.js (one bounded round per visible day). Verified with curl from
// this machine (ESPN answers `access-control-allow-origin: *`, so the
// browser/TV can call it directly):
//
//   GET https://site.api.espn.com/apis/site/v2/sports/<sport>/<league>/scoreboard
//       ?dates=yyyyMMdd&limit=1000[&groups=NN]
//
// - The date is the event day formatted in America/New_York (that is how ESPN
//   scopes `dates=`). Using the UTC date instead showed an empty slate —
//   exactly the failure mode to avoid.
// - College rows add `&groups=80` (football) or `&groups=50` (basketball);
//   ranges are rejected by ESPN, so one call per league per day.
//
// COST CONTRACT (owner TV: 1 GB class, 120 MB app cap):
//   - the day's schedule comes from this small curated slug table (below):
//     ONE bounded burst on entry — every mapped league for the visible day,
//     at most 6 requests in flight (see espnSchedule.js),
//   - 1200 ms per request, an overall round cap, a 10 min SCHEDULE cache per
//     league|date (a day's fixtures barely change) plus a 60 s LIVE cache for
//     the leagues that currently have a live match, and a failed league never
//     poisons the round.
import { groupEventsByDay } from "./sportsFeed.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const ESPN_SCOREBOARD_BASE = "https://site.api.espn.com/apis/site/v2/sports";
export const ESPN_REQUEST_TIMEOUT_MS = 1200;
// Bounded burst: at most 6 league scoreboards in flight — parallel enough to
// fill the cartelera in ~5 waves, never a thundering herd on a 1 GB TV.
export const ESPN_MAX_CONCURRENT = 6;
// Overall round cap: the worst full burst is ceil(28 / 6) × 1200 ms ≈ 6 s, so
// 9 s covers it with scheduling slack. A league dispatched after the cap is
// reported in `skipped`, never silently dropped.
export const ESPN_ROUND_BUDGET_MS = 9000;
// TWO caches, two purposes (see espnSchedule.js): a day's fixtures barely
// change — the SCHEDULE cache keeps a league|date for 10 minutes; live scores
// are the only thing needing freshness — the LIVE cache keeps a league|date
// that currently has a live match for 60 s.
export const ESPN_SCHEDULE_TTL_MS = 10 * 60 * 1000;
export const ESPN_LIVE_TTL_MS = 60000;
// Stream-resolution window: kickoff within 20 minutes, both names matching.
export const ESPN_MATCH_WINDOW_MS = 20 * 60 * 1000;

// The curated leagueName → ESPN slug table. ORDER MATTERS: entries are tried
// in order and the first match wins, so specific competitions (mundial,
// continental cups, "Brasileirão Série A") sit BEFORE the domestic leagues
// whose names they contain ("Serie A", "La Liga"). Aliases match as whole
// words after accent/punctuation folding ("La Liga EA Sports" hits "la liga";
// "Australia" does NOT hit the "usa" alias).
export const LEAGUE_SLUGS = [
  // US pro + college — "Fútbol Americano" alone is the owner's usual NFL label.
  // College sits BEFORE the pros: its aliases name the college competition
  // ("NCAA", "universitario"), and a bare "Fútbol Americano" still falls
  // through to the NFL row.
  {
    slug: "football/college-football",
    groups: 80,
    aliases: [
      "college football",
      "ncaa football",
      "ncaa futbol americano",
      "fbs",
      "fcs",
      "futbol americano universitario"
    ]
  },
  {
    slug: "football/nfl",
    aliases: ["nfl", "national football league", "futbol americano", "american football"]
  },
  { slug: "basketball/nba", aliases: ["nba", "national basketball association"] },
  { slug: "basketball/wnba", aliases: ["wnba"] },
  // A bare "NCAA" in a basketball feed means men's college basketball.
  {
    slug: "basketball/mens-college-basketball",
    groups: 50,
    aliases: [
      "ncaa",
      "ncaa basketball",
      "college basketball",
      "baloncesto universitario",
      "baloncesto ncaa"
    ]
  },
  { slug: "hockey/nhl", aliases: ["nhl", "national hockey league"] },
  { slug: "baseball/mlb", aliases: ["mlb", "major league baseball", "beisbol mlb"] },
  // Cups and international competitions BEFORE domestic leagues.
  {
    slug: "soccer/uefa.champions",
    aliases: ["champions league", "uefa champions", "champions", "copa de europa"]
  },
  {
    slug: "soccer/uefa.europa",
    aliases: [
      "europa league",
      "uefa europa",
      "supercopa de europa",
      "conference league",
      "europa conference"
    ]
  },
  { slug: "soccer/conmebol.libertadores", aliases: ["libertadores", "copa libertadores"] },
  { slug: "soccer/conmebol.sudamericana", aliases: ["sudamericana", "copa sudamericana"] },
  {
    slug: "soccer/fifa.world",
    aliases: ["mundial", "mundial de clubes", "world cup", "copa del mundo"]
  },
  // "Brasileirão Serie A" must resolve here, never to Italy's "Serie A".
  { slug: "soccer/bra.1", aliases: ["brasileirao", "brasileiro", "brasil", "brazil"] },
  {
    slug: "soccer/eng.1",
    aliases: ["premier league", "premier", "english premier league", "inglaterra", "england"]
  },
  {
    slug: "soccer/esp.1",
    aliases: ["laliga", "la liga", "liga espanola", "espana", "primera division espanola"]
  },
  { slug: "soccer/ita.1", aliases: ["serie a", "calcio", "italia", "italy"] },
  { slug: "soccer/ger.1", aliases: ["bundesliga", "alemania", "germany"] },
  { slug: "soccer/fra.1", aliases: ["ligue 1", "francia", "france"] },
  { slug: "soccer/mex.1", aliases: ["liga mx", "liga mexicana", "futbol mexicano", "mexico"] },
  { slug: "soccer/usa.1", aliases: ["mls", "major league soccer", "usa", "estados unidos"] },
  {
    slug: "soccer/arg.1",
    aliases: ["liga profesional", "futbol argentino", "primera division argentina", "argentina"]
  },
  {
    slug: "soccer/col.1",
    aliases: ["primera a", "categoria primera a", "liga colombiana", "colombia"]
  },
  {
    slug: "soccer/chi.1",
    aliases: ["liga chilena", "primera division de chile", "primera division chilena", "chile"]
  },
  { slug: "mma/ufc", aliases: ["ufc", "mma"] },
  { slug: "racing/f1", aliases: ["f1", "formula 1", "formula uno"] },
  { slug: "tennis/atp", aliases: ["atp"] },
  { slug: "tennis/wta", aliases: ["wta"] },
  { slug: "golf/pga", aliases: ["pga"] }
];

// Accent/punctuation folding: "Fútbol" -> "futbol", "C. A. Osasuna" -> "c a osasuna".
export function foldText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Aliases match as whole words after accent/punctuation folding. A
// multi-word alias must appear as a CONTIGUOUS phrase in the folded name, so
// "NCAA Fútbol Americano" is not stolen by the NFL row's "futbol americano".
function aliasMatches(nameWords, alias) {
  const aliasWords = foldText(alias).split(" ").filter(Boolean);
  if (!aliasWords.length) return false;
  if (aliasWords.length === 1) return nameWords.includes(aliasWords[0]);
  return nameWords.join(" ").includes(aliasWords.join(" "));
}

// The first table entry whose aliases match, or null when unmapped.
export function resolveLeagueEntry(leagueName) {
  const nameWords = foldText(leagueName).split(" ").filter(Boolean);
  if (!nameWords.length) return null;
  for (const entry of LEAGUE_SLUGS) {
    if (entry.aliases.some((alias) => aliasMatches(nameWords, alias))) return entry;
  }
  return null;
}

export function resolveLeagueSlug(leagueName) {
  const entry = resolveLeagueEntry(leagueName);
  return entry ? entry.slug : null;
}

export function espnScoreboardUrl(entry, dateKey) {
  let url = `${ESPN_SCOREBOARD_BASE}/${entry.slug}/scoreboard?dates=${dateKey}&limit=1000`;
  if (entry.groups) url += `&groups=${entry.groups}`;
  return url;
}

// The event day formatted in America/New_York as yyyyMMdd — that is how ESPN
// scopes `dates=`. With events, the day's most-common ET date wins (ties go
// to the earliest kickoff); without events the dayKey offsets from now
// (Ayer −1 day, Mañana +1). Falls back to the local date if Intl lacks the
// zone (old TVs).
let etFormatter = null;
function etDateKey(ms) {
  try {
    etFormatter =
      etFormatter ||
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
    return etFormatter.format(new Date(ms)).replace(/-/g, "");
  } catch (_) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }
}

export function espnDateForDay({ dayKey = "today", events = [], now = Date.now() } = {}) {
  const nowTs =
    Number.isFinite(Number(now)) && typeof now !== "function" ? Number(now) : Date.now();
  const dayEvents = groupEventsByDay(events, nowTs)[dayKey] || [];
  const withKickoff = dayEvents
    .map((ev) => Number(ev?.kickoffMs))
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);
  if (withKickoff.length) {
    const counts = new Map();
    for (const ms of withKickoff) {
      const key = etDateKey(ms);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    // Most-common ET date; ties go to the earliest kickoff's date.
    let best = "";
    let bestCount = 0;
    for (const ms of withKickoff) {
      const key = etDateKey(ms);
      if (counts.get(key) > bestCount) {
        best = key;
        bestCount = counts.get(key);
      }
    }
    if (best) return best;
  }
  const offset = dayKey === "yesterday" ? -1 : dayKey === "tomorrow" ? 1 : 0;
  return etDateKey(nowTs + offset * DAY_MS);
}

// normalizeNow: a function clock is called; a finite number is used as-is;
// anything else falls back to the real clock.
export function normalizeNow(now) {
  if (typeof now === "function") return Number(now()) || 0;
  const num = Number(now);
  return Number.isFinite(num) && num > 0 ? num : Date.now();
}

// ESPN ships team colours as bare hex ("288A00"). Normalize to "#288A00";
// anything that is not exactly 3 or 6 hex digits (with or without #) is
// invalid and degrades to "" — the renderer falls back to the card colour.
export function normalizeTeamColor(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw) && !/^[0-9a-fA-F]{3}$/.test(raw)) return "";
  if (raw.length === 3) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toUpperCase();
  }
  return `#${raw.toUpperCase()}`;
}

function finiteScore(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// One ESPN competitor -> the side object. Sides are derived from `homeAway`,
// NEVER from the array order (measured: ESPN listed Patriots@Packers with the
// home team second).
function parseSide(competitor) {
  const team = competitor?.team ?? {};
  const name = String(team.displayName ?? "").trim();
  if (!name) return null;
  return {
    name,
    shortName: String(team.shortDisplayName ?? "").trim(),
    abbr: String(team.abbreviation ?? "").trim(),
    color: normalizeTeamColor(team.color) || normalizeTeamColor(team.alternateColor),
    logo: String(team.logo ?? "").trim(),
    score: finiteScore(competitor?.score),
    record: String(competitor?.records?.[0]?.summary ?? "").trim()
  };
}

// One ESPN event -> the unified SportsEvent. Garbage rows are dropped, never
// thrown: a malformed league payload must not break the round.
// parseScoreboard never guesses the league slug — the round attaches the slug
// it fetched (one payload per slug, so the mapping is exact).
export function parseScoreboardEvent(event, slug = "", meta = {}) {
  const comp = Array.isArray(event?.competitions) ? event.competitions[0] : null;
  if (!comp) return null;
  const status = event?.status ?? comp?.status ?? {};
  const state = String(status?.type?.state ?? "").toLowerCase();
  if (state !== "pre" && state !== "in" && state !== "post") return null;
  const kickoffMs = Date.parse(comp?.date ?? event?.date ?? "");
  let home = null;
  let away = null;
  for (const competitor of Array.isArray(comp?.competitors) ? comp.competitors : []) {
    const side = parseSide(competitor);
    if (!side) continue;
    if (competitor?.homeAway === "home") home = side;
    else if (competitor?.homeAway === "away") away = side;
  }
  if (!home || !away) return null;
  const id = String(event?.id ?? "").trim();
  const firstKickoff = Number.isFinite(kickoffMs) ? kickoffMs : 0;
  return {
    // Stable non-empty id even when ESPN omits the event id (older payloads).
    id: id || `${slug}:${firstKickoff}:${foldText(away.name)}@${foldText(home.name)}`,
    slug,
    sportType: String(slug ?? "").split("/")[0],
    leagueName: String(meta.leagueName ?? "").trim(),
    leagueAbbr: String(meta.leagueAbbr ?? "").trim(),
    leagueLogo: String(meta.leagueLogo ?? "").trim(),
    state,
    // Derived partition fields so buildSections/partitionEvents consume the
    // event unchanged (status: finished | live | scheduled).
    status: state === "post" ? "finished" : state === "in" ? "live" : "scheduled",
    live: state === "in",
    kickoffMs: firstKickoff,
    statusText: String(status?.type?.shortDetail ?? "").trim(),
    period: Number.isFinite(Number(status?.period)) ? Number(status.period) : 0,
    clock: String(status?.displayClock ?? "").trim(),
    situation: String(comp?.situation?.downDistanceText ?? "").trim(),
    home,
    away
  };
}

export function parseScoreboard(payload, slug = "") {
  const rows = Array.isArray(payload?.events) ? payload.events : [];
  const league = Array.isArray(payload?.leagues) ? payload.leagues[0] : null;
  const meta = {
    leagueName: league?.name,
    leagueAbbr: league?.abbreviation,
    leagueLogo: league?.logos?.[0]?.href
  };
  const events = [];
  for (const row of rows) {
    const parsed = parseScoreboardEvent(row, slug, meta);
    if (parsed) events.push(parsed);
  }
  return events;
}

// One bounded fetch: the verdict (fetch AND body read) races the per-request
// timer, so a hanging response can never exceed the budget. No retries.
export async function fetchJsonBounded(fetchFn, url, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchFn(url, {});
        if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
        return await response.json();
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

// Accent-folded whole-word containment in either direction: the shorter name's
// words must all appear in the longer name's words ("Packers" matches "Green
// Bay Packers"; "Green" does not match "Packers").
export function teamNameMatches(eventTeamName, espnTeamName) {
  const a = foldText(eventTeamName).split(" ").filter(Boolean);
  const b = foldText(espnTeamName).split(" ").filter(Boolean);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((word) => long.includes(word));
}
