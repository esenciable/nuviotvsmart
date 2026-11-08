/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

const NOTICE_VISIBLE_MS = 6000;

// Focus handling, activation and tune-in. D-pad movement is delegated to the
// shared ScreenUtils.handleDpadNavigation geometry helper; this module only
// reacts to Back and Enter and drives playback hand-off to the player.
export function createLiveScreenMethods03() {
  const { Router, ScreenUtils, liveRepository, isBackEvent, escapeHtml, t } = internals;

  return {
    onKeyDown(event) {
      if (isBackEvent(event)) {
        event?.preventDefault?.();
        Router.back();
        return;
      }
      const code = Number(event?.keyCode || 0);
      // Reuse the shared dpad helper: geometry-based movement across the rail
      // and the grid, no bespoke focus model.
      if (code >= 37 && code <= 40 && ScreenUtils.handleDpadNavigation(event, this.container, ".focusable")) {
        this.rememberFocus();
        return;
      }
      if (code !== 13) {
        return;
      }
      const current = this.container?.querySelector(".focusable.focused");
      if (!current) {
        return;
      }
      const action = String(current.dataset.action || "");
      if (action === "selectCategory") {
        this.selectCategory(current.dataset.columnId);
      } else if (action === "tuneIn") {
        void this.tuneIn(current);
      }
    },

    rememberFocus() {
      const focused = this.container?.querySelector(".focusable.focused");
      if (focused?.dataset?.focusKey) {
        this.lastFocusedKey = String(focused.dataset.focusKey);
      }
    },

    selectCategory(columnId) {
      const key = String(columnId ?? "");
      if (!key || key === String(this.selectedColumnId)) {
        return;
      }
      this.selectedColumnId = columnId;
      this.channels = this.channelsByColumn.get(key) || [];
      this.channelsLoading = !this.channels.length;
      this.channelsError = "";
      this.clearNotice();
      this.render();
      void this.loadChannelsForCategory(columnId, { background: false });
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
      this.render();

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
        this.render();
        return;
      }
      const { url, headers } = result.data || {};
      if (!url) {
        this.showNotice(`${t("live_tune_failed", {}, "Could not tune this channel")}: no stream URL`);
        this.render();
        return;
      }
      Router.navigate("player", {
        streamUrl: url,
        itemType: "channel",
        playerTitle,
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
