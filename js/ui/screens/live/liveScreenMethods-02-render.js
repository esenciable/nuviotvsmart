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

// Fluidity: held-key auto-repeat must advance the list at a steady cadence
// instead of queuing behind the scroll animation. A repeat faster than the
// cadence is dropped.

// Rendering ----------------------------------------------------------------

export function createLiveScreenMethods02() {
  const { ScreenUtils, renderLoadingIndicator, escapeHtml, t, Router } = internals;

  const STYLE = `
    <style id="live-screen-style">
      /* STATIC LAYOUT CONTRACT (measured from the Android TV reference, dp x1.5):
         every box has a fixed size. Nothing may resize on focus — a keypress
         only toggles classes, writes hero text/src and lets the browser
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
      .live-hero { flex-shrink: 0; display: flex; align-items: stretch; gap: 20px; margin: 20px 36px 16px 84px; background: rgba(13,13,13,0.86); border: 1px solid rgba(255,255,255,0.12); border-radius: 30px; padding: 21px 27px; box-sizing: border-box; height: 264px; position: relative; overflow: hidden; }
      .live-hero.is-hidden { display: none; }
      .live-hero-main { display: flex; align-items: center; gap: 20px; flex: 1; min-width: 0; min-height: 0; }
      .live-hero-logo { position: relative; width: 96px; height: 102px; border-radius: 15px; background: rgba(13,13,13,0.66); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); overflow: hidden; flex-shrink: 0; }
      .live-hero-logo-initial { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 42px; font-weight: 700; color: #808080; }
      /* Late-loading logos are reserved a fixed box; the 64px image fills it
         with object-fit: contain so decode time can never shift anything. */
      .live-hero-logo img { position: absolute; top: 0; right: 0; bottom: 0; left: 0; margin: auto; width: 64px; height: 64px; object-fit: contain; }
      .live-hero-logo img.is-broken, .live-hero-logo img.is-hidden { display: none; }
      .live-hero-meta { flex: 1; min-width: 0; min-height: 0; }
      /* Channel line: number + channel name, 19.5px muted. */
      .live-hero-topline { display: flex; align-items: baseline; gap: 10px; }
      .live-hero-number { font-size: 19.5px; line-height: 24px; height: 24px; font-weight: 700; color: #808080; }
      .live-hero-channel { font-size: 19.5px; line-height: 24px; height: 24px; color: #B3B3B3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* Title: the channel name, 42px ExtraBold, exactly one line. */
      .live-hero-name { font-size: 42px; font-weight: 800; line-height: 48px; height: 48px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-hero-source { font-size: 19.5px; line-height: 24px; height: 24px; color: #B3B3B3; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .live-hero-actions { position: absolute; top: 21px; right: 27px; display: flex; gap: 14px; }
      /* Gear/search control: 51x51, radius 15. */
      .live-pill { display: inline-flex; align-items: center; justify-content: center; width: 51px; height: 51px; background: rgba(13,13,13,0.66); border: 0; border-radius: 15px; color: #B3B3B3; font-size: 19.5px; outline: none; cursor: pointer; box-sizing: border-box; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); }
      .live-pill.focused { outline: 2px solid #FFFFFF; outline-offset: -2px; background: #303030; color: #FFFFFF; }
      /* 16:9 preview box: fixed 325x183, radius 18; the logo sits centred. We
         have no frame source, so no fake thumbnail is ever drawn. */
      .live-hero-preview { flex-shrink: 0; width: 325px; height: 183px; border-radius: 18px; background: rgba(13,13,13,0.66); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
      .live-hero-preview img { width: 100%; height: 100%; object-fit: contain; }
      .live-hero-preview img.is-broken, .live-hero-preview img.is-hidden { display: none; }
      .live-hero-preview-initial { font-size: 64px; font-weight: 700; color: #55555c; }
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
      .live-keyboard { position: absolute; left: 84px; top: 300px; width: 560px; height: 350px; background: rgba(13,13,13,0.95); border: 1px solid rgba(255,255,255,0.12); border-radius: 24px; padding: 18px 24px; box-sizing: border-box; z-index: 3; display: flex; flex-direction: column; gap: 14px; }
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
      /* Fixed row pitch 57px: tile 51px + 6px gap. Inner padding 15px; the
         62x39 logo box, the 2-line-clamped 21px name and the muted meta line
         all live INSIDE the fixed tile — long text can never grow the row. */
      .live-channel-row { flex-shrink: 0; display: flex; align-items: center; gap: 14px; height: 51px; background: rgba(13,13,13,0.66); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10); border-radius: 18px; padding: 0 15px; outline: 2px solid transparent; outline-offset: -2px; cursor: pointer; box-sizing: border-box; overflow: hidden; }
      .live-channel-row.focused { outline-color: #FFFFFF; background: #303030; }
      .live-row-logo { position: relative; width: 62px; height: 39px; border-radius: 12px; background: rgba(13,13,13,0.66); overflow: hidden; flex-shrink: 0; }
      .live-row-logo-initial { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 21px; font-weight: 700; color: #808080; }
      .live-row-logo img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
      .live-row-logo img.is-broken { display: none; }
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

        ScreenUtils.indexFocusables(this.container);
        const hasLogos = Boolean(this.container.querySelector(".live-row-logo img"));
        if (hasLogos) {
          this.logoProbeCount = (this.logoProbeCount || 0) + 1;
          if (this.logoProbeCount <= 2) {
            this.probeChannelLogos?.();
          }
        }
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
    // Hidden while nothing is selected; shows the focused/highlighted channel:
    // logo box (96x102, 64px logo), the number + channel name line (19.5px), the
    // name as 42px ExtraBold one-line title, the source line, the search
    // control and the 325x183 preview box. No EPG exists, so there is no
    // badge, no time range, no description and no "no program" line.
    // Every patchable field (and both hero <img> nodes) is ALWAYS present, so
    // a focus move can update the hero purely in place — see updateHeroForFocus.
    renderHero() {
      try {
        const channel = this.heroChannel || null;
        const hidden = channel ? "" : " is-hidden";
        const label = formatChannelRowLabel(channel || {});
        const logo = channelLogoInfo(channel || {});
        const source = channel ? sourceNameFromChannelId(channel?.id) || sourceNameFromColumnId(channel?.group) : "";
        const number = label.number ? label.number.replace(/\.$/, "") : "";
        const heroImg = (field, withSrc) =>
          `<img data-hero-field="${field}" class="${withSrc ? "" : "is-hidden"}" alt="" onerror="this.classList.add('is-broken')"${withSrc ? ` src="${escapeHtml(logo.logo)}"` : ""} />`;
        return `
          <section class="live-hero${hidden}" aria-hidden="${channel ? "false" : "true"}">
            <div class="live-hero-main">
              <div class="live-hero-logo">
                <span class="live-hero-logo-initial" data-hero-field="logo-letter" aria-hidden="true">${escapeHtml(logo.letter)}</span>
                ${heroImg("logo-img", Boolean(logo.logo))}
              </div>
              <div class="live-hero-meta">
                <div class="live-hero-topline">
                  <span class="live-hero-number" data-hero-field="number">${escapeHtml(number)}</span>
                  <span class="live-hero-channel" data-hero-field="channel">${escapeHtml(label.name)}</span>
                </div>
                <h1 class="live-hero-name" data-hero-field="name">${escapeHtml(label.name)}</h1>
                <div class="live-hero-source" data-hero-field="source">${escapeHtml(source)}</div>
              </div>
            </div>
            <div class="live-hero-actions">
              <div class="live-pill focusable" data-action="openSearch" role="button" aria-label="${escapeHtml(t("live_search_open", {}, "Buscar canales"))}">⌕</div>
            </div>
            <div class="live-hero-preview" aria-hidden="true">
              <span class="live-hero-preview-initial" data-hero-field="preview-letter" aria-hidden="true">${escapeHtml(logo.letter)}</span>
              ${heroImg("preview-img", Boolean(logo.logo))}
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
    // only write textContent, classes and an img src into nodes that already
    // exist from the last real render.
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
        const channelNode = hero.querySelector('[data-hero-field="channel"]');
        if (channelNode) channelNode.textContent = label.name;
        const nameNode = hero.querySelector('[data-hero-field="name"]');
        if (nameNode) nameNode.textContent = label.name;
        const sourceNode = hero.querySelector('[data-hero-field="source"]');
        if (sourceNode) sourceNode.textContent = source;
        this.patchHeroImage(hero, '[data-hero-field="logo-letter"]', '[data-hero-field="logo-img"]', logo);
        this.patchHeroImage(hero, '[data-hero-field="preview-letter"]', '[data-hero-field="preview-img"]', logo);
      } catch (error) {
        reportLiveErrorSafe(error, "updateHeroForFocus");
      }
    },

    // One hero image box (logo or 16:9 preview): swap the src on the node that
    // already exists and toggle visibility classes. The box itself is fixed
    // size, so a late-loading logo can never shift anything.
    patchHeroImage(hero, letterSelector, imgSelector, logo) {
      const letterNode = hero.querySelector(letterSelector);
      if (letterNode) letterNode.textContent = logo.letter;
      const imgNode = hero.querySelector(imgSelector);
      if (!imgNode) return;
      if (logo.logo) {
        if (imgNode.getAttribute("src") !== logo.logo) {
          imgNode.classList.remove("is-broken");
          imgNode.setAttribute("src", logo.logo);
        }
        imgNode.classList.remove("is-hidden");
      } else {
        imgNode.classList.remove("is-broken");
        imgNode.removeAttribute("src");
        imgNode.classList.add("is-hidden");
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
        this.applyFocusState();
        this.updateHeroForFocus({ force: true });
      } catch (error) {
        reportLiveErrorSafe(error, "updateRowsOnly");
      }
    }
  };
}
