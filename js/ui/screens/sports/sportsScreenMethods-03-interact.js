/* eslint-disable no-unused-vars */
import * as internals from "./sportsScreen.js";
// The probe lives next to the feed (its fetch follows the same "arms only in a
// real browser/TV context" rule) and the probe-failure copy in the render
// module; both are imported directly because sportsScreen.js re-exports only
// the helpers the original layout contract pinned.
import { probePlayableStreams } from "../../../core/sports/sportsFeed.js";
import { resolveStreamsForEvent } from "../../../core/sports/espnSchedule.js";
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
        if (isBackEvent(event)) {
          event?.preventDefault?.();
          if (this.sourcePicker) {
            this.closeSourcePicker();
            return;
          }
          Router.back();
          return;
        }
        const code = Number(event?.keyCode || 0);
        if (this.sourcePicker) {
          // The picker owns the keys while it is open: Up/Down move the
          // highlight, Enter plays it, everything else is ignored. No player
          // navigation can happen from the picker without Enter.
          if (code === 13) {
            this.playPickedSource();
          } else if (code === 38 || code === 40) {
            this.movePickerIndex(code === 38 ? -1 : 1);
          }
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
      // Row 0: day chips + Actualizar. Row 1: the single filter pill.
      return 2;
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
      // row 1: the single filter pill.
      return 1;
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
        // Row 1 is the filter pill: display-only (no other filter exists in
        // this lightweight screen), Enter is a no-op.
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

    // Actualizar: one forced refresh of BOTH sources, TTL ignored for this
    // call (the addon pool and the ESPN schedule round both refetch).
    refresh() {
      this.loadAddonEvents({ force: true });
      return this.loadSchedule({ force: true });
    },

    // Enter on a match: find the ONE addon event for this ESPN match (both
    // team names + kickoff within 20 minutes) and resolve its stream. The
    // addon is ONLY the link source — no addon match means there is nothing to
    // play: the honest notice shows and NO player ever opens.
    //   ok        -> probe before hand-off (below)
    //   pending   -> inline notice with the retry hint; the card stays put
    //   error     -> the honest failure in the same notice area
    async resolveMatch(event) {
      const id = String(event?.id ?? "");
      if (!id || this.resolvingId) {
        return;
      }
      this.resolvingId = id;
      this.showNotice(internals.SPORTS_RESOLVING_TEXT, { sticky: true });

      const resolution = await resolveStreamsForEvent(event, this.addonEvents, {
        resolveStreams: (addonId) => sportsRepository.resolveStreams(addonId)
      });
      this.resolvingId = "";
      this.clearNotice();
      if (Router.getCurrent() !== "sports") {
        return; // the screen was left while resolving
      }
      if (!resolution) {
        this.showNotice(internals.SPORTS_NO_LINK_TEXT);
        return;
      }
      const result = resolution.result || { status: "error", detail: "" };
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
      // reported. Each candidate gets ONE bounded request, all of them
      // CONCURRENTLY, so a match with several links does not pay several
      // timeouts in series. EVERY stream that answers is kept; the first
      // answer no longer silently wins. If none answers: no navigation,
      // honest notice with the count tried, row stays focused for a retry.
      this.showNotice(internals.SPORTS_RESOLVING_TEXT, { sticky: true });
      const probe = await probePlayableStreams(candidates);
      this.clearNotice();
      if (Router.getCurrent() !== "sports") {
        return; // the screen was left while probing
      }
      if (!probe.playable.length) {
        this.showNotice(probeFailedNoticeText(probe.tried));
        return;
      }
      if (probe.playable.length === 1) {
        // The usual case: play it directly, no extra step.
        this.playStreamUrl(probe.playable[0], event);
        return;
      }
      // Several playable sources: offer them all in the picker.
      this.openSourcePicker(probe.playable, event);
    },

    // The single player hand-off (live HLS: the player's existing live engine
    // ladder handles the stream). Used by the direct path AND the picker.
    playStreamUrl(stream, event) {
      const url = String(stream?.url ?? "").trim();
      if (!url) return;
      Router.navigate("player", {
        streamUrl: url,
        itemType: "channel",
        playerTitle: internals.matchRowTitle(event),
        returnRoute: "sports",
        streamCandidates: [
          {
            url,
            behaviorHints: {
              proxyHeaders: { request: {} }
            }
          }
        ]
      });
    },

    // The source picker: a fixed panel over the list, one row per playable
    // source, the addon's original order. An explicit Enter action, so a
    // render is allowed (same as toggleFinished).
    openSourcePicker(streams, event) {
      this.sourcePicker = {
        streams: Array.isArray(streams) ? streams : [],
        index: 0,
        event: event || null
      };
      this.render();
    },

    // Back on the picker closes it (it never leaves the screen) and the
    // previous focus state — the same match row, still selected — returns.
    closeSourcePicker() {
      if (!this.sourcePicker) return;
      this.sourcePicker = null;
      this.render();
    },

    movePickerIndex(delta) {
      const picker = this.sourcePicker;
      if (!picker) return;
      const count = Array.isArray(picker.streams) ? picker.streams.length : 0;
      if (!count) return;
      const next = Math.min(Math.max((picker.index || 0) + delta, 0), count - 1);
      if (next === picker.index) return;
      picker.index = next;
      this.applyFocusState();
    },

    // Enter on the picker: play the highlighted source, close the picker.
    playPickedSource() {
      const picker = this.sourcePicker;
      if (!picker) return;
      const stream = (Array.isArray(picker.streams) ? picker.streams : [])[picker.index || 0];
      if (!stream) return;
      this.sourcePicker = null;
      this.playStreamUrl(stream, picker.event);
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
