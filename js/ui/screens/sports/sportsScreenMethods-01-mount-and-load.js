/* eslint-disable no-unused-vars */
import * as internals from "./sportsScreen.js";

// Mount, data loading and lifecycle for the Sports screen. THE SCHEDULE IS
// ESPN: the FIRST load of a visible day fetches EVERY mapped league in one
// bounded burst (6 in flight, progressive — see espnSchedule.js) and each
// league's rows paint as soon as it answers; the 60 s refresh afterwards only
// re-fetches the LIVE leagues' scores, because a day's schedule is cached for
// 10 minutes and is never re-downloaded while warm. The addon feed is loaded
// ONLY as the stream pool: its events are never rendered, they are the
// name+time hint that resolves an ESPN match to a /stream/tv/<id>.json call.
//
// Refresh happens on entry, on Actualizar and when the day changes — and
// NOWHERE else beyond the ESPN round: no polling loop, no interval. The ESPN
// round adds ONE bounded round per 60 s: a CHAINED setTimeout (no repeating
// interval primitive anywhere) that only runs while the screen is mounted AND
// document.visibilityState === "visible" — armed on mount, stopped on unmount
// and on hide (restarted on show, which also re-scores immediately).
import { espnScheduleForDay } from "../../../core/sports/espnSchedule.js";

export function createSportsScreenMethods01() {
  const { Router, ScreenUtils, sportsRepository, buildSections } = internals;

  return {
    mount(params = {}, _navigationContext = {}) {
      this.container = document.getElementById("sports");
      ScreenUtils.show(this.container);
      this.loadToken = (this.loadToken || 0) + 1;
      const token = this.loadToken;

      // Data state: the ESPN schedule (the rendered list) and the addon
      // events (the stream pool, never rendered). scheduleFailed: leagues
      // that could not be loaded on the last round — said quietly, never
      // hidden (see renderPartialNotice).
      this.scheduleEvents = [];
      this.addonEvents = [];
      this.scheduleFailed = 0;
      this.loading = true;
      this.error = "";

      // Day chips: a 15-day window (7 back / today / 7 forward) — default
      // Hoy (the window's centre). FINALIZADOS starts collapsed.
      // Must match the centre chip id from buildDayWindow(): the schedule layer
      // keys days numerically ("0" = today), so the legacy "today" string resolved
      // to a different date and the list looked empty until the chip was pressed.
      this.dayKey = "0";
      this.dayChips = [];
      this.sections = buildSections([]);
      this.finishedExpanded = false;

      // Deterministic focus state: header (row 0: day chips + Actualizar;
      // row 1: the filter pill) or the flat card list. The default header
      // index points at Hoy (the window centre, index 7).
      this.focusZone = "header";
      this.headerRow = 0;
      this.headerIndex = internals.SPORTS_DAY_WINDOW_RADIUS;
      this.rowIndex = 0;

      // Resolve / notice state.
      this.resolvingId = "";
      this.notice = "";
      this.noticeTimer = 0;

      // ESPN schedule state: the visible day's events and the visible-only
      // 60 s round timer.
      this.scoresToken = 0;
      this.scoresTimer = 0;
      this.onScoresVisibility = null;

      this.render({ preserveFocus: false });

      // The 60 s schedule round exists ONLY while the screen is mounted and
      // the document is visible; visibility changes re-arm or stop it.
      if (typeof document !== "undefined") {
        this.onScoresVisibility = () => this.handleScoresVisibilityChange();
        document.addEventListener("visibilitychange", this.onScoresVisibility);
      }
      this.startScoresTimer();

      // Entry: the ESPN schedule paints the list; the addon pool rides along
      // (its TTL decides network vs warm cache).
      this.loadAddonEvents({ force: false });
      return this.loadSchedule({ token });
    },

    // The addon events pool: fetched, parsed and STORED — never rendered.
    // Its only consumer is resolveStreamsForEvent (the stream hint).
    async loadAddonEvents({ force = false } = {}) {
      const result = force ? await sportsRepository.refresh() : await sportsRepository.getEvents();
      if (Router.getCurrent() !== "sports") return; // the screen moved on
      this.addonEvents = result.status === "ok" && Array.isArray(result.events) ? result.events : [];
    },

    // One ESPN schedule round for the visible day. Never throws; every
    // outcome lands in an honest visible state. The token keeps a stale day's
    // round from painting over a newer one. The FIRST load of a day paints
    // PROGRESSIVELY: each league's rows render as soon as its scoreboard
    // answers, so the cartelera fills league by league instead of appearing
    // all at once after the whole burst.
    async loadSchedule({ token = null, force = false } = {}) {
      const myToken = token == null ? (this.scoresToken = (this.scoresToken || 0) + 1) : token;
      const canPaint = () => myToken === this.scoresToken && Router.getCurrent() === "sports";
      const result = await espnScheduleForDay({
        dayKey: this.dayKey,
        force,
        onProgress: (events) => {
          if (!canPaint()) return; // the screen or the day moved on
          this.loading = false;
          this.scheduleEvents = Array.isArray(events) ? events : [];
          this.rebuildDerivedState();
          this.render({ preserveFocus: true });
        }
      });
      if (!canPaint()) return; // the screen or the day moved on; render nothing new
      this.loading = false;
      this.scheduleFailed = Number(result?.failed) || 0;
      this.scheduleEvents = Array.isArray(result?.events) ? result.events : [];
      this.rebuildDerivedState();
      this.render({ preserveFocus: false });
      this.renderPartialNotice();
    },

    // Quiet partial-failure note: when some leagues failed on a load that
    // still produced matches, one muted line carries the count — never
    // hidden, never an error state. Patched after the renderer's full rebuild
    // (the renderer is not re-rendered here); the next schedule load repaints
    // or clears it honestly.
    renderPartialNotice() {
      try {
        if (!this.container || !this.scheduleFailed || !this.scheduleEvents.length) return;
        const list = this.container.querySelector(".sports-list");
        if (!list || list.querySelector(".sports-partial-note")) return;
        const note = document.createElement("div");
        note.className = "sports-state sports-partial-note";
        note.textContent = `${this.scheduleFailed} ${
          this.scheduleFailed === 1 ? "liga sin datos" : "ligas sin datos"
        } (se reintenta automáticamente)`;
        list.appendChild(note);
      } catch (_) {
        // A cosmetic note must never break the schedule render.
      }
    },

    // Recomputes everything derived from the ESPN schedule: the day's
    // sections and the row focus clamp. Pure recompute, no network.
    rebuildDerivedState() {
      this.sections = buildSections(this.scheduleEvents);
      this.clampRowIndex();
    },

    // Day chip: drop the old day's schedule immediately (an in-flight round
    // for the previous day must never paint onto the new day's cards), then
    // run the new day's round.
    changeDay(dayKey) {
      const next = String(dayKey || "");
      if (!next || next === this.dayKey) return;
      this.dayKey = next;
      this.finishedExpanded = false;
      this.focusZone = "header";
      this.rowIndex = 0;
      this.scheduleEvents = [];
      this.scoresToken = (this.scoresToken || 0) + 1;
      this.rebuildDerivedState();
      this.render({ preserveFocus: false });
      return this.loadSchedule({});
    },

    clampRowIndex() {
      const rows = internals.buildMatchRows(this.sections, this.finishedExpanded);
      const max = Math.max(0, rows.length - 1);
      if (this.rowIndex > max) this.rowIndex = max;
      if (this.rowIndex < 0) this.rowIndex = 0;
    },

    // The 60 s schedule round: armed ONLY while mounted AND visible. A chained
    // setTimeout (no repeating interval primitive); stopScoresTimer clears it
    // on unmount and on hide.
    startScoresTimer() {
      this.stopScoresTimer();
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      this.scoresTimer = setTimeout(() => {
        this.scoresTimer = 0;
        if (Router.getCurrent() !== "sports") return;
        void this.loadSchedule({});
        this.startScoresTimer();
      }, internals.SPORTS_SCORES_REFRESH_MS);
    },

    stopScoresTimer() {
      if (this.scoresTimer) {
        clearTimeout(this.scoresTimer);
        this.scoresTimer = 0;
      }
    },

    // Hidden: stop the round. Visible again: restart it AND re-schedule now,
    // so a TV that slept never shows minutes-old scores when it wakes.
    handleScoresVisibilityChange() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        this.startScoresTimer();
        void this.loadSchedule({});
      } else {
        this.stopScoresTimer();
      }
    },

    cleanup() {
      this.loadToken = (this.loadToken || 0) + 1;
      this.loading = false;
      this.resolvingId = "";
      this.clearNoticeTimer();
      this.notice = "";
      // The schedule round dies with the screen: timer stopped, listener
      // removed, in-flight round invalidated.
      this.scoresToken = (this.scoresToken || 0) + 1;
      this.stopScoresTimer();
      if (this.onScoresVisibility && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", this.onScoresVisibility);
      }
      this.onScoresVisibility = null;
      this.scheduleEvents = [];
      this.addonEvents = [];
      ScreenUtils.hide(this.container);
    }
  };
}
