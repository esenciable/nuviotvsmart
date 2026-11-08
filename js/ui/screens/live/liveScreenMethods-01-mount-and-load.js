/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

// Mount and data loading. The screen renders its skeleton immediately, then
// paints the categories rail and the first category's channels as soon as they
// arrive, while the remaining categories preload in the background without
// ever blocking input. Every repository call is abortable through a token +
// controller pair so leaving the screen or switching categories cancels the
// pending work.
export function createLiveScreenMethods01() {
  const { Router, ScreenUtils, liveRepository } = internals;

  return {
    async mount(params = {}, navigationContext = {}) {
      this.container = document.getElementById("live");
      ScreenUtils.show(this.container);
      this.loadToken = (this.loadToken || 0) + 1;
      const token = this.loadToken;

      this.categories = [];
      this.categoriesLoading = true;
      this.categoriesError = "";
      this.selectedColumnId = null;
      this.channelsByColumn = this.channelsByColumn || new Map();
      this.channels = [];
      this.channelsLoading = false;
      this.channelsError = "";
      this.notice = "";
      this.tuningChannelId = "";
      this.lastFocusedKey = null;
      this.categoriesController = null;
      this.categoryLoadController = null;
      this.resolveController = null;
      this.noticeTimer = 0;

      this.render({ preserveFocus: false });

      // One controller per mount covers the categories call; switching
      // categories and tuning each own their dedicated controller below.
      const categoriesController = typeof AbortController === "function" ? new AbortController() : null;
      this.categoriesController = categoriesController;
      const categories = await liveRepository.listCategories({
        signal: categoriesController?.signal || null
      });
      if (token !== this.loadToken || Router.getCurrent() !== "live") {
        return;
      }
      this.categoriesLoading = false;
      if (categories.status !== "success") {
        this.categoriesError = String(categories.detail || "");
        this.render();
        return;
      }
      this.categories = Array.isArray(categories.data) ? categories.data : [];
      if (this.categories.length) {
        // Render the first category immediately and load its channels in the
        // foreground; everything else follows in the background.
        this.selectedColumnId = this.categories[0]?.columnId ?? null;
        this.channelsLoading = true;
      }
      this.render();
      if (this.selectedColumnId != null) {
        void this.loadChannelsForCategory(this.selectedColumnId, { background: false });
        void this.preloadRemainingCategories(token);
      }
    },

    async loadChannelsForCategory(columnId, { background = false } = {}) {
      const key = String(columnId ?? "");
      if (!key) {
        return;
      }
      const cached = this.channelsByColumn.get(key);
      if (cached) {
        if (!background && key === String(this.selectedColumnId)) {
          this.channelsLoading = false;
          this.channelsError = "";
          this.channels = cached;
          this.render();
        }
        return;
      }

      let controller = null;
      if (!background) {
        // A zap aborts the previous category's pending load so its late result
        // can never overwrite the new selection.
        this.categoryLoadController?.abort();
        controller = typeof AbortController === "function" ? new AbortController() : null;
        this.categoryLoadController = controller;
        this.channelsLoading = true;
        this.channelsError = "";
        this.render();
      }

      const result = await liveRepository.listChannels({
        columnId,
        signal: controller?.signal || null
      });
      if (controller && controller !== this.categoryLoadController) {
        return; // superseded by a newer category selection
      }
      if (result.status === "success") {
        this.channelsByColumn.set(key, result.data);
      }
      if (background) {
        return; // background preloads only warm the cache; never steal focus
      }
      if (Router.getCurrent() !== "live") {
        return;
      }
      this.channelsLoading = false;
      if (result.status === "aborted" || result.aborted) {
        return; // the screen moved on; render nothing new
      }
      if (result.status !== "success") {
        this.channelsError = String(result.detail || "");
        this.channels = [];
      } else {
        this.channelsError = "";
        this.channels = result.data;
      }
      this.render();
    },

    // Sequential background preload: the portal measures ~150 ms per call and
    // 2 calls per category, so one category at a time keeps the pace gentle
    // while making later category switches instant from cache.
    async preloadRemainingCategories(token) {
      for (const category of this.categories.slice(1)) {
        if (token !== this.loadToken || Router.getCurrent() !== "live") {
          return;
        }
        const columnId = category?.columnId;
        if (columnId == null || this.channelsByColumn.has(String(columnId))) {
          continue;
        }
        const result = await liveRepository.listChannels({ columnId });
        if (token !== this.loadToken || Router.getCurrent() !== "live") {
          return;
        }
        if (result.status === "success" && !this.channelsByColumn.has(String(columnId))) {
          this.channelsByColumn.set(String(columnId), result.data);
          if (String(columnId) === String(this.selectedColumnId)) {
            this.channelsLoading = false;
            this.channelsError = "";
            this.channels = result.data;
            this.render();
          }
        }
      }
    },

    cleanup() {
      this.loadToken = (this.loadToken || 0) + 1;
      this.categoriesController?.abort?.();
      this.categoryLoadController?.abort?.();
      this.resolveController?.abort?.();
      this.categoriesController = null;
      this.categoryLoadController = null;
      this.resolveController = null;
      this.clearNoticeTimer();
      this.notice = "";
      this.tuningChannelId = "";
      ScreenUtils.hide(this.container);
    }
  };
}
