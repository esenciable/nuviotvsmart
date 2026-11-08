/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";
import { clampIndex, shouldAcceptRepeatMove, expandedGroupIdsRef } from "./liveScreenMethods-02-render.js";

const NOTICE_VISIBLE_MS = 6000;

// Fluidity: a held remote key auto-repeats much faster than a 110ms scroll
// animation can settle. Repeats faster than the cadence are coalesced so the
// list advances at a steady pace instead of queuing.
const MOVE_CADENCE_MS = 90;
const SCROLL_ANIMATE_MS = 110;

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

// Errors must never be silent on a TV (no logs): every guarded handler reports
// through the runtime beacon with the message and a short stack head.
function reportLiveErrorSafe(error, where) {
  try {
    const message = String(error?.message || error || "unknown error");
    const stackHead = String(error?.stack || "")
      .split("\n")
      .slice(0, 4)
      .join(" | ")
      .slice(0, 300);
    void import("../../../core/diagnostics/runtimeBeacon.js")
      .then((mod) => mod.sendRuntimeBeacon({ phase: "live-error", where, message, stackHead }))
      .catch(() => {});
  } catch (_) {
    // Diagnostics are optional.
  }
}

function liveFocusSnapshot(container) {
  const focused = container?.querySelector(".focusable.focused");
  const list = container?.querySelector(".live-channel-list");
  const size = (el) => (el ? `${Math.round(el.scrollHeight)}/${Math.round(el.clientHeight)}` : "x");
  return {
    focus: focused ? `${focused.dataset.action || "?"}:${focused.dataset.flatIndex || focused.dataset.focusKey || "?"}` : "none",
    list: list ? Math.round(list.scrollTop) : -1,
    listSize: size(list)
  };
}

// Key handling, activation and tune-in. Focus is a deterministic state model
// (focusZone + flatIndex + rowFocusTarget) over the FLAT list order (group
// headers interleaved with their expanded rows) instead of geometric dpad
// navigation: UP/DOWN move one flat item with class toggles only (no
// re-render), RIGHT reaches the row's star, Enter activates (group toggle,
// tune-in, favourite), LEFT backs out of the star. Back exits search before
// leaving the screen.
export function createLiveScreenMethods03() {
  const { Router, ScreenUtils, liveRepository, isBackEvent, escapeHtml, t } = internals;

  return {
    onKeyDown(event) {
      try {
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
      } catch (error) {
        reportLiveErrorSafe(error, "onKeyDown");
      }
    },

    handleHorizontal(delta) {
      if (this.focusZone === "header") {
        // Only the search and guide pills live here.
        this.headerIndex = clampIndex((this.headerIndex || 0) + delta, 2);
        this.applyFocusState({ smooth: true });
        return;
      }
      // List zone: the only horizontal target is the row's star. Group header
      // cards have no horizontal neighbour; the star backs out with LEFT.
      const item = this.flatItems()[this.flatIndex || 0];
      if (!item || item.type !== "channel") {
        return;
      }
      if (delta > 0) {
        if (this.rowFocusTarget !== "star") {
          this.rowFocusTarget = "star";
          this.applyFocusState({ smooth: true });
        }
      } else if (this.rowFocusTarget === "star") {
        this.rowFocusTarget = "row";
        this.applyFocusState({ smooth: true });
      }
    },

    handleVertical(delta) {
      if (this.focusZone === "header") {
        // DOWN enters the flat list (at its remembered/clamped position); UP
        // from the header has nowhere to go and stays.
        if (delta > 0) {
          this.focusZone = "list";
          this.rowFocusTarget = "row";
          this.applyFocusState({ smooth: true });
        }
        return;
      }
      // List zone: one flat item per keypress, class toggles only. At the top
      // of the list UP returns to the header pills.
      const items = this.flatItems();
      if (!items.length) return;
      if (delta < 0 && (this.flatIndex || 0) <= 0) {
        this.focusZone = "header";
        this.headerIndex = 0;
        this.applyFocusState({ smooth: true });
        return;
      }
      this.moveFlat(delta);
    },

    // One flat move: coalesce auto-repeats faster than the scroll animation,
    // then reposition focus by toggling classes only (never a re-render).
    moveFlat(delta) {
      const items = this.flatItems();
      if (!items.length) return;
      const now = Date.now();
      if (!shouldAcceptRepeatMove(this.lastFlatMoveAt, now, MOVE_CADENCE_MS)) {
        return;
      }
      this.lastFlatMoveAt = now;
      const next = clampIndex((this.flatIndex || 0) + delta, items.length);
      if (next === this.flatIndex) return;
      this.flatIndex = next;
      this.rowFocusTarget = "row";
      this.applyFocusState({ smooth: true });
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
      const item = this.flatItems()[this.flatIndex || 0];
      if (!item) return;
      if (item.type === "group") {
        this.toggleGroup(item);
        return;
      }
      const channel = item.channel;
      if (!channel) return;
      if (this.rowFocusTarget === "star") {
        // Toggling a favourite must never tune in.
        this.toggleFavorite(channel.id);
        return;
      }
      const node = this.container?.querySelector(`[data-flat-index="${this.flatIndex}"]`);
      this.tuneIn(node || { dataset: { channelId: String(channel.id || ""), channelTitle: channel.name || "" } }).catch?.((error) =>
        reportLiveErrorSafe(error, "tuneIn")
      );
    },

    // Groups -----------------------------------------------------------------
    // Enter on a group header toggles it. When the rows are already known the
    // toggle is surgical (one insert/remove, no list re-render); otherwise the
    // list repaints once and the channels load in the background.
    toggleGroup(item) {
      const groupId = String(item?.groupId ?? "");
      if (!groupId) return;
      const willExpand = !expandedGroupIdsRef().has(groupId);
      if (willExpand) expandedGroupIdsRef().add(groupId);
      else expandedGroupIdsRef().delete(groupId);
      if (this.toggleGroupRowsInPlace(item, willExpand)) {
        this.reindexFlatDom();
        this.applyFocusState({ smooth: true });
        return;
      }
      this.updateRowsOnly();
      if (willExpand) this.ensureGroupChannels(groupId);
    },

    // Surgical toggle: insert/remove only the toggled group's rows. The
    // header keeps its flat index (it precedes its own rows), so focus stays
    // exactly where it is. Returns false when the cheap path is not possible.
    toggleGroupRowsInPlace(item, willExpand) {
      try {
        const container = this.container;
        const selector = groupAttributeSelector("data-group-id", item?.groupId);
        const header = container?.querySelector(`.live-group-header${selector}`);
        if (!header) return false;
        if (!willExpand) {
          container.querySelectorAll(`.live-group-rows${selector}`).forEach((node) => node.remove());
          header.setAttribute("aria-expanded", "false");
          header.querySelector(".live-group-chevron")?.classList.remove("is-expanded");
          return true;
        }
        if (item.loading || !Array.isArray(item.channels) || !item.channels.length) {
          return false; // rows unknown: full list repaint shows the loading state
        }
        const wrapper = document.createElement("div");
        wrapper.className = "live-group-rows";
        wrapper.dataset.groupId = String(item.groupId);
        wrapper.innerHTML = item.channels.map((channel) => this.renderChannelRow(channel)).join("");
        header.insertAdjacentElement("afterend", wrapper);
        header.setAttribute("aria-expanded", "true");
        header.querySelector(".live-group-chevron")?.classList.add("is-expanded");
        return true;
      } catch (error) {
        reportLiveErrorSafe(error, "toggleGroupRowsInPlace");
        return false;
      }
    },

    // Loads a group's channels through the existing cache machinery and
    // repaints the list exactly once when the cache arrives (the background
    // load path itself does not repaint).
    ensureGroupChannels(groupId) {
      const key = String(groupId ?? "");
      if (!key || key === internals.FAVORITES_CHIP_ID) return;
      if (this.channelsByColumn?.has(key)) return;
      void this.loadChannelsForCategory(key, { background: true });
      const token = this.loadToken || 0;
      const startedAt = Date.now();
      const poll = () => {
        this.groupPollTimer = 0;
        if (token !== (this.loadToken || 0) || Router.getCurrent?.() !== "live") return;
        if (this.channelsByColumn?.has(key)) {
          this.updateRowsOnly();
          return;
        }
        if (Date.now() - startedAt > 15000) return;
        this.groupPollTimer = setTimeout(poll, 400);
      };
      this.groupPollTimer = setTimeout(poll, 400);
    },

    // Search -----------------------------------------------------------------
    openSearch() {
      this.searchActive = true;
      this.searchQuery = "";
      this.flatIndex = 0;
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
        this.flatIndex = 0;
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
      this.flatIndex = 0;
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

    // Keep the focused node inside the list panel by the smallest movement
    // that makes it fully visible, animated over a short ease so held keys
    // never lag behind the scroll.
    ensureFocusVisible({ smooth = true } = {}) {
      try {
        const focused = this.container?.querySelector(".focusable.focused");
        if (!focused) {
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
        const maxTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
        const top = Math.min(maxTop, Math.max(0, panel.scrollTop + delta));
        if (smooth) {
          this.animateListScroll(panel, top);
        } else {
          panel.scrollTop = top;
        }
      } catch (error) {
        reportLiveErrorSafe(error, "ensureFocusVisible");
      }
    },

    // Short eased scroll (~110ms, ease-out cubic). A new target replaces the
    // running animation instead of queueing behind it.
    animateListScroll(panel, top) {
      if (this.listScrollFrame && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.listScrollFrame);
      }
      this.listScrollFrame = 0;
      const from = panel.scrollTop;
      const delta = top - from;
      if (Math.abs(delta) < 1) return;
      if (typeof requestAnimationFrame !== "function") {
        panel.scrollTop = top;
        return;
      }
      const start = globalThis.performance?.now ? performance.now() : Date.now();
      const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
      const step = (now) => {
        const t = Math.min(1, Math.max(0, (now - start) / SCROLL_ANIMATE_MS));
        panel.scrollTop = from + delta * easeOutCubic(t);
        this.listScrollFrame = t < 1 ? requestAnimationFrame(step) : 0;
      };
      this.listScrollFrame = requestAnimationFrame(step);
    },

    // Temporary probe: a TV gives no logs, so each channel logo reports whether
    // it actually decoded (naturalWidth) or errored. Decides between "the image
    // never arrives" and "the image arrives but is not visible".
    probeChannelLogos() {
      const images = Array.from(this.container?.querySelectorAll(".live-row-logo img") || []).slice(0, 12);
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

function groupAttributeSelector(attribute, value) {
  const raw = String(value ?? "");
  const escaped = globalThis.CSS?.escape ? CSS.escape(raw) : raw.replace(/(["\\])/g, "\\$1");
  return `[${attribute}="${escaped}"]`;
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
