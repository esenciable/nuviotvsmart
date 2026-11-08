/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

// Mount and data loading. The screen renders its skeleton immediately, then
// paints the chips row and the first source group's channels as soon as they
// arrive, while the remaining categories preload in the background without
// ever blocking input. Every repository call is abortable through a token +
// controller pair so leaving the screen or switching categories cancels the
// pending work.
export function createLiveScreenMethods01() {
  const { Router, ScreenUtils, liveRepository } = internals;

  return {
    async mount(params = {}, navigationContext = {}) {
      this.container = document.getElementById("live");
      // Temporary mount telemetry: confirms the screen is the mounted route and
      // that its container exists before any key can be judged.
      void import("../../../core/diagnostics/runtimeBeacon.js")
        .then((mod) =>
          mod.sendRuntimeBeacon({
            phase: "live-mount",
            hasContainer: Boolean(this.container),
            route: String(globalThis?.location?.hash || "")
          })
        )
        .catch(() => {});
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
      this.categoriesController = null;
      this.categoryLoadController = null;
      this.resolveController = null;
      this.noticeTimer = 0;

      // Deterministic focus state: which zone (header pills / chips row /
      // channel list) plus explicit indices. Never derived from geometry.
      this.focusZone = "chips";
      this.headerIndex = 0;
      this.chipIndex = 0;
      this.rowIndex = 0;
      this.rowFocusTarget = "row"; // "row" | "star"
      this.activeChipId = internals.ALL_CHIP_ID;

      // Search state: a real <input> is mounted over the pill while active.
      this.searchActive = false;
      this.searchQuery = "";

      // Favourites: persisted under one namespaced key, keyed by the stable
      // channel id. Loaded once per mount; every toggle writes through.
      this.favoriteIds = internals.readFavoriteIds();
      this.favoriteSet = new Set(this.favoriteIds);

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
        // "Todos" maps to the first source group: render it immediately and
        // load its channels in the foreground; everything else preloads in
        // the background so search and favourites see data as it arrives.
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
        if (!background) {
          this.channelsLoading = false;
          this.channelsError = "";
          this.refreshVisibleChannels();
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
        // Background preloads warm the cache for search and favourites; when
        // the visible list can grow from the new data, refresh it quietly.
        if (result.status === "success" && this.listDependsOnAllCaches()) {
          this.refreshVisibleChannels();
        }
        return;
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
      this.refreshVisibleChannels();
    },

    // The visible list reads from the union of cached per-category lists when
    // a favourites chip is active or a search query is being filtered; a
    // single category otherwise. Background loads then refresh the visible
    // list as new caches arrive.
    listDependsOnAllCaches() {
      if (this.searchActive && this.searchQuery) {
        return true;
      }
      return String(this.activeChipId) === internals.FAVORITES_CHIP_ID;
    },

    // Recomputes this.channels from the current chip/search state without
    // touching the network. Used for chip switches, search updates, favourite
    // changes and cache warm-ups.
    refreshVisibleChannels() {
      if (this.listDependsOnAllCaches()) {
        const union = new Map();
        for (const list of this.channelsByColumn.values()) {
          for (const channel of Array.isArray(list) ? list : []) {
            if (!union.has(String(channel?.id))) union.set(String(channel?.id), channel);
          }
        }
        let all = Array.from(union.values());
        if (this.searchActive && this.searchQuery) {
          all = all.filter((channel) => internals.channelMatchesQuery(channel, this.searchQuery));
        }
        if (String(this.activeChipId) === internals.FAVORITES_CHIP_ID && !(this.searchActive && this.searchQuery)) {
          all = all.filter((channel) => this.favoriteSet.has(String(channel?.id)));
        }
        this.channels = all;
        this.channelsLoading = false;
        this.channelsError = "";
        this.clampRowIndex();
        this.render();
        return;
      }
      // Single-category chips (including "Todos" -> first source group).
      this.clampRowIndex();
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
          } else if (this.listDependsOnAllCaches()) {
            this.refreshVisibleChannels();
          }
        }
      }
    },

    // Favourites -------------------------------------------------------------
    isFavoriteId(channelId) {
      return this.favoriteSet.has(String(channelId ?? ""));
    },

    // Toggles and persists. Returns the new favourite state for the channel.
    toggleFavorite(channelId) {
      const id = String(channelId ?? "");
      if (!id) return false;
      this.favoriteIds = internals.toggleFavoriteId(this.favoriteIds, id);
      this.favoriteSet = new Set(this.favoriteIds);
      internals.writeFavoriteIds(this.favoriteIds);
      if (String(this.activeChipId) === internals.FAVORITES_CHIP_ID) {
        // The favourited row may have just left (or entered) the visible list.
        this.refreshVisibleChannels();
      } else {
        this.updateRowsOnly();
      }
      return this.favoriteSet.has(id);
    },

    // Header source line: the merged sources actually backing the catalogue.
    sourceLabels() {
      const labels = [];
      for (const category of this.categories || []) {
        const label = internals.sourceNameFromColumnId(category?.columnId);
        if (label && !labels.includes(label)) labels.push(label);
      }
      if (!labels.length) {
        // Categories failed to load but channels may still be cached.
        for (const channel of this.channels || []) {
          const label = internals.sourceNameFromChannelId(channel?.id);
          if (label && !labels.includes(label)) labels.push(label);
        }
      }
      return labels;
    },

    clampRowIndex() {
      const max = Math.max(0, (Array.isArray(this.channels) ? this.channels.length : 0) - 1);
      if (this.rowIndex > max) this.rowIndex = max;
      if (this.rowIndex < 0) this.rowIndex = 0;
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
