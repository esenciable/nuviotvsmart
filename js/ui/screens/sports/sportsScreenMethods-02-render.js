/* eslint-disable no-unused-vars */
import * as internals from "./sportsScreen.js";

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

// Flat focus model for the list: one entry per focusable row, in paint order
// — every section header (focusable so the order never depends on data),
// then its match rows. FINALIZADOS contributes match rows only when expanded.
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
      .sports-state { display: flex; align-items: center; color: #808080; font-size: 19.5px; padding: 20px 4px; }
      .sports-state.is-error { color: #ffb4a8; overflow-wrap: anywhere; }
      /* Inline notice (pending / resolve failure): patched in place, the list
         and its focus stay exactly where they are. */
      .sports-notice { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; background: rgba(13,13,13,0.95); border: 1px solid #333333; border-radius: 10px; padding: 12px 18px; font-size: 15px; color: #FFFFFF; overflow-wrap: anywhere; z-index: 2; }
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
        if (this.focusZone === "header") {
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
