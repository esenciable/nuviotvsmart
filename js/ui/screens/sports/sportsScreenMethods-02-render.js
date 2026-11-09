/* eslint-disable no-unused-vars */
import * as internals from "./sportsScreen.js";

// Rendering for the rebuilt Sports screen — measured against the Android TV
// reference app (SportsDesign.kt / SportsScreen.kt / SportsUi.kt, 1280x720,
// scaled ×1.5 for this 1920x1080 surface; dp→px below).
//
// THE CARD: ONE structure for every state (pre/in/post) — league column,
// two stacked team bands, right status column, chevron. Nothing may look like
// a different component. The schedule comes from ESPN (espnSchedule.js); the
// addon feed is ONLY the stream source.
//
//   STATIC LAYOUT CONTRACT: every box has a fixed size; a focus move only
//   toggles classes and calls node.focus() — no resize, no re-render, no
//   per-keypress DOM measurement. Focus scales the card 1.02 with a solid
//   white border, instant — no transition (the border is always painted, so
//   no size ever changes).
//
// Styles are inlined because the screen ships without a dedicated stylesheet.

import { buildDayWindow, DAY_WINDOW_RADIUS, formatKickoffDayLabel } from "../../../core/sports/espnScores.js";

// Fixed geometry of a match card: 86dp = 129px tall + 8dp = 12px gap. The
// constant is the layout contract — the card never grows with its content
// (long team names clamp to one line inside the fixed bands).
export const SPORTS_ROW_HEIGHT = 129;
export const SPORTS_ROW_GAP = 12;

// The 15-day chip window: 7 days back, today, 7 days forward. The chips are
// built FRESH on every render (labels follow the real calendar — today is
// always "Hoy"), so a TV left on overnight never shows stale labels.
export const SPORTS_DAY_WINDOW_RADIUS = DAY_WINDOW_RADIUS;
export { buildDayWindow };

export const SPORTS_REFRESH_LABEL = "Actualizar";
export const SPORTS_FILTER_PILL_LABEL = "Todos los eventos";

// Honest-state copy. Never a blank panel, never a spinner that stays forever
// (every fetch is bounded by a timeout).
export const SPORTS_LOADING_TEXT = "Cargando partidos…";
export const SPORTS_EMPTY_TEXT = "No hay partidos hoy";
export const SPORTS_LOAD_ERROR_TEXT = "No se pudieron cargar los partidos";
export const SPORTS_NO_SIGNAL_TEXT = "No hay señal para este partido";
export const SPORTS_RESOLVING_TEXT = "Buscando señal…";
// The addon has no event matching this ESPN match: the addon is ONLY the
// stream source, so no match means there is nothing to play. Never open a
// player without a link.
export const SPORTS_NO_LINK_TEXT = "No hay enlace para este partido";

// ESPN scored round cadence: one bounded round every 60 s, only while the
// screen is mounted AND the document is visible (see methods-01). The cache
// lives in espnSchedule.js; the timer here is a chained setTimeout — no
// repeating interval primitive.
export const SPORTS_SCORES_REFRESH_MS = 60000;

// Probe failure (the addon answered but NO stream URL actually serves the
// playlist): the honest copy carries the count of streams tried. The card keeps
// its focus, so Enter retries the whole resolve+probe.
export function probeFailedNoticeText(triedCount) {
  const count = Math.floor(Number(triedCount) || 0);
  if (count <= 0) return "La señal del addon no responde";
  return `La señal del addon no responde (${count} ${count === 1 ? "señal probada" : "señales probadas"})`;
}

// Inline pending notice: the addon's retryAfterMs rounded to seconds. A
// missing/zero retry hint falls back to the generic one-liner.
export function pendingNoticeText(retryAfterMs) {
  const seconds = Math.round(Number(retryAfterMs) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "Señal no lista. Inténtalo de nuevo en un momento";
  }
  return `Señal no lista. Reintenta en ${seconds} s`;
}

export const SPORTS_PICKER_TITLE = "Elige una señal";
export const SPORTS_PICKER_UNVERIFIED_LABEL = "no verificada";

// The picker row label: the stream's `name` and `resolution`, plus the
// addon's own unverified marker when it declares `verified: false`. Never
// invented. Fallbacks: the stream's `title`, then a numbered "Señal N".
export function sourcePickerOptionLabel(stream, index = 0) {
  const ordinal = Math.floor(Number(index) || 0) + 1;
  const name = String(stream?.name ?? "").trim() || String(stream?.title ?? "").trim() || `Señal ${ordinal}`;
  const resolution = String(stream?.resolution ?? "").trim();
  return [name, resolution, stream?.verified === false ? SPORTS_PICKER_UNVERIFIED_LABEL : ""].filter(Boolean).join(" · ");
}

// The scheduled card's footer line under the bands:
//   "jue 12 nov · 19:30 · Stadion Ergilio Hato"
// Day label (local), local kickoff time and the venue when ESPN provides one
// (comp.venue.fullName); the venue degrades out gracefully when absent.
// Only for matches that have NOT started — live and finished cards keep the
// fixed geometry with no extra line.
export function scheduleFooterText(event) {
  if (String(event?.state ?? "") !== "pre") return "";
  const ms = Number(event?.kickoffMs);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const day = formatKickoffDayLabel(ms);
  const time = internals.formatKickoffTime(ms);
  const venue = String(event?.venue ?? "").trim();
  return [day, time, venue].filter(Boolean).join(" · ");
}

// One row per playable source, in the addon's stable order.
export function buildSourcePickerRows(streams) {
  return (Array.isArray(streams) ? streams : []).map((stream, index) => ({
    index,
    name: String(stream?.name ?? "").trim() || String(stream?.title ?? "").trim() || `Señal ${index + 1}`,
    resolution: String(stream?.resolution ?? "").trim(),
    unverified: stream?.verified === false,
    label: sourcePickerOptionLabel(stream, index)
  }));
}

// The two ESPN team names ("A vs B"), or a neutral placeholder.
export function matchRowTitle(event) {
  const home = String(event?.home?.name ?? "").trim();
  const away = String(event?.away?.name ?? "").trim();
  if (home && away) return `${home} vs ${away}`;
  return home || away || "Partido";
}

// Card helpers (measured spec) ----------------------------------------------

// Spanish period ordinal like the reference app shows it: 4º · 3:47.
export function periodOrdinal(period) {
  const p = Math.floor(Number(period) || 0);
  if (p <= 0) return "";
  return `${p}º`;
}

export function formatPeriodClock(period, clock) {
  return [periodOrdinal(period), String(clock ?? "").trim()].filter(Boolean).join(" · ");
}

// Countdown for a scheduled match, only while the start is under 6 h away:
// "en 12 min" / "en 1 h 51" / "en 2 h". Otherwise "" (the line stays empty).
export function countdownText(kickoffMs, now = Date.now()) {
  const kickoff = Number(kickoffMs);
  if (!Number.isFinite(kickoff) || kickoff <= Number(now)) return "";
  const minutes = Math.round((kickoff - Number(now)) / 60000);
  if (minutes >= 360) return "";
  if (minutes < 60) return `en ${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `en ${hours} h ${rem}` : `en ${hours} h`;
}

// Progress fraction, honestly computable or null. Elapsed share of the game
// from the period number against the league's known period count: football and
// basketball 4 quarters, hockey 3 periods, soccer 2 halves, baseball 9
// innings. Sports without a period count (golf, tennis, racing, boxing…) have
// NO bar — an invented fraction would be a meaningless number, the exact
// complaint this rebuild answers.
const PERIOD_COUNTS = {
  football: 4,
  basketball: 4,
  hockey: 3,
  baseball: 9,
  soccer: 2
};

export function liveProgressFraction(event) {
  if (String(event?.state ?? "") !== "in") return null;
  const total = PERIOD_COUNTS[String(event?.sportType ?? "")];
  if (!total) return null;
  const period = Math.floor(Number(event?.period) || 0);
  if (period <= 0) return 0;
  return Math.max(0, Math.min(1, period / total));
}

// Status ordinal for POSTPONED / CANCELLED / SUSPENDED style ESPN payloads:
// the state is still "pre" but the shortDetail names the disruption.
const OFF_STATUS_PATTERN = /postpon|cancel|suspend|suspendido|pospuesto|cancelado|aplazad|retrasad/i;

// The status column's content from the unified event. Same column, every
// state: live → red ● EN VIVO + period · clock; post → FINAL + the kickoff
// time; pre → the local kickoff time + the countdown (under 6 h only); an
// ESPN off-status → the status in caps.
export function scoreStatusView(event, now = Date.now()) {
  const state = String(event?.state ?? "");
  const statusText = String(event?.statusText ?? "").trim();
  if (state !== "in" && statusText && OFF_STATUS_PATTERN.test(statusText)) {
    return {
      kind: "off",
      badge: statusText.toUpperCase(),
      badgeClass: "sports-status-badge is-off",
      main: "",
      sub: "",
      situation: "",
      progress: null
    };
  }
  if (state === "in") {
    return {
      kind: "live",
      badge: "● EN VIVO",
      badgeClass: "sports-status-badge is-live",
      main: formatPeriodClock(event?.period, event?.clock),
      sub: "",
      // The down/distance line is a FOOTBALL thing: ESPN only provides it for
      // football, and the reference app only shows it there.
      situation: String(event?.sportType ?? "") === "football" ? String(event?.situation ?? "").trim() : "",
      progress: liveProgressFraction(event)
    };
  }
  if (state === "post") {
    return {
      kind: "final",
      badge: "FINAL",
      badgeClass: "sports-status-badge is-final",
      main: internals.formatKickoffTime(event?.kickoffMs) || "",
      sub: "",
      situation: "",
      progress: null
    };
  }
  return {
    kind: "time",
    badge: internals.formatKickoffTime(event?.kickoffMs) || "--:--",
    badgeClass: "sports-status-badge is-time",
    main: countdownText(event?.kickoffMs, now),
    sub: "",
    situation: "",
    progress: null
  };
}

// Band gradient colour: the team colour darkened toward #0B0C10 — lerp 0.50
// when the colour is light, 0.25 mid, 0.08 dark (relative luminance). A
// missing or invalid colour falls back to #3A4150, never yellow, never NaN.
const BAND_FALLBACK_COLOR = "#3A4150";
const BAND_DARK_ANCHOR = { r: 0x0b, g: 0x0c, b: 0x10 };

function hexToRgb(hex) {
  const raw = String(hex ?? "")
    .trim()
    .replace(/^#/, "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}

function relativeLuminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// The darkened base colour of a team band: lerp(teamColour, #0B0C10, t).
export function bandBaseColor(color) {
  const rgb = hexToRgb(color);
  if (!rgb) return BAND_FALLBACK_COLOR;
  const lum = relativeLuminance(rgb);
  const t = lum > 0.6 ? 0.5 : lum > 0.25 ? 0.25 : 0.08;
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((c, i) => lerp(c, [BAND_DARK_ANCHOR.r, BAND_DARK_ANCHOR.g, BAND_DARK_ANCHOR.b][i], t))
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

// The band's horizontal gradient: team base colour alpha .92 at 0%, .28 at
// 70%, .05 at 100% (the reference card's tint dies toward the right edge).
export function bandGradient(color) {
  const base = hexToRgb(bandBaseColor(color));
  if (!base) return BAND_FALLBACK_COLOR; // solid fallback, no gradient
  const rgba = (alpha) => `rgba(${base.r}, ${base.g}, ${base.b}, ${alpha})`;
  return `linear-gradient(90deg, ${rgba(0.92)} 0%, ${rgba(0.28)} 70%, ${rgba(0.05)} 100%)`;
}

// Up to two uppercase initials from the team name — the fallback mark when
// ESPN provides no logo.
export function teamInitials(name) {
  const words = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

// Is this side the trailing team (a leader exists and this side has fewer
// points)? Tied or scoreless games have no trailing side.
function isTrailing(side, other) {
  if (side?.score == null || other?.score == null) return false;
  return side.score < other.score;
}

// ONE card for every state. Structure, left to right:
//   league column (72px, fixed) → team bands (flex, two stacked) →
//   status column (177px, fixed) → chevron.
// Home band on top (broadcast order comes from the reference app: the HOME
// team leads the card), away below. The HOME/away sides are derived from
// ESPN's homeAway, never from payload order.
export function renderMatchCard(event, index) {
  const esc = internals.escapeHtml;
  const status = scoreStatusView(event);
  const home = event?.home ?? {};
  const away = event?.away ?? {};

  const band = (side, other) => {
    // The gradient ALWAYS applies; a missing/invalid team colour only falls
    // back to the measured #3A4150 base. Never yellow, never NaN.
    const background = `background: ${bandGradient(side?.color)};`;
    const trailing = isTrailing(side, other);
    const nameClass = trailing ? "sports-team-name is-trailing" : "sports-team-name";
    const scoreClass = trailing ? "sports-team-score is-trailing" : "sports-team-score";
    const logo = String(side?.logo ?? "").trim();
    const initials = teamInitials(side?.name);
    const logoContent = logo
      ? `<img class="sports-team-logo" src="${esc(logo)}" alt="" onerror="this.style.display='none'" />`
      : initials
        ? `<span class="sports-team-logo-fallback">${esc(initials)}</span>`
        : "";
    // A PRE-game score slot stays EMPTY even when ESPN carries a 0: a game
    // that has not started has no score, and a meaningless digit is exactly
    // the complaint this rebuild answers.
    const showScore = String(event?.state ?? "") !== "pre" && side?.score != null;
    const scoreValue = showScore ? esc(String(side.score)) : "";
    const record = String(side?.record ?? "").trim();
    return `
        <div class="sports-team-band" style="${background}">
          <span class="sports-team-logo-box">${logoContent}</span>
          <span class="sports-team-text">
            <span class="${nameClass}">${esc(side?.name || "—")}</span>
            ${record ? `<span class="sports-team-record">récord ${esc(record)}</span>` : ""}
          </span>
          <span class="${scoreClass}">${scoreValue}</span>
        </div>`;
  };

  const leagueMark = String(event?.leagueLogo ?? "").trim()
    ? `<img class="sports-league-logo" src="${esc(event.leagueLogo)}" alt="" onerror="this.style.display='none'" />`
    : `<span class="sports-league-abbr">${esc(event?.leagueAbbr || event?.slug || "")}</span>`;

  const situationLine =
    status.kind === "live" && status.situation ? `<span class="sports-status-situation">${esc(status.situation)}</span>` : "";
  const progressLine =
    status.progress != null
      ? `<span class="sports-status-progress"><span class="sports-status-progress-fill" style="width: ${Math.round(status.progress * 100)}%"></span></span>`
      : "";
  // Scheduled card footer: day · time · venue, INSIDE the fixed card — the
  // bands shrink, the card never grows past its measured 129px.
  const footerText = scheduleFooterText(event);
  const footerLine = footerText ? `<div class="sports-schedule-footer">${esc(footerText)}</div>` : "";

  return `
      <div class="sports-row focusable" role="button"
           data-row-index="${index}" data-row-type="match" data-event-id="${esc(event?.id ?? "")}">
        <div class="sports-league-col">${leagueMark}</div>
        <div class="sports-bands">
          ${band(home, away)}
          ${band(away, home)}
          ${footerLine}
        </div>
        <div class="sports-row-status">
          <span class="${status.badgeClass}">${esc(status.badge)}</span>
          ${status.main ? `<span class="sports-status-main">${esc(status.main)}</span>` : ""}
          ${situationLine}
          ${progressLine}
        </div>
        <span class="sports-row-chevron">›</span>
      </div>`;
}

// Flat focus model for the list: one entry per focusable row, in paint order
// — every section header (focusable so the order never depends on data),
// then its match cards. FINALIZADOS contributes cards only when expanded.
export function buildMatchRows(sections, finishedExpanded) {
  const rows = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    const key = String(section?.key ?? "");
    const collapsed = key === "finished" && !finishedExpanded;
    rows.push({
      type: "header",
      sectionKey: key,
      label: String(section?.label ?? ""),
      count: Array.isArray(section?.events) ? section.events.length : 0,
      collapsible: key === "finished",
      collapsed
    });
    if (!collapsed) {
      for (const event of Array.isArray(section?.events) ? section.events : []) {
        rows.push({ type: "match", sectionKey: key, event });
      }
    }
  }
  return rows;
}

export function createSportsScreenMethods02() {
  const { ScreenUtils, escapeHtml } = internals;

  const STYLE = `
    <style id="sports-screen-style">
      /* Measured from the Android TV reference (dp × 1.5). STATIC LAYOUT
         CONTRACT: fixed sizes everywhere; focus toggles the border colour and
         scales 1.02 — no transition, no layout change. NO YELLOW ANYWHERE. */
      .sports-shell { position: absolute; inset: 0; width: 100%; height: 100%; display: flex; flex-direction: column; background: #0B0B0B; color: #FFFFFF; overflow: hidden; }
      /* Header glow: a 330px lit wash above the content — vertical #1A1A1A
         fade plus two soft radial #F5F5F5 washes (the reference's lit look). */
      .sports-glow { position: absolute; top: 0; left: 0; right: 0; height: 330px; pointer-events: none;
        background:
          radial-gradient(ellipse 60% 100% at 20% 0%, rgba(245,245,245,0.08), transparent 70%),
          radial-gradient(ellipse 60% 100% at 80% 0%, rgba(245,245,245,0.032), transparent 70%),
          linear-gradient(180deg, rgba(26,26,26,0.85), rgba(26,26,26,0)); }
      /* HEADER ---------------------------------------------------------------- */
      .sports-header { flex-shrink: 0; position: relative; padding: 30px 54px 0 84px; box-sizing: border-box; }
      .sports-title { font-size: 39px; line-height: 48px; height: 48px; font-weight: 900; color: #FFFFFF; white-space: nowrap; }
      .sports-day-row { display: flex; align-items: center; gap: 6px; margin-top: 10px; height: 45px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
      .sports-day-row::-webkit-scrollbar { display: none; }
      .sports-chip { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; height: 45px; padding: 0 18px; background: transparent; border: 2.25px solid transparent; border-radius: 22.5px; outline: none; font-size: 18px; line-height: 24px; font-weight: 700; color: #8B90A0; cursor: pointer; box-sizing: border-box; white-space: nowrap; }
      .sports-chip.focused { border-color: #FFFFFF; }
      .sports-chip.is-selected { background: rgba(245,245,245,0.14); border-color: rgba(245,245,245,1); color: #FFFFFF; }
      .sports-refresh { margin-left: auto; }
      /* The single filter pill: fixed 48px, icon + label. */
      .sports-filter-row { display: flex; align-items: center; margin-top: 10px; height: 48px; }
      .sports-filter-pill { flex-shrink: 0; display: inline-flex; align-items: center; gap: 9px; height: 48px; padding: 0 18px; background: rgba(30,33,44,0.678); border: 1.5px solid rgba(255,255,255,0.20); border-radius: 24px; outline: none; font-size: 18px; line-height: 24px; font-weight: 800; color: #FFFFFF; cursor: pointer; box-sizing: border-box; white-space: nowrap; }
      .sports-filter-icon { font-size: 18px; }
      .sports-filter-pill.focused { background: rgba(40,44,58,0.722); border: 3px solid #FFFFFF; }
      .sports-filter-count { color: #8B90A0; font-weight: 700; }
      /* LIST ------------------------------------------------------------------ */
      .sports-list { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; scroll-behavior: auto; padding: 6px 54px 39px 84px; display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; }
      .sports-section-header { flex-shrink: 0; display: flex; align-items: center; gap: 10.5px; height: 44px; padding: 0; outline: 2px solid transparent; outline-offset: -2px; font-size: 16.5px; line-height: 22px; font-weight: 900; color: #C9CCD6; letter-spacing: 0.06em; cursor: pointer; box-sizing: border-box; }
      .sports-section-header .sports-live-dot { width: 12px; height: 12px; border-radius: 50%; background: #E53935; flex-shrink: 0; }
      .sports-section-header.is-live-section { color: #FFFFFF; }
      .sports-section-header.focused { outline-color: #FFFFFF; }
      .sports-section-count { margin-left: auto; color: #8B90A0; font-weight: 700; }
      .sports-section-chevron { color: #8B90A0; }
      /* THE CARD: one structure for every state. Height 129px (86dp), radius
         21px (14dp), glass background, 1.5px white@0.20 border INSIDE — the
         border is always painted so focus never changes the size. */
      .sports-row { position: relative; flex-shrink: 0; display: flex; align-items: stretch; height: 129px; background: rgba(30,33,44,0.678); border: 1.5px solid rgba(255,255,255,0.20); border-radius: 21px; cursor: pointer; box-sizing: border-box; overflow: hidden; outline: none; }
      .sports-row.focused { border-color: #FFFFFF; transform: scale(1.02); }
      .sports-league-col { flex-shrink: 0; width: 72px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.03); border-right: 1.5px solid rgba(255,255,255,0.08); }
      .sports-league-logo { width: 42px; height: 42px; object-fit: contain; }
      .sports-league-abbr { font-size: 16.5px; font-weight: 900; color: #8B90A0; text-transform: uppercase; }
      .sports-bands { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      /* TEAM BAND: horizontal team-colour gradient (inline), logo box, name +
         record stacked, big right-aligned tabular score. ~64.5px each. */
      .sports-team-band { flex: 1; min-height: 0; display: flex; align-items: center; gap: 13.5px; padding: 0 9px 0 13.5px; min-width: 0; }
      .sports-team-logo-box { position: relative; flex-shrink: 0; width: 45px; height: 45px; display: flex; align-items: center; justify-content: center; background: radial-gradient(circle at 50% 50%, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.16) 43%, rgba(255,255,255,0) 44%); }
      .sports-team-logo { width: 45px; height: 45px; object-fit: contain; }
      .sports-team-logo-fallback { width: 38.7px; height: 38.7px; display: flex; align-items: center; justify-content: center; border: 2.25px solid rgba(255,255,255,0.85); border-radius: 50%; font-size: 11.7px; font-weight: 900; color: #FFFFFF; box-sizing: border-box; }
      .sports-team-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .sports-team-name { font-size: 19.5px; line-height: 24px; font-weight: 800; color: #FFFFFF; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sports-team-name.is-trailing { color: rgba(255,255,255,0.75); }
      .sports-team-record { font-size: 13.3px; line-height: 17px; font-weight: 600; color: rgba(255,255,255,0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sports-team-score { flex-shrink: 0; min-width: 40px; padding: 0 7.5px; text-align: right; font-size: 33px; line-height: 36px; font-weight: 900; color: #FFFFFF; font-variant-numeric: tabular-nums; }
      .sports-team-score.is-trailing { color: rgba(255,255,255,0.50); }
      /* STATUS COLUMN: 177px fixed, left divider, vertically centred. */
      .sports-row-status { flex-shrink: 0; width: 177px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 4.5px; border-left: 1.5px solid rgba(255,255,255,0.08); padding: 0 30px 0 16.5px; box-sizing: border-box; overflow: hidden; }
      .sports-status-badge { display: inline-flex; align-items: center; max-width: 100%; border-radius: 7.5px; padding: 2.25px 9px; font-size: 13.5px; line-height: 18px; font-weight: 900; color: #FFFFFF; white-space: nowrap; }
      .sports-status-badge.is-live { background: #E53935; }
      .sports-status-badge.is-time { background: rgba(255,255,255,0.10); }
      .sports-status-badge.is-final { background: rgba(255,255,255,0.12); }
      .sports-status-badge.is-off { background: rgba(255,138,128,0.20); color: #FF8A80; }
      .sports-status-main { font-size: 18px; line-height: 24px; font-weight: 900; color: #FFFFFF; white-space: nowrap; }
      .sports-status-situation { max-width: 100%; font-size: 13.5px; line-height: 18px; color: #AAB0BE; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sports-status-progress { width: 100%; height: 4.5px; border-radius: 3px; background: rgba(255,255,255,0.14); overflow: hidden; }
      .sports-status-progress-fill { display: block; height: 100%; border-radius: 3px; background: #E53935; }
      /* SCHEDULED FOOTER: a fixed 18px line inside the bands column, under
         the two bands — the card stays 129px, the bands shrink around it. */
      .sports-schedule-footer { flex-shrink: 0; display: flex; align-items: center; height: 18px; padding: 0 13.5px; box-sizing: border-box; font-size: 12px; line-height: 14px; font-weight: 700; color: #8B90A0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-top: 1px solid rgba(255,255,255,0.06); }
      .sports-row-chevron { flex-shrink: 0; align-self: center; padding-right: 10.5px; font-size: 24px; line-height: 28px; color: #8B90A0; }
      .sports-state { display: flex; align-items: center; color: #8B90A0; font-size: 19.5px; padding: 20px 4px; }
      .sports-state.is-error { color: #FF8A80; overflow-wrap: anywhere; }
      /* Inline notice (pending / resolve failure): patched in place, the list
         and its focus stay exactly where they are. */
      .sports-notice { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; background: rgba(11,11,11,0.95); border: 1px solid #333333; border-radius: 10px; padding: 12px 18px; font-size: 15px; color: #FFFFFF; overflow-wrap: anywhere; z-index: 2; }
      /* SOURCE PICKER: a fixed panel over the list; same focus rules as the
         cards — class toggle + native focus, no animation. */
      .sports-picker { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 640px; max-height: 480px; display: flex; flex-direction: column; background: rgba(11,11,11,0.97); border: 1px solid #333333; border-radius: 18px; padding: 20px; box-sizing: border-box; overflow: hidden; z-index: 3; }
      .sports-picker-title { flex-shrink: 0; height: 28px; font-size: 21px; line-height: 28px; font-weight: 900; color: #FFFFFF; }
      .sports-picker-list { flex: 1; min-height: 0; overflow-y: auto; scroll-behavior: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
      .sports-picker-option { flex-shrink: 0; display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 15px; background: rgba(255,255,255,0.04); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); border-radius: 14px; outline: 2px solid transparent; outline-offset: -2px; cursor: pointer; box-sizing: border-box; overflow: hidden; font-size: 19.5px; line-height: 24px; color: #FFFFFF; white-space: nowrap; }
      .sports-picker-option.focused { outline-color: #FFFFFF; background: rgba(40,44,58,0.722); }
      .sports-picker-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 700; }
      .sports-picker-resolution { flex-shrink: 0; color: #8B90A0; font-weight: 600; }
      .sports-picker-unverified { flex-shrink: 0; color: #FF8A80; font-size: 15px; }
    </style>
  `;

  function renderDayChip(chip, index) {
    const selected = this.dayKey === chip.id ? " is-selected" : "";
    return `
      <div class="sports-chip focusable${selected}" role="button"
           data-header-row="0" data-chip-index="${index}" data-day="${escapeHtml(chip.id)}">
        ${escapeHtml(chip.label)}
      </div>
    `;
  }

  function renderHeader() {
    // Fresh 15-chip window on every render: labels follow the real calendar.
    const chips = buildDayWindow(Date.now());
    this.dayChips = chips;
    const dayChips = chips.map((chip, index) => renderDayChip.call(this, chip, index)).join("");
    const liveCount = Array.isArray(this.scheduleEvents) ? this.scheduleEvents.filter((event) => event?.state === "in").length : 0;
    return `
      <div class="sports-header">
        <div class="sports-title">${escapeHtml("Deportes")}</div>
        <div class="sports-day-row">
          ${dayChips}
          <div class="sports-chip sports-refresh focusable" role="button"
               data-header-row="0" data-chip-index="${chips.length}" data-action="refresh">
            ${escapeHtml(internals.SPORTS_REFRESH_LABEL)}
          </div>
        </div>
        <div class="sports-filter-row">
          <div class="sports-filter-pill focusable" role="button"
               data-header-row="1" data-chip-index="0" data-action="filter">
            <span class="sports-filter-icon">⚙</span>
            <span>${escapeHtml(internals.SPORTS_FILTER_PILL_LABEL)}</span>
            <span class="sports-filter-count">· ${liveCount} en vivo</span>
          </div>
        </div>
      </div>
    `;
  }

  function renderMatchRow(row, index) {
    return renderMatchCard(row.event, index);
  }

  function renderSourcePicker(picker) {
    const rows = buildSourcePickerRows(picker.streams);
    return `
      <div class="sports-picker" role="dialog" aria-label="${escapeHtml(SPORTS_PICKER_TITLE)}">
        <div class="sports-picker-title">${escapeHtml(SPORTS_PICKER_TITLE)}</div>
        <div class="sports-picker-list">
          ${rows
            .map(
              (row) => `
            <div class="sports-picker-option focusable" role="button" tabindex="-1" data-picker-index="${row.index}">
              <span class="sports-picker-name">${escapeHtml(row.name)}</span>
              ${row.resolution ? `<span class="sports-picker-resolution">${escapeHtml(row.resolution)}</span>` : ""}
              ${row.unverified ? `<span class="sports-picker-unverified">${escapeHtml(SPORTS_PICKER_UNVERIFIED_LABEL)}</span>` : ""}
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    `;
  }

  function renderList() {
    if (this.loading) {
      return `<div class="sports-state">${escapeHtml(internals.SPORTS_LOADING_TEXT)}</div>`;
    }
    if (this.error) {
      return `<div class="sports-state is-error">${escapeHtml(`${internals.SPORTS_LOAD_ERROR_TEXT}: ${this.error}`)}</div>`;
    }
    const rows = buildMatchRows(this.sections, this.finishedExpanded);
    const hasMatches = rows.some((row) => row.type === "match");
    if (!hasMatches) {
      return `<div class="sports-state">${escapeHtml(internals.SPORTS_EMPTY_TEXT)}</div>`;
    }
    return rows
      .map((row, index) => {
        if (row.type === "header") {
          const liveDot = row.sectionKey === "live" ? `<span class="sports-live-dot"></span>` : "";
          const liveClass = row.sectionKey === "live" ? " is-live-section" : "";
          const chevron = row.collapsible ? `<span class="sports-section-chevron">${row.collapsed ? "▸" : "▾"}</span>` : "";
          return `
            <div class="sports-section-header focusable${liveClass}" role="button"
                 data-row-index="${index}" data-row-type="header" data-section-key="${escapeHtml(row.sectionKey)}">
              ${liveDot}${escapeHtml(row.label)} <span class="sports-section-count">${row.count} partidos</span> ${chevron}
            </div>
          `;
        }
        return renderMatchRow(row, index);
      })
      .join("");
  }

  return {
    render({ preserveFocus = true } = {}) {
      try {
        this.container.innerHTML = `
          ${STYLE}
          <div class="sports-shell">
            <div class="sports-glow"></div>
            ${renderHeader.call(this)}
            <div class="sports-list">${renderList.call(this)}</div>
            ${this.notice ? `<div class="sports-notice" role="status">${escapeHtml(this.notice)}</div>` : ""}
            ${this.sourcePicker ? renderSourcePicker.call(this, this.sourcePicker) : ""}
          </div>
        `;
        ScreenUtils.indexFocusables(this.container);
        this.applyFocusState();
      } catch (error) {
        // A render failure must never leave a dead screen: a reachable shell
        // with the honest error line and one focusable.
        try {
          this.container.innerHTML = `
            ${STYLE}
            <div class="sports-shell">
              <div class="sports-header"><div class="sports-title">Deportes</div></div>
              <div class="sports-list"><div class="sports-state is-error">${escapeHtml(internals.SPORTS_LOAD_ERROR_TEXT)}</div></div>
            </div>
          `;
          ScreenUtils.indexFocusables(this.container);
        } catch (_) {
          // Without a working DOM nothing more can be done.
        }
      }
    },

    // Deterministic focus: one class toggle + native focus(). The browser
    // reveals the focused node (including horizontal chip scroll) with its
    // default instant behaviour — no measurement, no animation.
    applyFocusState() {
      try {
        this.container?.querySelectorAll(".focused").forEach((node) => node.classList.remove("focused"));
        let target = null;
        if (this.sourcePicker) {
          // The picker owns focus while it is open: the highlighted source row.
          target = this.container?.querySelector(`[data-picker-index="${this.sourcePicker.index}"]`);
        } else if (this.focusZone === "header") {
          target = this.container?.querySelector(`[data-header-row="${this.headerRow}"][data-chip-index="${this.headerIndex}"]`);
        } else {
          target = this.container?.querySelector(`[data-row-index="${this.rowIndex}"]`);
        }
        if (target) {
          target.classList.add("focused");
          target.focus();
          // The 15-chip day row is wider than the header: keep the focused
          // chip visible with the browser's instant native scroll.
          const dayRow = target.closest ? target.closest(".sports-day-row") : null;
          if (dayRow && target.scrollIntoView) {
            try {
              target.scrollIntoView({ block: "nearest", inline: "nearest" });
            } catch (_) {
              // Old TVs without options support: plain instant scroll.
              target.scrollIntoView();
            }
          }
        }
      } catch (_) {
        // Focus is cosmetic; a failure here must never break navigation state.
      }
    }
  };
}
