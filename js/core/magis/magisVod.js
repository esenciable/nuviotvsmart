// Magis VOD resolver: the measured sequence searchByName -> optional
// getItemData for series -> startPlayVOD -> getSlbInfo -> candidate selection
// loop probing each vod cdn x free/short entry for the first 200/206.
// Media probing goes through an injectable mediaTransport (the portal proxy is
// not involved; Tizen plays media via AVPlay, so no proxy is needed there).
import { createDeviceDict } from "./magisSession.js";

export const MAGIS_MEDIA_USER_AGENT = "Ranger/4.9.4-17294ac0";

// Measured portal payloads.
export function buildBaseFields(sessionState) {
  return {
    portalCode: "masnew",
    userId: String(sessionState.userId),
    userToken: String(sessionState.userToken)
  };
}

const SERIES_PROGRAM_TYPE = /series|teleplay|variety/i;

export function collectSearchItems(searchAnswer) {
  return (searchAnswer?.searchItemList || []).flatMap((entry) => entry.itemList || []);
}

export function pickSearchCandidate(items, { title, year, isSeries }) {
  const wantedTitle = String(title || "")
    .trim()
    .toLowerCase();
  const scored = items
    .filter((item) => item && item.contentId)
    .map((item) => {
      const name = String(item.name || "").toLowerCase();
      const isSeriesItem = SERIES_PROGRAM_TYPE.test(String(item.programType || ""));
      let score = 0;
      if (wantedTitle && name === wantedTitle) score += 100;
      else if (wantedTitle && name.startsWith(wantedTitle)) score += 50;
      else if (wantedTitle && name.includes(wantedTitle)) score += 25;
      if (isSeries && isSeriesItem) score += 10;
      if (!isSeries && !isSeriesItem) score += 10;
      const itemYear = String(item.releaseTime || "").slice(0, 4);
      if (year && itemYear === String(year)) score += 5;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].item : null;
}

// Locate the requested episode in a getItemData answer without assuming the
// portal's exact season/episode field names (they were not fully measured).
// Measured shape of v4/getItemData: assetData carries the season packs and the
// episode list, not the startPlayVOD movie shape.
export function collectSeasonPacks(itemDataAnswer) {
  const asset = itemDataAnswer?.assetData || {};
  return (asset.sameSeasonSeriesList || []).map((entry) => ({
    season: Number(entry?.seasonNumber),
    contentId: String(entry?.contentId || "")
  }));
}

export function collectEpisodes(itemDataAnswer) {
  const asset = itemDataAnswer?.assetData || {};
  return (asset.simpleProgramList || []).map((entry) => ({
    episode: Number(entry?.seriesNumber),
    contentId: String(entry?.contentId || ""),
    name: String(entry?.name || "")
  }));
}

export function pickEpisode(episodes, { episode } = {}) {
  if (!episodes.length) return null;
  const wanted = Number(episode) || 1;
  return (
    episodes.find((entry) => entry.episode === wanted && entry.contentId) ||
    episodes.find((entry) => entry.contentId) ||
    null
  );
}

// h264 + mp4 preferred, then the larger height (measured scoring).
export function scoreMedia(movie) {
  const codec = /h264/i.test(String(movie?.encodeFormat || "")) ? 0 : 2;
  const container = /mp4/i.test(String(movie?.videoFormat || "")) ? 0 : 1;
  const height = Number(String(movie?.quality || "").replace(/[^0-9]/g, "")) || 0;
  return codec * 1000 + container * 100 - height / 1000;
}

export function collectStartPlayMovies(playAnswer) {
  return (playAnswer?.episodeList?.[0]?.totalMovieList || []).flatMap(
    (group) => group?.movieList || []
  );
}

export function buildMediaProbeHeaders({ entryUrl, license, config }) {
  return {
    "Content-Auth": String(entryUrl || ""),
    "Content-License": String(license || ""),
    "User-Agent": MAGIS_MEDIA_USER_AGENT,
    App: String(config.appId),
    "App-Version": String(config.apkVersion)
  };
}

export function defaultMediaTransport({ url, headers, timeoutMs = 12000, fetchImpl = fetch } = {}) {
  // Selecting a candidate only needs the status line. Never read the body: a
  // live MPEG-TS is unbounded, so draining it here hangs the resolver forever
  // (measured against a real CDN). Ask for a tiny range and cancel the stream.
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  return fetchImpl(url, {
    headers: { ...headers, Range: "bytes=0-2047" },
    ...(controller ? { signal: controller.signal } : {})
  })
    .then((response) => {
      try {
        response.body?.cancel?.();
      } catch (_) {
        // Cancelling is best effort; the status already decided the candidate.
      }
      return { status: response.status, headers: {} };
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

export function createMagisVod({ portal, config, session, mediaTransport } = {}) {
  if (!portal || typeof portal.call !== "function") {
    throw new Error("magisVod: an injectable portal is required");
  }
  if (!config) {
    throw new Error("magisVod: config is required");
  }
  if (!session || typeof session.getOrCreate !== "function") {
    throw new Error("magisVod: an injectable session is required");
  }
  const probe = mediaTransport || defaultMediaTransport;

  async function resolveStream({ title, year, isSeries, season, episode } = {}) {
    if (!title) throw new Error("magisVod: title is required");
    const sessionState = await session.getOrCreate();
    const sn = sessionState.sn;
    const device = createDeviceDict(config, sn);
    const base = buildBaseFields(sessionState);

    // 1. searchByName
    const search = await portal.call("v3/searchByName", {
      ...base,
      value: String(title),
      type: "0",
      columnId: "",
      filter: "",
      pageNum: 1,
      pageSize: 10,
      ...device
    });
    const items = collectSearchItems(search);
    const candidate = pickSearchCandidate(items, { title, year, isSeries });
    if (!candidate?.contentId) {
      throw new Error(`magisVod: no search result for "${title}"`);
    }

    // 2. resolve the season pack and the episode. Measured: v4/getItemData is the
    // call that answers assetData { sameSeasonSeriesList[], simpleProgramList[] },
    // and startPlayVOD for a series needs BOTH the episode contentId and the
    // season pack id as seriesContentId; an episode alone is rejected.
    let seriesContentId = "";
    let episodeContentId = "";
    if (isSeries) {
      seriesContentId = String(candidate.contentId);
      const fetchItemData = (contentId) =>
        portal.call("v4/getItemData", {
          ...base,
          contentId,
          type: "0",
          sortType: "0",
          language: "en",
          macAddr: "02:00:00:00:00:00",
          ...device
        });
      let itemData = await fetchItemData(seriesContentId);
      const wantedSeason = Number(season) || 1;
      const pack = collectSeasonPacks(itemData).find((entry) => entry.season === wantedSeason);
      if (pack?.contentId && pack.contentId !== seriesContentId) {
        seriesContentId = pack.contentId;
        itemData = await fetchItemData(seriesContentId);
      }
      const picked = pickEpisode(collectEpisodes(itemData), { season, episode });
      if (picked?.contentId) {
        episodeContentId = String(picked.contentId);
      }
    }

    // 3. startPlayVOD
    const play = await portal.call("v10/startPlayVOD", {
      ...base,
      contentId: episodeContentId || String(candidate.contentId),
      seriesContentId,
      startTime: 0,
      type: "1",
      columnId: 0,
      authType: "",
      ...device
    });
    const movieList = collectStartPlayMovies(play);
    if (!movieList.length) {
      throw new Error("magisVod: startPlayVOD returned no movieList");
    }
    const media = movieList.slice().sort((a, b) => scoreMedia(a) - scoreMedia(b))[0];
    const license = media?.licenseList?.[0]?.license || "";
    const mediaId = String(media?.contentId || candidate.contentId);
    const ext = media?.videoFormat === "ts" ? "ts" : "mp4";

    // 4. getSlbInfo
    const slb = await portal.call("v14/getSlbInfo", {
      ...base,
      hasPay: "0",
      userIdentity: "1",
      type: "merge",
      appVer: String(config.apkVersion),
      lang: "es",
      encMediaSupported: 1,
      liveCodeList: ["masnew_live"],
      appParams: "",
      reserve1: "02:00:00:00:00:00",
      pipFlag: "0",
      ...device
    });
    const vodCdns = (slb?.cdn_list || []).filter((cdn) => cdn?.tag === "vod");

    // 5. candidate selection loop: every vod cdn x free/short entry,
    //    first 200/206 wins.
    const cdnFailed = [];
    for (const cdn of vodCdns) {
      const main = String(cdn.main_addr || "").replace(/\/$/, "");
      const mediaBase = /^http/i.test(main) ? main : `https://${main}`;
      for (const entry of cdn.url_list || []) {
        if (entry.tag !== "free" && entry.tag !== "short") continue;
        const url = `${mediaBase}/vod/${mediaId}_media.${ext}`;
        const probeHeaders = buildMediaProbeHeaders({
          entryUrl: entry.url,
          license,
          config
        });
        let status = null;
        try {
          const response = await probe({ url, headers: probeHeaders });
          status = response?.status ?? null;
        } catch (error) {
          cdnFailed.push({
            host: main,
            tag: entry.tag,
            status: null,
            error: String(error?.message || error)
          });
          continue;
        }
        if (status === 200 || status === 206) {
          return {
            url,
            headers: probeHeaders,
            contentId: mediaId,
            media,
            cdn: main,
            tag: entry.tag,
            license,
            diagnostics: {
              cdnAnswered: main,
              cdnFailed
            }
          };
        }
        cdnFailed.push({ host: main, tag: entry.tag, status, error: null });
      }
    }
    throw new Error(
      `magisVod: no vod cdn candidate answered 200/206 ` +
        `(tried ${cdnFailed.length} entries: ${JSON.stringify(cdnFailed)})`
    );
  }

  return { resolveStream };
}
