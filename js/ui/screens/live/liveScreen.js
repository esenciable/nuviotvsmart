import { Router } from "../../navigation/routerState.js";
import { ScreenUtils } from "../../navigation/screen.js";
import { Environment } from "../../../platform/environment.js";
import { I18n } from "../../../i18n/index.js";
import { renderLoadingIndicator } from "../../components/loadingIndicator.js";
import { liveRepository } from "../../../data/repository/liveRepository.js";

import { createLiveScreenMethods01 } from "./liveScreenMethods-01-mount-and-load.js";
import { createLiveScreenMethods02 } from "./liveScreenMethods-02-render.js";
import { createLiveScreenMethods03 } from "./liveScreenMethods-03-tune-in.js";

export {
  Router,
  ScreenUtils,
  Environment,
  renderLoadingIndicator,
  liveRepository,
  isBackEvent,
  escapeHtml,
  t
};

// Pure layout helpers live in the render module; they are re-exported here
// so the sibling method modules can reach them through `internals` and the
// layout tests can import them directly.
export {
  RAIL_SEARCH_ID,
  RAIL_FAVORITES_ID,
  RAIL_RECENTS_ID,
  categoryRailId,
  sourceRailIdFromColumnId,
  RECENTS_STORAGE_KEY,
  MAX_RECENT_CHANNELS,
  readRecentChannels,
  writeRecentChannels,
  pushRecentChannel,
  buildRailItems,
  collapsedSourceIdsRef,
  isSourceExpanded,
  toggleSourceCollapsed,
  FAVORITES_STORAGE_KEY,
  sourceNameFromChannelId,
  sourceNameFromColumnId,
  formatChannelRowLabel,
  normalizeSearchText,
  channelMatchesQuery,
  GENERIC_CATEGORY_NAME,
  isGenericCategoryName,
  isUsableCatalogIndex,
  catalogCountsFromIndex,
  leftoverChannelsFromIndex,
  findGenericCategory,
  buildKeyboardLayout,
  keyboardFlatKeys,
  keyboardMove,
  applyKeyboardKey,
  queryLineView,
  KEYBOARD_KEYS,
  KEYBOARD_KEY_COUNT,
  KEYBOARD_MAX_QUERY,
  KEYBOARD_QUERY_PLACEHOLDER,
  readFavoriteIds,
  writeFavoriteIds,
  toggleFavoriteId,
  clampIndex,
  LIVE_ROW_HEIGHT,
  LIVE_ROW_GAP,
  LIVE_ROW_PITCH,
  LIVE_VIRTUAL_BUFFER,
  LIVE_LIST_VIEWPORT_FALLBACK,
  computeChannelWindow,
  channelSpacerHeights,
  LIVE_SELECTION_STORAGE_KEY,
  rememberLiveSelection,
  readRememberedLiveSelection,
  forgetLiveSelection,
  resolveLiveSelectionRestore,
  planBackgroundCacheRelease,
  retainedLightState,
  planForegroundRestore
} from "./liveScreenMethods-02-render.js";

function isBackEvent(event) {
  return Environment.isBackEvent(event);
}

// The generated Magis catalog index (rail counts + the generic catalogue's
// leftovers), computed OFFLINE by `npm run catalog:index` and shipped as a
// static JSON next to the Magis client modules. Dynamic import with a
// graceful fallback: an absent or unreadable file resolves to null and the
// screen degrades (counts "…", generic catalogue fetched on demand) — it
// never crashes and never blocks the module load. One promise per session:
// the index is static, it is never re-fetched.
let catalogIndexPromise = null;
export function loadCatalogIndex() {
  if (!catalogIndexPromise) {
    catalogIndexPromise = import("../../../core/magis/catalog-index.json", {
      with: { type: "json" }
    })
      .then((mod) => (mod && mod.default) || null)
      .catch(() => null);
  }
  return catalogIndexPromise;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function t(key, params = {}, fallback = key) {
  return I18n.t(key, params, { fallback });
}

export const LiveScreen = {
  ...createLiveScreenMethods01(),
  ...createLiveScreenMethods02(),
  ...createLiveScreenMethods03()
};
