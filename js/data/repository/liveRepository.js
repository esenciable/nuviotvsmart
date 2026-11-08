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
import {
  PREMIUMTV_CHANNEL_ID_PREFIX,
  PREMIUMTV_DEFAULT_LIST_URL,
  createPremiumTvSource
} from "../../core/live/premiumTvSource.js";
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

// Generic storage adapter for the PremiumTV playlist persistence: the source
// only needs get/set; the key it namespaces under lives in premiumTvSource.js.
const premiumTvStorage = {
  get: (key, fallback) => LocalStore.get(key, fallback),
  set: (key, value) => LocalStore.set(key, value)
};

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
  premiumTv = null,
  premiumTvListUrl = PREMIUMTV_DEFAULT_LIST_URL,
  now = () => Date.now(),
  categoriesTtlMs = MAGIS_LIVE_CATEGORIES_TTL_MS,
  channelTtlMs = MAGIS_LIVE_CHANNEL_TTL_MS,
  maxCachedCategories = MAX_CACHED_CATEGORY_CHANNEL_LISTS
} = {}) {
  let clientPromise = null;
  let categoriesCache = null; // { value, expiresAt } (Magis side)
  const channelCache = new Map(); // columnId -> { value, expiresAt }

  // The second native LIVE source. Its own TTL/persistence lives inside the
  // source; the repository only merges. Tests inject `premiumTv`, so the
  // default fetch is armed only in a real browser/TV context (window exists):
  // `node --test` runs without a DOM and must stay fully offline.
  const premiumSource =
    premiumTv ||
    createPremiumTvSource({
      fetchImpl: typeof window !== "undefined" && typeof fetch === "function" ? fetch : null,
      storage: premiumTvStorage,
      listUrl: premiumTvListUrl
    });

  // Lazily build the full Magis client (config -> portal -> session -> vod +
  // live) exactly once, with the shared session persistence. Kept separate from
  // resolveLive because a re-authentication needs the client, not just its live
  // surface: returning client.live here silently turned refreshSession into a
  // no-op and the retry re-sent the expired token.
  const resolveClient = async () => {
    if (live && typeof live.listCategories === "function") {
      return null; // injected fake: there is no session to refresh
    }
    if (!clientPromise) {
      clientPromise = createMagisVodClient({ persistence: magisSessionPersistence });
      clientPromise.catch(() => {
        clientPromise = null; // allow a retry on the next resolution attempt
      });
    }
    return clientPromise;
  };

  const resolveLive = async () => {
    if (live && typeof live.listCategories === "function") {
      return live;
    }
    const client = await resolveClient();
    return client.live;
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

  // The portal expires tokens (aaa100027) and the app keeps the session across
  // restarts, so a stale token is normal. Re-authenticate with the stored device
  // identity and retry once instead of surfacing the portal error to the UI.
  const AUTH_ERROR_CODES = /^aaa1/;

  async function withSessionRetry(operation) {
    try {
      return await operation();
    } catch (error) {
      const code = String(error?.returnCode || "");
      if (!AUTH_ERROR_CODES.test(code)) {
        throw error;
      }
      const client = await resolveClient();
      await client?.refreshSession?.();
      return await operation();
    }
  }

  // Magis categories, exactly as before: the cache arm comes only from a
  // successful client call.
  async function loadMagisCategories({ signal } = {}) {
    if (categoriesCache && categoriesCache.expiresAt > now()) {
      return { ok: true, value: categoriesCache.value };
    }
    const liveClient = await resolveLive();
    if (signal?.aborted) {
      return { ok: false, detail: "liveRepository: aborted", aborted: true };
    }
    const categories = await withSessionRetry(() => liveClient.listCategories({ signal }));
    const value = Array.isArray(categories) ? categories : [];
    categoriesCache = { value, expiresAt: now() + categoriesTtlMs };
    return { ok: true, value };
  }

  // PremiumTV groups. The source caches internally (armed TTL + persisted
  // last good list), so a failure here is surfaced as a warning and never
  // breaks the Magis listing.
  async function loadPremiumCategories({ signal } = {}) {
    const groups = await premiumSource.listCategories({ signal });
    return { ok: true, value: Array.isArray(groups) ? groups : [] };
  }

  async function listCategories({ signal } = {}) {
    const [magisOutcome, premiumOutcome] = await Promise.allSettled([
      loadMagisCategories({ signal }),
      loadPremiumCategories({ signal })
    ]);
    const toFailure = (outcome) =>
      outcome.status === "fulfilled"
        ? outcome.value
        : { ok: false, detail: outcome.reason?.message || String(outcome.reason) };
    const magis = toFailure(magisOutcome);
    const premium = toFailure(premiumOutcome);

    // Magis categories first, then the PremiumTV groups; a failing source is
    // surfaced in `warnings` while the other source's data still flows.
    const data = [];
    const warnings = [];
    if (magis.ok) data.push(...magis.value);
    else warnings.push(`magis: ${magis.detail}`);
    if (premium.ok) data.push(...premium.value);
    else warnings.push(`premiumtv: ${premium.detail}`);

    if (!data.length) {
      const detail = warnings.length
        ? warnings.join("; ")
        : "liveRepository: no live sources available";
      console.warn("liveRepository: listCategories failed", detail);
      return errorResult(detail, {
        aborted: Boolean(signal?.aborted && magis.aborted)
      });
    }
    return { status: "success", data, warnings };
  }

  async function listChannels({ columnId, signal } = {}) {
    const key = String(columnId ?? "").trim();
    // PremiumTV columns carry the `premiumtv:` id prefix and are served by the
    // second source; everything else stays on the Magis path unchanged.
    if (key.startsWith(PREMIUMTV_CHANNEL_ID_PREFIX)) {
      try {
        if (signal?.aborted) return errorResult("liveRepository: aborted", { aborted: true });
        const channels = await premiumSource.listChannels({ columnId: key });
        return { status: "success", data: Array.isArray(channels) ? channels : [] };
      } catch (error) {
        console.warn("liveRepository: premiumtv listChannels failed", error);
        return errorResult(error?.message || error, { aborted: Boolean(signal?.aborted) });
      }
    }
    try {
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
      const channels = await withSessionRetry(() => liveClient.listChannels({ columnId, signal }));
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
    const raw = String(idOrCode ?? "").trim();
    // PremiumTV ids resolve straight from the parsed playlist: url + headers,
    // no portal call and no session involved.
    if (raw.startsWith(PREMIUMTV_CHANNEL_ID_PREFIX)) {
      try {
        if (signal?.aborted) return errorResult("liveRepository: aborted", { aborted: true });
        const channelCode = raw.slice(PREMIUMTV_CHANNEL_ID_PREFIX.length);
        if (!channelCode) {
          return errorResult("liveRepository: channel id is required");
        }
        const resolved = await premiumSource.resolveChannel({ channelCode, signal });
        if (!resolved?.url) {
          return errorResult("liveRepository: resolution returned no stream URL");
        }
        return {
          status: "success",
          data: {
            url: String(resolved.url),
            headers:
              resolved.headers && typeof resolved.headers === "object"
                ? { ...resolved.headers }
                : {}
          }
        };
      } catch (error) {
        console.warn("liveRepository: premiumtv resolveChannel failed", error);
        return errorResult(error?.message || error, { aborted: Boolean(signal?.aborted) });
      }
    }
    try {
      const channelCode = stripLiveChannelId(raw);
      if (!channelCode) {
        return errorResult("liveRepository: channel id is required");
      }
      const liveClient = await resolveLive();
      if (signal?.aborted) return errorResult("liveRepository: aborted", { aborted: true });
      const resolved = await withSessionRetry(() =>
        liveClient.resolveChannel({ channelCode, signal })
      );
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
