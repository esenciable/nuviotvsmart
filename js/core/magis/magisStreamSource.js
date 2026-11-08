// Magis VOD stream source: adapts the proven Magis VOD client into a stream
// group shaped exactly like the addon groups the stream repository emits, so
// the stream screen can render "Magis VOD" next to the addon groups without
// any special casing. All failures are contained: resolveStreamGroup returns
// null and keeps a diagnostic string for logging instead of throwing to the
// caller. Title resolution is injected (titleLookup(videoId, type)) so this
// module never talks to TMDB or the meta repository itself.
import { createMagisVodClient } from "./index.js";

export const MAGIS_STREAM_SOURCE_ID = "magis-vod";
export const MAGIS_STREAM_SOURCE_NAME = "Magis VOD";
export const MAGIS_STREAM_ORIGIN_KIND = "magis";

// The Magis group always sorts after every addon group in the stream list.
const MAGIS_STREAM_ORDER_INDEX = Number.MAX_SAFE_INTEGER;

const SERIES_TYPES = ["series", "tv", "show", "tvshow"];

function isSeriesType(type) {
  return SERIES_TYPES.includes(
    String(type || "")
      .trim()
      .toLowerCase()
  );
}

// Episode ids look like tt123:1:2 (imdb:season:episode). Magis searches by
// title, so split the trailing season/episode off the content id.
function splitSeriesVideoId(videoId) {
  const parts = String(videoId || "")
    .trim()
    .split(":");
  if (parts.length >= 3) {
    const season = Number(parts[parts.length - 2]);
    const episode = Number(parts[parts.length - 1]);
    if (Number.isInteger(season) && season > 0 && Number.isInteger(episode) && episode > 0) {
      return { season, episode, contentId: parts.slice(0, -2).join(":") };
    }
  }
  return { season: null, episode: null, contentId: String(videoId || "").trim() };
}

function parseQualityValue(quality) {
  const height = Number(String(quality || "").replace(/[^0-9]/g, ""));
  return Number.isFinite(height) && height > 0 ? height : -1;
}

export function createMagisStreamSource({ client, persistence, titleLookup } = {}) {
  let clientPromise = null;
  let lastDiagnostic = "";

  const noteDiagnostic = (message) => {
    lastDiagnostic = String(message || "");
    return lastDiagnostic;
  };

  const resolveClient = () => {
    if (client && typeof client.resolveStream === "function") {
      return Promise.resolve(client);
    }
    // Lazily build the full client (config -> portal -> session -> vod) with
    // the caller-provided persistence so the session mints once and is reused
    // across stream screens and app restarts.
    if (!clientPromise) {
      clientPromise = createMagisVodClient({ persistence }).catch((error) => {
        clientPromise = null; // allow a retry on the next resolution attempt
        throw error;
      });
    }
    return clientPromise;
  };

  function isAvailable() {
    return Boolean(typeof titleLookup === "function" && (client || persistence));
  }

  async function resolveStreamGroup({
    type,
    videoId,
    meta = null,
    season = null,
    episode = null,
    signal
  } = {}) {
    try {
      if (!isAvailable()) {
        noteDiagnostic(
          "magis stream source: unavailable (missing titleLookup or Magis persistence)"
        );
        return null;
      }
      if (signal?.aborted) {
        noteDiagnostic("magis stream source: aborted before resolution");
        return null;
      }

      // Title resolution: an optional pre-resolved meta identity wins; the
      // injected titleLookup is the default path. Without a title there is
      // nothing to search for, so return null before any portal call.
      const identity =
        meta && String(meta.title || "").trim()
          ? {
              title: String(meta.title).trim(),
              year: meta.year ?? null,
              isSeries: Boolean(meta.isSeries)
            }
          : await titleLookup(videoId, type);
      if (!identity || !String(identity.title || "").trim()) {
        noteDiagnostic(`magis stream source: no title resolved for ${String(videoId || "")}`);
        return null;
      }

      const parsed = splitSeriesVideoId(videoId);
      const resolvedSeason = season != null ? Number(season) : parsed.season;
      const resolvedEpisode = episode != null ? Number(episode) : parsed.episode;
      const isSeries = Boolean(identity.isSeries) || isSeriesType(type) || parsed.season != null;

      const magisClient = await resolveClient();
      // Warm/reuse the session explicitly: client.session.getOrCreate() mints
      // once (persisted by the caller) and reuses afterwards, so repeated
      // stream screens never re-mint.
      if (magisClient.session && typeof magisClient.session.getOrCreate === "function") {
        await magisClient.session.getOrCreate();
      }
      const resolved = await magisClient.resolveStream({
        title: String(identity.title).trim(),
        year: identity.year ?? null,
        isSeries,
        season: resolvedSeason,
        episode: resolvedEpisode
      });
      if (!resolved?.url) {
        noteDiagnostic("magis stream source: resolution returned no stream URL");
        return null;
      }

      const requestHeaders =
        resolved.headers && typeof resolved.headers === "object" ? { ...resolved.headers } : {};
      const qualityLabel = resolved.media?.quality ? String(resolved.media.quality) : null;
      const formatLabel = resolved.media?.videoFormat
        ? String(resolved.media.videoFormat).toUpperCase()
        : null;
      const title = [qualityLabel, formatLabel].filter(Boolean).join(" · ") || "Magis VOD";

      const origin = {
        kind: MAGIS_STREAM_ORIGIN_KIND,
        addonId: MAGIS_STREAM_SOURCE_ID,
        addonBaseUrl: null,
        addonName: MAGIS_STREAM_SOURCE_NAME,
        addonOrderIndex: MAGIS_STREAM_ORDER_INDEX
      };
      // Per-stream fields mirror StreamRepository.mapStream (the shape the
      // stream screen and player already consume). Headers are carried in
      // behaviorHints.proxyHeaders.request, the field the player reads for
      // direct playback (getCurrentStreamRequestHeaders et al).
      const stream = {
        name: MAGIS_STREAM_SOURCE_NAME,
        title,
        description: null,
        url: resolved.url,
        ytId: null,
        infoHash: null,
        fileIdx: null,
        externalUrl: null,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: { request: requestHeaders, response: null }
        },
        sources: [],
        quality: qualityLabel,
        qualityValue: parseQualityValue(qualityLabel),
        clientResolve: null,
        debridCacheStatus: null,
        subtitles: [],
        addonId: MAGIS_STREAM_SOURCE_ID,
        addonBaseUrl: null,
        addonName: MAGIS_STREAM_SOURCE_NAME,
        addonLogo: null,
        addonOrderIndex: MAGIS_STREAM_ORDER_INDEX,
        streamOrigin: { ...origin }
      };
      noteDiagnostic("");
      return {
        addonId: MAGIS_STREAM_SOURCE_ID,
        addonBaseUrl: null,
        addonName: MAGIS_STREAM_SOURCE_NAME,
        addonLogo: null,
        addonOrderIndex: MAGIS_STREAM_ORDER_INDEX,
        streamSource: MAGIS_STREAM_SOURCE_ID,
        streamOrigin: { ...origin },
        streams: [stream]
      };
    } catch (error) {
      noteDiagnostic(
        `magis stream source: ${String(error?.message || error || "unknown failure")}`
      );
      return null;
    }
  }

  return {
    isAvailable,
    resolveStreamGroup,
    getDiagnostic: () => lastDiagnostic
  };
}
