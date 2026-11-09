// ESPN live scores for the lightweight Sports screen: ONE bounded round of
// scoreboard fetches per day — measured against the Android TV reference app
// in this monorepo and verified with curl from this machine (ESPN answers
// `access-control-allow-origin: *`, so the browser/TV can call it directly):
//
//   GET https://site.api.espn.com/apis/site/v2/sports/<sport>/<league>/scoreboard
//       ?dates=yyyyMMdd&limit=1000[&groups=NN]
//
// - The date is the event day formatted in America/New_York (that is how ESPN
//   scopes `dates=`).
// - College rows add `&groups=80` (football) or `&groups=50` (basketball);
//   ranges are rejected by ESPN, so one call per league per day.
//
// COST CONTRACT (owner TV: 1 GB class, 120 MB app cap — the Android app's
// 3 days × ~40 leagues ≈ 120 requests every 10 s is unacceptable here):
//   - the feed's leagueName is mapped through a SMALL CURATED table (below);
//     unmapped leagues simply get no score — a comment marks that on purpose.
//   - one request per distinct mapped league in the visible day, capped at
//     8 slugs per round (extra leagues are logged and skipped),
//   - 1200 ms per request, an overall round cap, a 60 s TTL cache per
//     slug|date, and a failed league never poisons the round.
import { groupEventsByDay } from "./sportsFeed.js";

export const ESPN_SCOREBOARD_BASE = "https://site.api.espn.com/apis/site/v2/sports";
export const ESPN_MAX_SLUGS_PER_ROUND = 8;
export const ESPN_REQUEST_TIMEOUT_MS = 1200;
// Overall round cap: below the serial worst case (8 × 1200 ms).
export const ESPN_ROUND_BUDGET_MS = 8000;
export const ESPN_CACHE_TTL_MS = 60000;
// matchScore window: kickoff within 20 minutes, both names matching.
export const ESPN_MATCH_WINDOW_MS = 20 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// The curated leagueName → ESPN slug table. ORDER MATTERS: entries are tried
// in order and the first match wins, so specific competitions (mundial,
// continental cups, "Brasileirão Série A") sit BEFORE the domestic leagues
// whose names they contain ("Serie A", "La Liga"). Aliases match as whole
// words after accent/punctuation folding ("La Liga EA Sports" hits "la liga";
// "Australia" does NOT hit the "usa" alias). A leagueName that matches nothing
// resolves to null and its matches simply carry no score — deliberate: an
// unmapped league must never cost a request, and a wrong guess would cost a
// wrong score.
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
function foldText(value) {
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

function finiteScore(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// One ESPN event -> the compact game shape. Garbage rows are dropped, never
// thrown: a malformed league payload must not break the round.
// parseScoreboard never guesses the league slug — the round attaches the slug
// it fetched (one payload per slug, so the mapping is exact).
export function parseScoreboardEvent(event, slug = "") {
  const comp = Array.isArray(event?.competitions) ? event.competitions[0] : null;
  if (!comp) return null;
  const status = event?.status ?? comp?.status ?? {};
  const state = String(status?.type?.state ?? "").toLowerCase();
  if (state !== "pre" && state !== "in" && state !== "post") return null;
  const kickoffMs = Date.parse(comp?.date ?? event?.date ?? "");
  let home = null;
  let away = null;
  for (const competitor of Array.isArray(comp?.competitors) ? comp.competitors : []) {
    const name = String(competitor?.team?.displayName ?? "").trim();
    if (!name) continue;
    const side = {
      name,
      score: finiteScore(competitor?.score),
      record: String(competitor?.records?.[0]?.summary ?? "").trim()
    };
    if (competitor?.homeAway === "home") home = side;
    else if (competitor?.homeAway === "away") away = side;
  }
  if (!home || !away) return null;
  return {
    slug,
    kickoffMs: Number.isFinite(kickoffMs) ? kickoffMs : 0,
    state,
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
  const games = [];
  for (const row of rows) {
    const game = parseScoreboardEvent(row, slug);
    if (game) games.push(game);
  }
  return games;
}

// One bounded fetch: the verdict (fetch AND body read) races the per-request
// timer, so a hanging response can never exceed the budget. No retries.
async function fetchJsonBounded(fetchFn, url, timeoutMs) {
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

// TTL cache per slug|date; the default fetch arms only in a real browser/TV
// context, so importing this module in node --test never touches the network.
const scoreCache = new Map();

export function clearScoreCache() {
  scoreCache.clear();
}

function normalizeNow(now) {
  if (typeof now === "function") return Number(now()) || 0;
  const num = Number(now);
  return Number.isFinite(num) && num > 0 ? num : Date.now();
}

// One scored round for the visible day:
//   - derive the DISTINCT slugs present in that day's events (unmapped
//     leagues are skipped silently — no score for them, by design),
//   - cap the round at ESPN_MAX_SLUGS_PER_ROUND and log the skipped leagues,
//   - fetch each league's scoreboard with the per-request and overall budgets,
//   - serve repeats from the 60 s TTL cache (a failed league is not cached, so
//     the next round retries it),
//   - a failed league never poisons the round: whatever succeeded is returned.
// Returns { dateKey, slugs, skipped, games } — games carry the compact shape
// documented at the top plus `slug`.
export async function scoresForDay({ dayKey = "today", events = [], fetchImpl = null, now } = {}) {
  const nowFn = () => normalizeNow(now);
  const nowTs = nowFn();
  const dayEvents = groupEventsByDay(events, nowTs)[dayKey] || [];
  const dateKey = espnDateForDay({ dayKey, events, now: nowTs });

  // Spend the round on the leagues that actually have a match in progress: the cap
  // is a hard budget, and a score only changes while it is live. Measured before
  // this ordering existed: four big leagues (Premier, MLS, Liga MX, PGA) were
  // dropped in favour of whatever came first in the feed.
  const byslug = new Map();
  for (const ev of dayEvents) {
    const entry = resolveLeagueEntry(ev?.leagueName);
    if (!entry) continue;
    const live = ev?.live === true || String(ev?.status || "").toLowerCase() === "live" ? 1 : 0;
    const kickoff = Number(ev?.kickoffMs) || Number.MAX_SAFE_INTEGER;
    const current = byslug.get(entry.slug);
    if (!current) {
      byslug.set(entry.slug, { entry, liveCount: live, firstKickoff: kickoff });
    } else {
      current.liveCount += live;
      current.firstKickoff = Math.min(current.firstKickoff, kickoff);
    }
  }
  const ordered = [...byslug.values()].sort(
    (a, b) => b.liveCount - a.liveCount || a.firstKickoff - b.firstKickoff
  );
  const entries = ordered.slice(0, ESPN_MAX_SLUGS_PER_ROUND).map((x) => x.entry);
  const skipped = ordered.slice(ESPN_MAX_SLUGS_PER_ROUND).map((x) => x.entry.slug);
  if (skipped.length) {
    // Cost control is a deliberate contract: say WHICH leagues were dropped.
    console.warn(
      `espnScores: ${skipped.length} league(s) skipped this round (cap ${ESPN_MAX_SLUGS_PER_ROUND}): ${skipped.join(", ")}`
    );
  }

  const fetchFn =
    fetchImpl ||
    (typeof window !== "undefined" && typeof fetch === "function" ? fetch.bind(globalThis) : null);

  const games = [];
  const roundStart = nowFn();
  for (const entry of entries) {
    if (nowFn() - roundStart >= ESPN_ROUND_BUDGET_MS) {
      console.warn(
        `espnScores: round budget (${ESPN_ROUND_BUDGET_MS}ms) reached; remaining leagues skipped`
      );
      break;
    }
    const cacheKey = `${entry.slug}|${dateKey}`;
    const cached = scoreCache.get(cacheKey);
    if (cached && cached.expiresAt > nowFn()) {
      games.push(...cached.games);
      continue;
    }
    if (!fetchFn) break; // no fetch available: an empty round, never a throw
    try {
      const payload = await fetchJsonBounded(
        fetchFn,
        espnScoreboardUrl(entry, dateKey),
        ESPN_REQUEST_TIMEOUT_MS
      );
      const parsed = parseScoreboard(payload, entry.slug);
      scoreCache.set(cacheKey, { expiresAt: nowFn() + ESPN_CACHE_TTL_MS, games: parsed });
      games.push(...parsed);
    } catch (_) {
      // Failed league: not cached, does not poison the round.
    }
  }

  return { dateKey, slugs: entries.map((entry) => entry.slug), skipped, games };
}

// matchScore(event, scores): the rule the TV app uses — kickoff within 20
// minutes AND both team names matching after accent/punctuation folding with
// whole-word containment in either home/away order. Zero or MORE than one
// candidate is ambiguous (or absent) and returns null: never guess a score.
function teamNameMatches(eventTeamName, espnTeamName) {
  const a = foldText(eventTeamName).split(" ").filter(Boolean);
  const b = foldText(espnTeamName).split(" ").filter(Boolean);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((word) => long.includes(word));
}

function eventMatchesGame(event, game) {
  const kickoff = Number(event?.kickoffMs);
  const gameKickoff = Number(game?.kickoffMs);
  if (!Number.isFinite(kickoff) || !Number.isFinite(gameKickoff)) return false;
  if (Math.abs(kickoff - gameKickoff) > ESPN_MATCH_WINDOW_MS) return false;
  const names = (Array.isArray(event?.teams) ? event.teams : [])
    .map((team) => String(team?.name ?? "").trim())
    .filter(Boolean);
  if (names.length < 2) return false;
  const home = game?.home?.name ?? "";
  const away = game?.away?.name ?? "";
  if (!home || !away) return false;
  return (
    (teamNameMatches(names[0], home) && teamNameMatches(names[1], away)) ||
    (teamNameMatches(names[0], away) && teamNameMatches(names[1], home))
  );
}

export function matchScore(event, scores) {
  const list = Array.isArray(scores) ? scores : [];
  const matches = list.filter((game) => game && eventMatchesGame(event, game));
  return matches.length === 1 ? matches[0] : null;
}
