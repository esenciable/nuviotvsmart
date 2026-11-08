/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

// Rendering for the Live TV screen, following the mobile app's Live TV
// structure (apps/nuvio-mobile .../livetv/ui/LiveTvScreen.kt): ONE vertical
// list of collapsible groups. Each group is a header card (`Magis · Deportes`,
// channel count, chevron) and its channels render indented underneath when
// expanded. A `Favoritos` group sits first (only when it has channels); there
// is no `Todos` group, no categories rail and no preview panel: the list takes
// the full body width. With search active the list shows flat matching rows,
// exactly like the mobile search results.
//
// Focus is tracked as plain state on the screen (focusZone / flatIndex /
// rowFocusTarget) over the FLAT item order (group headers and rows
// interleaved), never by geometry. Movement must be fluid: a focus change only
// toggles classes (no re-render), scrolling is the smallest movement animated
// over ~110ms, and key repeats faster than the animation are coalesced.
//
// The styles are inlined here because the screen ships without a dedicated
// stylesheet. Palette and sizes are measured from the 1280x720 reference and
// scaled x1.5 for the 1920x1080 surface: page #0E0E12, cards #111111,
// muted #9CA3AF, rows ~126px tall, logos 66px.

// Pure helpers -------------------------------------------------------------

// Source display name from a stable channel id prefix (`magis:live:<code>` /
// `premiumtv:<hash>`). Unknown prefixes have no source label.
export function sourceNameFromChannelId(channelId) {
  const raw = String(channelId ?? "");
  if (raw.startsWith("magis:live:")) return "Magis";
  if (raw.startsWith("premiumtv:")) return "PremiumTV";
  return "";
}

// Source display name from a category/column id. PremiumTV columns carry the
// `premiumtv:` prefix; every other column id is a Magis portal column.
export function sourceNameFromColumnId(columnId) {
  const raw = String(columnId ?? "");
  if (!raw) return "";
  if (raw.startsWith("premiumtv:")) return "PremiumTV";
  return "Magis";
}

// Group label: `Source · Category` so two portals with same-named categories
// stay distinguishable, exactly like the reference (`TV · Deportes` style).
export function formatChipLabel(category) {
  const name = String(category?.name ?? "").trim() || "Unnamed";
  const source = sourceNameFromColumnId(category?.columnId);
  return source ? `${source} · ${name}` : name;
}

// Row first line: the number is rendered dimmed and separate from the bold
// name; a missing number renders as an empty string (no fake "0").
export function formatChannelRowLabel(channel) {
  const number = channel?.number;
  const hasNumber = number != null && String(number).trim() !== "";
  return {
    number: hasNumber ? `${String(number).trim()}.` : "",
    name: String(channel?.name ?? "").trim() || "Canal en vivo"
  };
}

// Logo resolution for thumbnails and the preview box: whitespace-only urls
// count as missing so the letter fallback shows instead of a broken image.
export function channelLogoInfo(channel) {
  const logo = String(channel?.logo ?? "").trim();
  const name = String(channel?.name ?? "").trim();
  return { logo, letter: (name.charAt(0) || "?").toUpperCase() };
}

// Case- and accent-insensitive normalization for the channel search filter.
export function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// Substring match on the channel name; an empty/blank query matches all.
export function channelMatchesQuery(channel, query) {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  return normalizeSearchText(channel?.name).includes(needle);
}

// Favourites persist locally under one namespaced key, keyed by the stable
// channel id so they survive list reloads and reordering. Storage is
// injectable for tests; all access is guarded because TVs and `node --test`
// may not expose localStorage at all.
export const FAVORITES_STORAGE_KEY = "nuvio.live.favorites.v1";

export function readFavoriteIds(storage) {
  const store = storage ?? globalThis?.localStorage ?? null;
  try {
    const raw = store?.getItem?.(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => String(id)).filter(Boolean);
  } catch (_) {
    return [];
  }
}

export function writeFavoriteIds(ids, storage) {
  const store = storage ?? globalThis?.localStorage ?? null;
  try {
    store?.setItem?.(FAVORITES_STORAGE_KEY, JSON.stringify(Array.isArray(ids) ? ids : []));
  } catch (_) {
    // Persistence is best effort; the in-memory set keeps working this session.
  }
}

// Pure toggle: returns a NEW array (React-free screens still re-render from
// state), keeping insertion order and uniqueness.
export function toggleFavoriteId(ids, channelId) {
  const id = String(channelId ?? "");
  if (!id) return Array.isArray(ids) ? [...ids] : [];
  const current = Array.isArray(ids) ? ids.map(String) : [];
  return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
}

// Group model --------------------------------------------------------------

// Special group ids. `__all__` no longer renders as a group ("Todos" was
// removed with the grouped layout) but the constant stays exported because the
// mount/load module and cached state still reference it. `__favorites__` is
// the id of the favorites group card.
export const ALL_CHIP_ID = "__all__";
export const FAVORITES_CHIP_ID = "__favorites__";

// Pure group sections for the list: the favorites group first (only when it
// has channels), then one section per portal category with the source
// prefixed in the label. A category whose channels are not cached yet renders
// as a loading section (count: null, channels: []). No `Todos` section exists.
export function buildGroupSections({
  categories = [],
  channelsByColumn = new Map(),
  favoriteChannels = [],
  favoritesLabel = "Favoritos"
} = {}) {
  const sections = [];
  const favorites = Array.isArray(favoriteChannels) ? favoriteChannels : [];
  if (favorites.length) {
    sections.push({
      groupId: FAVORITES_CHIP_ID,
      label: String(favoritesLabel || "Favoritos"),
      count: favorites.length,
      channels: favorites,
      loading: false
    });
  }
  for (const category of Array.isArray(categories) ? categories : []) {
    const columnId = String(category?.columnId ?? "");
    if (!columnId) continue;
    const cached = channelsByColumn instanceof Map ? channelsByColumn.get(columnId) : null;
    const channels = Array.isArray(cached) ? cached : [];
    sections.push({
      groupId: columnId,
      label: formatChipLabel(category),
      count: cached ? channels.length : null,
      channels,
      loading: !cached
    });
  }
  return sections;
}

// Pure flat focus order: one item per group header card, followed by the
// group's rows when (and only when) the group is expanded. The focused index
// lives in this flat space, so headers and rows are reachable with UP/DOWN
// exactly like the mobile list.
export function flattenSections(sections, expandedIds) {
  const items = [];
  for (const section of Array.isArray(sections) ? sections : []) {
    if (!section || !section.groupId) continue;
    items.push({
      type: "group",
      groupId: String(section.groupId),
      label: section.label,
      count: section.count,
      loading: Boolean(section.loading),
      channels: Array.isArray(section.channels) ? section.channels : []
    });
    const expanded = expandedIds instanceof Set ? expandedIds.has(String(section.groupId)) : false;
    if (expanded) {
      for (const channel of Array.isArray(section.channels) ? section.channels : []) {
        items.push({ type: "channel", groupId: String(section.groupId), channel });
      }
    }
  }
  return items;
}

// Clamp a flat index into [0, length - 1]; garbage input and empty lists
// collapse to 0 so focus can never land outside the list.
export function clampIndex(index, length) {
  const max = Math.max(0, Number(length) - 1);
  const value = Number(index);
  if (!Number.isInteger(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

// Fluidity: held-key auto-repeat must advance the list at a steady cadence
// instead of queuing behind the scroll animation. A repeat faster than the
// cadence is dropped.
export function shouldAcceptRepeatMove(lastMoveAt, now, cadenceMs) {
  const last = Number(lastMoveAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  const cadence = Number(cadenceMs);
  if (!Number.isFinite(cadence) || cadence <= 0) return true;
  return Number(now) - last >= cadence;
}

// Rendering ----------------------------------------------------------------

// Expanded group ids persist in memory across screen visits (module-level
// singleton, like the mobile app's LiveTvListMemory.expanded). Groups start
// collapsed.
const expandedGroupIds = new Set();

// Accessor shared with the key-handling module (one owner: this module).
export function expandedGroupIdsRef() {
  return expandedGroupIds;
}

export function createLiveScreenMethods02() {
  const { ScreenUtils, renderLoadingIndicator, escapeHtml, t, Router } = internals;

  const STYLE = `
    <style id="live-screen-style">
      .live-shell { position: absolute; inset: 0; height: 100%; display: flex; flex-direction: column; background: #0E0E12; color: #f5f5f5; overflow: hidden; }
      /* A flex child with overflow does not scroll unless it may shrink below
         its content: min-height:0 / min-width:0 everywhere it matters. Without
         them the panel grows with the content, the ancestor clips it, and the
         focused row walks off-screen while scrollTop stays 0. */
      .live-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 28px 40px 8px; box-sizing: border-box; }
      .live-header-left { min-width: 0; }
      .live-title { font-size: 42px; font-weight: 700; margin: 0; line-height: 1.15; }
      .live-header-sub { font-size: 20px; color: #9CA3AF; margin-top: 6px; }
      .live-header-actions { display: flex; gap: 16px; flex-shrink: 0; }
      .live-pill { display: inline-flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.08); border: 0; border-radius: 999px; color: #9CA3AF; font-size: 22px; padding: 18px 30px; outline: none; cursor: pointer; box-sizing: border-box; }
      .live-pill.focused { outline: 3px solid var(--secondary-color, #f5f5f5); outline-offset: 2px; background: rgba(255,255,255,0.16); color: #ffffff; }
      /* The search input sits exactly over its pill: a real <input> so the TV
         system IME can attach to it, styled invisible as a chrome-less field. */
      .live-search-pill { position: relative; min-width: 320px; }
      .live-search-input { position: absolute; inset: 0; width: 100%; height: 100%; background: transparent; border: 0; outline: none; color: #f5f5f5; font-size: 22px; padding: 0 30px; box-sizing: border-box; }
      /* ONE full-width list: group header cards with their rows indented
         underneath when expanded. No categories rail, no preview panel. */
      .live-body { flex: 1; min-height: 0; display: flex; padding: 8px 40px 28px; box-sizing: border-box; }
      .live-channel-list { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; scroll-behavior: auto; display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; }
      .live-group-header { flex-shrink: 0; display: flex; align-items: center; gap: 16px; min-height: 96px; background: #111111; border-radius: 16px; padding: 14px 24px; outline: none; cursor: pointer; box-sizing: border-box; transition: background-color 90ms ease, color 90ms ease; }
      .live-group-header.focused { background: #E8E8E8; color: #0E0E12; }
      .live-group-chevron { flex-shrink: 0; font-size: 26px; color: #9CA3AF; transition: transform 120ms ease; }
      .live-group-chevron.is-expanded { transform: rotate(90deg); }
      .live-group-header.focused .live-group-chevron { color: #55555c; }
      .live-group-label { flex: 1; min-width: 0; font-size: 26px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-group-count { flex-shrink: 0; background: rgba(255,255,255,0.08); border-radius: 999px; color: #9CA3AF; font-size: 20px; padding: 8px 18px; }
      .live-group-header.focused .live-group-count { color: #55555c; }
      .live-group-rows { flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; padding: 2px 0 6px 28px; box-sizing: border-box; }
      .live-channel-row { flex-shrink: 0; display: flex; align-items: center; gap: 20px; min-height: 126px; background: #111111; border-radius: 16px; padding: 14px 20px; outline: none; cursor: pointer; box-sizing: border-box; transition: background-color 90ms ease, color 90ms ease; }
      .live-channel-row.focused { background: #E8E8E8; color: #0E0E12; }
      .live-row-logo { position: relative; width: 66px; height: 66px; border-radius: 12px; background: rgba(0,0,0,0.4); overflow: hidden; flex-shrink: 0; }
      .live-row-logo-initial { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; color: #9CA3AF; }
      .live-row-logo img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
      .live-row-logo img.is-broken { display: none; }
      .live-row-text { flex: 1; min-width: 0; }
      .live-row-name { font-size: 24px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-row-number { font-size: 20px; color: #9CA3AF; }
      .live-channel-row.focused .live-row-number { color: #55555c; }
      .live-row-source { font-size: 18px; color: #9CA3AF; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-star { flex-shrink: 0; width: 56px; height: 56px; background: transparent; border: 0; outline: none; cursor: pointer; font-size: 34px; line-height: 1; color: #6b7280; padding: 0; }
      .live-star .live-star-glyph { visibility: hidden; }
      .live-channel-row:hover .live-star .live-star-glyph, .live-star.focused .live-star-glyph { visibility: visible; }
      .live-star.is-favorite { color: #F5C400; }
      .live-star.is-favorite .live-star-glyph { visibility: visible; }
      .live-star.focused { outline: 3px solid var(--secondary-color, #f5f5f5); outline-offset: 2px; border-radius: 10px; }
      .live-panel-state { display: flex; align-items: center; gap: 12px; color: #9CA3AF; font-size: 20px; padding: 20px 4px; }
      .live-panel-error, .live-panel-hint { color: #9CA3AF; font-size: 20px; padding: 20px 4px; overflow-wrap: anywhere; }
      .live-panel-error { color: #ffb4a8; }
      .live-notice { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; background: rgba(20,20,26,0.95); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; padding: 12px 18px; font-size: 15px; color: #f5f5f5; overflow-wrap: anywhere; z-index: 2; }
    </style>
  `;

  // Errors must never be silent on a TV (no logs): every guarded path reports
  // through the runtime beacon so the next owner report carries the message.
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

  // See the exported ALL_CHIP_ID / FAVORITES_CHIP_ID constants above.
  return {
    render({ preserveFocus = true } = {}) {
      try {
        const shellMarkup = `
          ${STYLE}
          <div class="live-shell">
            ${this.renderHeader()}
            <div class="live-body">
              ${this.renderChannelList()}
            </div>
            ${this.notice ? `<div class="live-notice" role="status">${escapeHtml(this.notice)}</div>` : ""}
          </div>
        `;
        this.container.innerHTML = shellMarkup;

        ScreenUtils.indexFocusables(this.container);
        this.bindSearchInput();
        const hasLogos = Boolean(this.container.querySelector(".live-row-logo img"));
        if (hasLogos) {
          this.logoProbeCount = (this.logoProbeCount || 0) + 1;
          if (this.logoProbeCount <= 2) {
            this.probeChannelLogos?.();
          }
        }
        this.applyFocusState({ smooth: false });
      } catch (error) {
        // A thrown exception during render used to blank the whole screen
        // (no header pills, no focus targets, dead D-pad). Render a minimal
        // shell that ALWAYS shows the header actions and report the error.
        reportLiveErrorSafe(error, "render");
        this.renderErrorFallback(error);
      }
    },

    // Minimal shell used only when the normal render throws: the header pills
    // are always present so the D-pad keeps a reachable target.
    renderErrorFallback(error) {
      try {
        const detail = String(error?.message || "").slice(0, 160);
        this.container.innerHTML = `
          ${STYLE}
          <div class="live-shell">
            <header class="live-header">
              <div class="live-header-left">
                <h1 class="live-title">Live TV</h1>
                <div class="live-header-sub"></div>
              </div>
              <div class="live-header-actions">
                <div class="live-pill live-search-pill focusable" data-action="openSearch" role="button">Buscar</div>
                <button class="live-pill focusable" data-action="showGuide">Guía</button>
              </div>
            </header>
            <div class="live-body">
              <div class="live-channel-list">
                <div class="live-panel-error">${escapeHtml(detail || "Live TV render error")}</div>
              </div>
            </div>
          </div>
        `;
        ScreenUtils.indexFocusables(this.container);
        this.applyFocusState({ smooth: false });
      } catch (_) {
        // Nothing more can be done without a working DOM.
      }
    },

    // Header: big "<n> canales" title over every channel known so far (the
    // union of all cached groups), one muted line with the merged sources,
    // then the search and guide pills. The pills must ALWAYS render: they are
    // guarded individually so one bad interpolation cannot drop them.
    renderHeader() {
      try {
        const categoriesLoading = Boolean(this.categoriesLoading);
        const count = categoriesLoading ? 0 : this.unionCachedChannels().length;
        const countLabel = categoriesLoading
          ? t("live_channels_loading_short", {}, "Cargando...")
          : t("live_header_count", { count }, `${count} canales`);
        const sources = Array.isArray(this.sourceLabels?.()) ? this.sourceLabels().join(" · ") : "";
        return `
          <header class="live-header">
            <div class="live-header-left">
              <h1 class="live-title">${escapeHtml(countLabel)}</h1>
              ${sources ? `<div class="live-header-sub">${escapeHtml(sources)}</div>` : ""}
            </div>
            <div class="live-header-actions">
              <div class="live-pill live-search-pill focusable" data-action="openSearch" role="button" aria-label="${escapeHtml(t("live_search_open", {}, "Buscar canales"))}">
                ${this.searchActive ? `<input class="live-search-input" type="text" placeholder="${escapeHtml(t("live_search_placeholder", {}, "Buscar canales"))}" value="${escapeHtml(this.searchQuery || "")}" />` : `<span class="live-search-placeholder">${escapeHtml(t("live_search_placeholder", {}, "Buscar canales"))}</span>`}
              </div>
              <button class="live-pill live-guide-pill focusable" data-action="showGuide">${escapeHtml(t("live_guide_button", {}, "Guía"))}</button>
            </div>
          </header>
        `;
      } catch (error) {
        reportLiveErrorSafe(error, "renderHeader");
        return `
          <header class="live-header">
            <div class="live-header-left"><h1 class="live-title">Live TV</h1></div>
            <div class="live-header-actions">
              <div class="live-pill live-search-pill focusable" data-action="openSearch" role="button">Buscar</div>
              <button class="live-pill focusable" data-action="showGuide">Guía</button>
            </div>
          </header>
        `;
      }
    },

    // The union of every cached per-group channel list, deduplicated by the
    // stable channel id. One implementation shared by the header count, the
    // favorites group and the visible-channels refresh.
    unionCachedChannels() {
      const union = new Map();
      const caches = this.channelsByColumn instanceof Map ? this.channelsByColumn : new Map();
      for (const list of caches.values()) {
        for (const channel of Array.isArray(list) ? list : []) {
          if (!union.has(String(channel?.id))) union.set(String(channel?.id), channel);
        }
      }
      return Array.from(union.values());
    },

    // Group sections for the current state: favorites first (only when it has
    // channels), then one per portal category.
    groupSections() {
      const favoriteChannels = this.favoriteSet?.size
        ? this.unionCachedChannels().filter((channel) => this.favoriteSet.has(String(channel?.id)))
        : [];
      return buildGroupSections({
        categories: this.categories,
        channelsByColumn: this.channelsByColumn,
        favoriteChannels,
        favoritesLabel: t("live_chip_favorites", {}, "Favoritos")
      });
    },

    // Expanded ids live in the module-level Set (persists across visits).
    expandedGroupIdSet() {
      return expandedGroupIds;
    },

    // The flat focus order for the CURRENT state: while searching, flat
    // matching rows with no groups (mobile search results); otherwise group
    // headers interleaved with their expanded rows.
    flatItems() {
      if (this.searchActive && String(this.searchQuery || "").trim()) {
        return (Array.isArray(this.channels) ? this.channels : []).map((channel) => ({
          type: "channel",
          groupId: "",
          channel
        }));
      }
      return flattenSections(this.groupSections(), expandedGroupIds);
    },

    // Deterministic zone/index normalization: maps the mount module's legacy
    // initial zone, clamps the flat index to the real item count, and bounces
    // an empty list back to the header so no state can dead-end the D-pad.
    normalizeFocusState() {
      if (this.focusZone === "chips") this.focusZone = "list";
      if (this.focusZone === "header") {
        this.headerIndex = clampIndex(this.headerIndex || 0, 2);
        return;
      }
      const items = this.flatItems();
      if (!items.length) {
        this.focusZone = "header";
        this.headerIndex = 0;
        return;
      }
      const current = Number.isInteger(this.flatIndex) ? this.flatIndex : Number.isInteger(this.rowIndex) ? this.rowIndex : 0;
      this.flatIndex = clampIndex(current, items.length);
      if (items[this.flatIndex]?.type !== "channel") {
        this.rowFocusTarget = "row";
      }
    },

    // Applies the deterministic focus state to the DOM: marks the focused
    // node and gives it real DOM focus without ever scrolling the document.
    // This MUST stay cheap: class toggles only, never a re-render.
    applyFocusState({ smooth = false } = {}) {
      try {
        this.normalizeFocusState();
        const target = this.focusedNode();
        this.container?.querySelectorAll(".focusable.focused").forEach((node) => {
          if (node !== target) node.classList.remove("focused");
        });
        if (target) {
          target.classList.add("focused");
          focusWithoutAutoScrollSafe(target);
          this.ensureFocusVisible?.({ smooth });
        }
      } catch (error) {
        reportLiveErrorSafe(error, "applyFocusState");
      }
    },

    // The single source of truth for "which element has focus right now".
    // Every zone resolves to a real node (header pill fallback) so a missing
    // list can never leave the D-pad pointing at nothing.
    focusedNode() {
      if (!this.container) return null;
      if (this.searchActive) {
        return this.container.querySelector(".live-search-input");
      }
      if (this.focusZone === "header") {
        const pills = this.container.querySelectorAll(".live-header-actions .live-pill");
        return pills[this.headerIndex || 0] || pills[0] || null;
      }
      const node = this.container.querySelector(`[data-flat-index="${this.flatIndex}"]`);
      if (!node) {
        return this.container.querySelector(".live-header-actions .live-pill");
      }
      if (this.rowFocusTarget === "star" && node.classList.contains("live-channel-row")) {
        return node.querySelector(".live-star") || node;
      }
      return node;
    },

    // The grouped list: favorites group first (only when it has channels),
    // then one collapsible group per category. With search active the list is
    // flat matching rows, exactly like the mobile search results.
    renderChannelList() {
      if (this.categoriesLoading) {
        return `
          <div class="live-channel-list" aria-busy="true">
            <div class="live-panel-state">${renderLoadingIndicator()}<span>${escapeHtml(t("live_categories_loading", {}, "Loading categories..."))}</span></div>
          </div>
        `;
      }
      if (this.categoriesError) {
        return `<div class="live-channel-list"><div class="live-panel-error">${escapeHtml(
          `${t("live_categories_error", {}, "Could not load Live TV")}: ${this.categoriesError}`
        )}</div></div>`;
      }
      if (this.searchActive && String(this.searchQuery || "").trim()) {
        const results = Array.isArray(this.channels) ? this.channels : [];
        if (!results.length) {
          return `<div class="live-channel-list"><div class="live-panel-hint">${escapeHtml(t("live_search_empty", {}, "Sin resultados"))}</div></div>`;
        }
        return `<div class="live-channel-list">${results.map((channel) => this.renderChannelRow(channel)).join("")}</div>`;
      }
      const sections = this.groupSections();
      if (!sections.length) {
        return `<div class="live-channel-list"><div class="live-panel-hint">${escapeHtml(t("live_channels_empty", {}, "No channels available"))}</div></div>`;
      }
      if (sections.some((section) => section.loading)) {
        this.scheduleCountsRefresh();
      }
      let flatIndex = 0;
      const blocks = sections
        .map((section) => {
          const expanded = expandedGroupIds.has(String(section.groupId));
          const countLabel = section.loading ? "…" : String(section.count ?? 0);
          const header = `
            <article class="live-group-header focusable"
                     role="button"
                     data-action="toggleGroup"
                     data-group-id="${escapeHtml(section.groupId)}"
                     data-flat-index="${flatIndex++}"
                     aria-expanded="${expanded ? "true" : "false"}">
              <span class="live-group-chevron${expanded ? " is-expanded" : ""}" aria-hidden="true">▸</span>
              <span class="live-group-label">${escapeHtml(section.label)}</span>
              <span class="live-group-count">${escapeHtml(countLabel)}</span>
            </article>`;
          if (!expanded) return header;
          const rows =
            section.loading && !section.channels.length
              ? `<div class="live-panel-state">${renderLoadingIndicator()}<span>${escapeHtml(t("live_channels_loading", {}, "Loading channels..."))}</span></div>`
              : section.channels.map((channel) => this.renderChannelRow(channel)).join("");
          return `${header}<div class="live-group-rows" data-group-id="${escapeHtml(section.groupId)}">${rows}</div>`;
        })
        .join("");
      return `<div class="live-channel-list">${blocks}</div>`;
    },

    // While group counts are still loading, repaint ONCE when the background
    // preload fills the caches, instead of leaving "…" on the cards forever.
    scheduleCountsRefresh() {
      if (this.countsRefreshTimer) return;
      const startedAt = Date.now();
      const tick = () => {
        this.countsRefreshTimer = 0;
        if (Router.getCurrent?.() !== "live") return;
        const pending = this.groupSections().some((section) => section.loading);
        if (!pending) {
          this.updateRowsOnly();
          return;
        }
        if (Date.now() - startedAt > 24000) return;
        this.countsRefreshTimer = setTimeout(tick, 1500);
      };
      this.countsRefreshTimer = setTimeout(tick, 1500);
    },

    renderChannelRow(channel) {
      const label = formatChannelRowLabel(channel);
      const logo = channelLogoInfo(channel);
      const isFavorite = this.isFavoriteId(channel?.id);
      const source = sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group);
      return `
        <article class="live-channel-row focusable"
                 data-action="tuneIn"
                 data-channel-id="${escapeHtml(String(channel?.id || ""))}"
                 data-channel-title="${escapeHtml(channel?.name || t("live_channel_fallback_title", {}, "Live channel"))}">
          <div class="live-row-logo">
            <span class="live-row-logo-initial" aria-hidden="true">${escapeHtml(logo.letter)}</span>
            ${logo.logo ? `<img src="${escapeHtml(logo.logo)}" alt="" onerror="this.classList.add('is-broken')" />` : ""}
          </div>
          <div class="live-row-text">
            ${label.number ? `<div class="live-row-number">${escapeHtml(label.number)}</div>` : ""}
            <div class="live-row-name">${escapeHtml(label.name)}</div>
            ${source ? `<div class="live-row-source">${escapeHtml(source)}</div>` : ""}
          </div>
          <button class="live-star focusable${isFavorite ? " is-favorite" : ""}"
                  data-action="toggleFavorite"
                  data-channel-id="${escapeHtml(String(channel?.id || ""))}"
                  aria-label="${escapeHtml(t("live_favorite_toggle", {}, "Favorito"))}"
                  aria-pressed="${isFavorite ? "true" : "false"}">
            <span class="live-star-glyph" aria-hidden="true">${isFavorite ? "★" : "☆"}</span>
          </button>
        </article>
      `;
    },

    // Re-stamps data-flat-index over the live DOM order. Used after a surgical
    // group toggle so the flat focus model and the DOM never disagree.
    reindexFlatDom() {
      const nodes = this.container?.querySelectorAll(".live-group-header, .live-channel-row");
      let index = 0;
      nodes?.forEach((node) => {
        node.dataset.flatIndex = String(index);
        index += 1;
      });
    },

    // In-place refresh of the list only (search typing, favourite toggles,
    // group data arrival). Focus movement never goes through here: it toggles
    // classes directly so a keypress costs no re-render.
    updateRowsOnly() {
      if (!this.container) return;
      try {
        const list = this.container.querySelector(".live-channel-list");
        if (!list) {
          this.render();
          return;
        }
        const previousScrollTop = list.scrollTop;
        const temp = document.createElement("div");
        temp.innerHTML = this.renderChannelList();
        const next = temp.firstElementChild;
        if (next) {
          list.replaceWith(next);
          next.scrollTop = previousScrollTop;
        }
        this.reindexFlatDom();
        ScreenUtils.indexFocusables(this.container);
        this.applyFocusState();
      } catch (error) {
        reportLiveErrorSafe(error, "updateRowsOnly");
      }
    },

    // Recomputes the visible channel set for search/favorites state without
    // touching the network, then repaints the list in place. Overrides the
    // mount module's full-screen render with the same recompute logic but a
    // list-only update, so data arrival never rebuilds the whole screen.
    refreshVisibleChannels() {
      try {
        if (this.listDependsOnAllCaches?.()) {
          let all = this.unionCachedChannels();
          if (this.searchActive && this.searchQuery) {
            all = all.filter((channel) => internals.channelMatchesQuery(channel, this.searchQuery));
          }
          if (String(this.activeChipId) === internals.FAVORITES_CHIP_ID && !(this.searchActive && this.searchQuery)) {
            all = all.filter((channel) => this.favoriteSet?.has(String(channel?.id)));
          }
          this.channels = all;
        }
        this.channelsLoading = false;
        this.channelsError = "";
        this.clampRowIndex?.();
        this.updateRowsOnly();
      } catch (error) {
        reportLiveErrorSafe(error, "refreshVisibleChannels");
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
