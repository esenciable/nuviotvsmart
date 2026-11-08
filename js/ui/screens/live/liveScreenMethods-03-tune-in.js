/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

const NOTICE_VISIBLE_MS = 6000;

// Temporary focal telemetry: a TV gives no logs, and "navigation does not work"
// can mean no movement, a double move from two handlers, or the wrong target.
// Every key reports what the screen actually did so the next fix is measured.
function reportLiveNav(payload) {
  try {
    void import("../../../core/diagnostics/runtimeBeacon.js")
      .then((mod) => mod.sendRuntimeBeacon({ phase: "live-nav", ...payload }))
      .catch(() => {});
  } catch (_) {
    // Diagnostics are optional.
  }
}

function liveFocusSnapshot(container) {
  const focused = container?.querySelector(".focusable.focused");
  const chips = container?.querySelector(".live-chips-row");
  const list = container?.querySelector(".live-channel-list");
  const size = (el) => (el ? `${Math.round(el.scrollHeight)}/${Math.round(el.clientHeight)}` : "x");
  return {
    focus: focused ? `${focused.dataset.action || "?"}:${focused.dataset.focusKey || focused.dataset.chipId || "?"}` : "none",
    chips: chips ? Math.round(chips.scrollLeft) : -1,
    list: list ? Math.round(list.scrollTop) : -1,
    chipsSize: size(chips),
    listSize: size(list)
  };
}

// Key handling, activation and tune-in. Focus is a deterministic state model
// (focusZone + chipIndex + rowIndex + rowFocusTarget) instead of geometric
// dpad navigation: LEFT/RIGHT cross between the chips row and the list only at
// the row edge (and reach the row's star), UP/DOWN scroll the list and move
// the preview live, Enter activates. Back exits search before leaving the
// screen.
export function createLiveScreenMethods03() {
  const { Router, ScreenUtils, liveRepository, isBackEvent, escapeHtml, t } = internals;

  return {
    onKeyDown(event) {
      const code = Number(event?.keyCode || 0);
      if ((code >= 37 && code <= 40) || code === 13) {
        reportLiveNav({ key: code, repeat: Boolean(event?.repeat), before: liveFocusSnapshot(this.container) });
      }
      if (isBackEvent(event)) {
        event?.preventDefault?.();
        if (this.searchActive) {
          this.exitSearch();
          reportLiveNav({ after: liveFocusSnapshot(this.container), search: "exit" });
          return;
        }
        Router.back();
        return;
      }
      if (this.searchActive) {
        // The real <input> owns every key while search is open; Escape (27)
        // leaves search. Nothing may move focus out from under the IME.
        if (code === 27) {
          this.exitSearch();
        }
        return;
      }

      if (code === 37 || code === 39) {
        this.handleHorizontal(code === 37 ? -1 : 1);
      } else if (code === 38 || code === 40) {
        this.handleVertical(code === 38 ? -1 : 1);
      } else if (code === 13) {
        this.handleEnter();
      } else {
        return;
      }
      reportLiveNav({ key: code, after: liveFocusSnapshot(this.container) });
    },

    handleHorizontal(delta) {
      if (this.focusZone === "header") {
        // Only the search and guide pills live here.
        this.headerIndex = Math.min(1, Math.max(0, (this.headerIndex || 0) + delta));
        this.applyFocusState({ smooth: true });
        return;
      }
      if (this.focusZone === "chips") {
        const chips = this.chipModel();
        this.chipIndex = Math.min(chips.length - 1, Math.max(0, (this.chipIndex || 0) + delta));
        this.applyFocusState({ smooth: true });
        return;
      }
      // List zone: LEFT leaves the star back to the row, then leaves the list
      // for the chips row (the list is one column wide, so LEFT is always the
      // row edge). RIGHT enters the row's star and stops there.
      if (delta < 0) {
        if (this.rowFocusTarget === "star") {
          this.rowFocusTarget = "row";
          this.applyFocusState({ smooth: true });
        } else {
          this.focusZone = "chips";
          this.applyFocusState({ smooth: true });
        }
      } else if (this.rowFocusTarget === "row") {
        this.rowFocusTarget = "star";
        this.applyFocusState({ smooth: true });
      }
    },

    handleVertical(delta) {
      if (this.focusZone === "header") {
        this.focusZone = "chips";
        this.applyFocusState({ smooth: true });
        return;
      }
      if (this.focusZone === "chips") {
        if (delta > 0) {
          this.focusZone = "list";
          this.rowFocusTarget = "row";
          this.applyFocusState({ smooth: true });
        } else {
          this.focusZone = "header";
          this.headerIndex = 0;
          this.applyFocusState({ smooth: true });
        }
        return;
      }
      // List zone: UP/DOWN move the focused row and the preview follows focus
      // immediately (no Enter needed).
      const count = Array.isArray(this.channels) ? this.channels.length : 0;
      if (!count) return;
      const next = Math.min(count - 1, Math.max(0, (this.rowIndex || 0) + delta));
      if (next === this.rowIndex) return;
      this.rowIndex = next;
      this.updateRowsOnly();
    },

    handleEnter() {
      if (this.focusZone === "header") {
        if ((this.headerIndex || 0) === 0) {
          this.openSearch();
        } else {
          this.showGuideNotice();
        }
        return;
      }
      if (this.focusZone === "chips") {
        const chip = this.chipModel()[this.chipIndex || 0];
        if (chip) this.selectChip(chip.id, this.chipIndex);
        return;
      }
      const channels = Array.isArray(this.channels) ? this.channels : [];
      const channel = channels[this.rowIndex || 0];
      if (!channel) return;
      if (this.rowFocusTarget === "star") {
        // Toggling a favourite must never tune in.
        this.toggleFavorite(channel.id);
        return;
      }
      const node = this.container?.querySelector(`.live-channel-row[data-row-index="${this.rowIndex}"]`);
      void this.tuneIn(node || { dataset: { channelId: String(channel.id || ""), channelTitle: channel.name || "" } });
    },

    // Chips ------------------------------------------------------------------
    selectChip(chipId, chipIndex = this.chipIndex) {
      const id = String(chipId ?? "");
      if (!id) return;
      this.activeChipId = id;
      this.focusZone = "chips";
      if (Number.isInteger(chipIndex)) this.chipIndex = chipIndex;
      this.rowIndex = 0;
      this.rowFocusTarget = "row";
      this.clearNotice();
      if (id === FAVORITES_CHIP_ID) {
        this.refreshVisibleChannels();
        return;
      }
      // "Todos" shows the first source group; other chips map 1:1 to a portal
      // category. Cached lists render instantly, misses load in the foreground.
      const columnId = id === internals.ALL_CHIP_ID ? (this.categories[0]?.columnId ?? null) : id;
      this.selectedColumnId = columnId;
      const cached = this.channelsByColumn.get(String(columnId));
      if (cached) {
        this.channels = cached;
        this.channelsLoading = false;
        this.channelsError = "";
        this.refreshVisibleChannels();
        return;
      }
      this.channels = [];
      this.channelsLoading = true;
      this.channelsError = "";
      this.render();
      void this.loadChannelsForCategory(columnId, { background: false });
    },

    // Search -----------------------------------------------------------------
    openSearch() {
      this.searchActive = true;
      this.searchQuery = "";
      this.rowIndex = 0;
      this.rowFocusTarget = "row";
      this.render();
      // Mounting the input and focusing it is what invites the TV system IME;
      // typing filters immediately even if a TV never shows the IME.
      const input = this.container?.querySelector(".live-search-input");
      if (input) {
        focusWithoutAutoScrollSafe(input);
        this.bindSearchInput(input);
      }
    },

    bindSearchInput(input) {
      const field = input || this.container?.querySelector(".live-search-input");
      if (!field || field.dataset.liveBound === "1") return;
      field.dataset.liveBound = "1";
      field.addEventListener("input", () => {
        this.searchQuery = String(field.value || "");
        this.rowIndex = 0;
        this.rowFocusTarget = "row";
        this.refreshVisibleChannels();
      });
      field.addEventListener("keydown", (event) => {
        // Escape never bubbles into a Back navigation while typing.
        if (Number(event?.keyCode || 0) === 27 || event?.key === "Escape") {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          this.exitSearch();
        }
      });
    },

    exitSearch() {
      this.searchActive = false;
      this.searchQuery = "";
      this.rowIndex = 0;
      this.rowFocusTarget = "row";
      this.focusZone = "header";
      this.headerIndex = 0;
      this.refreshVisibleChannels();
      this.applyFocusState();
    },

    // Guide ------------------------------------------------------------------
    showGuideNotice() {
      // Honest answer only: there is no EPG source yet, so there is no guide
      // screen to open and no date to promise.
      this.showNotice(t("live_guide_unavailable", {}, "La guía de programas necesita datos EPG y todavía no está disponible"));
    },

    // Keep the focused node inside its own scroll panel. The chips row scrolls
    // horizontally, the channel list vertically; never the document, and by
    // the smallest amount that makes the node fully visible.
    ensureFocusVisible({ smooth = true } = {}) {
      const focused = this.container?.querySelector(".focusable.focused");
      if (!focused) {
        return;
      }
      const chipsRow = focused.closest(".live-chips-row");
      if (chipsRow) {
        const rowRect = chipsRow.getBoundingClientRect();
        const rect = focused.getBoundingClientRect();
        const margin = 24;
        let delta = 0;
        if (rect.left < rowRect.left + margin) {
          delta = rect.left - rowRect.left - margin;
        } else if (rect.right > rowRect.right - margin) {
          delta = rect.right - rowRect.right + margin;
        }
        if (!delta) return;
        const left = chipsRow.scrollLeft + delta;
        if (typeof chipsRow.scrollTo === "function") {
          chipsRow.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
        } else {
          chipsRow.scrollLeft = left;
        }
        return;
      }
      const panel = focused.closest(".live-channel-list");
      if (!panel) {
        return;
      }
      const panelRect = panel.getBoundingClientRect();
      const rect = focused.getBoundingClientRect();
      const margin = 16;
      let delta = 0;
      if (rect.top < panelRect.top + margin) {
        delta = rect.top - panelRect.top - margin;
      } else if (rect.bottom > panelRect.bottom - margin) {
        delta = rect.bottom - panelRect.bottom + margin;
      }
      if (!delta) {
        return;
      }
      const top = panel.scrollTop + delta;
      if (typeof panel.scrollTo === "function") {
        panel.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
      } else {
        panel.scrollTop = top;
      }
    },

    // Temporary probe: a TV gives no logs, so each channel logo reports whether
    // it actually decoded (naturalWidth) or errored. Decides between "the image
    // never arrives" and "the image arrives but is not visible".
    probeChannelLogos() {
      const images = Array.from(this.container?.querySelectorAll(".live-row-logo img, .live-preview-logo") || []).slice(0, 12);
      if (!images.length) {
        // The first renders are the loading skeleton: nothing to measure yet.
        return;
      }
      const outcomes = [];
      let pending = images.length;
      const settle = (img, ok) => {
        outcomes.push({ ok, w: img.naturalWidth || 0, src: String(img.currentSrc || img.src || "").slice(-28) });
        pending -= 1;
        if (pending > 0) return;
        reportLiveNav({
          phase: "logos",
          total: images.length,
          ok: outcomes.filter((o) => o.ok).length,
          sample: outcomes.slice(0, 3)
        });
      };
      images.forEach((img) => {
        if (img.complete) {
          settle(img, img.naturalWidth > 0);
          return;
        }
        img.addEventListener("load", () => settle(img, img.naturalWidth > 0), { once: true });
        img.addEventListener("error", () => settle(img, false), { once: true });
      });
      setTimeout(() => {
        if (pending > 0) {
          reportLiveNav({ phase: "logos", total: images.length, stalled: pending });
        }
      }, 8000);
    },

    async tuneIn(node) {
      const channelId = String(node?.dataset?.channelId || "");
      const playerTitle = String(node?.dataset?.channelTitle || t("live_channel_fallback_title", {}, "Live channel"));
      if (!channelId || this.tuningChannelId) {
        return;
      }
      // A new tune-in supersedes a pending one: abort the previous resolution
      // so its late result can never start playback of a stale channel.
      this.resolveController?.abort?.();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      this.resolveController = controller;
      this.tuningChannelId = channelId;
      this.showNotice(t("live_tuning", {}, "Tuning..."), { sticky: true });

      const result = await liveRepository.resolveChannel(channelId, {
        signal: controller?.signal || null
      });
      if (controller !== this.resolveController || controller.signal?.aborted) {
        return; // superseded, cancelled or the screen was left
      }
      this.tuningChannelId = "";
      this.clearNotice();
      if (result.status !== "success") {
        if (!result.aborted) {
          // Stay on the screen and surface the diagnostic; never a blank screen.
          this.showNotice(`${t("live_tune_failed", {}, "Could not tune this channel")}: ${String(result.detail || "")}`);
        }
        return;
      }
      const { url, headers } = result.data || {};
      if (!url) {
        this.showNotice(`${t("live_tune_failed", {}, "Could not tune this channel")}: no stream URL`);
        return;
      }
      Router.navigate("player", {
        streamUrl: url,
        itemType: "channel",
        playerTitle,
        returnRoute: "live",
        streamCandidates: [
          {
            url,
            behaviorHints: {
              proxyHeaders: { request: headers || {} }
            }
          }
        ]
      });
    },

    showNotice(message, { sticky = false } = {}) {
      this.notice = String(message || "");
      this.clearNoticeTimer();
      if (!sticky && this.notice) {
        this.noticeTimer = setTimeout(() => {
          this.noticeTimer = 0;
          if (Router.getCurrent() !== "live") return;
          this.notice = "";
          const node = this.container?.querySelector(".live-notice");
          if (node) node.remove();
        }, NOTICE_VISIBLE_MS);
      }
      if (this.container) {
        const existing = this.container.querySelector(".live-notice");
        if (existing) {
          existing.textContent = this.notice;
        } else if (this.notice) {
          this.container
            .querySelector(".live-shell")
            ?.insertAdjacentHTML("beforeend", `<div class="live-notice" role="status">${escapeHtml(this.notice)}</div>`);
        }
      }
    },

    clearNotice() {
      this.notice = "";
      this.clearNoticeTimer();
      this.container?.querySelector(".live-notice")?.remove();
    },

    clearNoticeTimer() {
      if (this.noticeTimer) {
        clearTimeout(this.noticeTimer);
        this.noticeTimer = 0;
      }
    }
  };
}

function focusWithoutAutoScrollSafe(node) {
  try {
    internals.focusWithoutAutoScroll(node);
  } catch (_) {
    try {
      node?.focus?.();
    } catch (_) {
      // Focus is best effort on constrained TV engines.
    }
  }
}
