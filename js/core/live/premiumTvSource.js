// PremiumTV live source: fetches a public M3U playlist, parses it once, and
// adapts it to the same surface the Magis live client exposes (listCategories,
// listChannels, resolveChannel). No portal, no probing: the stream URL and its
// headers come straight from the playlist entry.
//
// Caching contract:
// - A SUCCESSFUL parse arms the TTL and persists the parsed list.
// - A FAILED fetch must NOT arm the TTL (the next attempt retries immediately)
//   and must serve the last good list from storage when present, so a cold
//   start with the feed down still shows channels (the Android app kept its
//   last good list in memory only and showed an empty section instead).
import { parseM3u, premiumTvChannelId, headersForEntry } from "./m3uPlaylist.js";

export const PREMIUMTV_CHANNEL_ID_PREFIX = "premiumtv:";
export const PREMIUMTV_DEFAULT_LIST_URL = "https://esenciable.github.io/nuvio-iptv/esencial.m3u";
export const PREMIUMTV_DEFAULT_TTL_MS = 30 * 60 * 1000;
// Namespaced storage key: the persisted parsed list survives restarts.
export const PREMIUMTV_STORAGE_KEY = "nuvio.premiumtv.playlist.v1";
// Cap what we persist: the measured feed holds 1869 entries (~380 KB of text,
// far less once parsed); anything beyond this bound stays in memory only.
export const PREMIUMTV_MAX_PERSISTED_ENTRIES = 3000;

export function createPremiumTvSource({
  fetchImpl = null,
  storage = null,
  listUrl = PREMIUMTV_DEFAULT_LIST_URL,
  ttlMs = PREMIUMTV_DEFAULT_TTL_MS,
  now = () => Date.now()
} = {}) {
  // Armed state: only a successful parse ever lands here.
  let memory = null; // { urlTvg, entries, fetchedAt }
  let entriesByCode = new Map();

  function indexEntries(entries) {
    entriesByCode = new Map();
    for (const entry of entries) {
      const code = premiumTvChannelId(entry.url);
      if (!entriesByCode.has(code)) entriesByCode.set(code, entry);
    }
  }

  function persist(record) {
    if (!storage || typeof storage.set !== "function") return;
    try {
      const entries = record.entries.slice(0, PREMIUMTV_MAX_PERSISTED_ENTRIES).map((entry) => ({
        name: entry.name ?? "",
        url: entry.url,
        group: entry.group ?? null,
        logo: entry.logo ?? null,
        tvgId: entry.tvgId ?? null,
        tvgName: entry.tvgName ?? null,
        number: entry.number ?? null,
        userAgent: entry.userAgent ?? null,
        referrer: entry.referrer ?? null
      }));
      storage.set(PREMIUMTV_STORAGE_KEY, {
        urlTvg: record.urlTvg ?? null,
        savedAt: record.fetchedAt,
        entries
      });
    } catch {
      // Persistence is best-effort: the in-memory list still serves.
    }
  }

  function readPersisted() {
    if (!storage || typeof storage.get !== "function") return null;
    let saved = null;
    try {
      saved = storage.get(PREMIUMTV_STORAGE_KEY, null);
    } catch {
      return null;
    }
    if (!saved || !Array.isArray(saved.entries)) return null;
    const entries = saved.entries.filter((entry) => entry && entry.url);
    if (!entries.length) return null;
    // fetchedAt 0: a storage fallback never counts as an armed TTL.
    return { urlTvg: saved.urlTvg ?? null, entries, fetchedAt: 0 };
  }

  async function loadList({ force = false } = {}) {
    if (!force && memory && now() - memory.fetchedAt < ttlMs) return memory;
    try {
      if (typeof fetchImpl !== "function") {
        throw new Error("premiumTvSource: fetch is not configured");
      }
      const response = await fetchImpl(listUrl, {
        headers: { Accept: "application/vnd.apple.mpegurl, audio/x-mpegurl, */*" }
      });
      if (response && typeof response.ok === "boolean" && !response.ok) {
        throw new Error(`premiumTvSource: feed responded with HTTP ${response.status}`);
      }
      const text =
        response && typeof response.text === "function" ? await response.text() : String(response);
      const parsed = parseM3u(text);
      if (!parsed.entries.length) {
        throw new Error("premiumTvSource: feed parsed to zero channels");
      }
      memory = { urlTvg: parsed.urlTvg, entries: parsed.entries, fetchedAt: now() };
      indexEntries(memory.entries);
      persist(memory);
      return memory;
    } catch (error) {
      // Failure: never arm the TTL, serve the last good list instead.
      if (memory) return memory;
      const saved = readPersisted();
      if (saved) {
        indexEntries(saved.entries);
        return saved;
      }
      throw error;
    }
  }

  async function listCategories({ signal } = {}) {
    void signal; // the fetch is a single short request; no abort plumbing yet
    const list = await loadList();
    const groups = [];
    const seen = new Set();
    for (const entry of list.entries) {
      const group = entry.group ? String(entry.group) : "";
      if (!group || seen.has(group)) continue;
      seen.add(group);
      groups.push({ columnId: `${PREMIUMTV_CHANNEL_ID_PREFIX}${group}`, name: group });
    }
    return groups;
  }

  async function listChannels({ columnId } = {}) {
    const key = String(columnId ?? "");
    if (!key.startsWith(PREMIUMTV_CHANNEL_ID_PREFIX)) return [];
    const groupName = key.slice(PREMIUMTV_CHANNEL_ID_PREFIX.length);
    const list = await loadList();
    const channels = [];
    for (const entry of list.entries) {
      if (String(entry.group ?? "") !== groupName) continue;
      const code = premiumTvChannelId(entry.url);
      channels.push({
        code,
        id: `${PREMIUMTV_CHANNEL_ID_PREFIX}${code}`,
        name: String(entry.name ?? ""),
        number: entry.number ?? null,
        logo: String(entry.logo ?? ""),
        group: key,
        groupName,
        // EPG contract: the guide id comes from tvg-id (usually null today).
        epgChannelId: entry.tvgId || null,
        tvgId: entry.tvgId || null
      });
    }
    return channels;
  }

  async function resolveChannel({ channelCode, signal } = {}) {
    void signal;
    const code = String(channelCode ?? "").trim();
    const list = await loadList();
    const entry =
      entriesByCode.get(code) || list.entries.find((item) => premiumTvChannelId(item.url) === code);
    if (!entry) {
      throw new Error(`premiumTvSource: unknown channel ${code}`);
    }
    return { url: entry.url, headers: headersForEntry(entry) };
  }

  async function refresh() {
    await loadList({ force: true });
  }

  return { listCategories, listChannels, resolveChannel, refresh };
}
