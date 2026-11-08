/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

// Rendering for the Live TV screen, restyled after the Android TV app's Live
// tab: compact header (title + source line, search and guide pills), a
// horizontal chips row (Todos / Favoritos / one chip per category), a left
// channel list and a right preview panel. Focus is tracked as plain state on
// the screen (focusZone / chipIndex / rowIndex / rowFocusTarget), never by
// geometry. The styles are inlined here because the screen ships without a
// dedicated stylesheet.
//
// Palette and sizes are measured from the 1280x720 reference and scaled x1.5
// for the 1920x1080 surface: page #0E0E12, cards #111111, muted #9CA3AF,
// selected chip #FFFFFF on #0E0E12, rows ~126px tall, logos 66px.

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

// Chip label: `Source · Category` so two portals with same-named categories
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

// Rendering ----------------------------------------------------------------

// Special chips that are not portal categories. `__all__` deliberately maps
// to the first source group (the cheapest deterministic "everything is
// already loaded" union); `__favorites__` unions the cached channel lists.
export const ALL_CHIP_ID = "__all__";
export const FAVORITES_CHIP_ID = "__favorites__";

export function createLiveScreenMethods02() {
  const { ScreenUtils, renderLoadingIndicator, escapeHtml, t } = internals;

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
      .live-chips-row { display: flex; gap: 12px; padding: 16px 40px 12px; overflow-x: auto; overflow-y: hidden; flex-shrink: 0; scrollbar-width: none; }
      .live-chips-row::-webkit-scrollbar { display: none; }
      .live-chip { flex-shrink: 0; background: rgba(255,255,255,0.08); border: 0; border-radius: 999px; color: #cfcfd6; font-size: 22px; padding: 14px 28px; outline: none; cursor: pointer; white-space: nowrap; box-sizing: border-box; }
      .live-chip.selected { background: #ffffff; color: #0E0E12; font-weight: 700; }
      .live-chip.focused { outline: 3px solid var(--secondary-color, #f5f5f5); outline-offset: 2px; }
      .live-body { flex: 1; min-height: 0; display: flex; gap: 32px; padding: 8px 40px 28px; box-sizing: border-box; }
      .live-channel-list { width: 50%; min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding-right: 8px; box-sizing: border-box; }
      .live-channel-row { flex-shrink: 0; display: flex; align-items: center; gap: 20px; min-height: 126px; background: #111111; border-radius: 16px; padding: 14px 20px; outline: none; cursor: pointer; box-sizing: border-box; }
      .live-channel-row.focused { background: #E8E8E8; color: #0E0E12; }
      .live-row-logo { position: relative; width: 66px; height: 66px; border-radius: 12px; background: rgba(0,0,0,0.4); overflow: hidden; flex-shrink: 0; }
      .live-row-logo-initial, .live-preview-logo-initial { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; color: #9CA3AF; }
      .live-row-logo img, .live-preview-logo { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
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
      .live-preview { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
      .live-preview-name { font-size: 36px; font-weight: 700; margin: 4px 0 6px; }
      .live-preview-number { color: #9CA3AF; font-weight: 400; }
      .live-preview-source { font-size: 20px; color: #9CA3AF; margin-bottom: 18px; }
      .live-preview-box { position: relative; width: 100%; max-width: 835px; aspect-ratio: 16 / 9; background: #111111; border-radius: 16px; overflow: hidden; }
      /* padding-top fallback when aspect-ratio is missing on older TV engines */
      @supports not (aspect-ratio: 16 / 9) { .live-preview-box { height: 470px; } }
      .live-preview-logo-wrap { position: absolute; inset: 0; }
      .live-preview-logo-initial { font-size: 64px; }
      .live-preview-chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
      .live-preview-chip { background: rgba(255,255,255,0.08); border-radius: 999px; color: #9CA3AF; font-size: 18px; padding: 8px 18px; }
      .live-panel-state { display: flex; align-items: center; gap: 12px; color: #9CA3AF; font-size: 20px; padding: 20px 4px; }
      .live-panel-error, .live-panel-hint { color: #9CA3AF; font-size: 20px; padding: 20px 4px; overflow-wrap: anywhere; }
      .live-panel-error { color: #ffb4a8; }
      .live-notice { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; background: rgba(20,20,26,0.95); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; padding: 12px 18px; font-size: 15px; color: #f5f5f5; overflow-wrap: anywhere; z-index: 2; }
    </style>
  `;

  // See the exported ALL_CHIP_ID / FAVORITES_CHIP_ID constants above.
  return {
    render({ preserveFocus = true } = {}) {
      const shellMarkup = `
        ${STYLE}
        <div class="live-shell">
          ${this.renderHeader()}
          ${this.renderChipsRow()}
          <div class="live-body">
            ${this.renderChannelList()}
            ${this.renderPreviewPanel()}
          </div>
          ${this.notice ? `<div class="live-notice" role="status">${escapeHtml(this.notice)}</div>` : ""}
        </div>
      `;
      this.container.innerHTML = shellMarkup;

      ScreenUtils.indexFocusables(this.container);
      this.bindSearchInput();
      const hasLogos = Boolean(this.container.querySelector(".live-row-logo img, .live-preview-logo"));
      if (hasLogos) {
        this.logoProbeCount = (this.logoProbeCount || 0) + 1;
        if (this.logoProbeCount <= 2) {
          this.probeChannelLogos?.();
        }
      }
      this.applyFocusState({ smooth: false });
    },

    // Applies the deterministic focus state to the DOM: marks the focused
    // node and gives it real DOM focus without ever scrolling the document.
    applyFocusState({ smooth = false } = {}) {
      const target = this.focusedNode();
      this.container?.querySelectorAll(".focusable.focused").forEach((node) => {
        if (node !== target) node.classList.remove("focused");
      });
      if (target) {
        target.classList.add("focused");
        focusWithoutAutoScrollSafe(target);
        this.ensureFocusVisible?.({ smooth });
      }
    },

    // The single source of truth for "which element has focus right now".
    focusedNode() {
      if (!this.container) return null;
      if (this.searchActive) {
        return this.container.querySelector(".live-search-input");
      }
      if (this.focusZone === "header") {
        const pills = this.container.querySelectorAll(".live-header-actions .live-pill");
        return pills[this.headerIndex || 0] || null;
      }
      if (this.focusZone === "chips") {
        const chips = this.container.querySelectorAll(".live-chip");
        return chips[this.chipIndex || 0] || null;
      }
      const rows = this.container.querySelectorAll(".live-channel-row");
      const row = rows[this.rowIndex || 0];
      if (!row) return null;
      if (this.rowFocusTarget === "star") {
        return row.querySelector(".live-star") || row;
      }
      return row;
    },

    // Header: big "<n> canales" title for the selected chip's list, one muted
    // line with the merged sources, then the search and guide pills. No EPG
    // or programme-count line is rendered anywhere (there is no guide data).
    renderHeader() {
      const count = Array.isArray(this.channels) ? this.channels.length : 0;
      const countLabel = this.channelsLoading
        ? t("live_channels_loading_short", {}, "Cargando...")
        : t("live_header_count", { count }, `${count} canales`);
      const sources = this.sourceLabels().join(" · ");
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
    },

    // Chip list: Todos, Favoritos, then one chip per category with the source
    // prefixed in the label. The selected chip is white with dark text.
    renderChipsRow() {
      if (this.categoriesLoading) {
        return `
          <div class="live-chips-row" aria-busy="true">
            <div class="live-panel-state">${renderLoadingIndicator()}<span>${escapeHtml(t("live_categories_loading", {}, "Loading categories..."))}</span></div>
          </div>
        `;
      }
      if (this.categoriesError) {
        return `<div class="live-panel-error" style="padding: 16px 40px;">${escapeHtml(
          `${t("live_categories_error", {}, "Could not load Live TV")}: ${this.categoriesError}`
        )}</div>`;
      }
      const chips = this.chipModel();
      const items = chips
        .map((chip, index) => {
          const selected = String(chip.id) === String(this.activeChipId);
          return `
            <button class="live-chip focusable${selected ? " selected" : ""}"
                    data-action="selectChip"
                    data-chip-id="${escapeHtml(chip.id)}"
                    data-chip-index="${index}">
              ${escapeHtml(chip.label)}
            </button>
          `;
        })
        .join("");
      return `<div class="live-chips-row">${items}</div>`;
    },

    // Chips model shared by rendering and key handling so indices always agree.
    chipModel() {
      const chips = [
        { id: ALL_CHIP_ID, label: t("live_chip_all", {}, "Todos") },
        { id: FAVORITES_CHIP_ID, label: t("live_chip_favorites", {}, "Favoritos") }
      ];
      for (const category of this.categories || []) {
        chips.push({
          id: String(category?.columnId ?? ""),
          label: formatChipLabel(category)
        });
      }
      return chips;
    },

    renderChannelList() {
      if (this.channelsLoading) {
        return `
          <div class="live-channel-list">
            <div class="live-panel-state">${renderLoadingIndicator()}<span>${escapeHtml(t("live_channels_loading", {}, "Loading channels..."))}</span></div>
          </div>
        `;
      }
      if (this.channelsError) {
        return `
          <div class="live-channel-list">
            <div class="live-panel-error">${escapeHtml(
              `${t("live_channels_error", {}, "Could not load channels")}: ${this.channelsError}`
            )}</div>
          </div>
        `;
      }
      const channels = Array.isArray(this.channels) ? this.channels : [];
      if (!channels.length) {
        const hint =
          String(this.activeChipId) === FAVORITES_CHIP_ID
            ? t("live_favorites_empty", {}, "Aún no tienes canales favoritos: marca una fila con la estrella")
            : this.searchQuery
              ? t("live_search_empty", {}, "Sin resultados")
              : t("live_channels_empty", {}, "No channels available");
        return `<div class="live-channel-list"><div class="live-panel-hint">${escapeHtml(hint)}</div></div>`;
      }
      const rows = channels.map((channel, index) => this.renderChannelRow(channel, index)).join("");
      return `<div class="live-channel-list">${rows}</div>`;
    },

    renderChannelRow(channel, index) {
      const label = formatChannelRowLabel(channel);
      const logo = channelLogoInfo(channel);
      const isFavorite = this.isFavoriteId(channel?.id);
      const source = sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group);
      return `
        <article class="live-channel-row focusable"
                 data-action="tuneIn"
                 data-channel-id="${escapeHtml(String(channel?.id || ""))}"
                 data-channel-title="${escapeHtml(channel?.name || t("live_channel_fallback_title", {}, "Live channel"))}"
                 data-row-index="${index}">
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
                  data-row-index="${index}"
                  aria-label="${escapeHtml(t("live_favorite_toggle", {}, "Favorito"))}"
                  aria-pressed="${isFavorite ? "true" : "false"}">
            <span class="live-star-glyph" aria-hidden="true">${isFavorite ? "★" : "☆"}</span>
          </button>
        </article>
      `;
    },

    // Right panel: focused channel name (large), muted source line, a 16:9
    // dark box with the logo centred (letter fallback), then small chips built
    // only from real data: En vivo + the channel's group + its source label.
    renderPreviewPanel() {
      const channels = Array.isArray(this.channels) ? this.channels : [];
      const channel = channels[this.rowIndex || 0] || null;
      if (!channel) {
        return `<aside class="live-preview"></aside>`;
      }
      const label = formatChannelRowLabel(channel);
      const logo = channelLogoInfo(channel);
      const source = sourceNameFromChannelId(channel?.id);
      const chips = [`<span class="live-preview-chip">${escapeHtml(t("live_chip_live", {}, "En vivo"))}</span>`];
      const groupName = String(channel?.groupName ?? "").trim();
      if (groupName) {
        chips.push(`<span class="live-preview-chip">${escapeHtml(groupName)}</span>`);
      }
      if (source) {
        chips.push(`<span class="live-preview-chip">${escapeHtml(source)}</span>`);
      }
      return `
        <aside class="live-preview">
          <div class="live-preview-name">${label.number ? `<span class="live-preview-number">${escapeHtml(label.number)}</span> ` : ""}${escapeHtml(label.name)}</div>
          ${source ? `<div class="live-preview-source">${escapeHtml(source)}</div>` : ""}
          <div class="live-preview-box">
            <div class="live-preview-logo-wrap">
              <span class="live-preview-logo-initial" aria-hidden="true">${escapeHtml(logo.letter)}</span>
              ${logo.logo ? `<img class="live-preview-logo" src="${escapeHtml(logo.logo)}" alt="" onerror="this.classList.add('is-broken')" />` : ""}
            </div>
          </div>
          <div class="live-preview-chips">${chips.join("")}</div>
        </aside>
      `;
    },

    // In-place refresh of list + preview (row moves, search typing, favourite
    // toggles). Full re-renders are reserved for chip/category changes so a
    // 500-row list is not rebuilt on every keypress.
    updateRowsOnly() {
      if (!this.container) return;
      const list = this.container.querySelector(".live-channel-list");
      if (list) {
        const temp = document.createElement("div");
        temp.innerHTML = this.renderChannelList();
        list.replaceWith(temp.firstElementChild);
      }
      const preview = this.container.querySelector(".live-preview");
      if (preview) {
        const temp = document.createElement("div");
        temp.innerHTML = this.renderPreviewPanel();
        preview.replaceWith(temp.firstElementChild);
      }
      ScreenUtils.indexFocusables(this.container);
      this.applyFocusState();
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
