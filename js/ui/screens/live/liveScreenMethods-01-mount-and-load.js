/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";
import { searchChannelsFromIndex } from "./liveScreenMethods-02-render.js";
import { PREMIUMTV_CHANNEL_ID_PREFIX } from "../../../core/live/premiumTvSource.js";

function clampRowIndexValue(index, length) {
  const max = Math.max(0, (Array.isArray(length) ? length.length : Number(length) || 0) - 1);
  const value = Number(index);
  if (!Number.isInteger(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

// The current route, safe when the Router stub has no getCurrent (tests).
// Never throws; a missing Router reads as "not on the live screen".
function currentRouteSafe(router) {
  try {
    return typeof router?.getCurrent === "function" ? router.getCurrent() : null;
  } catch (_) {
    return null;
  }
}

// Mount and data loading for the reference layout: the screen renders its
// skeleton immediately, then paints the left rail and the first category's
// channels as soon as they arrive. Magis rail counts and the generic
// catalogue's leftovers come from the GENERATED catalog index shipped with
// the app (js/core/magis/catalog-index.json, built offline by `npm run
// catalog:index`) — the screen never walks all categories in the background
// and never computes channel ownership at runtime. Search reads the index's
// complete channel list (every category, loaded or not) and falls back to the
// loaded per-category caches while the index is missing or stale. Categories
// load on demand when selected: one fetch each, no speculative loading. An
// absent/stale index degrades gracefully: counts render "…", the generic
// catalogue falls back to its portal fetch, search falls back to the loaded
// caches, and tune-in surfaces the real portal error.
//
// Every repository call is abortable through a token + controller pair so
// leaving the screen or switching categories cancels the pending work.
export function createLiveScreenMethods01() {
  const {
    Router,
    ScreenUtils,
    liveRepository,
    rememberLiveSelection,
    readRememberedLiveSelection,
    resolveLiveSelectionRestore,
    loadCatalogIndex,
    isUsableCatalogIndex,
    catalogCountsFromIndex,
    leftoverChannelsFromIndex,
    findGenericCategory
  } = internals;

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
      // The generated Magis catalog index: rail counts + the generic
      // catalogue's leftovers. Filled by applyCatalogIndex on mount; an
      // unusable index keeps these at their empty defaults.
      this.catalogIndex = null;
      this.catalogCounts = new Map();
      this.catalogGenericColumnId = "";
      this.categoriesController = null;
      this.categoryLoadController = null;
      this.resolveController = null;
      this.noticeTimer = 0;
      this.heroChannel = null; // hidden until a channel row is focused

      // Background release state (Samsung memory guide). ONE AbortController
      // per mount owns the document listeners this screen binds (the
      // visibilitychange handler here); cleanup() aborts it, so a teardown
      // can never leak a listener. The channel list's scroll listener is
      // removed explicitly in cleanup() (same memoized function ref).
      this._liveMounted = true;
      this._releasedForBackground = false;
      this._backgroundRetained = null;
      this._backgroundDroppedColumnIds = [];
      this._mountListeners = typeof AbortController === "function" ? new AbortController() : null;
      if (this._mountListeners && typeof document !== "undefined" && document?.addEventListener) {
        document.addEventListener(
          "visibilitychange",
          () => {
            this.handleVisibilityChange?.();
          },
          { signal: this._mountListeners.signal }
        );
      }

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
      // The generated catalog index (local JSON, no network) travels in
      // parallel with the categories call.
      const categoriesController = typeof AbortController === "function" ? new AbortController() : null;
      this.categoriesController = categoriesController;
      const catalogIndexPromise = loadCatalogIndex();
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
        if (!this.paintReported) {
          this.paintReported = true;
          void import("../../../core/diagnostics/runtimeBeacon.js")
            .then((mod) =>
              mod.sendRuntimeBeacon({
                phase: "live-paint",
                ms: Math.round(globalThis.performance?.now?.() || 0),
                rows: Array.isArray(this.channels) ? this.channels.length : 0
              })
            )
            .catch(() => {});
        }
        return;
      }
      this.categories = Array.isArray(categories.data) ? categories.data : [];
      // Apply the generated index BEFORE any selection so the rail paints
      // real counts and the generic catalogue can serve its leftovers.
      const catalogIndex = await catalogIndexPromise;
      if (token !== this.loadToken || Router.getCurrent() !== "live") {
        return;
      }
      this.applyCatalogIndex(catalogIndex);
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
      }
      // Both sources answer the search from here on: Magis from the index,
      // PremiumTV from these warmed (free) group lists.
      void this.warmPremiumCaches();
    },

    // Applies the generated Magis catalog index: per-category rail counts
    // (already deduped offline) and the generic catalogue's column id. An
    // absent/stale index (unusable) is a graceful degradation: counts stay
    // "…", the generic catalogue is NOT identified (its selection falls back
    // to the normal portal fetch) and nothing here can throw.
    applyCatalogIndex(index) {
      this.catalogIndex = isUsableCatalogIndex(index) ? index : null;
      this.catalogCounts = catalogCountsFromIndex(this.catalogIndex);
      this.catalogGenericColumnId = "";
      if (this.catalogIndex) {
        const generic = findGenericCategory(this.categories, this.catalogIndex.genericCategoryName);
        this.catalogGenericColumnId = generic ? String(generic.columnId) : "";
      }
    },

    async loadChannelsForCategory(columnId) {
      const key = String(columnId ?? "");
      if (!key) {
        return;
      }
      const cached = this.channelsByColumn.get(key);
      if (cached) {
        if (String(this.railSelection) === internals.categoryRailId(key)) {
          this.channelsLoading = false;
          this.channelsError = "";
          this.channels = cached;
          this.refreshVisibleChannels();
        }
        return;
      }
      // The generic catalogue page renders its LEFTOVERS from the generated
      // index — the 500-channel portal page is never fetched at runtime. The
      // branch only exists when a usable index identified the category; an
      // unusable index falls through to the normal on-demand fetch below.
      if (key === this.catalogGenericColumnId) {
        const leftovers = leftoverChannelsFromIndex(this.catalogIndex);
        this.channelsByColumn.set(key, leftovers);
        if (String(this.railSelection) === internals.categoryRailId(key)) {
          this.channelsLoading = false;
          this.channelsError = "";
          this.refreshVisibleChannels();
        }
        return;
      }

      // A zap aborts the previous category's pending load so its late result
      // can never overwrite the new selection.
      this.categoryLoadController?.abort();
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      this.categoryLoadController = controller;
      this.channelsLoading = true;
      this.channelsError = "";
      this.render();

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

    // PremiumTV ships ONE playlist for the whole source (persisted, up to 3000
    // entries), so a group's channels are an in-memory filter over that list,
    // never a download. Warming every group here costs no network and is what
    // lets the GLOBAL search answer from both sources at once, instead of only
    // the folders the user happened to open this session.
    async warmPremiumCaches(loadChannels = null) {
      if (!(this.channelsByColumn instanceof Map)) return 0;
      const token = this.loadToken;
      const list = Array.isArray(this.categories) ? this.categories : [];
      const pending = list
        .map((entry) => String(entry?.columnId ?? ""))
        .filter((id) => id.startsWith(PREMIUMTV_CHANNEL_ID_PREFIX) && !this.channelsByColumn.has(id));
      if (!pending.length) return 0;
      const load = typeof loadChannels === "function" ? loadChannels : (args) => liveRepository.listChannels(args);
      let warmed = 0;
      for (const columnId of pending) {
        if (token !== this.loadToken) return warmed;
        try {
          const result = await load({ columnId });
          if (result?.status !== "success") continue;
          this.channelsByColumn.set(columnId, Array.isArray(result.data) ? result.data : []);
          warmed += 1;
        } catch (_) {
          // A failing PremiumTV group never breaks Magis nor the search: the
          // source keeps whatever the cache already holds.
        }
      }
      if (warmed && this.searchActive && String(this.searchQuery || "").trim()) {
        this.refreshVisibleChannels();
      }
      return warmed;
    },

    // Recomputes this.channels from the current rail selection / search state
    // without touching the network. Used for rail switches, search updates,
    // favourite changes and cache warm-ups.
    refreshVisibleChannels() {
      const query = this.searchActive ? String(this.searchQuery || "").trim() : "";
      const caches = this.channelsByColumn instanceof Map ? this.channelsByColumn : new Map();
      if (query) {
        // GLOBAL search: when the generated index ships its channel list,
        // the query matches EVERY Magis channel — all 38 categories, loaded
        // or not — instead of only the per-category caches warmed this
        // session. Rows render with the owning category's name, and Enter
        // resolves by channel code (per channel, no category load needed).
        const indexChannels = searchChannelsFromIndex(this.catalogIndex);
        if (!indexChannels.length) {
          // FALLBACK (index missing or stale — no channels list): today's
          // behaviour, the deduplicated union of every cached per-category
          // list.
          const union = new Map();
          for (const list of caches.values()) {
            for (const channel of Array.isArray(list) ? list : []) {
              if (!union.has(String(channel?.id))) union.set(String(channel?.id), channel);
            }
          }
          this.channels = Array.from(union.values()).filter((channel) => internals.channelMatchesQuery(channel, this.searchQuery));
        } else {
          const matches = indexChannels.filter((channel) => internals.channelMatchesQuery(channel, this.searchQuery));
          // PremiumTV channels are not part of the Magis index: their cached
          // lists stay searchable, otherwise a loaded PremiumTV channel would
          // vanish from search the moment the Magis index ships.
          const premium = new Map();
          for (const [columnId, list] of caches) {
            if (!String(columnId).startsWith("premiumtv:")) continue;
            for (const channel of Array.isArray(list) ? list : []) {
              const id = String(channel?.id ?? "");
              if (id && !premium.has(id)) premium.set(id, channel);
            }
          }
          this.channels = matches.concat(
            Array.from(premium.values()).filter((channel) => internals.channelMatchesQuery(channel, this.searchQuery))
          );
        }
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
          // The per-category lists are already deduplicated OFFLINE (the
          // generic catalogue's cache holds exactly its index leftovers), so
          // the cached list renders as-is — no runtime ownership computation.
          this.channels = Array.isArray(cached) ? cached : [];
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
        void this.loadChannelsForCategory(item.columnId);
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
    // caches, the generated catalog index and the recents/favourites
    // snapshots only (no network). Used to clamp a restored row index before
    // the selection paints the list.
    visibleCountForRailId(railId) {
      const id = String(railId ?? "");
      if (id.startsWith("cat:")) {
        const columnId = id.slice(4);
        const cached = this.channelsByColumn?.get?.(columnId);
        if (Array.isArray(cached)) return cached.length;
        // Not loaded yet: the index's deduped count is the real count.
        const counted = this.catalogCounts?.get?.(columnId);
        return Number.isFinite(counted) ? counted : 0;
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
        void this.loadChannelsForCategory(item.columnId);
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

    // Background release / foreground restore (Samsung memory guide) --------
    // The visibility listener is bound in mount() with the mount AbortController
    // and dies with it in cleanup(); these handlers do the release and restore.

    handleVisibilityChange() {
      try {
        if (typeof document === "undefined" || !document) return;
        if (document.hidden) {
          this.releaseForBackground();
        } else {
          this.restoreFromBackground();
        }
      } catch (_) {
        // A release/restore failure must never break the screen; the next
        // foreground interaction repaints from the retained state.
      }
    },

    // Drops every cached per-category channel list except the currently
    // selected one and invalidates the memoized ownership map. Returns the
    // release plan (the dropped column ids drive the restore refetch).
    dropBackgroundCaches() {
      const plan = internals.planBackgroundCacheRelease({
        channelsByColumn: this.channelsByColumn,
        railSelection: this.railSelection
      });
      for (const columnId of plan.drop) {
        this.channelsByColumn.delete(columnId);
      }
      return plan;
    },

    // visibilitychange -> hidden: release everything rebuildable, keep only
    // the light state. Not mounted => nothing at all; the Router already left
    // => a no-op beyond clearing the rebuildable caches (the Router's cleanup
    // owns the teardown — no DOM, no timer, no focus work here).
    releaseForBackground() {
      if (!this._liveMounted) return;
      if (currentRouteSafe(Router) !== "live") {
        this.dropBackgroundCaches();
        return;
      }
      // Timers and pending polls this screen owns.
      this.clearNoticeTimer();
      this.categoryLoadController?.abort?.();
      this.categoryLoadController = null;
      this._releasedForBackground = true; // stops the preload loop and late results
      // Per-category caches except the currently selected one.
      const plan = this.dropBackgroundCaches();
      this._backgroundDroppedColumnIds = plan.drop;
      // The virtual pool's row content: empty every recycled row node so its
      // subtree and per-node data can be collected; the window sync refills
      // the pool on return. The spacers stay, so the scroll height (and with
      // it the scroll position) survives untouched.
      this._virtualWindow = null;
      const list = this.container?.querySelector('.live-channel-list[data-virtual-list="true"]');
      const scrollTop = list?.scrollTop || 0;
      list?.querySelectorAll(".live-channel-row").forEach((node) => {
        node.innerHTML = "";
      });
      // The light state that makes the return feel instant. this.channels is
      // the rendered COPY of the released caches — rebuildable, so it goes
      // too; favourites, recents, search query, focus and selection stay.
      this.channels = [];
      this._backgroundRetained = internals.retainedLightState(this, { scrollTop });
    },

    // visibilitychange -> visible: restore. Repaints the current selection
    // from the network exactly when its cache was dropped and re-applies the
    // retained rail selection / row focus / scroll position. There is no
    // preload to re-arm: every category loads on demand when selected.
    restoreFromBackground() {
      if (!this._liveMounted || currentRouteSafe(Router) !== "live") return;
      if (!this._releasedForBackground) return; // nothing was released
      this._releasedForBackground = false;
      const retained = this._backgroundRetained;
      const droppedColumnIds = Array.isArray(this._backgroundDroppedColumnIds) ? this._backgroundDroppedColumnIds : [];
      this._backgroundRetained = null;
      this._backgroundDroppedColumnIds = [];
      if (retained) {
        // Re-apply the retained light state (the fields never mutated while
        // hidden, but the snapshot is authoritative).
        this.railSelection = retained.railSelection || this.railSelection || null;
        this.railFocusId = retained.railFocusId || this.railFocusId;
        this.railIndex = retained.railIndex;
        this.rowIndex = retained.rowIndex;
        this.rowFocusTarget = retained.rowFocusTarget;
        this.focusZone = retained.focusZone;
        this.searchActive = retained.searchActive;
        this.searchQuery = retained.searchQuery;
        this.keyboardIndex = retained.keyboardIndex;
        // The scroll position is restored by prepareChannelWindow when the
        // list repaints (the pending value survives the loading render too).
        this._virtualPendingScrollTop = retained.scrollTop;
      }
      const plan = internals.planForegroundRestore({
        railSelection: this.railSelection,
        cachedColumnIds: Array.from(this.channelsByColumn?.keys?.() || []),
        droppedColumnIds
      });
      if (plan.selectionWasDropped && plan.selectedColumnId) {
        // Refetch the selection; the repaint (and with it the focus and
        // scroll restore) happens when the list lands.
        void this.loadChannelsForCategory(plan.selectedColumnId);
      } else {
        this.refreshVisibleChannels();
        this.applyFocusState?.();
      }
    },

    cleanup() {
      this.loadToken = (this.loadToken || 0) + 1;
      this._liveMounted = false;
      this._releasedForBackground = false;
      this._backgroundRetained = null;
      this._backgroundDroppedColumnIds = [];
      // Abort the mount's listeners: the visibilitychange handler dies here
      // with its AbortController, and the channel list's scroll listener is
      // removed explicitly from the live node (same memoized function ref),
      // so a teardown can never leak a listener.
      this._mountListeners?.abort?.();
      this._mountListeners = null;
      const boundList = this.container?.querySelector('.live-channel-list[data-virtual-list="true"]');
      if (boundList && this._onChannelListScroll) {
        boundList.removeEventListener("scroll", this._onChannelListScroll);
      }
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
