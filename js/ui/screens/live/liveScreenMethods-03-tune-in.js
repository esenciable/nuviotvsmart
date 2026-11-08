/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";
import {
  clampIndex,
  shouldAcceptRepeatMove,
  collapsedSourceIdsRef,
  toggleSourceCollapsed,
  railMoveIndex,
  railFocusAfterChange,
  KEYBOARD_KEYS,
  buildKeyboardLayout,
  keyboardFlatKeys,
  keyboardMove,
  applyKeyboardKey
} from "./liveScreenMethods-02-render.js";

const NOTICE_VISIBLE_MS = 6000;

// Fluidity: a held remote key auto-repeats much faster than a 110ms scroll
// animation can settle. Repeats faster than the cadence are coalesced so the
// list advances at a steady pace instead of queuing.
const MOVE_CADENCE_MS = 90;
const SCROLL_ANIMATE_MS = 110;

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

// Key handling, activation and tune-in for the reference layout. Focus is a
// deterministic state model over two panels plus the hero actions:
//   rail  (left column)  — UP/DOWN move inside the rail; RIGHT/Enter activate
//                          the row (select + enter the channel rows; Enter on
//                          a source header toggles it; Enter on the search row
//                          opens the on-screen keyboard); UP from the very top
//                          reaches the hero actions while the hero is visible.
//   rows  (right side)   — UP/DOWN move one row (class toggles only); Enter
//                          tunes in; RIGHT reaches the row's star; LEFT backs
//                          out to the rail.
//   hero  (top actions)  — LEFT/RIGHT between the search and guide pills;
//                          DOWN returns to the rail.
//   keyboard (search)    — the deterministic on-screen keyboard (no system
//                          IME): arrows move between keys row-aware, Enter
//                          types the focused key, Back closes the keyboard and
//                          returns to the Buscar row keeping the query, Listo
//                          applies the query and moves to the results.
// Back exits the keyboard first, then search itself, before leaving the screen.
export function createLiveScreenMethods03() {
  const { Router, ScreenUtils, liveRepository, isBackEvent, escapeHtml, t } = internals;

  return {
    onKeyDown(event) {
      try {
        const code = Number(event?.keyCode || 0);
        if (isBackEvent(event)) {
          event?.preventDefault?.();
          if (this.keyboardOpen) {
            // Back inside the keyboard closes it and keeps the query: focus
            // returns to the Buscar row with the results still applied.
            this.closeKeyboard();
            return;
          }
          if (this.searchActive) {
            this.exitSearch();
            return;
          }
          Router.back();
          return;
        }
        if (this.focusZone === "keyboard") {
          // The on-screen keyboard owns the D-pad while it is open. Movement
          // is pure (row-aware over the cached key model) — no DOM measuring.
          if (code === 37 || code === 39) {
            this.moveKeyboard(code === 37 ? -1 : 1, 0);
          } else if (code === 38 || code === 40) {
            this.moveKeyboard(0, code === 38 ? -1 : 1);
          } else if (code === 13) {
            this.applyFocusedKey();
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
      } catch (error) {
        reportLiveErrorSafe(error, "onKeyDown");
      }
    },

    handleHorizontal(delta) {
      if (this.focusZone === "hero") {
        // Only the search and guide pills live here.
        this.heroIndex = clampIndex((this.heroIndex || 0) + delta, 2);
        this.applyFocusState({ smooth: true });
        return;
      }
      if (this.focusZone === "rail") {
        // RIGHT activates the row exactly like Enter (select + enter rows).
        if (delta > 0) {
          this.activateRailRow();
        }
        return;
      }
      // Rows zone: RIGHT reaches the row's star; LEFT backs out of the star,
      // and from the row itself returns to the rail.
      if (delta > 0) {
        if (this.rowFocusTarget !== "star") {
          this.rowFocusTarget = "star";
          this.applyFocusState({ smooth: true });
        }
        return;
      }
      if (this.rowFocusTarget === "star") {
        this.rowFocusTarget = "row";
        this.applyFocusState({ smooth: true });
        return;
      }
      this.returnToRail();
    },

    handleVertical(delta) {
      if (this.focusZone === "hero") {
        // DOWN returns to the rail; UP from the pills has nowhere to go.
        if (delta > 0) {
          this.focusZone = "rail";
          this.applyFocusState({ smooth: true });
        }
        return;
      }
      if (this.focusZone === "rows") {
        // One row per keypress, class toggles only. At the top LEFT-side
        // semantics do not apply: UP past the first row returns to the rail.
        const rows = this.visibleChannels();
        if (!rows.length) {
          this.focusZone = "rail";
          this.applyFocusState({ smooth: true });
          return;
        }
        if (delta < 0 && (this.rowIndex || 0) <= 0) {
          this.returnToRail();
          return;
        }
        this.moveRows(delta);
        return;
      }
      // Rail zone: one item per keypress, class toggles only. UP from the
      // very top reaches the hero actions while the hero is visible.
      const items = this.railItems();
      if (!items.length) return;
      if (delta < 0 && (this.railIndex || 0) <= 0) {
        if (this.heroChannel) {
          this.focusZone = "hero";
          this.heroIndex = 0;
          this.applyFocusState({ smooth: true });
        }
        return;
      }
      this.moveRail(delta);
    },

    handleEnter() {
      if (this.focusZone === "hero") {
        // The hero has a single control: the search (gear) control.
        this.openSearch();
        return;
      }
      if (this.focusZone === "rows") {
        const rows = this.visibleChannels();
        const channel = rows[this.rowIndex || 0];
        if (!channel) return;
        if (this.rowFocusTarget === "star") {
          // Toggling a favourite must never tune in.
          this.toggleFavorite(channel.id);
          return;
        }
        const node = this.container?.querySelector(`[data-row-index="${this.rowIndex}"]`);
        this.tuneIn(node || { dataset: { channelId: String(channel.id || ""), channelTitle: channel.name || "" } }).catch?.((error) =>
          reportLiveErrorSafe(error, "tuneIn")
        );
        return;
      }
      // Rail zone: activate the focused row.
      this.activateRailRow();
    },

    // Rail movement ----------------------------------------------------------
    // One rail item per keypress: coalesce auto-repeats faster than the
    // scroll animation, then reposition focus by toggling classes only
    // (never a re-render).
    moveRail(delta) {
      const items = this.railItems();
      if (!items.length) return;
      const now = Date.now();
      if (!shouldAcceptRepeatMove(this.lastRailMoveAt, now, MOVE_CADENCE_MS)) {
        return;
      }
      this.lastRailMoveAt = now;
      // Index-based over the CURRENT list, clamped at both ends: no wrap, no
      // jump. At a boundary the index does not move and the ring stays put.
      const next = railMoveIndex(items, this.railIndex, delta);
      if (next === this.railIndex) return;
      this.setRailFocusIndex(next);
      this.applyFocusState({ smooth: true });
    },

    // Rows movement ----------------------------------------------------------
    moveRows(delta) {
      const rows = this.visibleChannels();
      if (!rows.length) return;
      const now = Date.now();
      if (!shouldAcceptRepeatMove(this.lastRowMoveAt, now, MOVE_CADENCE_MS)) {
        return;
      }
      this.lastRowMoveAt = now;
      const next = clampIndex((this.rowIndex || 0) + delta, rows.length);
      if (next === this.rowIndex) return;
      this.rowIndex = next;
      this.rowFocusTarget = "row";
      this.applyFocusState({ smooth: true });
    },

    // LEFT from a row (or UP past the first row) goes back to the rail at the
    // currently selected row.
    returnToRail() {
      this.focusZone = "rail";
      this.rowFocusTarget = "row";
      const selectionIndex = this.railItems().findIndex((item) => item.railId === String(this.railSelection ?? ""));
      if (selectionIndex >= 0) {
        this.setRailFocusIndex(selectionIndex);
      }
      this.applyFocusState({ smooth: true });
    },

    // Enter (or RIGHT) on the focused rail row.
    activateRailRow() {
      const items = this.railItems();
      const item = items[this.railIndex || 0];
      if (!item) return;
      if (item.type === "source") {
        this.toggleSource(item);
        return;
      }
      if (item.type === "search") {
        this.openSearch();
        return;
      }
      this.selectRailItem(item.railId, { enterRows: true });
    },

    // Source headers ---------------------------------------------------------
    // Enter on a source header toggles it. When the categories are known the
    // toggle is surgical (one insert/remove, no panel re-render); otherwise
    // the rail repaints once.
    toggleSource(item) {
      const railId = String(item?.railId ?? "");
      if (!railId) return;
      // Capture WHERE focus is before the list changes so it can be recovered
      // by identity afterwards (never by a stale number).
      const previousItems = this.railItems();
      const previousIndex = clampIndex(this.railIndex || 0, previousItems.length);
      const previousItem = previousItems[previousIndex] || null;
      const willExpand = !collapsedSourceIdsRef().has(railId);
      toggleSourceCollapsed(collapsedSourceIdsRef(), railId);
      if (this.toggleSourceRowsInPlace(item, willExpand)) {
        this.reindexRailDom();
        // The rail's geometry changed (rows inserted/removed): refresh the
        // cached offsets once so the next keypress still uses the cache.
        this.cacheLayoutMetrics?.();
        // Identity-based focus recovery: the toggled header KEEPS the ring
        // (its railId survives, so its index), a focused category whose rows
        // just vanished lands on its source's header, and anything else
        // clamps into the changed list. Focus never rests on a missing node.
        this.setRailFocusIndex(railFocusAfterChange(this.railItems(), previousIndex, previousItem));
        this.applyFocusState({ smooth: true });
        return;
      }
      this.updateRowsOnly();
    },

    // Surgical toggle: insert/remove only the toggled source's category rows.
    // The header keeps its rail index (it precedes its own rows), so focus
    // stays exactly where it is. Returns false when the cheap path is not
    // possible.
    toggleSourceRowsInPlace(item, willExpand) {
      try {
        const container = this.container;
        const header = container?.querySelector(`.live-source-header[data-rail-id="${attributeEscape(item?.railId)}"]`);
        if (!header) return false;
        if (!willExpand) {
          // Remove every category row that follows this header until the next
          // header (or the end of the rail).
          let node = header.nextElementSibling;
          while (node && !node.classList.contains("live-source-header")) {
            const next = node.nextElementSibling;
            if (node.classList.contains("live-rail-category")) node.remove();
            node = next;
          }
          header.setAttribute("aria-expanded", "false");
          const chevron = header.querySelector(".live-source-chevron");
          if (chevron) {
            chevron.textContent = "›";
            chevron.classList.remove("is-expanded");
          }
          return true;
        }
        const categories = Array.isArray(item?.categories) ? item.categories : [];
        if (!categories.length) return false;
        const fragment = document.createElement("template");
        fragment.innerHTML = categories
          .map((category, index) => {
            const flatIndex = Number(header.dataset.railIndex || 0) + 1 + index;
            return this.renderRailCategory(category, flatIndex);
          })
          .join("");
        let anchor = header;
        for (const row of Array.from(fragment.content.children)) {
          anchor.insertAdjacentElement("afterend", row);
          anchor = row;
        }
        header.setAttribute("aria-expanded", "true");
        const chevron = header.querySelector(".live-source-chevron");
        if (chevron) {
          chevron.textContent = "▾";
          chevron.classList.add("is-expanded");
        }
        return true;
      } catch (error) {
        reportLiveErrorSafe(error, "toggleSourceRowsInPlace");
        return false;
      }
    },

    // Re-stamps data-rail-index over the live DOM order after a surgical
    // source toggle so the flat focus model and the DOM never disagree.
    reindexRailDom() {
      const nodes = this.container?.querySelectorAll(".live-rail .focusable");
      let index = 0;
      nodes?.forEach((node) => {
        node.dataset.railIndex = String(index);
        index += 1;
      });
    },

    // Search -----------------------------------------------------------------
    // The on-screen keyboard replaces the old system-IME-over-an-input approach:
    // the IME never attached on the device and typed text was invisible. Now
    // every key is a .focusable node we own, registered in the cached layout
    // metrics, and the query renders as plain DOM text in the query line.
    openSearch() {
      this.searchActive = true;
      this.keyboardOpen = true;
      this.keyboardIndex = 0;
      this.focusZone = "keyboard";
      this.rowIndex = 0;
      this.rowFocusTarget = "row";
      // Reopening with an existing query recomputes the results first; the
      // full render then mounts the fixed keyboard panel with them in place.
      this.refreshVisibleChannels();
      this.render({ preserveFocus: false });
    },

    // D-pad movement inside the keyboard: pure row-aware move over the fixed
    // key model, then a class toggle (never a re-render, never a measurement).
    moveKeyboard(dx, dy) {
      const next = keyboardMove(KEYBOARD_KEYS, this.keyboardIndex || 0, dx, dy);
      if (next === this.keyboardIndex) return;
      this.keyboardIndex = next;
      this.applyFocusState({ smooth: true });
    },

    // Enter on a key: chars/ESPACIO/BORRAR/LIMPIAR update the query purely,
    // patch the query line in place and re-filter the rows; LISTO closes the
    // keyboard and moves focus to the results.
    applyFocusedKey() {
      const entry = KEYBOARD_KEYS[this.keyboardIndex || 0];
      if (!entry) return;
      if (entry.key.type === "done") {
        this.closeKeyboard({ toResults: true });
        return;
      }
      const next = applyKeyboardKey(this.searchQuery, entry.key);
      if (next === this.searchQuery) return;
      this.searchQuery = next;
      this.rowIndex = 0;
      this.rowFocusTarget = "row";
      this.updateKeyboardQueryLine?.();
      this.refreshVisibleChannels();
    },

    // Back from the keyboard: close the panel and return focus to the Buscar
    // row KEEPING the query (the results and the dimmed rail stay applied).
    // With `toResults` (Listo), focus moves into the channel rows instead.
    closeKeyboard({ toResults = false } = {}) {
      this.keyboardOpen = false;
      if (toResults) {
        this.focusZone = "rows";
        this.rowIndex = 0;
        this.rowFocusTarget = "row";
      } else {
        this.focusZone = "rail";
        const items = this.railItems();
        const searchIndex = items.findIndex((item) => item.type === "search");
        this.setRailFocusIndex(searchIndex);
      }
      this.render({ preserveFocus: false });
    },

    exitSearch() {
      this.searchActive = false;
      this.keyboardOpen = false;
      this.searchQuery = "";
      this.rowIndex = 0;
      this.rowFocusTarget = "row";
      this.focusZone = "rail";
      this.refreshVisibleChannels();
      this.applyFocusState();
    },

    // Guide ------------------------------------------------------------------
    // No EPG source exists, so there is no guide control on the hero and no
    // guide screen to open.

    // Layout metrics cache --------------------------------------------------
    // THE fluidity rule: no DOM measurement per keypress. After each real
    // render, after expand/collapse and on resize, the focusable rows' offsets
    // (relative to their scroll panel, via offsetParent) plus each panel's
    // clientHeight/scrollHeight are cached here. The move handler only reads
    // this cache — never getBoundingClientRect, offsetTop or clientHeight.
    cacheLayoutMetrics() {
      try {
        const container = this.container;
        if (!container) return;
        const metrics = new Map();
        for (const panel of container.querySelectorAll(".live-rail, .live-channel-list, .live-keyboard-grid")) {
          const rows = new Map();
          for (const node of panel.querySelectorAll(".focusable")) {
            rows.set(node, { top: node.offsetTop, height: node.offsetHeight });
          }
          metrics.set(panel, {
            rows,
            viewHeight: panel.clientHeight,
            scrollRange: Math.max(0, panel.scrollHeight - panel.clientHeight)
          });
        }
        this.layoutMetrics = metrics;
      } catch (error) {
        reportLiveErrorSafe(error, "cacheLayoutMetrics");
      }
    },

    // Keep the focused node inside its panel (rail or channel list) using ONLY
    // the cached offsets: the smallest movement that makes it fully visible,
    // animated over a short ease so held keys never lag behind the scroll.
    // A keypress must never trigger a DOM measurement here.
    ensureFocusVisible({ smooth = true } = {}) {
      try {
        const focused = this.container?.querySelector(".focusable.focused");
        if (!focused) {
          return;
        }
        const panel = focused.closest(".live-rail, .live-channel-list, .live-keyboard-grid");
        if (!panel) {
          return;
        }
        const panelMetrics = this.layoutMetrics instanceof Map ? this.layoutMetrics.get(panel) : null;
        const entry = panelMetrics?.rows instanceof Map ? panelMetrics.rows.get(focused) : null;
        if (!entry) {
          // No cached entry for this node yet (it appears with the next real
          // render / recache). Doing nothing keeps the keypress cheap; it can
          // never trigger a per-move measurement.
          return;
        }
        const margin = 16;
        const top = Number(panel.scrollTop) || 0;
        let delta = 0;
        if (entry.top < top + margin) {
          delta = entry.top - top - margin;
        } else if (entry.top + entry.height > top + panelMetrics.viewHeight - margin) {
          delta = entry.top + entry.height - top - panelMetrics.viewHeight + margin;
        }
        if (!delta) {
          return;
        }
        const target = Math.min(panelMetrics.scrollRange, Math.max(0, top + delta));
        if (smooth) {
          this.animateListScroll(panel, target);
        } else {
          panel.scrollTop = target;
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
        try {
          void import("../../../core/diagnostics/runtimeBeacon.js")
            .then((mod) =>
              mod.sendRuntimeBeacon({
                phase: "live-nav",
                kind: "logos",
                total: images.length,
                ok: outcomes.filter((o) => o.ok).length,
                sample: outcomes.slice(0, 3)
              })
            )
            .catch(() => {});
        } catch (_) {
          // Diagnostics are optional.
        }
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
          try {
            void import("../../../core/diagnostics/runtimeBeacon.js")
              .then((mod) => mod.sendRuntimeBeacon({ phase: "live-nav", stalled: pending }))
              .catch(() => {});
          } catch (_) {
            // Diagnostics are optional.
          }
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
      // Vistos recientemente: persist a snapshot so the rail's recents row
      // (and its rows) survive leaving and re-entering the screen.
      try {
        const rows = this.visibleChannels?.() || [];
        const channel =
          rows.find((entry) => String(entry?.id) === channelId) ||
          (String(this.heroChannel?.id || "") === channelId ? this.heroChannel : null);
        const snapshot = channel || { id: channelId, name: playerTitle };
        this.recentChannels = internals.pushRecentChannel(this.recentChannels, snapshot);
        internals.writeRecentChannels(this.recentChannels);
        this.updateRowsOnly();
      } catch (error) {
        reportLiveErrorSafe(error, "pushRecentChannel");
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

function attributeEscape(value) {
  const raw = String(value ?? "");
  const escaped = globalThis.CSS?.escape ? CSS.escape(raw) : raw.replace(/(["\\])/g, "\\$1");
  return escaped;
}
