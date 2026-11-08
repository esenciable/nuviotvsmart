// Magis LIVE repository: the single UI-facing seam for the Live TV screen.
// Wraps the proven magisLive client (created once, reusing the same Magis
// session persistence key as streamRepository) with module-level caches so the
// catalog survives leaving and re-entering the screen, and never throws to the
// UI: every entry point resolves to a { status, data | detail } shape and the
// screen decides what to render.
import {
  MAGIS_LIVE_CATEGORIES_TTL_MS,
  MAGIS_LIVE_CHANNEL_TTL_MS
} from "../../core/magis/magisLive.js";
import { createMagisVodClient } from "../../core/magis/index.js";
import { LocalStore } from "../../core/storage/localStore.js";

// Same session key as streamRepository.js: the session mints once and is
// reused across stream screens, live screens and app restarts. Do not invent a
// second key.
const MAGIS_SESSION_STORAGE_KEY = "nuvio.magis.session.v1";
const magisSessionPersistence = {
  load: () => LocalStore.get(MAGIS_SESSION_STORAGE_KEY, null),
  save: (state) => LocalStore.set(MAGIS_SESSION_STORAGE_KEY, state),
  clear: () => LocalStore.remove(MAGIS_SESSION_STORAGE_KEY)
};

export const LIVE_CHANNEL_ID_PREFIX = "magis:live:";

// EPG contract (no guide UI yet): when an XMLTV guide eventually arrives it
// attaches programmes to these channel objects by `epgChannelId`, falling back
// to `tvgId`, and then to a normalized channel name. Magis publishes no
// listings today, so both ids stay null here — the future guide only fills
// them in and never has to reshape this model.

// Stable id space for live channels inside the app: `magis:live:<code>`.
export function liveChannelId(code) {
  return `${LIVE_CHANNEL_ID_PREFIX}${String(code || "")}`;
}

export function stripLiveChannelId(idOrCode) {
  const raw = String(idOrCode || "").trim();
  return raw.startsWith(LIVE_CHANNEL_ID_PREFIX) ? raw.slice(LIVE_CHANNEL_ID_PREFIX.length) : raw;
}

// Bounds the per-category channel cache: each entry holds one category's
// assembled channel list, so a 40-category portal must not grow the map
// forever. Oldest entries (insertion order) are evicted first.
export const MAX_CACHED_CATEGORY_CHANNEL_LISTS = 12;

export function createLiveRepository({
  live = null,
  now = () => Date.now(),
  categoriesTtlMs = MAGIS_LIVE_CATEGORIES_TTL_MS,
  channelTtlMs = MAGIS_LIVE_CHANNEL_TTL_MS,
  maxCachedCategories = MAX_CACHED_CATEGORY_CHANNEL_LISTS
} = {}) {
  let clientPromise = null;
  let categoriesCache = null; // { value, expiresAt }
  const channelCache = new Map(); // columnId -> { value, expiresAt }

  const resolveLive = async () => {
    if (live && typeof live.listCategories === "function") {
      return live;
    }
    // Lazily build the full Magis client (config -> portal -> session -> vod +
    // live) exactly once, with the shared session persistence.
    if (!clientPromise) {
      clientPromise = createMagisVodClient({ persistence: magisSessionPersistence }).then(
        (client) => client.live
      );
      clientPromise.catch(() => {
        clientPromise = null; // allow a retry on the next resolution attempt
      });
    }
    return clientPromise;
  };

  const errorResult = (detail, { aborted = false } = {}) => ({
    status: "error",
    ...(aborted ? { aborted: true } : {}),
    detail: String(detail || "unknown failure")
  });

  function mapChannel(row = {}, { group = null, groupName = null } = {}) {
    const code = String(row?.code ?? "").trim();
    if (!code) return null;
    return {
      id: liveChannelId(code),
      code,
      name: String(row?.name ?? ""),
      number: row?.number ?? null,
      logo: String(row?.logo ?? ""),
      // EPG-ready fields: see the contract comment above LIVE_CHANNEL_ID_PREFIX.
      epgChannelId: null,
      tvgId: null,
      group,
      groupName
    };
  }

  // Resolves the display name for a category id from the in-memory categories
  // cache only: listChannels never triggers a categories fetch of its own, so
  // groupName is null when the categories have not been loaded yet. The Live
  // screen always loads categories before channels, so this is the warm path.
  function categoryForColumnId(columnId) {
    const value =
      categoriesCache && Array.isArray(categoriesCache.value) ? categoriesCache.value : [];
    return value.find((entry) => String(entry?.columnId) === String(columnId)) || null;
  }

  function evictOverflow() {
    while (channelCache.size > maxCachedCategories) {
      const oldestKey = channelCache.keys().next().value;
      channelCache.delete(oldestKey);
    }
  }

  async function listCategories({ signal } = {}) {
    try {
      if (categoriesCache && categoriesCache.expiresAt > now()) {
        return { status: "success", data: categoriesCache.value };
      }
      const liveClient = await resolveLive();
      if (signal?.aborted) return errorResult("liveRepository: aborted", { aborted: true });
      const categories = await liveClient.listCategories({ signal });
      const value = Array.isArray(categories) ? categories : [];
      categoriesCache = { value, expiresAt: now() + categoriesTtlMs };
      return { status: "success", data: value };
    } catch (error) {
      console.warn("liveRepository: listCategories failed", error);
      return errorResult(error?.message || error, { aborted: Boolean(signal?.aborted) });
    }
  }

  async function listChannels({ columnId, signal } = {}) {
    try {
      const key = String(columnId ?? "").trim();
      if (!key) {
        return errorResult("liveRepository: columnId is required");
      }
      const cached = channelCache.get(key);
      if (cached && cached.expiresAt > now()) {
        return { status: "success", data: cached.value };
      }
      const liveClient = await resolveLive();
      if (signal?.aborted) return errorResult("liveRepository: aborted", { aborted: true });
      // The client pages internally (100 per page, up to 5 pages, stopping at a
      // short page) and caches individual pages for its own 60 s TTL.
      const channels = await liveClient.listChannels({ columnId, signal });
      const category = categoryForColumnId(key);
      const value = (Array.isArray(channels) ? channels : [])
        .map((row) =>
          mapChannel(row, { group: category?.columnId ?? key, groupName: category?.name ?? null })
        )
        .filter(Boolean);
      channelCache.delete(key);
      channelCache.set(key, { value, expiresAt: now() + channelTtlMs });
      evictOverflow();
      return { status: "success", data: value };
    } catch (error) {
      console.warn("liveRepository: listChannels failed", error);
      return errorResult(error?.message || error, { aborted: Boolean(signal?.aborted) });
    }
  }

  async function resolveChannel(idOrCode, { signal } = {}) {
    try {
      const channelCode = stripLiveChannelId(idOrCode);
      if (!channelCode) {
        return errorResult("liveRepository: channel id is required");
      }
      const liveClient = await resolveLive();
      if (signal?.aborted) return errorResult("liveRepository: aborted", { aborted: true });
      const resolved = await liveClient.resolveChannel({ channelCode, signal });
      if (!resolved?.url) {
        return errorResult("liveRepository: resolution returned no stream URL");
      }
      const headers =
        resolved.headers && typeof resolved.headers === "object" ? { ...resolved.headers } : {};
      return { status: "success", data: { url: String(resolved.url), headers } };
    } catch (error) {
      console.warn("liveRepository: resolveChannel failed", error);
      return errorResult(error?.message || error, { aborted: Boolean(signal?.aborted) });
    }
  }

  // Cached lookup by channel id (prefixed `magislive`-style id or bare code).
  // Serves the warm per-category cache only — it never resolves through the
  // client — so an unknown (or not-yet-loaded) channel yields null.
  function getChannel(id) {
    const raw = String(id ?? "").trim();
    const code = stripLiveChannelId(raw);
    if (!code) return null;
    for (const entry of channelCache.values()) {
      if (!entry || entry.expiresAt <= now()) continue;
      const found = entry.value.find((channel) => channel.code === code || channel.id === raw);
      if (found) return found;
    }
    return null;
  }

  function clearCaches() {
    categoriesCache = null;
    channelCache.clear();
  }

  return { listCategories, listChannels, resolveChannel, getChannel, clearCaches };
}

// One repository instance per app: module-level caches survive leaving and
// re-entering the Live screen. The Magis client itself is built lazily on the
// first call, so importing this module never touches the network or storage.
export const liveRepository = createLiveRepository();
