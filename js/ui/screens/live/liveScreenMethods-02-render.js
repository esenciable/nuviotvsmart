/* eslint-disable no-unused-vars */
import * as internals from "./liveScreen.js";

// Rendering for the Live TV screen, following the REAL Android TV reference
// (nuvio-plus-sports beta.8.4): a HERO panel on top (channel identity + a 16:9
// box + search/guide actions) and, below it, a LEFT VERTICAL RAIL of grouped
// categories next to the channel rows.
//
// The rail reads, top to bottom: Buscar (search), Favoritos (always),
// Vistos recientemente (only when non-empty), then ONE collapsible section
// per SOURCE (MAGIS / PREMIUMTV) with the source's own count and its
// indented category rows (name left, count right).
// Category counts come from the GENERATED catalog index the app ships with
// (js/core/magis/catalog-index.json, `npm run catalog:index`) — no portal
// call; a count missing from the index renders "…" and its source's count
// stays "…" (no fake sums).
// There is NO aggregate "all channels" row: nothing here may load or
// merge every category on demand.
//
// We have no EPG: the hero shows the source name where the reference shows the
// time range. It is a COMPACT TEXT BLOCK (number, name, source) — no image,
// no preview box: the owner decision removed every channel logo from this
// screen, so it never loads or decodes an image.
//
// Focus is deterministic state (focusZone + railIndex / rowIndex /
// rowFocusTarget + heroIndex), never geometry. Movement must feel exactly
// like the rest of the app: a focus change only toggles classes (no
// re-render) and calls node.focus(), letting the browser reveal the focused
// element natively — no scroll animation and no repeat throttling.
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

// Source display name from the channel's id/group; no logo is read here.

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
// snapshots (id + name + number) so the rows render even before any
// per-category cache is warm. Same storage idea as favourites. The snapshot
// is deliberately text-only: nothing on this screen loads an image.

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

// On-screen keyboard -------------------------------------------------------
// Deterministic replacement for the TV's system IME (which does not attach in
// this widget): a fixed grid of keys we own. Pure helpers so node --test can
// pin the layout, the movement and the query updates without a DOM.

// The query never grows unbounded: typing past the cap is dropped.
export const KEYBOARD_MAX_QUERY = 40;

// Shown in the query line only while nothing has been typed.
export const KEYBOARD_QUERY_PLACEHOLDER = "Escribe para buscar…";

// The grid, row by row. Rows 0-2: A-Z plus Ñ (9 per row); row 3: the digits;
// row 4: the four actions (ESPACIO / BORRAR / LIMPIAR / LISTO). Every key has
// a stable id, a visible label, a type and the value typing contributes.
export function buildKeyboardLayout() {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZÑ".split("");
  const rows = [];
  for (let i = 0; i < letters.length; i += 9) {
    rows.push(
      letters.slice(i, i + 9).map((letter) => ({
        id: `char:${letter}`,
        label: letter,
        type: "char",
        value: letter
      }))
    );
  }
  rows.push(
    "0123456789".split("").map((digit) => ({
      id: `char:${digit}`,
      label: digit,
      type: "char",
      value: digit
    }))
  );
  rows.push([
    { id: "action:space", label: "ESPACIO", type: "space", value: " " },
    { id: "action:backspace", label: "BORRAR", type: "backspace", value: "" },
    { id: "action:clear", label: "LIMPIAR", type: "clear", value: "" },
    { id: "action:done", label: "LISTO", type: "done", value: "" }
  ]);
  return rows;
}

// The same grid flattened with each key's row/col coordinates — the exact
// model the D-pad movement and the DOM (data-key-index) both use.
export function keyboardFlatKeys(rows) {
  const flat = [];
  (Array.isArray(rows) ? rows : []).forEach((row, rowIndex) => {
    (Array.isArray(row) ? row : []).forEach((key, col) => {
      if (key) flat.push({ key, row: rowIndex, col });
    });
  });
  return flat;
}

// The flat grid of the one keyboard this screen ships (deterministic: no DOM,
// no data). Consumed by the focus model, the metrics cache and the renderer.
export const KEYBOARD_KEYS = keyboardFlatKeys(buildKeyboardLayout());
export const KEYBOARD_KEY_COUNT = KEYBOARD_KEYS.length;

// Row-aware movement: horizontal steps clamp inside the key's own row;
// vertical steps land in the target row at the nearest column (clamped when
// that row is shorter). Always returns a valid flat index — never a dead end.
export function keyboardMove(flatKeys, index, dx = 0, dy = 0) {
  if (!Array.isArray(flatKeys) || flatKeys.length === 0) return 0;
  const from = flatKeys[clampIndex(index, flatKeys.length)];
  const stepX = Math.trunc(Number(dx) || 0);
  const stepY = Math.trunc(Number(dy) || 0);
  const rows = new Map();
  for (const entry of flatKeys) {
    const rowNumber = Number(entry?.row) || 0;
    if (!rows.has(rowNumber)) rows.set(rowNumber, []);
    rows.get(rowNumber).push(entry);
  }
  const rowNumbers = Array.from(rows.keys()).sort((a, b) => a - b);
  const targetRowIndex = clampIndex(from.row + stepY, rowNumbers.length);
  const rowEntries = rows.get(rowNumbers[targetRowIndex]) || [];
  const col = clampIndex(from.col + stepX, rowEntries.length);
  const target = rowEntries[col] || from;
  return flatKeys.indexOf(target);
}

// Pure query update for one key press: chars and space append, BORRAR removes
// exactly one character, LIMPIAR empties, LISTO is a no-op here (closing the
// keyboard is the caller's job). The cap keeps typing from growing forever.
export function applyKeyboardKey(query, key) {
  const current = String(query ?? "");
  const type = String(key?.type ?? "");
  if (type === "backspace") return current.slice(0, -1);
  if (type === "clear") return "";
  if (type === "done") return current;
  if (type === "char" || type === "space") {
    return (current + String(key?.value ?? "")).slice(0, KEYBOARD_MAX_QUERY);
  }
  return current;
}

// The query line model: the caret is ALWAYS rendered after the typed text,
// and the placeholder exists only while the query is empty — so typing is
// visible as plain DOM text and never reflows the fixed-height line.
export function queryLineView(query) {
  const text = String(query ?? "");
  return {
    text,
    placeholder: text ? "" : KEYBOARD_QUERY_PLACEHOLDER,
    caretAfterText: true,
    caretPosition: text.length
  };
}

// Generated catalog index --------------------------------------------
// The Magis portal exposes one GENERIC catalogue category ("ChannelList"):
// that is the portal's full channel LISTING page, not a genre. Every other
// category is SPECIFIC (Deportes, Vivo gratis, Cine y Series, a country...)
// and they overlap heavily.
//
// Owner-approved rule: each channel lives in exactly ONE category. That rule
// is computed OFFLINE by `npm run catalog:index`
// (scripts/magis-catalog-index.mjs) and shipped as
// js/core/magis/catalog-index.json: { generatedAt, genericCategoryName,
// categories: [{ columnId, name, count }], leftovers: [{ code, name,
// number }] } — counts AFTER dedupe, plus the generic catalogue's leftovers.
// The screen only READS the index: no runtime ownership computation and no
// background walk of all categories. An absent/stale index degrades: counts
// render "…", the generic catalogue falls back to its portal fetch, and
// tune-in surfaces the real portal error. Never crashes.
export const GENERIC_CATEGORY_NAME = "ChannelList";

// Case-insensitive identification of the catalogue page category. The index
// carries the generic name it was generated with; the constant is the
// fallback when an index entry omits it.
export function isGenericCategoryName(name, genericName = GENERIC_CATEGORY_NAME) {
  return (
    String(name ?? "")
      .trim()
      .toLowerCase() ===
    String(genericName ?? GENERIC_CATEGORY_NAME)
      .trim()
      .toLowerCase()
  );
}

// Pure: the index is usable only when it was actually generated (a non-empty
// generatedAt — the shipped placeholder has `null` — plus a categories list).
// Anything else degrades to the on-demand paths.
export function isUsableCatalogIndex(index) {
  return Boolean(
    index &&
    typeof index === "object" &&
    String(index.generatedAt ?? "").trim() !== "" &&
    Array.isArray(index.categories) &&
    String(index.genericCategoryName ?? "").trim() !== ""
  );
}

// Pure: Map columnId (as string) -> rail count (AFTER dedupe, from the
// index). An unusable index or a malformed entry contributes nothing, so the
// rail renders "…" instead of a fake 0.
export function catalogCountsFromIndex(index) {
  const counts = new Map();
  if (!isUsableCatalogIndex(index)) return counts;
  for (const entry of index.categories) {
    const columnId = String(entry?.columnId ?? "").trim();
    if (!columnId) continue;
    counts.set(columnId, Math.max(0, Math.trunc(Number(entry?.count) || 0)));
  }
  return counts;
}

// Pure: the generic catalogue's channel rows, built from the index's
// leftovers — the 500-channel portal page is NEVER fetched at runtime. An
// unusable index yields no rows (the caller falls back to the portal fetch).
// No `logo` field: nothing on this screen reads one.
export function leftoverChannelsFromIndex(index) {
  if (!isUsableCatalogIndex(index)) return [];
  const list = Array.isArray(index.leftovers) ? index.leftovers : [];
  const seen = new Set();
  const channels = [];
  for (const entry of list) {
    const code = String(entry?.code ?? "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    channels.push({
      id: `magis:live:${code}`,
      code,
      name: String(entry?.name ?? "").trim() || "Canal en vivo",
      number: entry?.number ?? null,
      epgChannelId: null,
      tvgId: null,
      group: null,
      groupName: String(index.genericCategoryName ?? GENERIC_CATEGORY_NAME)
    });
  }
  return channels;
}

// Pure: the generic catalogue category of the CURRENT portal categories,
// matched against the index's genericCategoryName (case-insensitive). Called
// only with a usable index; null means "stay on the on-demand fetch path".
export function findGenericCategory(categories, genericName = GENERIC_CATEGORY_NAME) {
  for (const category of Array.isArray(categories) ? categories : []) {
    if (isGenericCategoryName(category?.name, genericName)) return category;
  }
  return null;
}

// Rail model ---------------------------------------------------------------

// Stable rail ids for the fixed rows and per-item channel sources. Category
// rows and source headers derive their ids from the portal data.
export const RAIL_SEARCH_ID = "__search__";
export const RAIL_FAVORITES_ID = "__favorites__";
export const RAIL_RECENTS_ID = "__recents__";
// The aggregate "all channels" row was REMOVED (it loaded every category
// of every source and made the whole screen slow). No rail id exists for it
// anymore; the legacy id below is only so a persisted remembered selection
// restores to the default instead of hunting for a vanished row.
const LEGACY_AGGREGATE_RAIL_ID = "__all__";

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

// Remembered Live TV selection -------------------------------------------
// The last rail selection (stable railId) plus the focused channel row,
// remembered at MODULE level (like the mobile app's LiveTvListMemory) so
// leaving to the player — or unmounting entirely — never loses where the user
// was. It is also written to one cheap namespaced key so it survives a full
// app restart; the in-memory value is authoritative within a session.
export const LIVE_SELECTION_STORAGE_KEY = "nuvio.live.selection.v1";

let rememberedLiveSelection = null;

// Saves { railId, rowIndex }; a missing railId is never remembered. Returns
// the stored snapshot (or null). Storage is injectable for tests and all
// access is guarded, like the favourites/recents stores.
export function rememberLiveSelection(selection, storage) {
  const railId = String(selection?.railId ?? "");
  if (!railId) return null;
  rememberedLiveSelection = {
    railId,
    rowIndex: Math.max(0, Math.trunc(Number(selection?.rowIndex) || 0))
  };
  const store = storage ?? globalThis?.localStorage ?? null;
  try {
    store?.setItem?.(LIVE_SELECTION_STORAGE_KEY, JSON.stringify(rememberedLiveSelection));
  } catch (_) {
    // Persistence is best effort; the in-memory value keeps working.
  }
  return { ...rememberedLiveSelection };
}

export function readRememberedLiveSelection(storage) {
  if (rememberedLiveSelection) return { ...rememberedLiveSelection };
  const store = storage ?? globalThis?.localStorage ?? null;
  try {
    const raw = store?.getItem?.(LIVE_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const railId = String(parsed?.railId ?? "");
    if (!railId) return null;
    return { railId, rowIndex: Math.max(0, Math.trunc(Number(parsed?.rowIndex) || 0)) };
  } catch (_) {
    return null;
  }
}

// Test/session isolation: clears the in-memory value (storage is untouched).
export function forgetLiveSelection() {
  rememberedLiveSelection = null;
}

// Pure restore rules over the CURRENT flat rail items:
//   1. the remembered railId still exists -> restored at its index, with the
//      row index clamped to the visible channel count,
//   2. it is a category whose source section still exists -> that source's
//      header (row 0),
//   3. otherwise (source vanished) -> the first item (index 0, row 0).
// With no memory at all it returns null so the caller keeps its own default.
export function resolveLiveSelectionRestore(items, remembered, channelCount = 0) {
  if (!remembered) return null;
  const list = Array.isArray(items) ? items : [];
  const railId = String(remembered.railId ?? "");
  // A remembered removed aggregate id is treated as no memory at all: the
  // caller applies its own default (the first category of the first source).
  if (railId === LEGACY_AGGREGATE_RAIL_ID) return null;
  const rowIndex = Math.max(0, Math.trunc(Number(remembered.rowIndex) || 0));
  if (railId) {
    const index = list.findIndex((item) => item?.railId === railId);
    if (index >= 0) {
      return { railId, index, rowIndex: clampIndex(rowIndex, channelCount) };
    }
    if (railId.startsWith("cat:")) {
      const owner = list.find(
        (item) =>
          item?.type === "source" && (Array.isArray(item.categories) ? item.categories : []).some((category) => category?.railId === railId)
      );
      if (owner) {
        return { railId: owner.railId, index: list.indexOf(owner), rowIndex: 0 };
      }
    }
  }
  return { railId: null, index: 0, rowIndex: 0 };
}

// The flat focus order of the LEFT RAIL for the current state:
//   [search] [favorites] [recents?] [source header, its categories]...
// Magis counts come from the GENERATED catalog index (already deduped, no
// portal call): a category missing from the index renders `…` (count null).
// PremiumTV groups are not in the index (they do not overlap the Magis
// catalog): their count is the cached list length, or `…` while it loads on
// demand. A source's count stays `…` until every one of its categories has a
// count — no fake sums.
export function buildRailItems({
  categories = [],
  channelsByColumn = new Map(),
  catalogCounts = new Map(),
  favoriteCount = 0,
  recentCount = 0
} = {}) {
  const caches = channelsByColumn instanceof Map ? channelsByColumn : new Map();
  const indexCounts = catalogCounts instanceof Map ? catalogCounts : new Map();
  const items = [
    { type: "search", railId: RAIL_SEARCH_ID, label: "Buscar", count: null },
    { type: "favorites", railId: RAIL_FAVORITES_ID, label: "Favoritos", count: Math.max(0, Number(favoriteCount) || 0) }
  ];
  const recents = Math.max(0, Number(recentCount) || 0);
  if (recents > 0) {
    items.push({ type: "recents", railId: RAIL_RECENTS_ID, label: "Vistos recientemente", count: recents });
  }

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
    const premium = sourceNameFromColumnId(columnId) === "PremiumTV";
    // Magis: the count is the index's deduped count ("…" while missing).
    // PremiumTV: the on-demand cache length ("…" while not loaded).
    const count = premium ? (cached ? channels.length : null) : indexCounts.has(columnId) ? indexCounts.get(columnId) : null;
    section.categories.push({
      type: "category",
      railId: categoryRailId(columnId),
      columnId,
      label: String(category?.name ?? "").trim() || "Sin nombre",
      count,
      loading: count == null
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

// Index-based rail movement over the CURRENT item list: one item per step,
// clamped at both ends — no wrap, no jump. UP at the first item stays put
// (the key handler lifts focus to the hero instead) and DOWN at the last item
// stays put with the ring visible. Garbage indices clamp to 0; an empty list
// collapses to 0 so movement can never throw or dead-end.
export function railMoveIndex(items, index, delta) {
  const length = Array.isArray(items) ? items.length : 0;
  if (length <= 0) return 0;
  const from = clampIndex(index, length);
  const step = Math.trunc(Number(delta) || 0);
  return clampIndex(from + step, length);
}

// Where rail focus lands when the item list CHANGES (counts arriving, recents
// appearing or disappearing, a source expanding/collapsing):
//   1. the focused item's railId is still present -> its NEW index,
//   2. the focused category vanished because its source collapsed -> that
//      source's header (from the item's own sourceRailId, or discovered from
//      the collapsed section's retained categories),
//   3. otherwise -> the previous index clamped into the (shorter) list.
// Focus must never rest on an index that no longer resolves to a node.
export function railFocusAfterChange(nextItems, previousIndex, previousItem) {
  const items = Array.isArray(nextItems) ? nextItems : [];
  const previousId = String(previousItem?.railId ?? "");
  if (previousId) {
    const same = items.findIndex((item) => item?.railId === previousId);
    if (same >= 0) return same;
    const sourceRailId = String(previousItem?.sourceRailId ?? "");
    if (sourceRailId) {
      const header = items.findIndex((item) => item?.railId === sourceRailId);
      if (header >= 0) return header;
    }
    if (previousId.startsWith("cat:")) {
      const owner = items.find(
        (item) =>
          item?.type === "source" &&
          (Array.isArray(item.categories) ? item.categories : []).some((category) => category?.railId === previousId)
      );
      if (owner) return items.indexOf(owner);
    }
  }
  return clampIndex(previousIndex, items.length);
}

// Virtualized channel list -----------------------------------------------
// Samsung's memory guide requires any TV list over ~100 items to be
// virtualized, and this channel list can hold 500 rows: only the rows inside
// the visible window plus a buffer (LIVE_VIRTUAL_BUFFER above and below)
// exist in the DOM. A top and a bottom spacer preserve the FULL scroll
// height, so the scrollbar and the scroll position stay exactly where the
// fixed geometry puts them. These helpers are pure so node --test pins the
// windowing without a DOM (tests/test-live-virtual-list.mjs).

// Fixed geometry of a channel row: 51px tile + 6px flex gap (the layout
// contract below pins both in CSS). The pitch is a constant, never measured
// per scroll step — only the scroll container's height is measured, once per
// data change.
export const LIVE_ROW_HEIGHT = 51;
export const LIVE_ROW_GAP = 6;
export const LIVE_ROW_PITCH = LIVE_ROW_HEIGHT + LIVE_ROW_GAP;

// Rows kept in the DOM above and below the visible window.
export const LIVE_VIRTUAL_BUFFER = 8;

// Fallback viewport height (12 rows) for the frame before the container is
// measurable (hidden container, first paint). Corrected by the real measure
// on the next data change.
export const LIVE_LIST_VIEWPORT_FALLBACK = 12 * LIVE_ROW_PITCH;

// Pure windowing model. Modes:
//   "scroll" (scroll events): the window covers the viewport plus the
//      buffer; a focused row the scroll moved away from is FORCED back in by
//      extending the window, so the recompute can never drop the focused
//      node and steal focus.
//   "focus" (a focus move / a window painted for focus): when the focused
//      row is not inside the viewport window, the window re-anchors around
//      it so its node exists at its absolute position and plain focus()
//      reveals it natively; when it is already inside, the viewport window
//      is kept (no churn on normal moves).
// The result is always clamped to [0, total] at both ends; a short list
// (fewer rows than the window) renders fully.
export function computeChannelWindow({
  total,
  scrollTop = 0,
  viewportHeight = 0,
  focusIndex = -1,
  mode = "scroll",
  buffer = LIVE_VIRTUAL_BUFFER
} = {}) {
  const count = Math.max(0, Math.trunc(Number(total)) || 0);
  if (count === 0) return { start: 0, end: 0 };
  const top = Math.max(0, Math.trunc(Number(scrollTop)) || 0);
  const height = Math.max(0, Number(viewportHeight) || 0);
  const buf = Math.max(0, Math.trunc(Number(buffer)) || 0);
  let start = Math.max(0, Math.floor(top / LIVE_ROW_PITCH) - buf);
  let end = Math.min(count, Math.ceil((top + height) / LIVE_ROW_PITCH) + buf);
  const focus = Math.trunc(Number(focusIndex));
  const hasFocus = Number.isInteger(focus) && focus >= 0 && focus < count;
  if (hasFocus && (focus < start || focus >= end)) {
    const focusStart = Math.max(0, focus - buf);
    const focusEnd = Math.min(count, focus + 1 + buf);
    if (mode === "focus") {
      start = focusStart;
      end = Math.max(focusEnd, start);
    } else {
      start = Math.min(start, focusStart);
      end = Math.max(end, focusEnd);
    }
  }
  start = Math.min(start, count - 1);
  end = Math.max(start, Math.min(end, count));
  return { start, end };
}

// Spacer heights for a window. Because the list lays rows out with a flex
// gap, a spacer contributes its own gap to the flow: the heights subtract
// exactly that gap, so spacer + window rows reproduce the full list height
// EXACTLY (pinned by test). A height of 0 means "emit no spacer" — a
// zero-height flex child would still contribute a phantom gap.
export function channelSpacerHeights({ start, end, total } = {}) {
  const count = Math.max(0, Math.trunc(Number(total)) || 0);
  const from = Math.max(0, Math.trunc(Number(start)) || 0);
  const to = Math.max(from, Math.trunc(Number(end)) || 0);
  return {
    topSpacerHeight: from > 0 ? Math.max(0, from * LIVE_ROW_PITCH - LIVE_ROW_GAP) : 0,
    bottomSpacerHeight: to < count ? Math.max(0, (count - to) * LIVE_ROW_PITCH - LIVE_ROW_GAP) : 0
  };
}

// Fluidity: held-key auto-repeat must advance the list at a steady cadence
// instead of queuing behind the scroll animation. A repeat faster than the
// cadence is dropped.

// Background release (Samsung memory guide) --------------------------------
// On document.visibilitychange -> hidden, a mounted Live TV screen releases
// everything the return path can rebuild and keeps only light state, because
// Samsung documents a 120 MB cap for Tizen apps and KILLS processes that
// exceed the system memory budget. These helpers are pure so node --test pins
// the plan: which per-category caches are dropped and which are kept, the
// retained light state shape, and the restore plan (refetched vs reused).

// Pure: the background cache release plan. Every cached per-category channel
// list is REBUILDABLE (one portal call) except the one behind the currently
// selected rail row, which is kept so the return repaint feels instant. A
// non-category selection (favourites, recents, search) reads the UNION of the
// caches, so no single cache is "the current one" and all of them drop.
export function planBackgroundCacheRelease({ channelsByColumn = new Map(), railSelection = "" } = {}) {
  const caches = channelsByColumn instanceof Map ? channelsByColumn : new Map();
  const selection = String(railSelection ?? "");
  const selectedColumnId = selection.startsWith("cat:") ? selection.slice(4) : null;
  const keep = [];
  const drop = [];
  for (const key of caches.keys()) {
    const columnId = String(key);
    if (selectedColumnId != null && columnId === selectedColumnId) keep.push(columnId);
    else drop.push(columnId);
  }
  return { keep, drop, selectedColumnId };
}

// Pure: the LIGHT state a release retains — the fields that make the return
// feel instant (rail selection id, focused rail row by identity, focused
// channel row and its target, scroll position, search query and keyboard
// index, favourites, recents). The arrays are COPIED so the snapshot can
// never alias live state, and heavy state (the channel lists, the caches, the
// categories) is never included. `scrollTop` is the channel list's scroll
// position at release time, read by the caller.
export function retainedLightState(screen, { scrollTop = 0 } = {}) {
  const favoriteIds = Array.isArray(screen?.favoriteIds) ? screen.favoriteIds : [];
  const recentChannels = Array.isArray(screen?.recentChannels) ? screen.recentChannels : [];
  return {
    railSelection: String(screen?.railSelection ?? ""),
    railFocusId: String(screen?.railFocusId ?? ""),
    railIndex: Math.max(0, Math.trunc(Number(screen?.railIndex) || 0)),
    rowIndex: Math.max(0, Math.trunc(Number(screen?.rowIndex) || 0)),
    rowFocusTarget: String(screen?.rowFocusTarget || "row"),
    focusZone: String(screen?.focusZone || "rail"),
    searchActive: Boolean(screen?.searchActive),
    searchQuery: String(screen?.searchQuery ?? ""),
    keyboardIndex: Math.max(0, Math.trunc(Number(screen?.keyboardIndex) || 0)),
    favoriteIds: favoriteIds.map((id) => String(id)),
    recentChannels: recentChannels.map((entry) => ({ ...entry })),
    scrollTop: Math.max(0, Math.trunc(Number(scrollTop) || 0))
  };
}

// Pure: the foreground restore plan. The selected category is refetched from
// the network exactly when its cache was dropped; a cache that survived is
// reused; favourites/recents/search repaint from whatever caches remain while
// the re-armed preload refetches the dropped ones. The preload is re-armed
// only when something was actually dropped.
export function planForegroundRestore({ railSelection = "", cachedColumnIds = [], droppedColumnIds = [] } = {}) {
  const cached = new Set((Array.isArray(cachedColumnIds) ? cachedColumnIds : []).map((id) => String(id)));
  const dropped = (Array.isArray(droppedColumnIds) ? droppedColumnIds : []).map((id) => String(id));
  const selection = String(railSelection ?? "");
  if (selection.startsWith("cat:")) {
    const columnId = selection.slice(4);
    const selectionWasDropped = !cached.has(columnId);
    return {
      selectedColumnId: columnId,
      selectionWasDropped,
      refetchColumnIds: selectionWasDropped ? [columnId] : [],
      reuseColumnIds: Array.from(cached),
      rearmPreload: dropped.length > 0
    };
  }
  return {
    selectedColumnId: null,
    selectionWasDropped: dropped.length > 0,
    refetchColumnIds: dropped,
    reuseColumnIds: Array.from(cached),
    rearmPreload: dropped.length > 0
  };
}

// Rendering ----------------------------------------------------------------

export function createLiveScreenMethods02() {
  const { ScreenUtils, renderLoadingIndicator, escapeHtml, t, Router } = internals;

  const STYLE = `
    <style id="live-screen-style">
      /* STATIC LAYOUT CONTRACT (measured from the Android TV reference, dp x1.5):
         every box has a fixed size. Nothing may resize on focus — a keypress
         only toggles classes, writes hero text and lets the browser
         reveal the focused row. The focus state is a fill plus an inner ring:
         no scale, no elevation, no layout change, and no transition on the
         focus state at all — the fill and the ring appear in the same frame. */
      .live-shell { position: absolute; inset: 0; width: 100%; height: 100%; display: flex; flex-direction: column; background: #0D0D0D; color: #FFFFFF; overflow: hidden; }
      /* A flex child with overflow does not scroll unless it may shrink below
         its content: min-height:0 / min-width:0 everywhere it matters. Without
         them the panel grows with the content, the ancestor clips it, and the
         focused row walks off-screen while scrollTop stays 0. */
      /* HERO ---------------------------------------------------------------- */
      /* Fixed 264px height (183px content + 21px padding on both sides); the
         hero is never content-sized, so showing/patching it can never resize
         the body below. Glass card: #0D0D0D at 0.86 + 1px white hairline. */
      .live-hero { flex-shrink: 0; display: flex; align-items: stretch; gap: 20px; margin: 20px 36px 16px 84px; background: rgba(13,13,13,0.86); border: 1px solid rgba(255,255,255,0.12); border-radius: 30px; padding: 21px 27px; box-sizing: border-box; height: 152px; position: relative; overflow: hidden; }
      .live-hero.is-hidden { display: none; }
      /* Compact text block: vertical centre in the fixed panel; the freed
         height (Down from 264px with the logo + preview boxes) flows to the
         channel list below. */
      .live-hero-main { display: flex; align-items: center; flex: 1; min-width: 0; min-height: 0; }
      .live-hero-meta { flex: 1; min-width: 0; min-height: 0; }
      /* Channel line: the number, 19.5px muted. */
      .live-hero-number { font-size: 19.5px; line-height: 24px; height: 24px; font-weight: 700; color: #808080; }
      /* Title: the channel name, 42px ExtraBold, exactly one line. */
      .live-hero-name { font-size: 42px; font-weight: 800; line-height: 48px; height: 48px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-hero-source { font-size: 19.5px; line-height: 24px; height: 24px; color: #B3B3B3; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-hero-actions { position: absolute; top: 21px; right: 27px; display: flex; gap: 14px; }
      /* Gear/search control: 51x51, radius 15. */
      .live-pill { display: inline-flex; align-items: center; justify-content: center; width: 51px; height: 51px; background: rgba(13,13,13,0.66); border: 0; border-radius: 15px; color: #B3B3B3; font-size: 19.5px; outline: none; cursor: pointer; box-sizing: border-box; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); }
      .live-pill.focused { outline: 2px solid #FFFFFF; outline-offset: -2px; background: #303030; color: #FFFFFF; }
      /* 16:9 preview box REMOVED (it existed to show the channel image). The
         freed height flows to the body below; no image css remains at all. */
      /* BODY: narrow LEFT RAIL + channel rows on the right ------------------- */
      /* Screen padding: 84px left, 36px right. */
      .live-body { flex: 1; min-height: 0; min-width: 0; display: flex; gap: 20px; padding: 0 36px 24px 84px; box-sizing: border-box; }
      /* The rail is a FIXED 285px column (never a %), and position:relative
         makes it the offsetParent of its rows so their offsets can be cached
         once per real render. */
      .live-rail { flex: 0 0 285px; min-width: 0; min-height: 0; overflow-y: auto; scroll-behavior: auto; position: relative; display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; transition: opacity 120ms ease; }
      .live-rail.is-dimmed { opacity: 0.45; }
      /* Rail tiles: search 45px, group tile 51px, playlist header 48px — all
         fixed. Idle: #0D0D0D at 0.66 + inner hairline; focus: #303030 fill
         plus a 2px white ring painted INSIDE (no scale, no layout change). */
      .live-rail-row { flex-shrink: 0; display: flex; align-items: center; gap: 14px; height: 51px; background: rgba(13,13,13,0.66); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); border-radius: 18px; padding: 0 15px 0 18px; outline: 2px solid transparent; outline-offset: -2px; cursor: pointer; box-sizing: border-box; overflow: hidden; }
      .live-rail-row.focused { outline-color: #FFFFFF; background: #303030; }
      /* Selected-but-unfocused rail row: 1px ring at alpha 0.8. */
      .live-rail-row.is-selected { box-shadow: inset 0 0 0 1px rgba(245,245,245,0.8); }
      .live-rail-search { height: 45px; }
      .live-rail-icon { flex-shrink: 0; font-size: 21px; line-height: 24px; color: #B3B3B3; }
      .live-rail-label { flex: 1; min-width: 0; font-size: 21px; line-height: 24px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-rail-count { flex-shrink: 0; font-size: 18px; line-height: 22px; color: #808080; }
      .live-rail-row.focused .live-rail-count { color: #B3B3B3; }
      /* The on-screen keyboard replaces the old IME-over-the-pill approach:
         the TV's system IME never attached in this widget and typed text was
         invisible. The panel is FIXED SIZE, the query line has a FIXED height
         and every key has a FIXED size, so typing can never reflow anything. */
      .live-keyboard { position: absolute; left: 84px; top: 224px; width: 560px; height: 350px; background: rgba(13,13,13,0.95); border: 1px solid rgba(255,255,255,0.12); border-radius: 24px; padding: 18px 24px; box-sizing: border-box; z-index: 3; display: flex; flex-direction: column; gap: 14px; }
      /* Fixed-height query line: exactly what has been typed, plus a blinking
         caret after the text, or the placeholder while empty. */
      .live-keyboard-query { flex-shrink: 0; display: flex; align-items: center; height: 48px; padding: 0 4px; box-sizing: border-box; }
      .live-keyboard-text { flex-shrink: 0; font-size: 21px; line-height: 24px; font-weight: 700; color: #FFFFFF; white-space: nowrap; overflow: hidden; max-width: 460px; }
      .live-keyboard-caret { flex-shrink: 0; width: 3px; height: 28px; margin-left: 2px; background: #F5C400; animation: live-caret-blink 1.1s linear infinite; }
      @keyframes live-caret-blink { 0%, 50% { opacity: 1; } 50.001%, 100% { opacity: 0; } }
      .live-keyboard-placeholder { font-size: 19.5px; line-height: 24px; color: #808080; }
      .live-keyboard-query.has-text .live-keyboard-placeholder { display: none; }
      /* The key grid is the keyboard's scroll panel: shrinkable, and its keys
         are registered in the cached layout metrics like every other panel. */
      .live-keyboard-grid { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; position: relative; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; }
      .live-keyboard-row { flex-shrink: 0; display: flex; gap: 8px; }
      .live-key { flex-shrink: 0; display: flex; align-items: center; justify-content: center; height: 44px; background: rgba(13,13,13,0.66); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); border-radius: 12px; outline: 2px solid transparent; outline-offset: -2px; font-size: 19.5px; line-height: 24px; font-weight: 700; color: #B3B3B3; box-sizing: border-box; cursor: pointer; }
      .live-key.focused { outline-color: #FFFFFF; background: #303030; color: #FFFFFF; }
      .live-key.is-char { width: 48px; }
      .live-key.is-digit { width: 44px; }
      .live-key.is-space { width: 140px; font-size: 15px; }
      .live-key.is-backspace, .live-key.is-clear, .live-key.is-done { width: 116px; font-size: 15px; }
      .live-source-header { height: 48px; }
      .live-source-chevron { flex-shrink: 0; width: 22px; font-size: 19.5px; line-height: 24px; color: #808080; transition: transform 120ms ease; }
      .live-rail-category { margin-left: 26px; height: 51px; }
      .live-rail-category .live-rail-label { font-weight: 500; font-size: 21px; color: #B3B3B3; }
      /* CHANNEL ROWS (right side) ------------------------------------------- */
      .live-channel-list { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; scroll-behavior: auto; position: relative; display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; }
      /* Virtualization spacers: invisible flex children that hold the scroll
         height of the rows OUTSIDE the window (heights set by the window
         sync, from the pure spacer arithmetic). No size, no background: the
         scrollbar and the scroll position stay exactly where the full list
         would put them. */
      .live-list-spacer { flex-shrink: 0; width: 100%; }
      /* Fixed row pitch 57px: tile 51px + 6px gap. Inner padding 15px; the
         2-line-clamped 21px name, the muted meta line and the star live
         INSIDE the fixed tile — long text can never grow the row. No logo
         box: the name gets the row's full width. */
      .live-channel-row { flex-shrink: 0; display: flex; align-items: center; gap: 14px; height: 51px; background: rgba(13,13,13,0.66); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); border-radius: 18px; padding: 0 15px; outline: 2px solid transparent; outline-offset: -2px; cursor: pointer; box-sizing: border-box; overflow: hidden; }
      .live-channel-row.focused { outline-color: #FFFFFF; background: #303030; }
      .live-row-text { flex: 1; min-width: 0; min-height: 0; }
      /* Fixed line-height + a 2-line clamp: long channel names read fully
         enough without ever changing the row's fixed geometry. */
      .live-row-name { font-size: 21px; line-height: 24px; max-height: 48px; font-weight: 700; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: break-word; }
      .live-row-meta { display: flex; align-items: baseline; gap: 8px; margin-top: 2px; min-width: 0; }
      .live-row-number { flex-shrink: 0; font-size: 15px; line-height: 18px; color: #808080; }
      .live-row-source { font-size: 15px; line-height: 18px; color: #808080; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-star { flex-shrink: 0; width: 39px; height: 39px; background: transparent; border: 0; outline: none; cursor: pointer; font-size: 24px; line-height: 1; color: #808080; padding: 0; }
      .live-star .live-star-glyph { visibility: hidden; }
      .live-channel-row:hover .live-star .live-star-glyph, .live-star.focused .live-star-glyph { visibility: visible; }
      .live-star.is-favorite { color: #FFD700; }
      .live-star.is-favorite .live-star-glyph { visibility: visible; }
      .live-star.focused { outline: 2px solid #FFFFFF; outline-offset: -2px; border-radius: 10px; }
      .live-panel-state { display: flex; align-items: center; gap: 12px; color: #808080; font-size: 19.5px; padding: 20px 4px; }
      .live-panel-error, .live-panel-hint { color: #808080; font-size: 19.5px; padding: 20px 4px; overflow-wrap: anywhere; }
      .live-panel-error { color: #ffb4a8; }
      .live-notice { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 70%; background: rgba(13,13,13,0.95); border: 1px solid #333333; border-radius: 10px; padding: 12px 18px; font-size: 15px; color: #FFFFFF; overflow-wrap: anywhere; z-index: 2; }
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
            ${this.keyboardOpen ? this.renderKeyboard() : ""}
            ${this.notice ? `<div class="live-notice" role="status">${escapeHtml(this.notice)}</div>` : ""}
          </div>
        `;
        this.container.innerHTML = shellMarkup;

        this.prepareChannelWindow();

        ScreenUtils.indexFocusables(this.container);
        this.applyFocusState();
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
        this.applyFocusState();
      } catch (_) {
        // Nothing more can be done without a working DOM.
      }
    },

    // HERO -------------------------------------------------------------------
    // Hidden while nothing is selected; shows the focused/highlighted channel
    // as a compact text block: number (19.5px), name as 42px ExtraBold
    // one-line title, source line, plus the search control. No logo box, no
    // 16:9 preview, no image of any kind.
    // Every patchable field is ALWAYS present, so a focus move can update the
    // hero purely in place — see updateHeroForFocus.
    renderHero() {
      try {
        const channel = this.heroChannel || null;
        const hidden = channel ? "" : " is-hidden";
        const label = formatChannelRowLabel(channel || {});
        const source = channel ? sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group) : "";
        const number = label.number ? label.number.replace(/\.$/, "") : "";
        return `
          <section class="live-hero${hidden}" aria-hidden="${channel ? "false" : "true"}">
            <div class="live-hero-main">
              <div class="live-hero-meta">
                <div class="live-hero-number" data-hero-field="number">${escapeHtml(number)}</div>
                <h1 class="live-hero-name" data-hero-field="name">${escapeHtml(label.name)}</h1>
                <div class="live-hero-source" data-hero-field="source">${escapeHtml(source)}</div>
              </div>
            </div>
            <div class="live-hero-actions">
              <div class="live-pill focusable" data-action="openSearch" role="button" aria-label="${escapeHtml(t("live_search_open", {}, "Buscar canales"))}">⌕</div>
            </div>
          </section>
        `;
      } catch (error) {
        reportLiveErrorSafe(error, "renderHero");
        return `<section class="live-hero is-hidden" aria-hidden="true"></section>`;
      }
    },

    // Patch the hero fields in place for a newly focused/highlighted channel.
    // Never a re-render, never a re-measure, never a restructure: focus moves
    // only write textContent into nodes that already exist from the last real
    // render.
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
        const source = sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group);
        const number = label.number ? label.number.replace(/\.$/, "") : "";
        const numberNode = hero.querySelector('[data-hero-field="number"]');
        if (numberNode) numberNode.textContent = number;
        const nameNode = hero.querySelector('[data-hero-field="name"]');
        if (nameNode) nameNode.textContent = label.name;
        const sourceNode = hero.querySelector('[data-hero-field="source"]');
        if (sourceNode) sourceNode.textContent = source;
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
                </div>
              `;
            }
            if (item.type === "source") {
              const expanded = item.expanded !== false;
              // ONLY the header here: the category rows are separate items in
              // the flat model below and are rendered exactly once each.
              // Emitting them inline too duplicated every row in the DOM and
              // desynchronised data-rail-index from the model after every
              // surgical toggle — the root cause of the stuck rail movement.
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
              `;
            }
            if (item.type === "category") {
              return this.renderRailCategory(item, index);
            }
            // favorites / recents (fixed rows)
            return `
              <div class="live-rail-row focusable"
                   role="button"
                   data-action="selectRail"
                   data-rail-id="${escapeHtml(item.railId)}"
                   data-rail-index="${index}">
                <span class="live-rail-icon" aria-hidden="true">${item.type === "favorites" ? "★" : "↺"}</span>
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
    // The flat rail model for the CURRENT state. Rail counts come from the
    // generated catalog index (this.catalogCounts) — no portal call.
    railItems() {
      return buildRailItems({
        categories: this.categories,
        channelsByColumn: this.channelsByColumn,
        catalogCounts: this.catalogCounts instanceof Map ? this.catalogCounts : new Map(),
        favoriteCount: this.favoriteSet?.size
          ? this.unionCachedChannels().filter((channel) => this.favoriteSet.has(String(channel?.id))).length
          : 0,
        recentCount: Array.isArray(this.recentChannels) ? this.recentChannels.length : 0
      });
    },

    // Writes a rail focus index and remembers WHICH item (by railId) the index
    // points at, so any later change of the item list (counts arriving,
    // recents appearing, a source collapsing) can re-derive the index by
    // identity instead of leaving a stale number behind.
    setRailFocusIndex(index) {
      const items = this.railItems();
      this.railIndex = clampIndex(index, items.length);
      this.railFocusId = items[this.railIndex]?.railId ?? null;
      return this.railIndex;
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

    // ON-SCREEN KEYBOARD -----------------------------------------------------
    // The deterministic search keyboard (no system IME, no input field): a
    // fixed-size panel with the query line and the key grid. Keys are
    // .focusable nodes with data-key-index, found by the same focus machinery
    // as the rail and the channel rows.
    renderKeyboard() {
      try {
        const view = queryLineView(this.searchQuery);
        const rowsMarkup = buildKeyboardLayout()
          .map((row, rowIndex) => {
            const keysMarkup = row
              .map((key) => {
                const entry = KEYBOARD_KEYS.find((candidate) => candidate.key.id === key.id);
                const index = entry ? KEYBOARD_KEYS.indexOf(entry) : 0;
                return `<div class="live-key focusable is-${key.type === "char" ? (/[0-9]/.test(key.value) ? "digit" : "char") : key.type}"
                             role="button"
                             data-action="keyboardKey"
                             data-key-index="${index}"
                             data-key-type="${escapeHtml(key.type)}"
                             data-key-value="${escapeHtml(key.value)}">${escapeHtml(key.label)}</div>`;
              })
              .join("");
            return `<div class="live-keyboard-row" data-keyboard-row="${rowIndex}">${keysMarkup}</div>`;
          })
          .join("");
        return `
          <div class="live-keyboard" role="dialog" aria-label="${escapeHtml(t("live_search_open", {}, "Buscar canales"))}">
            <div class="live-keyboard-query${view.text ? " has-text" : ""}"><span class="live-keyboard-text" data-keyboard-field="query-text">${escapeHtml(view.text)}</span><span class="live-keyboard-caret" aria-hidden="true"></span><span class="live-keyboard-placeholder" data-keyboard-field="query-placeholder">${escapeHtml(view.placeholder)}</span></div>
            <div class="live-keyboard-grid">${rowsMarkup}</div>
          </div>
        `;
      } catch (error) {
        reportLiveErrorSafe(error, "renderKeyboard");
        return "";
      }
    },

    // Typing must be visible immediately WITHOUT a re-render: patch the query
    // line in place (textContent + one class), exactly like the hero patch.
    updateKeyboardQueryLine() {
      try {
        const line = this.container?.querySelector(".live-keyboard-query");
        if (!line) return;
        const view = queryLineView(this.searchQuery);
        const textNode = line.querySelector('[data-keyboard-field="query-text"]');
        if (textNode) textNode.textContent = view.text;
        const placeholderNode = line.querySelector('[data-keyboard-field="query-placeholder"]');
        if (placeholderNode) placeholderNode.textContent = view.placeholder;
        line.classList.toggle("has-text", Boolean(view.text));
      } catch (error) {
        reportLiveErrorSafe(error, "updateKeyboardQueryLine");
      }
    },

    // Deterministic zone/index normalization: clamps every index to the real
    // item count and bounces impossible zones back to a reachable one so no
    // state can dead-end the D-pad (loading, empty category, error).
    normalizeFocusState() {
      if (this.focusZone === "keyboard") {
        // The keyboard keys are a fixed set: the index always clamps into it.
        this.keyboardIndex = clampIndex(Number.isInteger(this.keyboardIndex) ? this.keyboardIndex : 0, KEYBOARD_KEY_COUNT);
        return;
      }
      if (this.focusZone === "hero") {
        // The hero has a single control (search); one index, always 0.
        if (!this.heroChannel) {
          this.focusZone = "rail";
        } else {
          this.heroIndex = clampIndex(this.heroIndex || 0, 1);
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
      // Re-derive the rail index by IDENTITY every time the list could have
      // changed (a render, counts arriving, recents appearing or disappearing,
      // a source collapsing): a bare index silently points at the wrong row.
      const items = this.railItems();
      const focusedId = String(this.railFocusId ?? "");
      let sourceRailId = "";
      if (focusedId.startsWith("cat:")) {
        const owner = items.find(
          (item) =>
            item.type === "source" &&
            (Array.isArray(item.categories) ? item.categories : []).some((category) => category.railId === focusedId)
        );
        sourceRailId = owner?.railId ?? "";
      }
      this.railIndex = railFocusAfterChange(items, Number.isInteger(this.railIndex) ? this.railIndex : 0, {
        railId: focusedId,
        sourceRailId
      });
      this.railFocusId = items[this.railIndex]?.railId ?? null;
    },

    // Applies the deterministic focus state to the DOM: marks the focused
    // node and gives it real DOM focus with the browser's NATIVE reveal —
    // plain focus() with the default scrolling, exactly like the rest of the
    // app. No preventScroll, no manual scrollTop, no animation. This MUST
    // stay cheap: class toggles plus one focus() call, never a re-render.
    applyFocusState() {
      try {
        this.normalizeFocusState();
        // Virtualized rows: the focused row's node must EXIST before focus
        // is applied below. The window sync anchors on the focused row (mode
        // "focus"), so the node is in the DOM at its absolute position and
        // the plain focus() reveal scrolls it into view natively — including
        // when focus arrives from the selection memory after a player, and
        // when the window is recomputed on data arrival.
        if (this.focusZone === "rows") {
          this.syncChannelWindow({ focusIndex: this.rowIndex, mode: "focus" });
        }
        const target = this.focusedNode();
        this.container?.querySelectorAll(".focusable.focused").forEach((node) => {
          if (node !== target) node.classList.remove("focused");
        });
        if (target) {
          target.classList.add("focused");
          // Native reveal: the browser scrolls the focused element into view
          // in the same operation. The rail, the channel list and the keyboard
          // grid are all overflow-y:auto panels, so focus() handles them.
          try {
            target.focus();
          } catch (_) {
            // Focus is best effort on constrained TV engines.
          }
        }
        // Selected-but-unfocused rail row: a 1px ring marks the active source
        // (class toggle only — never a re-render, never a layout change).
        const selectionId = String(this.railSelection ?? "");
        this.container?.querySelectorAll(".live-rail-row").forEach((node) => {
          node.classList.toggle("is-selected", Boolean(selectionId) && node.dataset.railId === selectionId);
        });
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
      if (this.focusZone === "keyboard") {
        const keys = this.container.querySelectorAll(".live-keyboard-grid .focusable");
        return keys[this.keyboardIndex || 0] || keys[0] || null;
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
    // (full-width 2-line-clamped name, `N. Nombre`, muted source, star).
    // No logo box: nothing on this screen loads an image. States
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
          return this.renderWindowedListMarkup();
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
        return this.renderWindowedListMarkup();
      } catch (error) {
        reportLiveErrorSafe(error, "renderChannelList");
        return `<div class="live-channel-list"><div class="live-panel-error">Live TV error</div></div>`;
      }
    },

    // The windowed list shell. The rows themselves are painted by
    // syncChannelWindow (a fixed pool of nodes between two spacers), never
    // inline: with 500 channels only the window ever exists in the DOM.
    renderWindowedListMarkup() {
      return `<div class="live-channel-list" data-virtual-list="true"></div>`;
    },

    // The row's inner markup: the 2-line-clamped name, the muted number +
    // source line and the favourite star — the existing row design, no logo
    // box, nothing on this screen loads an image. Shared by the pooled-node
    // filler so a recycled row renders exactly like a fresh one.
    renderChannelRowInner(channel) {
      const label = formatChannelRowLabel(channel);
      const isFavorite = this.isFavoriteId(channel?.id);
      const source = sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group);
      return `
        <div class="live-row-text">
          <div class="live-row-name">${escapeHtml(label.name)}</div>
          <div class="live-row-meta">${label.number ? `<span class="live-row-number">${escapeHtml(label.number)}</span>` : ""}${source ? `<span class="live-row-source">${escapeHtml(source)}</span>` : ""}</div>
        </div>
        <button class="live-star focusable${isFavorite ? " is-favorite" : ""}"
                data-action="toggleFavorite"
                data-channel-id="${escapeHtml(String(channel?.id || ""))}"
                aria-label="${escapeHtml(t("live_favorite_toggle", {}, "Favorito"))}"
                aria-pressed="${isFavorite ? "true" : "false"}">
          <span class="live-star-glyph" aria-hidden="true">${isFavorite ? "★" : "☆"}</span>
        </button>
      `;
    },

    // Swaps a pooled row node's content for another channel: the article
    // node is REUSED, only its dataset and children change. This is the
    // recycling primitive — a scroll step never creates or destroys nodes
    // once the pool is warm. The tabindex is stamped here because pooled
    // nodes can also be freshly CREATED by the window sync mid-navigation
    // (pool growth), where no ScreenUtils.indexFocusables pass runs: without
    // the stamp the node is not focusable, focus() is a silent no-op and the
    // native reveal never happens — the ring walks off-screen and the press
    // is dead (the recycled row must render exactly like a fresh one).
    fillChannelRowNode(node, channel, index = 0) {
      node.className = "live-channel-row focusable";
      node.tabIndex = 0;
      node.setAttribute("data-action", "tuneIn");
      node.setAttribute("data-row-index", String(Number(index) || 0));
      node.setAttribute("data-channel-id", String(channel?.id || ""));
      node.setAttribute("data-channel-title", String(channel?.name || t("live_channel_fallback_title", {}, "Live channel")));
      node.innerHTML = this.renderChannelRowInner(channel);
      return node;
    },

    // VIRTUAL WINDOW SYNC --------------------------------------------------
    // Paints the current window into the list: spacers first (exact scroll
    // height), then the fixed pool of row nodes. A window move RECYCLES: a
    // pooled node whose row left the window is refilled with an entering row
    // (content swap), so per scroll step no nodes are created or destroyed
    // in the steady state. The recompute is arithmetic only — the viewport
    // height is measured once per data change (prepareChannelWindow), the
    // row pitch is a fixed constant — and it NEVER touches focus: the
    // focused row is forced inside the window, its node survives, and DOM
    // focus stays exactly where it was.
    syncChannelWindow({ focusIndex = -1, mode = "scroll" } = {}) {
      try {
        const list = this.container?.querySelector('.live-channel-list[data-virtual-list="true"]');
        if (!list) return;
        const rows = this.visibleChannels();
        const total = Array.isArray(rows) ? rows.length : 0;
        if (!total) {
          this._virtualWindow = null;
          return;
        }
        // Measure ONCE per data change (the pending flag is set by
        // prepareChannelWindow); scrolling only ever does arithmetic below.
        if (this._virtualMeasurePending) {
          this._virtualViewportHeight = list.clientHeight > 0 ? list.clientHeight : LIVE_LIST_VIEWPORT_FALLBACK;
          this._virtualMeasurePending = false;
          this._virtualWindow = null;
        }
        const window = computeChannelWindow({
          total,
          scrollTop: list.scrollTop || 0,
          viewportHeight: this._virtualViewportHeight || LIVE_LIST_VIEWPORT_FALLBACK,
          focusIndex,
          mode
        });
        const previous = this._virtualWindow;
        if (previous && previous.start === window.start && previous.end === window.end && previous.total === total) {
          return; // same window: zero DOM work for this scroll step
        }
        const spacers = channelSpacerHeights({ start: window.start, end: window.end, total });
        const topSpacer = this.applyChannelSpacer(list, "top", spacers.topSpacerHeight);
        const bottomSpacer = this.applyChannelSpacer(list, "bottom", spacers.bottomSpacerHeight);

        // Recycle: keep every pooled node whose row is still in the window;
        // fill the others with the entering rows.
        const existing = new Map();
        list.querySelectorAll(".live-channel-row").forEach((node) => {
          existing.set(Number(node.dataset.rowIndex), node);
        });
        const recycled = [];
        existing.forEach((node, index) => {
          if (!(index >= window.start && index < window.end)) recycled.push(node);
        });
        let recycleCursor = 0;
        const ordered = [];
        for (let index = window.start; index < window.end; index += 1) {
          let node = existing.get(index);
          if (!node) {
            node = recycled[recycleCursor];
            if (node) {
              recycleCursor += 1;
            } else {
              // Pool growth only (first paint, or a wider window): the node
              // then stays pooled for the screen's lifetime.
              node = document.createElement("article");
              node.className = "live-channel-row focusable";
            }
            this.fillChannelRowNode(node, rows[index], index);
          }
          ordered.push(node);
        }
        // Surplus nodes exist only when the window shrinks at a list end.
        for (; recycleCursor < recycled.length; recycleCursor += 1) {
          recycled[recycleCursor].remove();
        }
        // Ascending DOM order between the spacers — the classic minimal-move
        // reorder: a node already at its expected slot is left untouched.
        let anchor = topSpacer ? topSpacer.nextSibling : list.firstChild;
        for (const node of ordered) {
          if (node === anchor) {
            anchor = node.nextSibling;
          } else {
            list.insertBefore(node, anchor);
          }
        }
        this._virtualWindow = { start: window.start, end: window.end, total };
      } catch (error) {
        reportLiveErrorSafe(error, "syncChannelWindow");
      }
    },

    // Creates, sizes or removes one scroll spacer. Height 0 means ABSENT: a
    // zero-height flex child would still contribute a phantom gap and shift
    // the rows by the gap width.
    applyChannelSpacer(list, which, height) {
      const existing = list.querySelector(`[data-spacer="${which}"]`);
      if (!height || height <= 0) {
        existing?.remove();
        return null;
      }
      let spacer = existing;
      if (!spacer) {
        spacer = document.createElement("div");
        spacer.className = "live-list-spacer";
        spacer.setAttribute("data-spacer", which);
        spacer.setAttribute("aria-hidden", "true");
        if (which === "top") list.insertBefore(spacer, list.firstChild);
        else list.appendChild(spacer);
      }
      spacer.style.height = `${height}px`;
      return spacer;
    },

    // Scroll-path recompute (remote, wheel, any native scroll): arithmetic
    // plus a content swap of the entering rows only. It never calls
    // applyFocusState and never calls focus() — the recompute cannot steal
    // focus.
    channelListScrollHandler() {
      if (!this._onChannelListScroll) {
        this._onChannelListScroll = () => {
          this.syncChannelWindow({
            focusIndex: this.focusZone === "rows" ? this.rowIndex : -1,
            mode: "scroll"
          });
        };
      }
      return this._onChannelListScroll;
    },

    // After a real render or an in-place data refresh: measures the scroll
    // container ONCE (the row pitch is a fixed constant of the layout
    // contract), restores a pending scroll position, binds the passive
    // scroll listener and paints the initial window — anchored on the
    // focused row whenever focus is in the rows, so a restored selection
    // from the player's selection memory always has its row in the DOM.
    prepareChannelWindow() {
      try {
        const list = this.container?.querySelector(".live-channel-list");
        if (!list || !list.hasAttribute("data-virtual-list")) return;
        this._virtualMeasurePending = true;
        this._virtualWindow = null;
        if (this._virtualPendingScrollTop != null) {
          list.scrollTop = Math.max(0, Number(this._virtualPendingScrollTop) || 0);
          this._virtualPendingScrollTop = null;
        }
        if (!list.dataset.virtualScrollBound) {
          list.dataset.virtualScrollBound = "true";
          // Removal is guaranteed by cleanup(): it explicitly removes this
          // handler from the live list node (same memoized function ref), so
          // a teardown can never leak the binding.
          list.addEventListener("scroll", this.channelListScrollHandler(), { passive: true });
        }
        this.syncChannelWindow({
          focusIndex: this.focusZone === "rows" ? this.rowIndex : -1,
          mode: "focus"
        });
      } catch (error) {
        reportLiveErrorSafe(error, "prepareChannelWindow");
      }
    },

    // In-place refresh of the rail counts and the channel list only (data
    // arrival, search typing, favourite toggles, recent updates). Focus
    // movement never goes through here: it toggles classes directly so a
    // keypress costs no re-render.
    updateRowsOnly() {
      if (!this.container) return;
      try {
        const list = this.container.querySelector(".live-channel-list");
        // When the current list is the windowed one, its scrollTop is the
        // position to keep across the refresh. When it is NOT (loading / error
        // panel — e.g. a foreground restore refetching a released selection),
        // a pending scroll restore is preserved instead of overwritten with 0.
        const previousScrollTop = list?.hasAttribute?.("data-virtual-list") ? (list?.scrollTop ?? 0) : (this._virtualPendingScrollTop ?? 0);
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
          // The scrollTop is restored AFTER insertion (a detached node has no
          // scroll position): the window sync reads it back so the scroll
          // position stays exactly where it was across the data refresh.
          this._virtualPendingScrollTop = previousScrollTop;
          list.replaceWith(nextList);
        } else if (nextList) {
          this.container.querySelector(".live-body")?.appendChild(nextList);
        }
        this.prepareChannelWindow();
        ScreenUtils.indexFocusables(this.container);
        this.applyFocusState();
        this.updateHeroForFocus({ force: true });
      } catch (error) {
        reportLiveErrorSafe(error, "updateRowsOnly");
      }
    }
  };
}
