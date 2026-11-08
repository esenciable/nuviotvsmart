/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

function clampRowIndexValue(index, length) {
  const max = Math.max(0, (Array.isArray(length) ? length.length : Number(length) || 0) - 1);
  const value = Number(index);
  if (!Number.isInteger(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

// Mount and data loading for the reference layout: the screen renders its
// skeleton immediately, then paints the left rail and the first category's
// channels as soon as they arrive, while the remaining categories preload in
// the background without ever blocking input. Per-category COUNTS in the rail
// are read from those same cached lists — never from extra portal calls; a
// pending category renders "…" until its background load lands.
//
// Every repository call is abortable through a token + controller pair so
// leaving the screen or switching categories cancels the pending work.
export function createLiveScreenMethods01() {
  const { Router, ScreenUtils, liveRepository, rememberLiveSelection, readRememberedLiveSelection, resolveLiveSelectionRestore } =
    internals;

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
      this.railSelection = null; // railId of the selected channel source
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
      this.heroChannel = null; // hidden until a channel row is focused

      // Deterministic focus state: which zone (hero actions / left rail /
      // channel rows) plus explicit indices. Never derived from geometry.
      this.focusZone = "rail";
      this.heroIndex = 0;
      this.railIndex = 0;
      // WHICH rail item (by railId) the index points at: the rail index is
      // re-derived from this identity whenever the item list changes, so a
      // stale number can never leave focus on a missing or wrong row.
      this.railFocusId = null;
      this.rowIndex = 0;
      this.rowFocusTarget = "row"; // "row" | "star"

      // Search state: the deterministic on-screen keyboard (no system IME,
      // no system IME, no input field). `searchActive` means a query is applied (rail dimmed,
      // flat results on the right); `keyboardOpen` means the fixed keyboard
      // panel is mounted and owns the D-pad. Back from the keyboard keeps the
      // query; Back on the Buscar row afterwards exits search entirely.
      this.searchActive = false;
      this.searchQuery = "";
      this.keyboardOpen = false;
      this.keyboardIndex = 0;

      // Favourites and recently watched: persisted under namespaced keys.
      // Favourites store stable ids; recents store lightweight snapshots so
      // their rows render even before any per-category cache is warm.
      this.favoriteIds = internals.readFavoriteIds();
      this.favoriteSet = new Set(this.favoriteIds);
      this.recentChannels = internals.readRecentChannels();

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
      this.render();
      if (this.categories.length) {
        // Restore WHERE the user was (the remembered rail id + focused row,
        // module-level memory like the mobile app's LiveTvListMemory). It
        // drives the SAME category load path as a manual selection — no extra
        // loading, and the row focus is applied once the list paints.
        const remembered = readRememberedLiveSelection();
        const restore = remembered
          ? resolveLiveSelectionRestore(this.railItems(), remembered, this.visibleCountForRailId(remembered.railId))
          : null;
        if (restore && restore.railId) {
          this.restoreRailSelection(restore);
        } else if (restore) {
          // The remembered selection (and its whole source) is gone: land on
          // the first rail item.
          this.focusZone = "rail";
          this.setRailFocusIndex(0);
          this.applyFocusState?.();
        } else {
          // First visit (no memory) — and a remembered removed aggregate id,
          // which restore resolves to no memory — lands on today's default:
          // the first category of the first source that has categories.
          const first = this.railItems().find((item) => item.type === "category");
          if (first) {
            this.selectRailItem(first.railId, { enterRows: false });
          }
        }
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
        if (!background && String(this.railSelection) === internals.categoryRailId(key)) {
          this.channelsLoading = false;
          this.channelsError = "";
          this.channels = cached;
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
        // Background preloads warm the cache for the rail counts, search,
        // favourites and recents; when the visible list can grow from the new
        // data, refresh it quietly.
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

    // True when the visible list reads from the UNION of the cached
    // per-category lists (search, favourites) rather than one category,
    // so a background cache arrival must refresh the visible rows and the
    // rail counts. There is no aggregate selection anymore.
    listDependsOnAllCaches() {
      if (this.searchActive && this.searchQuery) {
        return true;
      }
      const selection = String(this.railSelection ?? "");
      return selection === internals.RAIL_FAVORITES_ID;
    },

    // True when the visible list is one CATEGORY's deduplicated list: every
    // background cache arrival can refine ownership (rows may leave once),
    // so the visible rows must be recomputed — from the caches only, never
    // an extra portal call. Search/favourites keep the FULL set and are
    // covered by listDependsOnAllCaches above.
    categorySelectionDependsOnCaches() {
      if (this.searchActive) return false;
      const selection = String(this.railSelection ?? "");
      return selection.startsWith("cat:");
    },

    // Recomputes this.channels from the current rail selection / search state
    // without touching the network. Used for rail switches, search updates,
    // favourite changes and cache warm-ups.
    refreshVisibleChannels() {
      const query = this.searchActive ? String(this.searchQuery || "").trim() : "";
      const caches = this.channelsByColumn instanceof Map ? this.channelsByColumn : new Map();
      if (query) {
        // Search filters the LOADED channels: the deduplicated union of every
        // cached per-category list.
        const union = new Map();
        for (const list of caches.values()) {
          for (const channel of Array.isArray(list) ? list : []) {
            if (!union.has(String(channel?.id))) union.set(String(channel?.id), channel);
          }
        }
        this.channels = Array.from(union.values()).filter((channel) => internals.channelMatchesQuery(channel, this.searchQuery));
      } else {
        const selection = String(this.railSelection ?? "");
        if (selection === internals.RAIL_FAVORITES_ID) {
          const union = new Map();
          for (const list of caches.values()) {
            for (const channel of Array.isArray(list) ? list : []) {
              if (!union.has(String(channel?.id))) union.set(String(channel?.id), channel);
            }
          }
          // Favourite order wins: ids first, then rows the caches can resolve.
          this.channels = this.favoriteIds.map((id) => union.get(String(id))).filter(Boolean);
        } else if (selection === internals.RAIL_RECENTS_ID) {
          this.channels = Array.isArray(this.recentChannels) ? [...this.recentChannels] : [];
        } else if (selection && selection.startsWith("cat:")) {
          const columnId = selection.slice(4);
          const cached = caches.get(columnId);
          // Category dedupe (owner-approved rule): the list excludes channels
          // another category owns; the generic catalogue keeps only the
          // channels no specific category owns. Ownership comes from the same
          // per-category caches — never an extra portal call.
          this.channels = internals.filterChannelsByOwnership(Array.isArray(cached) ? cached : [], columnId, this.categoryOwnership());
          this.channelsError = "";
        }
      }
      this.channelsLoading = false;
      this.clampRowIndex();
      // While searching, the hero follows the highlighted matching row (the
      // input holds real focus, so row focus can never drive it).
      if (this.searchActive && query && Array.isArray(this.channels) && this.channels.length) {
        this.heroChannel = this.channels[clampRowIndexValue(this.rowIndex, this.channels.length)];
      }
      this.updateRowsOnly?.();
    },

    // Selects a rail row: sets the visible channel source on the right and,
    // unless `enterRows: false`, moves focus into the rows (RIGHT from the
    // rail, or Enter on a selectable row). Search opens the input; a source
    // header toggles instead. Returns nothing; focus is applied here.
    selectRailItem(railId, { enterRows = true } = {}) {
      const items = this.railItems();
      const item = items.find((entry) => entry.railId === String(railId ?? ""));
      if (!item) return;
      if (item.type === "search") {
        this.openSearch?.();
        return;
      }
      if (item.type === "source") {
        this.toggleSource?.(item);
        return;
      }
      this.railSelection = item.railId;
      if (item.type === "category") {
        void this.loadChannelsForCategory(item.columnId, { background: false });
      } else {
        // favorites / recents: pure cache recompute, no network.
        this.refreshVisibleChannels();
      }
      this.clampRowIndex();
      if (enterRows) {
        this.focusZone = "rows";
        this.rowIndex = 0;
        this.rowFocusTarget = "row";
      } else {
        this.focusZone = "rail";
        const index = this.railItems().findIndex((entry) => entry.railId === item.railId);
        this.setRailFocusIndex(index);
      }
      this.applyFocusState?.();
    },

    // Sequential background preload: the portal measures ~150 ms per call and
    // 2 calls per category, so one category at a time (single await per
    // iteration, no queue, no unbounded work) keeps the pace gentle while
    // making later category switches instant from cache and filling the
    // rail's per-category counts. The mount token stops it the moment the
    // screen is left, and each arrival only refreshes the visible rows when
    // the current selection actually reads from the caches.
    async preloadRemainingCategories(token) {
      for (const category of this.categories || []) {
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
          if (this.listDependsOnAllCaches() || this.categorySelectionDependsOnCaches()) {
            // A category selection refines quietly (a channel may leave its
            // old category once); search/favourites grow with the caches.
            this.refreshVisibleChannels();
          } else {
            // Only the rail counts changed ("…" -> numbers).
            this.updateRowsOnly?.();
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
      if (String(this.railSelection) === internals.RAIL_FAVORITES_ID && !this.searchActive) {
        // The favourited row may have just left (or entered) the visible list.
        this.refreshVisibleChannels();
      } else {
        this.updateRowsOnly();
      }
      return this.favoriteSet.has(id);
    },

    // Row count the given rail id will show, read from the per-category
    // caches and the recents/favourites snapshots only (no network). Used to
    // clamp a restored row index before the selection paints the list.
    visibleCountForRailId(railId) {
      const id = String(railId ?? "");
      if (id.startsWith("cat:")) {
        const cached = this.channelsByColumn?.get?.(id.slice(4));
        return Array.isArray(cached) ? cached.length : 0;
      }
      if (id === internals.RAIL_FAVORITES_ID) return Array.isArray(this.favoriteIds) ? this.favoriteIds.length : 0;
      if (id === internals.RAIL_RECENTS_ID) return Array.isArray(this.recentChannels) ? this.recentChannels.length : 0;
      return 0;
    },

    // Applies a resolved restore: selects the remembered rail through the
    // SAME path as a manual selection, then restores the focused row (clamped
    // again after the list paints, so a shorter list can never overshoot).
    // A source-header fallback only focuses the header — selecting a header
    // would COLLAPSE the source, never restore anything.
    restoreRailSelection(restore) {
      const items = this.railItems();
      const item = items[restore.index];
      if (!item) return false;
      if (item.type === "source") {
        this.focusZone = "rail";
        this.rowIndex = 0;
        this.rowFocusTarget = "row";
        this.setRailFocusIndex(restore.index);
        this.applyFocusState?.();
        return true;
      }
      this.rowIndex = Math.max(0, Math.trunc(Number(restore.rowIndex) || 0));
      this.railSelection = item.railId;
      if (item.type === "category") {
        void this.loadChannelsForCategory(item.columnId, { background: false });
      } else {
        // favorites / recents: pure cache recompute, no network.
        this.refreshVisibleChannels();
      }
      this.clampRowIndex();
      this.focusZone = "rows";
      this.rowFocusTarget = "row";
      this.applyFocusState?.();
      return true;
    },

    clampRowIndex() {
      const max = Math.max(0, (Array.isArray(this.channels) ? this.channels.length : 0) - 1);
      if (this.rowIndex > max) this.rowIndex = max;
      if (this.rowIndex < 0) this.rowIndex = 0;
    },

    cleanup() {
      this.loadToken = (this.loadToken || 0) + 1;
      // Remember WHERE the user was before the screen goes away (player visit,
      // or leaving Live TV entirely) so the next mount restores the spot.
      rememberLiveSelection({ railId: this.railSelection, rowIndex: this.rowIndex });
      this.categoriesController?.abort?.();
      this.categoryLoadController?.abort?.();
      this.resolveController?.abort?.();
      this.categoriesController = null;
      this.categoryLoadController = null;
      this.resolveController = null;
      this.clearNoticeTimer();
      this.notice = "";
      this.tuningChannelId = "";
      this.heroChannel = null;
      ScreenUtils.hide(this.container);
    }
  };
}
