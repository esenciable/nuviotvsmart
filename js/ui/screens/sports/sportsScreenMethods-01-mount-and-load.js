/* eslint-disable no-unused-vars */
import * as internals from "./sportsScreen.js";

// Mount, data loading and lifecycle for the Sports screen. Refresh happens on
// entry, on Actualizar and when the day changes — and NOWHERE else: there is
// no polling loop, no interval, no background timer. The feed's own 60 s TTL
// keeps the repeat fetches (entry, day change) from hitting the network.
import { groupEventsByDay } from "../../../core/sports/sportsFeed.js";

export function createSportsScreenMethods01() {
  const { Router, ScreenUtils, sportsRepository, buildSections, sportChips } = internals;

  return {
    mount(params = {}, _navigationContext = {}) {
      this.container = document.getElementById("sports");
      ScreenUtils.show(this.container);
      this.loadToken = (this.loadToken || 0) + 1;
      const token = this.loadToken;

      // Data state.
      this.events = [];
      this.loading = true;
      this.error = "";
      // Day chips: Ayer / Hoy / Mañana — default Hoy. Sport chips: Todos +
      // one per sportType present today. FINALIZADOS starts collapsed.
      this.dayKey = "today";
      this.sportType = null;
      this.sportChips = sportChips([]);
      this.sections = buildSections([]);
      this.finishedExpanded = false;

      // Deterministic focus state: header (day chips + Actualizar, then the
      // sport chips) or the flat row list. The default header index points at
      // Hoy (day chip 1).
      this.focusZone = "header";
      this.headerRow = 0;
      this.headerIndex = 1;
      this.rowIndex = 0;

      // Resolve / notice state.
      this.resolvingId = "";
      this.notice = "";
      this.noticeTimer = 0;

      this.render({ preserveFocus: false });

      // Entry refresh: the repository's TTL decides whether this is a network
      // call or a warm cache hit.
      return this.loadEvents({ force: false, token });
    },

    // One data load path for entry, Actualizar (force) and day change.
    // Never throws; every outcome lands in an honest visible state.
    async loadEvents({ force = false, token = null } = {}) {
      const myToken = token == null ? (this.loadToken = (this.loadToken || 0) + 1) : token;
      this.loading = true;
      this.error = "";
      // Only paint the loading line when there is nothing to show yet: a
      // refresh over warm data keeps the list on screen (no flicker).
      if (!Array.isArray(this.events) || !this.events.length) {
        this.render({ preserveFocus: false });
      }

      const result = force ? await sportsRepository.refresh() : await sportsRepository.getEvents();
      if (myToken !== this.loadToken || Router.getCurrent() !== "sports") {
        return; // the screen moved on; render nothing new
      }
      this.loading = false;
      if (result.status !== "ok") {
        if (!result.aborted) {
          this.error = String(result.detail || "");
        }
        if (!Array.isArray(this.events) || !this.events.length) {
          this.render({ preserveFocus: false });
        }
        return;
      }
      this.events = Array.isArray(result.events) ? result.events : [];
      this.rebuildDerivedState();
      this.render({ preserveFocus: false });
    },

    // Recomputes everything derived from the raw events: the sport chips (the
    // sports present TODAY, Todos first), the day's sections and the row
    // focus clamp. Pure recompute, no network.
    rebuildDerivedState() {
      const todayEvents = groupEventsByDay(this.events).today;
      this.sportChips = sportChips(todayEvents);
      // A refresh may have dropped the selected sport: fall back to Todos.
      if (this.sportType && !this.sportChips.some((chip) => chip.sportType === this.sportType)) {
        this.sportType = null;
      }
      this.sections = sportsRepository.sectionsForDay({
        events: this.events,
        dayKey: this.dayKey,
        sportType: this.sportType,
        now: Date.now()
      });
      this.clampRowIndex();
    },

    // Day chip: recompute sections from the CURRENT events first (instant
    // paint), then refresh per the owner rule (TTL decides network vs cache).
    changeDay(dayKey) {
      const next = String(dayKey || "");
      if (!next || next === this.dayKey) return;
      this.dayKey = next;
      this.finishedExpanded = false;
      this.focusZone = "header";
      this.rowIndex = 0;
      this.rebuildDerivedState();
      this.render({ preserveFocus: false });
      return this.loadEvents({ force: false });
    },

    // Sport chip: pure recompute, no fetch.
    changeSport(sportType) {
      const next = sportType == null ? null : String(sportType);
      if (next === this.sportType) return;
      this.sportType = next;
      this.rowIndex = 0;
      this.rebuildDerivedState();
      this.render({ preserveFocus: false });
    },

    clampRowIndex() {
      const rows = internals.buildMatchRows(this.sections, this.finishedExpanded);
      const max = Math.max(0, rows.length - 1);
      if (this.rowIndex > max) this.rowIndex = max;
      if (this.rowIndex < 0) this.rowIndex = 0;
    },

    cleanup() {
      this.loadToken = (this.loadToken || 0) + 1;
      this.loading = false;
      this.resolvingId = "";
      this.clearNoticeTimer();
      this.notice = "";
      ScreenUtils.hide(this.container);
    }
  };
}
