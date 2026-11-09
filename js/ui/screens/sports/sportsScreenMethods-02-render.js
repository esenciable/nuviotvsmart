/* eslint-disable no-unused-vars */
import * as internals from "./sportsScreen.js";
import { matchScore } from "../../../core/sports/espnScores.js";

// Rendering for the lightweight Sports screen. Same rules as Live TV:
//   - STATIC LAYOUT CONTRACT: every box has a fixed size; a focus move only
//     toggles classes and calls node.focus() — no resize, no re-render, no
//     per-keypress DOM measurement, no transition on the focus state at all.
//   - NO IMAGES of any kind: no image nodes, no CSS background payloads, no logos. The
//     team logos from the feed are never read (Samsung 120 MB app cap; all
//     Live TV channel images were removed for exactly this reason).
//   - One vertical list: EN VIVO -> PRÓXIMOS -> FINALIZADOS (collapsed by
//     default). FINALIZADOS' header toggles it; the other headers are plain
//     focusable labels so the flat focus order never depends on data.
//
// Styles are inlined because the screen ships without a dedicated stylesheet.
// Palette matches the Live TV screen: page #0D0D0D, focus fill #303030, 2px
// white ring painted INSIDE, muted #808080, accent #F5C400.

// Fixed geometry of a match row: 64px tile + 6px flex gap. The constant is
// the layout contract — the row never grows with its content (long team names
// clamp to one line inside the fixed tile).
export const SPORTS_ROW_HEIGHT = 64;
export const SPORTS_ROW_GAP = 6;

// The three day chips, in fixed order. Default selection: Hoy.
export const SPORTS_DAY_CHIPS = [
  { id: "yesterday", label: "Ayer" },
  { id: "today", label: "Hoy" },
  { id: "tomorrow", label: "Mañana" }
];

export const SPORTS_REFRESH_LABEL = "Actualizar";
export const SPORTS_ALL_SPORTS_LABEL = "Todos";

// Honest-state copy. Never a blank panel, never a spinner that stays forever
// (the feed fetch is bounded by a timeout).
export const SPORTS_LOADING_TEXT = "Cargando partidos…";
export const SPORTS_EMPTY_TEXT = "No hay partidos hoy";
export const SPORTS_LOAD_ERROR_TEXT = "No se pudieron cargar los partidos";
export const SPORTS_NO_SIGNAL_TEXT = "No hay señal para este partido";
export const SPORTS_RESOLVING_TEXT = "Buscando señal…";

// ESPN scored round cadence: one bounded round every 60 s, only while the
// screen is mounted AND the document is visible (see methods-01). The cache
// lives in espnScores.js; the timer here is a chained setTimeout — no
// repeating interval primitive.
export const SPORTS_SCORES_REFRESH_MS = 60000;

// Source picker (several playable streams): a fixed panel over the list that
// offers every playable source instead of silently playing the first.

// Probe failure (the addon answered but NO stream URL actually serves the
// playlist): the honest copy carries the count of streams tried. The row keeps
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

// The two team names (no logos). With both names: "A vs B"; otherwise the
// event's own title; otherwise a neutral placeholder.
export function matchRowTitle(event) {
  const names = (Array.isArray(event?.teams) ? event.teams : []).map((team) => String(team?.name ?? "").trim()).filter(Boolean);
  if (names.length >= 2) {
    return `${names[0]} vs ${names[1]}`;
  }
  const title = String(event?.title ?? "").trim();
  return title || "Partido";
}

// The score line: only when the match is live and the addon provides BOTH
// numeric team scores. Never invented, never shown for scheduled matches.
export function matchRowScore(event) {
  if (!event?.live) return "";
  const scores = (Array.isArray(event?.teams) ? event.teams : []).map((team) =>
    Number.isFinite(Number(team?.score)) ? Number(team.score) : null
  );
  if (scores.length < 2 || scores[0] == null || scores[1] == null) return "";
  return `${scores[0]} - ${scores[1]}`;
}

// ESPN scored-row helpers (reference layout) -------------------------------

// Period ordinal like the reference app shows it: 4th · 15:00.
export function periodOrdinal(period) {
  const p = Math.floor(Number(period) || 0);
  if (p <= 0) return "";
  const rem = p % 10;
  const rem100 = p % 100;
  const suffix = rem === 1 && rem100 !== 11 ? "st" : rem === 2 && rem100 !== 12 ? "nd" : rem === 3 && rem100 !== 13 ? "rd" : "th";
  return `${p}${suffix}`;
}

export function formatPeriodClock(period, clock) {
  return [periodOrdinal(period), String(clock ?? "").trim()].filter(Boolean).join(" · ");
}

// The status block's content from the merged game: red ● EN VIVO with the
// period · clock under it while live, FINAL when finished, the local kickoff
// time otherwise.
export function scoreStatusView(game) {
  const state = String(game?.state ?? "");
  if (state === "in") {
    return {
      kind: "live",
      main: "● EN VIVO",
      sub: formatPeriodClock(game?.period, game?.clock),
      situation: String(game?.situation ?? "")
    };
  }
  if (state === "post") {
    return { kind: "final", main: "FINAL", sub: "", situation: "" };
  }
  return {
    kind: "time",
    main: internals.formatKickoffTime(game?.kickoffMs) || "--:--",
    sub: "",
    situation: ""
  };
}

// The scored row's inner markup (reference layout, NO images): two lines, one
// per team — name left, its record in muted small text, the score right-
// aligned in a large tabular figure — and a small status block at the right.
// The down/distance line renders only for LIVE football (ESPN only provides
// situation for football, and only while the game is in progress). Away is
// the top line, home the bottom (broadcast order).
export function renderScoredRowInner(game) {
  const esc = internals.escapeHtml;
  const teamLine = (team) => `
        <div class="sports-score-line">
          <span class="sports-score-team">${esc(team?.name || "—")}</span>
          ${team?.record ? `<span class="sports-score-record">${esc(team.record)}</span>` : ""}
          <span class="sports-score-figure">${team?.score == null ? "–" : esc(String(team.score))}</span>
        </div>`;
  const status = scoreStatusView(game);
  const situationLine =
    status.kind === "live" && status.situation ? `<span class="sports-status-situation">${esc(status.situation)}</span>` : "";
  return `
        <div class="sports-row-scored-main">
          ${teamLine(game?.away)}
          ${teamLine(game?.home)}
        </div>
        <div class="sports-row-status is-${esc(status.kind)}">
          <span class="sports-status-main${status.kind === "live" ? " sports-live-badge" : ""}">${esc(status.main)}</span>
          ${status.sub ? `<span class="sports-status-sub">${esc(status.sub)}</span>` : ""}
          ${situationLine}
        </div>`;
}

// Flat focus model for the list: one entry per focusable row, in paint order
// — every section header (focusable so the order never depends on data),
// then its match rows. FINALIZADOS contributes match rows only when expanded.
// `scores` (the day's ESPN games, optional) are merged per row via the TV
// app's match rule: a match with NO counterpart keeps score null and renders
// exactly as before — never a blank or a zero.
export function buildMatchRows(sections, finishedExpanded, scores = null) {
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
        rows.push({ type: "match", sectionKey: key, event, score: matchScore(event, scores) });
      }
    }
  }
  return rows;
}

export function createSportsScreenMethods02() {
  const { ScreenUtils, escapeHtml, formatKickoffTime } = internals;

  const STYLE = `
    <style id="sports-screen-style">
      /* STATIC LAYOUT CONTRACT: fixed sizes everywhere; focus only toggles a
         class (fill + inner ring) — no scale, no layout change, no transition. */
      .sports-shell { position: absolute; inset: 0; width: 100%; height: 100%; display: flex; flex-direction: column; background: #0D0D0D; color: #FFFFFF; overflow: hidden; }
      /* HEADER ---------------------------------------------------------------- */
      .sports-header { flex-shrink: 0; padding: 20px 36px 14px 84px; box-sizing: border-box; }
      .sports-title { font-size: 42px; line-height: 48px; height: 48px; font-weight: 800; }
      .sports-day-row { display: flex; align-items: center; gap: 12px; margin-top: 14px; height: 51px; }
      .sports-chip { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; height: 51px; padding: 0 24px; background: rgba(13,13,13,0.66); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); border-radius: 15px; outline: 2px solid transparent; outline-offset: -2px; font-size: 19.5px; line-height: 24px; font-weight: 600; color: #B3B3B3; cursor: pointer; box-sizing: border-box; white-space: nowrap; }
      .sports-chip.focused { outline-color: #FFFFFF; background: #303030; color: #FFFFFF; }
      .sports-chip.is-selected { box-shadow: inset 0 0 0 1px rgba(245,196,0,0.9); color: #F5C400; }
      .sports-refresh { margin-left: auto; color: #B3B3B3; }
      .sports-sport-row { display: flex; align-items: center; gap: 10px; margin-top: 12px; height: 51px; overflow-x: auto; overflow-y: hidden; scroll-behavior: auto; }
      /* LIST ------------------------------------------------------------------ */
      .sports-list { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; scroll-behavior: auto; padding: 6px 36px 24px 84px; display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; }
      .sports-section-header { flex-shrink: 0; display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 15px; outline: 2px solid transparent; outline-offset: -2px; font-size: 19.5px; line-height: 24px; font-weight: 700; color: #F5C400; letter-spacing: 0.06em; cursor: pointer; box-sizing: border-box; }
      .sports-section-header.focused { outline-color: #FFFFFF; background: #303030; }
      .sports-section-count { color: #808080; font-weight: 500; }
      .sports-section-chevron { color: #808080; }
      .sports-row { flex-shrink: 0; display: flex; align-items: center; gap: 14px; height: 64px; background: rgba(13,13,13,0.66); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); border-radius: 18px; padding: 0 15px; outline: 2px solid transparent; outline-offset: -2px; cursor: pointer; box-sizing: border-box; overflow: hidden; }
      .sports-row.focused { outline-color: #FFFFFF; background: #303030; }
      .sports-row-time { flex-shrink: 0; width: 110px; font-size: 19.5px; line-height: 24px; font-weight: 700; color: #FFFFFF; }
      .sports-row-time.is-live { color: #FF6B5E; font-size: 15px; letter-spacing: 0.04em; }
      .sports-row-main { flex: 1; min-width: 0; min-height: 0; }
      .sports-row-league { font-size: 15px; line-height: 18px; height: 18px; color: #808080; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sports-row-teams { font-size: 21px; line-height: 26px; height: 26px; margin-top: 2px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sports-row-score { flex-shrink: 0; min-width: 64px; text-align: right; font-size: 24px; line-height: 28px; font-weight: 800; color: #F5C400; font-variant-numeric: tabular-nums; }
      /* SCORED ROW (ESPN): the reference layout — two team lines (name left,
         muted record, big right-aligned tabular figure) plus a small status
         block. Same fixed 64px row; no images, no transitions. */
      .sports-row-scored-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .sports-score-line { display: flex; align-items: baseline; gap: 8px; height: 24px; min-width: 0; }
      .sports-score-team { flex: 0 1 auto; min-width: 0; font-size: 19px; line-height: 24px; font-weight: 700; color: #FFFFFF; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sports-score-record { flex-shrink: 0; font-size: 13px; line-height: 24px; color: #808080; }
      .sports-score-figure { flex-shrink: 0; width: 64px; text-align: right; font-size: 27px; line-height: 24px; font-weight: 800; color: #FFFFFF; font-variant-numeric: tabular-nums; }
      .sports-row-status { flex-shrink: 0; width: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; overflow: hidden; }
      .sports-status-main { font-size: 15px; line-height: 18px; font-weight: 700; color: #808080; white-space: nowrap; }
      .sports-status-main.sports-live-badge { color: #FF6B5E; letter-spacing: 0.04em; }
      .sports-status-sub { font-size: 13px; line-height: 16px; color: #B3B3B3; white-space: nowrap; }
      .sports-status-situation { font-size: 12px; line-height: 15px; max-width: 100%; color: #808080; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sports-state { display: flex; align-items: center; color: #808080; font-size: 19.5px; padding: 20px 4px; }
      .sports-state.is-error { color: #ffb4a8; overflow-wrap: anywhere; }
      /* Inline notice (pending / resolve failure): patched in place, the list
         and its focus stay exactly where they are. */
      .sports-notice { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; background: rgba(13,13,13,0.95); border: 1px solid #333333; border-radius: 10px; padding: 12px 18px; font-size: 15px; color: #FFFFFF; overflow-wrap: anywhere; z-index: 2; }
      /* SOURCE PICKER: a fixed panel over the list; same focus rules as the
         rows — class toggle + native focus, no animation, no images. */
      .sports-picker { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 640px; max-height: 480px; display: flex; flex-direction: column; background: rgba(13,13,13,0.97); border: 1px solid #333333; border-radius: 18px; padding: 20px; box-sizing: border-box; overflow: hidden; z-index: 3; }
      .sports-picker-title { flex-shrink: 0; height: 28px; font-size: 21px; line-height: 28px; font-weight: 800; color: #F5C400; }
      .sports-picker-list { flex: 1; min-height: 0; overflow-y: auto; scroll-behavior: auto; display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
      .sports-picker-option { flex-shrink: 0; display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 15px; background: rgba(255,255,255,0.04); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); border-radius: 14px; outline: 2px solid transparent; outline-offset: -2px; cursor: pointer; box-sizing: border-box; overflow: hidden; font-size: 19.5px; line-height: 24px; color: #FFFFFF; white-space: nowrap; }
      .sports-picker-option.focused { outline-color: #FFFFFF; background: #303030; }
      .sports-picker-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 700; }
      .sports-picker-resolution { flex-shrink: 0; color: #808080; font-weight: 600; }
      .sports-picker-unverified { flex-shrink: 0; color: #FF6B5E; font-size: 15px; }
    </style>
  `;

  function renderDayChip(chip, index) {
    const selected = this.dayKey === chip.id ? " is-selected" : "";
    return `
      <div class="sports-chip focusable${selected}" role="button"
           data-header-row="0" data-chip-index="${index}" data-day="${chip.id}">
        ${escapeHtml(chip.label)}
      </div>
    `;
  }

  function renderSportChip(chip, index) {
    const selected = (this.sportType || null) === (chip.sportType || null) ? " is-selected" : "";
    return `
      <div class="sports-chip focusable${selected}" role="button"
           data-header-row="1" data-chip-index="${index}" data-sport="${escapeHtml(chip.id)}">
        ${escapeHtml(chip.label)}
      </div>
    `;
  }

  function renderHeader() {
    const dayChips = internals.SPORTS_DAY_CHIPS.map((chip, index) => renderDayChip.call(this, chip, index)).join("");
    const sportChips = (Array.isArray(this.sportChips) ? this.sportChips : [])
      .map((chip, index) => renderSportChip.call(this, chip, index))
      .join("");
    return `
      <div class="sports-header">
        <div class="sports-title">${escapeHtml("Deportes")}</div>
        <div class="sports-day-row">
          ${dayChips}
          <div class="sports-chip sports-refresh focusable" role="button"
               data-header-row="0" data-chip-index="${internals.SPORTS_DAY_CHIPS.length}" data-action="refresh">
            ${escapeHtml(internals.SPORTS_REFRESH_LABEL)}
          </div>
        </div>
        <div class="sports-sport-row">${sportChips}</div>
      </div>
    `;
  }

  function renderMatchRow(row, index) {
    const event = row.event || {};
    // A merged ESPN score switches the row to the reference layout (two team
    // lines + status block). A match with no counterpart keeps today's row
    // EXACTLY as it is — no score, no badge, never a blank or a zero.
    if (row.score) {
      return `
      <div class="sports-row focusable" role="button"
           data-row-index="${index}" data-row-type="match" data-event-id="${escapeHtml(event.id ?? "")}">
        ${renderScoredRowInner(row.score)}
      </div>
    `;
    }
    const live = event.live === true || event.status === "live";
    const lead = live
      ? `<span class="sports-row-time is-live">EN VIVO</span>`
      : `<span class="sports-row-time">${escapeHtml(formatKickoffTime(event.kickoffMs) || "--:--")}</span>`;
    const league = escapeHtml(String(event.leagueName ?? "").trim());
    const score = escapeHtml(matchRowScore(event));
    return `
      <div class="sports-row focusable" role="button"
           data-row-index="${index}" data-row-type="match" data-event-id="${escapeHtml(event.id ?? "")}">
        ${lead}
        <div class="sports-row-main">
          <div class="sports-row-league">${league}</div>
          <div class="sports-row-teams">${escapeHtml(matchRowTitle(event))}</div>
        </div>
        ${score ? `<div class="sports-row-score">${score}</div>` : ""}
      </div>
    `;
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
    const rows = buildMatchRows(this.sections, this.finishedExpanded, this.scores);
    const hasMatches = rows.some((row) => row.type === "match");
    if (!hasMatches) {
      return `<div class="sports-state">${escapeHtml(internals.SPORTS_EMPTY_TEXT)}</div>`;
    }
    return rows
      .map((row, index) => {
        if (row.type === "header") {
          const chevron = row.collapsible ? `<span class="sports-section-chevron">${row.collapsed ? "▸" : "▾"}</span>` : "";
          return `
            <div class="sports-section-header focusable" role="button"
                 data-row-index="${index}" data-row-type="header" data-section-key="${escapeHtml(row.sectionKey)}">
              ${escapeHtml(row.label)} <span class="sports-section-count">(${row.count})</span> ${chevron}
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
        }
      } catch (_) {
        // Focus is cosmetic; a failure here must never break navigation state.
      }
    }
  };
}
