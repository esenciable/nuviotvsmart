// Magis LIVE resolver: the measured sequence getNextColumns (categories) ->
// v6/getLiveData (paged channels) -> v4/startPlayLive -> v14/getSlbInfo ->
// candidate selection loop probing each live cdn x free entry for the first
// 200/206 whose body starts with #EXTM3U. The playCode and license live INSIDE
// liveAddressList entries, and live cdns carry a path in main_addr that must be
// stripped (both measured against the live portal, see /tmp/magis-live-final.mjs).
// Media probing goes through an injectable mediaTransport, mirroring magisVod.
// Portal calls cannot carry an AbortSignal (magisPortal.call has no signal
// parameter and is outside this module), so cancellation is enforced here: the
// signal races each portal call (a zap rejects the await immediately) and is
// forwarded verbatim to the media probe transport, where the fetch aborts.
import { createDeviceDict } from "./magisSession.js";
import { buildBaseFields, buildMediaProbeHeaders } from "./magisVod.js";

export const MAGIS_LIVE_COLUMN_CODE = "masnew_live";
export const MAGIS_LIVE_PAGE_SIZE = 100;
export const MAGIS_LIVE_MAX_PAGES = 5;
export const MAGIS_LIVE_CATEGORIES_TTL_MS = 5 * 60 * 1000;
export const MAGIS_LIVE_CHANNEL_TTL_MS = 60 * 1000;
export const MAGIS_LIVE_PROBE_TIMEOUT_MS = 8000;
export const MAGIS_LIVE_PROBE_PREFIX_BYTES = 64;

function createAbortError() {
  const error = new Error("magisLive: aborted");
  error.name = "AbortError";
  return error;
}

// Live probe transport: unlike the VOD probe, a live candidate must be checked
// for an m3u8 body, so read at most a small prefix of the first chunk and
// cancel the stream. Never read the whole body. Aborts on a timeout and on the
// caller's signal.
export function defaultLiveMediaTransport({
  url,
  headers,
  signal,
  timeoutMs = MAGIS_LIVE_PROBE_TIMEOUT_MS,
  prefixBytes = MAGIS_LIVE_PROBE_PREFIX_BYTES,
  fetchImpl = fetch
} = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;
  const onExternalAbort = () => controller?.abort();
  if (signal && controller) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  };
  return (async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        headers,
        ...(controller ? { signal: controller.signal } : {})
      });
    } catch (error) {
      if (timedOut) {
        throw new Error(`magisLive: media probe timed out after ${timeoutMs}ms for ${url}`);
      }
      throw error;
    }
    const status = response.status;
    if (status !== 200 && status !== 206) {
      try {
        response.body?.cancel?.();
      } catch (_) {
        // Cancelling is best effort; the status already decided the candidate.
      }
      return { status, bodyPrefix: "" };
    }
    let bodyPrefix = "";
    const reader = response.body?.getReader?.();
    if (reader) {
      try {
        const chunk = await reader.read();
        if (chunk?.value) {
          bodyPrefix = new TextDecoder().decode(chunk.value.subarray(0, prefixBytes));
        }
      } finally {
        try {
          reader.cancel();
        } catch (_) {
          // best effort
        }
      }
    } else {
      // No stream body available: fall back to text and slice the prefix.
      const text = await response.text();
      bodyPrefix = text.slice(0, prefixBytes);
    }
    return { status, bodyPrefix };
  })().finally(cleanup);
}

// Measured mapping: the portal answers both key spellings
// (channelList|liveList, channelCode|code, channelName|name,
// channelNumber|number, posterUrl|logo).
export function collectLiveChannels(answer) {
  return (answer?.channelList || answer?.liveList || []).map((row) => ({
    code: String(row?.channelCode ?? row?.code ?? ""),
    name: String(row?.channelName ?? row?.name ?? ""),
    number: row?.channelNumber ?? row?.number ?? null,
    logo: String(row?.posterUrl ?? row?.logo ?? "")
  }));
}

export function createMagisLive({
  portal,
  config,
  session,
  mediaTransport,
  now = () => Date.now(),
  categoriesTtlMs = MAGIS_LIVE_CATEGORIES_TTL_MS,
  channelTtlMs = MAGIS_LIVE_CHANNEL_TTL_MS
} = {}) {
  if (!portal || typeof portal.call !== "function") {
    throw new Error("magisLive: an injectable portal is required");
  }
  if (!config) {
    throw new Error("magisLive: config is required");
  }
  if (!session || typeof session.getOrCreate !== "function") {
    throw new Error("magisLive: an injectable session is required");
  }
  const probe = mediaTransport || defaultLiveMediaTransport;

  let categoriesCache = null; // { value, expiresAt }
  const channelCache = new Map(); // `${columnId}:${pageNum}:${pageSize}` -> { value, expiresAt }

  // Portal cancellation: portal.call has no signal parameter, so race it
  // against the signal; a zap rejects the caller's await immediately.
  async function callPortal(path, payload, signal) {
    if (signal?.aborted) throw createAbortError();
    if (!signal) return portal.call(path, payload);
    let onAbort;
    try {
      return await Promise.race([
        portal.call(path, payload),
        new Promise((_, reject) => {
          onAbort = () => reject(createAbortError());
          signal.addEventListener("abort", onAbort, { once: true });
        })
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async function buildRequestFields() {
    const sessionState = await session.getOrCreate();
    return {
      base: buildBaseFields(sessionState),
      device: createDeviceDict(config, sessionState.sn)
    };
  }

  // Measured: getNextColumns with columnCode masnew_live and pageSize 200
  // (30 silently truncates); the array is at recommendList[].
  async function listCategories({ signal } = {}) {
    if (categoriesCache && categoriesCache.expiresAt > now()) {
      return categoriesCache.value;
    }
    const { base, device } = await buildRequestFields();
    const answer = await callPortal(
      "getNextColumns",
      {
        ...base,
        columnCode: MAGIS_LIVE_COLUMN_CODE,
        pageNum: 1,
        pageSize: 200,
        version: "",
        ...device
      },
      signal
    );
    const seen = new Set();
    const categories = [];
    for (const entry of answer?.recommendList || []) {
      const columnId = entry?.columnId;
      if (columnId == null || seen.has(String(columnId))) continue;
      seen.add(String(columnId));
      categories.push({
        columnId,
        name: String(entry.name ?? ""),
        code: String(entry.code ?? ""),
        free: entry.free
      });
    }
    categoriesCache = { value: categories, expiresAt: now() + categoriesTtlMs };
    return categories;
  }

  // Measured: v6/getLiveData per (columnId, pageNum), paginating while a page
  // comes back full and never beyond maxPages.
  async function listChannels({
    columnId,
    pageSize = MAGIS_LIVE_PAGE_SIZE,
    maxPages = MAGIS_LIVE_MAX_PAGES,
    signal
  } = {}) {
    if (columnId == null) {
      throw new Error("magisLive: columnId is required");
    }
    const { base, device } = await buildRequestFields();
    const channels = [];
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const cacheKey = `${columnId}:${pageNum}:${pageSize}`;
      const cached = channelCache.get(cacheKey);
      let rows;
      if (cached && cached.expiresAt > now()) {
        rows = cached.value;
      } else {
        const answer = await callPortal(
          "v6/getLiveData",
          { ...base, columnId, pageNum, pageSize, ...device },
          signal
        );
        rows = collectLiveChannels(answer);
        channelCache.set(cacheKey, { value: rows, expiresAt: now() + channelTtlMs });
      }
      channels.push(...rows);
      if (rows.length < pageSize) break;
    }
    return channels;
  }

  // Measured playback sequence: startPlayLive (playCode+license live INSIDE
  // liveAddressList entries) -> getSlbInfo with liveCodeList:[channelCode] ->
  // strip the path from each live cdn's main_addr -> probe each candidate
  // (cdn x free entry) with the auth headers, first 200/206 with an #EXTM3U
  // prefix wins.
  async function resolveChannel({ channelCode, signal } = {}) {
    if (!channelCode) {
      throw new Error("magisLive: channelCode is required");
    }
    const { base, device } = await buildRequestFields();

    const play = await callPortal(
      "v4/startPlayLive",
      { ...base, channelCode: String(channelCode), columnId: 0, type: "1", ...device },
      signal
    );
    const address = (play?.liveAddressList || []).find(
      (entry) => entry?.playCode && entry?.license
    );
    if (!address) {
      throw new Error(
        "magisLive: startPlayLive returned no liveAddressList entry with playCode+license"
      );
    }

    const slb = await callPortal(
      "v14/getSlbInfo",
      {
        ...base,
        hasPay: "0",
        userIdentity: "1",
        type: "merge",
        appVer: String(config.apkVersion),
        lang: "es",
        encMediaSupported: 1,
        liveCodeList: [String(channelCode)],
        appParams: "",
        reserve1: "02:00:00:00:00:00",
        pipFlag: "0",
        ...device
      },
      signal
    );

    const cdnFailed = [];
    const liveCdns = (slb?.cdn_list || []).filter((cdn) => cdn?.tag === "live");
    for (const cdn of liveCdns) {
      if (signal?.aborted) throw createAbortError();
      // Strip scheme and path: live cdns carry e.g. http://host/v3/youshi/.
      const host = String(cdn.main_addr || "")
        .replace(/^https?:\/\//, "")
        .split("/")[0];
      if (!host) {
        cdnFailed.push({ host: "", status: null, error: "missing main_addr" });
        continue;
      }
      for (const entry of cdn.url_list || []) {
        if (signal?.aborted) throw createAbortError();
        // Measured: only the free entries carry the auth url.
        if (entry?.tag !== "free") continue;
        const url = `http://${host}/live/${address.playCode}.m3u8`;
        const headers = buildMediaProbeHeaders({
          entryUrl: entry.url,
          license: address.license,
          config
        });
        let status = null;
        try {
          const probeResult = await probe({ url, headers, signal });
          status = probeResult?.status ?? null;
          const bodyPrefix = String(probeResult?.bodyPrefix || "");
          if ((status === 200 || status === 206) && bodyPrefix.startsWith("#EXTM3U")) {
            return {
              url,
              headers,
              diagnostics: {
                cdnAnswered: host,
                cdnFailed
              }
            };
          }
          cdnFailed.push({ host, status, error: null });
        } catch (error) {
          // A caller abort is not a cdn failure: stop the whole resolution.
          if (signal?.aborted) throw error;
          cdnFailed.push({ host, status: null, error: String(error?.message || error) });
        }
      }
    }
    throw new Error(
      `magisLive: no live cdn candidate answered with an m3u8 playlist ` +
        `(tried ${cdnFailed.length}: ${JSON.stringify(cdnFailed)})`
    );
  }

  return { listCategories, listChannels, resolveChannel };
}
