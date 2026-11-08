/* eslint-disable no-unused-vars */
import * as internals from "./sportsScreen.js";
// The probe lives next to the feed (its fetch follows the same "arms only in a
// real browser/TV context" rule) and the probe-failure copy in the render
// module; both are imported directly because sportsScreen.js re-exports only
// the helpers the original layout contract pinned.
import { pickPlayableStream } from "../../../core/sports/sportsFeed.js";
import { probeFailedNoticeText } from "./sportsScreenMethods-02-render.js";

// Key handling, activation and stream resolution for the Sports screen.
// Focus zones:
//   header — row 0: day chips + Actualizar; row 1: sport chips. LEFT/RIGHT
//            move within the row, UP/DOWN between rows and into the list.
//   rows   — the flat list (section headers + match rows): one row per
//            keypress, class toggles only. Enter on the FINALIZADOS header
//            toggles it; Enter on a match resolves the stream.
// Back leaves the screen. There is NO polling loop anywhere on this screen.
export function createSportsScreenMethods03() {
  const { Router, isBackEvent, escapeHtml, sportsRepository } = internals;

  return {
    onKeyDown(event) {
      try {
        const code = Number(event?.keyCode || 0);
        if (isBackEvent(event)) {
          event?.preventDefault?.();
          Router.back();
          return;
        }
        if (code === 37 || code === 39) {
          this.handleHorizontal(code === 37 ? -1 : 1);
        } else if (code === 38 || code === 40) {
          this.handleVertical(code === 38 ? -1 : 1);
        } else if (code === 13) {
          this.handleEnter();
        }
      } catch (_) {
        // A key handling failure must never break the screen.
      }
    },

    headerRowCount() {
      const sportCount = Array.isArray(this.sportChips) ? this.sportChips.length : 0;
      return sportCount > 0 ? 2 : 1;
    },

    handleHorizontal(delta) {
      if (this.focusZone !== "header") {
        return;
      }
      const length = this.headerRowLength(this.headerRow);
      const next = Math.min(Math.max((this.headerIndex || 0) + delta, 0), Math.max(0, length - 1));
      if (next === this.headerIndex) return;
      this.headerIndex = next;
      this.applyFocusState();
    },

    headerRowLength(row) {
      if (row === 0) {
        // day chips + Actualizar
        return 4;
      }
      return Math.max(1, Array.isArray(this.sportChips) ? this.sportChips.length : 1);
    },

    handleVertical(delta) {
      if (this.focusZone === "header") {
        const nextRow = (this.headerRow || 0) + delta;
        if (nextRow < 0) return; // UP at the top row stays put
        if (nextRow >= this.headerRowCount()) {
          // DOWN from the last header row enters the list.
          const rows = internals.buildMatchRows(this.sections, this.finishedExpanded);
          if (!rows.length) return;
          this.focusZone = "rows";
          this.clampRowIndex();
        } else {
          this.headerRow = nextRow;
          this.headerIndex = Math.min(this.headerIndex || 0, this.headerRowLength(nextRow) - 1);
        }
        this.applyFocusState();
        return;
      }
      // Rows zone: one row per keypress. UP past the first row returns to the
      // header (the sport chips row when present, otherwise the day row).
      const rows = internals.buildMatchRows(this.sections, this.finishedExpanded);
      if (!rows.length) return;
      if (delta < 0 && (this.rowIndex || 0) <= 0) {
        this.focusZone = "header";
        this.headerRow = this.headerRowCount() - 1;
        this.headerIndex = Math.min(this.headerIndex || 0, this.headerRowLength(this.headerRow) - 1);
        this.applyFocusState();
        return;
      }
      const next = Math.min(Math.max((this.rowIndex || 0) + delta, 0), rows.length - 1);
      if (next === this.rowIndex) return;
      this.rowIndex = next;
      this.applyFocusState();
    },

    handleEnter() {
      if (this.focusZone === "header") {
        if (this.headerRow === 0) {
          const dayChips = internals.SPORTS_DAY_CHIPS;
          if (this.headerIndex < dayChips.length) {
            this.changeDay(dayChips[this.headerIndex].id);
          } else {
            this.refresh();
          }
          return;
        }
        const chip = (Array.isArray(this.sportChips) ? this.sportChips : [])[this.headerIndex];
        if (chip) {
          this.changeSport(chip.sportType);
        }
        return;
      }
      const rows = internals.buildMatchRows(this.sections, this.finishedExpanded);
      const row = rows[this.rowIndex || 0];
      if (!row) return;
      if (row.type === "header") {
        if (row.sectionKey === "finished") {
          this.toggleFinished();
        }
        return;
      }
      void this.resolveMatch(row.event);
    },

    // FINALIZADOS collapsed <-> expanded. The rows list changes, so this is a
    // render — an explicit Enter action, never a per-keypress repaint.
    toggleFinished() {
      this.finishedExpanded = !this.finishedExpanded;
      this.clampRowIndex();
      this.render();
    },

    // Actualizar: one forced refresh, TTL ignored for this call.
    refresh() {
      return this.loadEvents({ force: true });
    },

    // Enter on a match: resolve the stream (ONE attempt, no retries) and
    //   ok        -> hand off to the player full screen (live HLS engine)
    //   pending   -> inline notice with the retry hint; the row stays put
    //   error     -> the honest failure in the same notice area
    async resolveMatch(event) {
      const id = String(event?.id ?? "");
      if (!id || this.resolvingId) {
        return;
      }
      this.resolvingId = id;
      this.showNotice(internals.SPORTS_RESOLVING_TEXT, { sticky: true });

      const result = await sportsRepository.resolveStreams(id);
      this.resolvingId = "";
      this.clearNotice();
      if (Router.getCurrent() !== "sports") {
        return; // the screen was left while resolving
      }
      if (result.status === "pending") {
        this.showNotice(internals.pendingNoticeText(result.retryAfterMs));
        return;
      }
      if (result.status !== "ok") {
        this.showNotice(`${internals.SPORTS_NO_SIGNAL_TEXT}: ${String(result.detail || "")}`);
        return;
      }
      const candidates = (Array.isArray(result.streams) ? result.streams : []).filter(
        (candidate) => candidate && String(candidate.url || "").trim()
      );
      if (!candidates.length) {
        this.showNotice(internals.SPORTS_NO_SIGNAL_TEXT);
        return;
      }
      // PROBE BEFORE HAND-OFF: the addon's URLs are unverified and were
      // measured 404 — handing one to the player is the black screen the owner
      // reported. Each candidate gets one bounded request; the first that
      // answers is the one the player gets. If none answers: no navigation,
      // honest notice with the count tried, row stays focused for a retry.
      this.showNotice(internals.SPORTS_RESOLVING_TEXT, { sticky: true });
      const probe = await pickPlayableStream(candidates);
      this.clearNotice();
      if (Router.getCurrent() !== "sports") {
        return; // the screen was left while probing
      }
      if (!probe.url) {
        this.showNotice(probeFailedNoticeText(probe.tried));
        return;
      }
      // Live HLS: the player's existing live engine ladder handles the stream.
      Router.navigate("player", {
        streamUrl: probe.url,
        itemType: "channel",
        playerTitle: internals.matchRowTitle(event),
        returnRoute: "sports",
        streamCandidates: [
          {
            url: probe.url,
            behaviorHints: {
              proxyHeaders: { request: {} }
            }
          }
        ]
      });
    },

    // Inline notice, patched in place (like the Live TV screen): the list,
    // the scroll position and the focus never move because of a notice.
    showNotice(message, { sticky = false } = {}) {
      this.notice = String(message || "");
      this.clearNoticeTimer();
      if (!sticky && this.notice) {
        this.noticeTimer = setTimeout(() => {
          this.noticeTimer = 0;
          if (Router.getCurrent() !== "sports") return;
          this.notice = "";
          this.container?.querySelector(".sports-notice")?.remove();
        }, 6000);
      }
      if (!this.container || !this.notice) return;
      const existing = this.container.querySelector(".sports-notice");
      if (existing) {
        existing.textContent = this.notice;
      } else {
        this.container
          .querySelector(".sports-shell")
          ?.insertAdjacentHTML("beforeend", `<div class="sports-notice" role="status">${escapeHtml(this.notice)}</div>`);
      }
    },

    clearNotice() {
      this.notice = "";
      this.clearNoticeTimer();
      this.container?.querySelector(".sports-notice")?.remove();
    },

    clearNoticeTimer() {
      if (this.noticeTimer) {
        clearTimeout(this.noticeTimer);
        this.noticeTimer = 0;
      }
    }
  };
}
