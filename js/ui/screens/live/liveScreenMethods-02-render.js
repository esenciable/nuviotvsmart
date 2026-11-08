/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

// Rendering for the Live TV screen, following the REAL Android TV reference
// (nuvio-plus-sports beta.8.4): a HERO panel on top (channel identity + a 16:9
// box + search/guide actions) and, below it, a LEFT VERTICAL RAIL of grouped
// categories next to the channel rows.
//
// The rail reads, top to bottom: Buscar (search), Favoritos (always),
// Vistos recientemente (only when non-empty), Todos los canales (merged
// total), then ONE collapsible section per SOURCE (MAGIS / PREMIUMTV) with the
// source's own count and its indented category rows (name left, count right).
// Category counts come from the per-category channel lists the screen already
// loads — never from extra portal calls; a pending list renders "…" and its
// source's count stays "…" until every one of its categories is cached.
//
// We have no EPG: the hero shows the source name where the reference shows the
// time range, the muted line "Sin información de programa", and NO progress
// bar. The 16:9 preview box keeps the channel logo centred — never a fake
// thumbnail.
//
// Focus is deterministic state (focusZone + railIndex / rowIndex /
// rowFocusTarget + heroIndex), never geometry. Movement must be fluid: a focus
// change only toggles classes (no re-render), scrolling is the smallest
// movement animated over ~110ms, and key repeats faster than the cadence are
// coalesced.
//
// Styles are inlined because the screen ships without a dedicated stylesheet.
// Palette from the 960x540 reference scaled x2 for the 1920x1080 surface:
// page #0E0E12, cards #111111, muted #9CA3AF, accent #F5C400, white outline
// on the focused row.

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

// Logo resolution for thumbnails and the hero preview box: whitespace-only
// urls count as missing so the letter fallback shows instead of a broken image.
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

// Recently watched ----------------------------------------------------------
// The last tuned channels, persisted under one namespaced key as lightweight
// snapshots (id + name + logo + number) so the rows render even before any
// per-category cache is warm. Same storage idea as favourites.

export const RECENTS_STORAGE_KEY = "nuvio.live.recents.v1";
export const MAX_RECENT_CHANNELS = 12;

// Pure: returns a NEW list with the channel's snapshot first, deduped by the
// stable channel id and capped at MAX_RECENT_CHANNELS.
export function pushRecentChannel(recents, channel) {
  const id = String(channel?.id ?? "").trim();
  if (!id) return Array.isArray(recents) ? [...recents] : [];
  const snapshot = {
    id,
    name: String(channel?.name ?? "").trim() || "Canal en vivo",
    logo: String(channel?.logo ?? "").trim(),
    number: channel?.number ?? null
  };
  const current = Array.isArray(recents) ? recents : [];
  const rest = current.filter((entry) => String(entry?.id ?? "") !== id);
  return [snapshot, ...rest].slice(0, MAX_RECENT_CHANNELS);
}

export function readRecentChannels(storage) {
  const store = storage ?? globalThis?.localStorage ?? null;
  try {
    const raw = store?.getItem?.(RECENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && String(entry?.id ?? "").trim())
      .map((entry) => ({
        id: String(entry.id),
        name: String(entry?.name ?? "").trim() || "Canal en vivo",
        logo: String(entry?.logo ?? "").trim(),
        number: entry?.number ?? null
      }))
      .slice(0, MAX_RECENT_CHANNELS);
  } catch (_) {
    return [];
  }
}

export function writeRecentChannels(recents, storage) {
  const store = storage ?? globalThis?.localStorage ?? null;
  try {
    const safe = Array.isArray(recents) ? recents.slice(0, MAX_RECENT_CHANNELS) : [];
    store?.setItem?.(RECENTS_STORAGE_KEY, JSON.stringify(safe));
  } catch (_) {
    // Persistence is best effort; the in-memory list keeps working this session.
  }
}

// Rail model ---------------------------------------------------------------

// Stable rail ids for the fixed rows and per-item channel sources. Category
// rows and source headers derive their ids from the portal data.
export const RAIL_SEARCH_ID = "__search__";
export const RAIL_FAVORITES_ID = "__favorites__";
export const RAIL_RECENTS_ID = "__recents__";
export const RAIL_ALL_ID = "__all__";

export function categoryRailId(columnId) {
  return `cat:${String(columnId ?? "")}`;
}

export function sourceRailIdFromColumnId(columnId) {
  return `source:${sourceNameFromColumnId(columnId)}`;
}

// Collapsed source sections persist in memory across screen visits (module-
// level singleton). Sources are EXPANDED by default, so this set remembers the
// collapsed ones — a fresh source appears expanded without extra state.
const collapsedSourceIds = new Set();

// Accessor shared with the key-handling module (one owner: this module).
export function collapsedSourceIdsRef() {
  return collapsedSourceIds;
}

export function isSourceExpanded(sourceRailId, collapsedIds) {
  const set = collapsedIds instanceof Set ? collapsedIds : collapsedSourceIds;
  return !set.has(String(sourceRailId ?? ""));
}

// Pure toggle (mutates the shared set in place, like the focus model does).
export function toggleSourceCollapsed(collapsedIds, sourceRailId) {
  const id = String(sourceRailId ?? "");
  if (!id) return;
  const set = collapsedIds instanceof Set ? collapsedIds : collapsedSourceIds;
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

// The flat focus order of the LEFT RAIL for the current state:
//   [search] [favorites] [recents?] [all] [source header, its categories]...
// Counts are read from the per-category caches ONLY (no extra portal calls):
// a category with no cached list yet is `loading: true` with count `null`,
// and its source's count stays `null` ("…") until every one of its
// categories is cached.
export function buildRailItems({ categories = [], channelsByColumn = new Map(), favoriteCount = 0, recentCount = 0 } = {}) {
  const caches = channelsByColumn instanceof Map ? channelsByColumn : new Map();
  const items = [
    { type: "search", railId: RAIL_SEARCH_ID, label: "Buscar", count: null },
    { type: "favorites", railId: RAIL_FAVORITES_ID, label: "Favoritos", count: Math.max(0, Number(favoriteCount) || 0) }
  ];
  const recents = Math.max(0, Number(recentCount) || 0);
  if (recents > 0) {
    items.push({ type: "recents", railId: RAIL_RECENTS_ID, label: "Vistos recientemente", count: recents });
  }

  // Todos los canales: the deduplicated union of every cached list.
  const union = new Map();
  for (const list of caches.values()) {
    for (const channel of Array.isArray(list) ? list : []) {
      if (!union.has(String(channel?.id))) union.set(String(channel?.id), channel);
    }
  }
  items.push({
    type: "all",
    railId: RAIL_ALL_ID,
    label: "Todos los canales",
    count: union.size > 0 ? union.size : null
  });

  // ONE section per source, in first-appearance order over the merged
  // categories; each keeps its own category rows in feed order.
  const sources = [];
  const bySource = new Map();
  for (const category of Array.isArray(categories) ? categories : []) {
    const columnId = String(category?.columnId ?? "").trim();
    if (!columnId) continue;
    const source = sourceNameFromColumnId(columnId);
    if (!source) continue;
    const sourceRailId = `source:${source}`;
    let section = bySource.get(sourceRailId);
    if (!section) {
      section = { type: "source", railId: sourceRailId, label: source, categories: [] };
      bySource.set(sourceRailId, section);
      sources.push(section);
    }
    const cached = caches.get(columnId);
    const channels = Array.isArray(cached) ? cached : [];
    section.categories.push({
      type: "category",
      railId: categoryRailId(columnId),
      columnId,
      label: String(category?.name ?? "").trim() || "Sin nombre",
      count: cached ? channels.length : null,
      loading: !cached
    });
  }
  for (const section of sources) {
    const allCached = section.categories.every((category) => !category.loading);
    section.count = allCached ? section.categories.reduce((sum, category) => sum + (category.count ?? 0), 0) : null;
    section.expanded = isSourceExpanded(section.railId);
    section.loading = !allCached;
    items.push(section);
    if (section.expanded) {
      // The flat focus order interleaves each header with its own rows, so a
      // collapsed section contributes NO focusable category items.
      for (const category of section.categories) {
        items.push({ ...category, sourceRailId: section.railId });
      }
    }
  }
  return items;
}

// Clamp an index into [0, length - 1]; garbage input and empty lists
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

export function createLiveScreenMethods02() {
  const { ScreenUtils, renderLoadingIndicator, escapeHtml, t, Router } = internals;

  const STYLE = `
    <style id="live-screen-style">
      .live-shell { position: absolute; inset: 0; height: 100%; display: flex; flex-direction: column; background: #0E0E12; color: #f5f5f5; overflow: hidden; }
      /* A flex child with overflow does not scroll unless it may shrink below
         its content: min-height:0 / min-width:0 everywhere it matters. Without
         them the panel grows with the content, the ancestor clips it, and the
         focused row walks off-screen while scrollTop stays 0. */
      /* HERO ---------------------------------------------------------------- */
      .live-hero { flex-shrink: 0; display: flex; align-items: stretch; gap: 24px; margin: 20px 40px 16px; background: #111111; border-radius: 20px; padding: 20px 24px; box-sizing: border-box; min-height: 240px; position: relative; }
      .live-hero.is-hidden { display: none; }
      .live-hero-main { display: flex; align-items: center; gap: 24px; flex: 1; min-width: 0; }
      .live-hero-logo { position: relative; width: 108px; height: 108px; border-radius: 16px; background: rgba(0,0,0,0.4); overflow: hidden; flex-shrink: 0; }
      .live-hero-logo-initial { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 44px; font-weight: 700; color: #9CA3AF; }
      .live-hero-logo img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
      .live-hero-logo img.is-broken { display: none; }
      .live-hero-meta { flex: 1; min-width: 0; }
      .live-hero-topline { display: flex; align-items: center; gap: 16px; }
      .live-hero-number { font-size: 26px; font-weight: 700; color: #9CA3AF; }
      .live-hero-badge { display: inline-block; background: #e11d2e; color: #ffffff; border-radius: 6px; font-size: 18px; font-weight: 700; letter-spacing: 1px; padding: 4px 12px; }
      .live-hero-name { font-size: 44px; font-weight: 700; line-height: 1.15; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-hero-source { font-size: 22px; color: #9CA3AF; margin-top: 10px; }
      .live-hero-noprogram { font-size: 20px; color: #9CA3AF; margin-top: 6px; }
      .live-hero-actions { position: absolute; top: 16px; right: 20px; display: flex; gap: 14px; }
      .live-pill { display: inline-flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.08); border: 0; border-radius: 999px; color: #9CA3AF; font-size: 20px; padding: 12px 24px; outline: none; cursor: pointer; box-sizing: border-box; }
      .live-pill.focused { outline: 3px solid var(--secondary-color, #ffffff); outline-offset: 2px; background: rgba(255,255,255,0.16); color: #ffffff; }
      /* 16:9 preview box: the logo sits centred. We have no frame source, so
         no fake thumbnail is ever drawn. */
      .live-hero-preview { flex-shrink: 0; width: 426px; height: 240px; border-radius: 14px; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; overflow: hidden; }
      .live-hero-preview img { max-width: 70%; max-height: 70%; object-fit: contain; }
      .live-hero-preview img.is-broken { display: none; }
      .live-hero-preview-initial { font-size: 64px; font-weight: 700; color: #55555c; }
      /* BODY: narrow LEFT RAIL + channel rows on the right ------------------- */
      .live-body { flex: 1; min-height: 0; display: flex; gap: 20px; padding: 0 40px 24px; box-sizing: border-box; }
      .live-rail { flex: 0 0 21%; min-width: 0; min-height: 0; overflow-y: auto; scroll-behavior: auto; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; transition: opacity 120ms ease; }
      .live-rail.is-dimmed { opacity: 0.45; }
      .live-rail-row { flex-shrink: 0; display: flex; align-items: center; gap: 14px; min-height: 84px; background: #111111; border-radius: 14px; padding: 12px 20px; outline: 3px solid transparent; outline-offset: -3px; cursor: pointer; box-sizing: border-box; transition: background-color 90ms ease, outline-color 90ms ease; }
      .live-rail-row.focused { outline-color: #ffffff; background: #1b1b22; }
      .live-rail-search { position: relative; }
      .live-rail-icon { flex-shrink: 0; font-size: 26px; color: #9CA3AF; }
      .live-rail-label { flex: 1; min-width: 0; font-size: 24px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-rail-count { flex-shrink: 0; font-size: 20px; color: #9CA3AF; }
      .live-rail-row.focused .live-rail-count { color: #d1d5db; }
      /* The search input sits exactly over its rail row: a real <input> so the
         TV system IME can attach to it, styled invisible as a chrome-less field. */
      .live-search-input { position: absolute; inset: 0; width: 100%; height: 100%; background: transparent; border: 0; outline: none; color: #f5f5f5; font-size: 22px; padding: 0 20px 0 62px; box-sizing: border-box; }
      .live-source-header { border-radius: 14px; }
      .live-source-chevron { flex-shrink: 0; width: 26px; font-size: 24px; color: #9CA3AF; transition: transform 120ms ease; }
      .live-rail-category { margin-left: 26px; min-height: 72px; }
      .live-rail-category .live-rail-label { font-weight: 500; font-size: 22px; color: #d1d5db; }
      /* CHANNEL ROWS (right side) ------------------------------------------- */
      .live-channel-list { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; scroll-behavior: auto; display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; }
      .live-channel-row { flex-shrink: 0; display: flex; align-items: center; gap: 20px; min-height: 126px; background: #111111; border-radius: 16px; padding: 14px 20px; outline: 3px solid transparent; outline-offset: -3px; cursor: pointer; box-sizing: border-box; transition: background-color 90ms ease, outline-color 90ms ease; }
      .live-channel-row.focused { outline-color: #ffffff; background: #1b1b22; }
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

  // "…" while a count is unknown; a known count renders as-is (0 included).
  function countLabel(count) {
    return count == null ? "…" : String(count);
  }

  return {
    render({ preserveFocus = true } = {}) {
      try {
        const shellMarkup = `
          ${STYLE}
          <div class="live-shell">
            ${this.renderHero()}
            <div class="live-body">
              ${this.renderRail()}
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
        this.updateHeroForFocus({ force: true });
      } catch (error) {
        // A thrown exception during render used to blank the whole screen
        // (no hero actions, no focus targets, dead D-pad). Render a minimal
        // shell that ALWAYS keeps a reachable focusable and report the error.
        reportLiveErrorSafe(error, "render");
        this.renderErrorFallback(error);
      }
    },

    // Minimal shell used only when the normal render throws: the search row
    // stays present so the D-pad keeps a reachable target.
    renderErrorFallback(error) {
      try {
        const detail = String(error?.message || "").slice(0, 160);
        this.container.innerHTML = `
          ${STYLE}
          <div class="live-shell">
            <div class="live-body">
              <div class="live-rail">
                <div class="live-rail-row live-rail-search focusable" data-action="openSearch" data-rail-index="0" role="button">
                  <span class="live-rail-icon" aria-hidden="true">⌕</span>
                  <span class="live-rail-label">Buscar</span>
                </div>
                <div class="live-panel-error">${escapeHtml(detail || "Live TV render error")}</div>
              </div>
              <div class="live-channel-list"></div>
            </div>
          </div>
        `;
        ScreenUtils.indexFocusables(this.container);
        this.applyFocusState({ smooth: false });
      } catch (_) {
        // Nothing more can be done without a working DOM.
      }
    },

    // HERO -------------------------------------------------------------------
    // Hidden while nothing is selected; shows the focused/highlighted channel:
    // logo box, `N` + red EN VIVO badge, the big name, the source name (where
    // the reference shows its EPG time range) and the honest "no EPG" line.
    renderHero() {
      try {
        const channel = this.heroChannel || null;
        const hidden = channel ? "" : " is-hidden";
        const label = formatChannelRowLabel(channel || {});
        const logo = channelLogoInfo(channel || {});
        const source = channel ? sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group) : "";
        const number = label.number ? label.number.replace(/\.$/, "") : "";
        return `
          <section class="live-hero${hidden}" aria-hidden="${channel ? "false" : "true"}">
            <div class="live-hero-main">
              <div class="live-hero-logo">
                <span class="live-hero-logo-initial" aria-hidden="true">${escapeHtml(logo.letter)}</span>
                ${logo.logo ? `<img src="${escapeHtml(logo.logo)}" alt="" onerror="this.classList.add('is-broken')" />` : ""}
              </div>
              <div class="live-hero-meta">
                <div class="live-hero-topline">
                  ${number ? `<span class="live-hero-number" data-hero-field="number">${escapeHtml(number)}</span>` : `<span class="live-hero-number" data-hero-field="number"></span>`}
                  <span class="live-hero-badge">EN VIVO</span>
                </div>
                <h1 class="live-hero-name" data-hero-field="name">${escapeHtml(label.name)}</h1>
                <div class="live-hero-source" data-hero-field="source">${escapeHtml(source)}</div>
                <div class="live-hero-noprogram">${escapeHtml(t("live_no_program_info", {}, "Sin información de programa"))}</div>
              </div>
            </div>
            <div class="live-hero-actions">
              <div class="live-pill focusable" data-action="openSearch" role="button" aria-label="${escapeHtml(t("live_search_open", {}, "Buscar canales"))}">
                <span aria-hidden="true">⌕</span><span>${escapeHtml(t("live_search_open", {}, "Buscar"))}</span>
              </div>
              <button class="live-pill focusable" data-action="showGuide">${escapeHtml(t("live_guide_button", {}, "Guía"))}</button>
            </div>
            <div class="live-hero-preview" aria-hidden="true">
              ${logo.logo ? `<img src="${escapeHtml(logo.logo)}" alt="" onerror="this.classList.add('is-broken')" />` : `<span class="live-hero-preview-initial">${escapeHtml(logo.letter)}</span>`}
            </div>
          </section>
        `;
      } catch (error) {
        reportLiveErrorSafe(error, "renderHero");
        return `<section class="live-hero is-hidden" aria-hidden="true"></section>`;
      }
    },

    // Patch the hero fields in place for a newly focused/highlighted channel.
    // Never a re-render: focus movement must stay cheap.
    updateHeroForFocus({ force = false } = {}) {
      try {
        const hero = this.container?.querySelector(".live-hero");
        if (!hero) return;
        const channel = this.heroChannel || null;
        if (!channel) {
          hero.classList.add("is-hidden");
          hero.setAttribute("aria-hidden", "true");
          return;
        }
        hero.classList.remove("is-hidden");
        hero.setAttribute("aria-hidden", "false");
        if (!force && String(hero.dataset.heroChannelId || "") === String(channel.id || "")) {
          return; // same channel: nothing to patch
        }
        hero.dataset.heroChannelId = String(channel.id || "");
        const label = formatChannelRowLabel(channel);
        const logo = channelLogoInfo(channel);
        const source = sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group);
        const number = label.number ? label.number.replace(/\.$/, "") : "";
        const numberNode = hero.querySelector('[data-hero-field="number"]');
        if (numberNode) numberNode.textContent = number;
        const nameNode = hero.querySelector('[data-hero-field="name"]');
        if (nameNode) nameNode.textContent = label.name;
        const sourceNode = hero.querySelector('[data-hero-field="source"]');
        if (sourceNode) sourceNode.textContent = source;
        const logoBox = hero.querySelector(".live-hero-logo");
        if (logoBox) {
          logoBox.innerHTML = `
            <span class="live-hero-logo-initial" aria-hidden="true">${escapeHtml(logo.letter)}</span>
            ${logo.logo ? `<img src="${escapeHtml(logo.logo)}" alt="" onerror="this.classList.add('is-broken')" />` : ""}
          `;
        }
        const preview = hero.querySelector(".live-hero-preview");
        if (preview) {
          preview.innerHTML = logo.logo
            ? `<img src="${escapeHtml(logo.logo)}" alt="" onerror="this.classList.add('is-broken')" />`
            : `<span class="live-hero-preview-initial">${escapeHtml(logo.letter)}</span>`;
        }
      } catch (error) {
        reportLiveErrorSafe(error, "updateHeroForFocus");
      }
    },

    // LEFT RAIL --------------------------------------------------------------
    renderRail() {
      try {
        const items = this.railItems();
        const dimmed = this.searchActive ? " is-dimmed" : "";
        const rows = items
          .map((item, index) => {
            if (item.type === "search") {
              return `
                <div class="live-rail-row live-rail-search focusable"
                     role="button"
                     data-action="openSearch"
                     data-rail-index="${index}">
                  <span class="live-rail-icon" aria-hidden="true">⌕</span>
                  <span class="live-rail-label">${escapeHtml(item.label)}</span>
                  ${this.searchActive ? `<input class="live-search-input" type="text" aria-label="${escapeHtml(t("live_search_open", {}, "Buscar canales"))}" value="${escapeHtml(this.searchQuery || "")}" />` : ""}
                </div>
              `;
            }
            if (item.type === "source") {
              const expanded = item.expanded !== false;
              return `
                <div class="live-rail-row live-source-header focusable"
                     role="button"
                     data-action="toggleSource"
                     data-rail-id="${escapeHtml(item.railId)}"
                     data-rail-index="${index}"
                     aria-expanded="${expanded ? "true" : "false"}">
                  <span class="live-source-chevron" aria-hidden="true">${expanded ? "▾" : "›"}</span>
                  <span class="live-rail-label">${escapeHtml(item.label)}</span>
                  <span class="live-rail-count">${escapeHtml(countLabel(item.count))}</span>
                </div>
                ${expanded ? item.categories.map((category) => this.renderRailCategory(category)).join("") : ""}
              `;
            }
            if (item.type === "category") {
              return this.renderRailCategory(item, index);
            }
            // favorites / recents / all
            return `
              <div class="live-rail-row focusable"
                   role="button"
                   data-action="selectRail"
                   data-rail-id="${escapeHtml(item.railId)}"
                   data-rail-index="${index}">
                <span class="live-rail-icon" aria-hidden="true">${item.type === "favorites" ? "★" : item.type === "recents" ? "↺" : "☰"}</span>
                <span class="live-rail-label">${escapeHtml(item.label)}</span>
                <span class="live-rail-count">${escapeHtml(countLabel(item.count))}</span>
              </div>
            `;
          })
          .join("");
        return `<nav class="live-rail${dimmed}" aria-label="${escapeHtml(t("live_rail_label", {}, "Categorías"))}">${rows}</nav>`;
      } catch (error) {
        reportLiveErrorSafe(error, "renderRail");
        return `<nav class="live-rail"><div class="live-rail-row live-rail-search focusable" data-action="openSearch" role="button"><span class="live-rail-label">Buscar</span></div></nav>`;
      }
    },

    renderRailCategory(category, index = 0) {
      return `
        <div class="live-rail-row live-rail-category focusable"
             role="button"
             data-action="selectRail"
             data-rail-id="${escapeHtml(category.railId)}"
             data-rail-index="${Number(index) || 0}">
          <span class="live-rail-label">${escapeHtml(category.label)}</span>
          <span class="live-rail-count">${escapeHtml(countLabel(category.count))}</span>
        </div>
      `;
    },

    // The flat rail items for the CURRENT state (pure model above).
    railItems() {
      return buildRailItems({
        categories: this.categories,
        channelsByColumn: this.channelsByColumn,
        favoriteCount: this.favoriteSet?.size
          ? this.unionCachedChannels().filter((channel) => this.favoriteSet.has(String(channel?.id))).length
          : 0,
        recentCount: Array.isArray(this.recentChannels) ? this.recentChannels.length : 0
      });
    },

    // The union of every cached per-category channel list, deduplicated by the
    // stable channel id. One implementation shared by the "Todos" count, the
    // favorites rows and the search filter.
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

    // Deterministic zone/index normalization: clamps every index to the real
    // item count and bounces impossible zones back to a reachable one so no
    // state can dead-end the D-pad (loading, empty category, error).
    normalizeFocusState() {
      const railLength = this.railItems().length;
      if (this.focusZone === "hero") {
        // The hero actions only exist while the hero is visible.
        if (!this.heroChannel) {
          this.focusZone = "rail";
        } else {
          this.heroIndex = clampIndex(this.heroIndex || 0, 2);
          return;
        }
      }
      if (this.focusZone === "rows") {
        const rows = this.visibleChannels();
        if (!rows.length) {
          this.focusZone = "rail";
        } else {
          this.rowIndex = clampIndex(Number.isInteger(this.rowIndex) ? this.rowIndex : 0, rows.length);
          return;
        }
      }
      // Rail zone (or bounced back into it): the search row always exists.
      this.focusZone = "rail";
      this.railIndex = clampIndex(Number.isInteger(this.railIndex) ? this.railIndex : 0, railLength);
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
        // The hero highlights the focused channel (sticky: it stays visible
        // after LEFT returns to the rail, until a new row takes over).
        if (this.focusZone === "rows") {
          const rows = this.visibleChannels?.() || [];
          const channel = rows[this.rowIndex] || null;
          if (channel) this.heroChannel = channel;
        }
        this.updateHeroForFocus();
      } catch (error) {
        reportLiveErrorSafe(error, "applyFocusState");
      }
    },

    // The single source of truth for "which element has focus right now".
    // Every zone resolves to a real node (rail row fallback) so a missing
    // list can never leave the D-pad pointing at nothing.
    focusedNode() {
      if (!this.container) return null;
      if (this.searchActive) {
        return this.container.querySelector(".live-search-input");
      }
      if (this.focusZone === "hero") {
        const pills = this.container.querySelectorAll(".live-hero-actions .live-pill");
        return pills[this.heroIndex || 0] || pills[0] || null;
      }
      if (this.focusZone === "rows") {
        const node = this.container.querySelector(`[data-row-index="${this.rowIndex}"]`);
        if (node && this.rowFocusTarget === "star") {
          return node.querySelector(".live-star") || node;
        }
        if (node) return node;
        // Fall through to the rail when the rows vanished.
      }
      const railNode = this.container.querySelector(`[data-rail-index="${this.railIndex}"]`);
      if (railNode) return railNode;
      return this.container.querySelector(".live-rail .focusable") || this.container.querySelector(".focusable");
    },

    // The channels behind the current rail selection (or the search filter).
    // Data comes only from the per-category caches and the recents snapshots:
    // selecting never triggers a portal call here, loading happens explicitly
    // in loadChannelsForCategory when a category is chosen.
    visibleChannels() {
      if (this.searchActive && String(this.searchQuery || "").trim()) {
        return Array.isArray(this.channels) ? this.channels : [];
      }
      if (String(this.railSelection) === RAIL_RECENTS_ID) {
        return Array.isArray(this.recentChannels) ? this.recentChannels : [];
      }
      return Array.isArray(this.channels) ? this.channels : [];
    },

    // The channel rows on the right: one per line, the existing row design
    // (logo with letter fallback, `N. Nombre`, muted source, star). States
    // (loading / empty / error / search hint) always keep the rail reachable.
    renderChannelList() {
      try {
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
          return `<div class="live-channel-list">${results.map((channel, index) => this.renderChannelRow(channel, index)).join("")}</div>`;
        }
        if (this.channelsLoading) {
          return `
            <div class="live-channel-list" aria-busy="true">
              <div class="live-panel-state">${renderLoadingIndicator()}<span>${escapeHtml(t("live_channels_loading", {}, "Loading channels..."))}</span></div>
            </div>
          `;
        }
        if (this.channelsError) {
          return `<div class="live-channel-list"><div class="live-panel-error">${escapeHtml(
            `${t("live_channels_error", {}, "Could not load the channels")}: ${this.channelsError}`
          )}</div></div>`;
        }
        const rows = this.visibleChannels();
        if (!rows.length) {
          return `<div class="live-channel-list"><div class="live-panel-hint">${escapeHtml(t("live_channels_empty", {}, "No channels available"))}</div></div>`;
        }
        return `<div class="live-channel-list">${rows.map((channel, index) => this.renderChannelRow(channel, index)).join("")}</div>`;
      } catch (error) {
        reportLiveErrorSafe(error, "renderChannelList");
        return `<div class="live-channel-list"><div class="live-panel-error">Live TV error</div></div>`;
      }
    },

    renderChannelRow(channel, index = 0) {
      const label = formatChannelRowLabel(channel);
      const logo = channelLogoInfo(channel);
      const isFavorite = this.isFavoriteId(channel?.id);
      const source = sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group);
      return `
        <article class="live-channel-row focusable"
                 data-action="tuneIn"
                 data-row-index="${Number(index) || 0}"
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

    // In-place refresh of the rail counts and the channel list only (data
    // arrival, search typing, favourite toggles, recent updates). Focus
    // movement never goes through here: it toggles classes directly so a
    // keypress costs no re-render.
    updateRowsOnly() {
      if (!this.container) return;
      try {
        const list = this.container.querySelector(".live-channel-list");
        const previousScrollTop = list?.scrollTop ?? 0;
        const temp = document.createElement("div");
        temp.innerHTML = `
          ${this.renderHero()}
          ${this.renderRail()}
          ${this.renderChannelList()}
        `;
        const nextHero = temp.querySelector(".live-hero");
        const nextRail = temp.querySelector(".live-rail");
        const nextList = temp.querySelector(".live-channel-list");
        const currentHero = this.container.querySelector(".live-hero");
        if (nextHero && currentHero) {
          currentHero.replaceWith(nextHero);
        }
        const currentRail = this.container.querySelector(".live-rail");
        if (nextRail && currentRail) {
          currentRail.replaceWith(nextRail);
        }
        if (nextList && list) {
          nextList.scrollTop = previousScrollTop;
          list.replaceWith(nextList);
        } else if (nextList) {
          this.container.querySelector(".live-body")?.appendChild(nextList);
        }
        ScreenUtils.indexFocusables(this.container);
        this.bindSearchInput();
        this.applyFocusState();
        this.updateHeroForFocus({ force: true });
      } catch (error) {
        reportLiveErrorSafe(error, "updateRowsOnly");
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
