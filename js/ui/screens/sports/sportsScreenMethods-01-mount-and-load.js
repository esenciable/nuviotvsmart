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
import { sportingEventsForDay } from "../../../core/sports/sportingEvents.js";
import { euroleagueForDay } from "../../../core/sports/euroleague.js";
import { acbForDay } from "../../../core/sports/acb.js";

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
      // No token here: loadSchedule guards every paint against its OWN counter
      // (scoresToken). Passing the mount token made canPaint() compare two
      // different counters, so the first load discarded every progressive paint
      // and the list stayed empty until the user changed day and came back.
      return this.loadSchedule({});
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
      // SECOND SCHEDULE SOURCE (sporting-events.org): the four competitions
      // ESPN lacks (cricket, darts, rugby league, snooker) are fetched only
      // AFTER the ESPN slate painted. Their rows map into the SAME unified
      // event shape, so buildSections places them under the existing
      // PRÓXIMOS section. A failure here must NEVER touch the ESPN list: one
      // muted line, no retry loop (the module's per-slug 6 h success / 10 min
      // failure cache throttles every repeat attempt by itself).
      try {
        const secondary = await sportingEventsForDay({ dayKey: this.dayKey });
        if (!canPaint()) return; // the screen or the day moved on
        if (Array.isArray(secondary?.events) && secondary.events.length) {
          this.scheduleEvents = [...this.scheduleEvents, ...secondary.events];
          this.rebuildDerivedState();
          this.render({ preserveFocus: false });
          this.renderPartialNotice();
        }
        if (Array.isArray(secondary?.failedSlugs) && secondary.failedSlugs.length) {
          this.renderSecondaryNotice(secondary.failedSlugs);
        }
      } catch (_) {
        // Strictly additive: an unexpected failure in the secondary path
        // leaves the ESPN list exactly as painted, with one muted line.
        this.renderSecondaryNotice(["sporting-events.org"]);
      }
      // THIRD SCHEDULE SOURCE (EuroLeague official API, no key): the two
      // European competitions ESPN lacks (E = EuroLeague, U = EuroCup) load
      // AFTER the ESPN slate and the sporting-events rows. euroleagueForDay
      // emits each competition's rows as its answer lands (progressive, same
      // paint path as the ESPN round), already filtered to the visible local
      // day; the season payload is cached 30 min per competition|season. A
      // failing competition is ONE muted line — the list painted above is
      // never touched, and no live state is ever invented for its games.
      try {
        const euro = await euroleagueForDay({
          dayKey: this.dayKey,
          force,
          onProgress: (euroleagueRows) => {
            if (!canPaint()) return; // the screen or the day moved on
            if (!Array.isArray(euroleagueRows) || !euroleagueRows.length) return;
            this.scheduleEvents = [...this.scheduleEvents, ...euroleagueRows];
            this.rebuildDerivedState();
            this.render({ preserveFocus: false });
            this.renderPartialNotice();
          }
        });
        if (!canPaint()) return; // the screen or the day moved on; render nothing new
        if (Array.isArray(euro?.failedCompetitions) && euro.failedCompetitions.length) {
          const labels = { E: "EuroLeague", U: "EuroCup" };
          this.renderSecondaryNotice(euro.failedCompetitions.map((code) => labels[code] || code));
        }
      } catch (_) {
        // Strictly additive: an unexpected failure leaves every row already
        // painted exactly as it is, with one muted line.
        this.renderSecondaryNotice(["api-live.euroleague.net"]);
      }
      // FOURTH SCHEDULE SOURCE (Liga Endesa / ACB): the Spanish league ESPN
      // lacks, scraped from acb.com/es/liga/partidos — the Tizen/Android
      // engines bypass CORS (the TV measures readable bodies from the
      // CORS-less host), so the RSC page is pulled directly. It loads AFTER
      // the ESPN slate, the sporting-events rows and the EuroLeague rows,
      // appending through the SAME paint path guarded by canPaint(): the
      // parsed round is cached 30 min, a body above 1 MB is skipped, and a
      // failed or unparsable page is ONE muted line — the rows painted above
      // are never touched, and no live state is ever invented for its games.
      try {
        const acb = await acbForDay({ dayKey: this.dayKey, force });
        if (!canPaint()) return; // the screen or the day moved on; render nothing new
        if (Array.isArray(acb?.events) && acb.events.length) {
          this.scheduleEvents = [...this.scheduleEvents, ...acb.events];
          this.rebuildDerivedState();
          this.render({ preserveFocus: false });
          this.renderPartialNotice();
        }
        if (Array.isArray(acb?.failedCompetitions) && acb.failedCompetitions.length) {
          this.renderSecondaryNotice(acb.failedCompetitions);
        }
      } catch (_) {
        // Strictly additive: an unexpected failure leaves every row already
        // painted exactly as it is, with one muted line.
        this.renderSecondaryNotice(["acb.com"]);
      }
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

    // One muted line for the SECOND schedule source (sporting-events.org):
    // when one of its slugs failed on this load, the count and slugs are said
    // quietly — never an error state, never a retry loop. Appended after the
    // render (like renderPartialNotice); the next schedule load repaints or
    // clears it honestly. The ESPN list above it is untouched.
    renderSecondaryNotice(failedSlugs) {
      try {
        const failed = (Array.isArray(failedSlugs) ? failedSlugs : []).filter(Boolean);
        if (!this.container || !failed.length) return;
        const list = this.container.querySelector(".sports-list");
        if (!list || list.querySelector(".sports-secondary-note")) return;
        const note = document.createElement("div");
        note.className = "sports-state sports-secondary-note";
        note.textContent = `Fuente secundaria sin datos: ${failed.join(", ")}`;
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
