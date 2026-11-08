// PremiumTV source test: fake fetch returning the fixture, no network, no DOM.
// Covers: categories from groups in feed order, channels per group, resolve
// returning url+headers, the TTL (no extra fetch within it), refresh forcing a
// refetch, and the failure contract (a FAILED fetch must NOT arm the TTL and
// must serve the last good persisted list so a cold start with the feed down
// still shows channels).
import test from "node:test";
import assert from "node:assert/strict";

import {
  createPremiumTvSource,
  PREMIUMTV_CHANNEL_ID_PREFIX,
  PREMIUMTV_DEFAULT_LIST_URL
} from "../js/core/live/premiumTvSource.js";
import { premiumTvChannelId } from "../js/core/live/m3uPlaylist.js";

const FIXTURE = [
  "#EXTM3U url-tvg=\"https://example.com/epg.xml\"",
  "#EXTINF:-1 tvg-id=\"ch1.example\" tvg-logo=\"http://logo.example/1.png\" group-title=\"Noticias, Local\",Canal 1 HD",
  "#EXTVLCOPT:http-user-agent=SmartTVAgent/2.0",
  "#EXTVLCOPT:http-referrer=https://teleon.tv/",
  "http://stream.example/one.m3u8",
  "#EXTINF:-1 group-title=\"Noticias, Local\",Canal 1 B",
  "http://stream.example/one-b.m3u8",
  "#EXTINF:-1 group-title=\"El Salvador - TCS\",Canal 2 TCS SD",
  "#EXTVLCOPT:http-referrer=https://teleon.tv/",
  "http://jmp2.uk/two.m3u8"
].join("\n");

function makeStorage() {
  const map = new Map();
  return {
    get: (key, fallback) => (map.has(key) ? map.get(key) : fallback),
    set: (key, value) => map.set(key, value),
    peek: (key) => map.get(key)
  };
}

function makeFetch() {
  const state = { calls: 0, fail: false };
  const fetchImpl = async () => {
    state.calls += 1;
    if (state.fail) throw new Error("feed down");
    return {
      ok: true,
      status: 200,
      text: async () => FIXTURE
    };
  };
  return { fetchImpl, state };
}

function makeSource({ storage = makeStorage(), listUrl = PREMIUMTV_DEFAULT_LIST_URL } = {}) {
  const { fetchImpl, state } = makeFetch();
  let nowMs = 1_000_000;
  const source = createPremiumTvSource({
    fetchImpl,
    storage,
    listUrl,
    ttlMs: 30 * 60 * 1000,
    now: () => nowMs
  });
  return {
    source,
    state,
    storage,
    advance: (ms) => {
      nowMs += ms;
    },
    get nowMs() {
      return nowMs;
    }
  };
}

test("listCategories returns the distinct groups in feed order", async () => {
  const env = makeSource();
  const categories = await env.source.listCategories();
  assert.deepEqual(categories, [
    { columnId: `${PREMIUMTV_CHANNEL_ID_PREFIX}Noticias, Local`, name: "Noticias, Local" },
    { columnId: `${PREMIUMTV_CHANNEL_ID_PREFIX}El Salvador - TCS`, name: "El Salvador - TCS" }
  ]);
  assert.equal(env.state.calls, 1);
});

test("listChannels returns the channels of one group with stable ids", async () => {
  const env = makeSource();
  const channels = await env.source.listChannels({
    columnId: `${PREMIUMTV_CHANNEL_ID_PREFIX}Noticias, Local`
  });

  assert.equal(channels.length, 2);
  const first = channels[0];
  const expectedHash = premiumTvChannelId("http://stream.example/one.m3u8");
  assert.equal(first.code, expectedHash);
  assert.equal(first.id, `${PREMIUMTV_CHANNEL_ID_PREFIX}${expectedHash}`);
  assert.equal(first.name, "Canal 1 HD");
  assert.equal(first.logo, "http://logo.example/1.png");
  assert.equal(first.group, `${PREMIUMTV_CHANNEL_ID_PREFIX}Noticias, Local`);
  assert.equal(first.groupName, "Noticias, Local");
  assert.equal(first.epgChannelId, "ch1.example");
  assert.equal(first.tvgId, "ch1.example");

  // The other group is not leaked into this list.
  assert.ok(channels.every((channel) => channel.groupName === "Noticias, Local"));

  // An unknown group yields an empty list, not an error.
  const unknown = await env.source.listChannels({
    columnId: `${PREMIUMTV_CHANNEL_ID_PREFIX}Nope`
  });
  assert.deepEqual(unknown, []);
});

test("resolveChannel returns url+headers straight from the entry, no probing", async () => {
  const env = makeSource();
  const hash = premiumTvChannelId("http://stream.example/one.m3u8");
  const resolved = await env.source.resolveChannel({ channelCode: hash });
  assert.deepEqual(resolved, {
    url: "http://stream.example/one.m3u8",
    headers: { "User-Agent": "SmartTVAgent/2.0", Referer: "https://teleon.tv/" }
  });

  // An unknown channel code rejects.
  await assert.rejects(
    () => env.source.resolveChannel({ channelCode: "does-not-exist" }),
    /unknown channel/i
  );
});

test("a second call within the TTL performs no extra fetch", async () => {
  const env = makeSource();
  await env.source.listCategories();
  await env.source.listCategories();
  await env.source.listChannels({ columnId: `${PREMIUMTV_CHANNEL_ID_PREFIX}Noticias, Local` });
  const hash = premiumTvChannelId("http://stream.example/one.m3u8");
  await env.source.resolveChannel({ channelCode: hash });
  assert.equal(env.state.calls, 1);

  // Past the TTL the feed is fetched again.
  env.advance(30 * 60 * 1000 + 1);
  await env.source.listCategories();
  assert.equal(env.state.calls, 2);
});

test("refresh() forces a refetch", async () => {
  const env = makeSource();
  await env.source.listCategories();
  assert.equal(env.state.calls, 1);
  await env.source.refresh();
  assert.equal(env.state.calls, 2);
  const categories = await env.source.listCategories();
  assert.equal(categories.length, 2);
  assert.equal(env.state.calls, 2); // still armed by the refresh
});

test("a failed fetch serves the persisted list and does NOT arm the TTL", async () => {
  const env = makeSource();

  // First load succeeds and persists the parsed list.
  await env.source.listCategories();
  assert.equal(env.state.calls, 1);
  const persisted = env.storage.peek("nuvio.premiumtv.playlist.v1");
  assert.ok(Array.isArray(persisted?.entries) && persisted.entries.length === 3);

  // Feed goes down; advance past the TTL so the next call must fetch again.
  env.state.fail = true;
  env.advance(30 * 60 * 1000 + 1);
  const categories = await env.source.listCategories();
  assert.equal(categories.length, 2); // last good list, from storage/memory
  assert.equal(env.state.calls, 2); // the failed fetch was attempted

  // The TTL was NOT armed by the failure: a small step forward retries
  // immediately instead of waiting another 30 minutes.
  env.advance(1_000);
  await env.source.listChannels({ columnId: `${PREMIUMTV_CHANNEL_ID_PREFIX}Noticias, Local` });
  assert.equal(env.state.calls, 3);

  // And the persisted list survives a cold start: a fresh source over the same
  // storage with the feed still down still shows channels.
  const cold = createPremiumTvSource({
    fetchImpl: async () => {
      throw new Error("feed down");
    },
    storage: env.storage,
    listUrl: PREMIUMTV_DEFAULT_LIST_URL,
    now: () => env.nowMs
  });
  const coldCategories = await cold.listCategories();
  assert.equal(coldCategories.length, 2);
});

test("a failed first fetch with no persisted list rejects", async () => {
  const source = createPremiumTvSource({
    fetchImpl: async () => {
      throw new Error("feed down");
    },
    storage: makeStorage(),
    listUrl: PREMIUMTV_DEFAULT_LIST_URL,
    now: () => 1_000_000
  });
  await assert.rejects(() => source.listCategories(), /feed down/);
});

test("an empty feed is treated as a failure and never overwrites the last good list", async () => {
  const storage = makeStorage();
  let payload = FIXTURE;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => payload });
  const source = createPremiumTvSource({
    fetchImpl,
    storage,
    listUrl: PREMIUMTV_DEFAULT_LIST_URL,
    now: () => 1_000_000
  });

  await source.listCategories();
  payload = "";
  // refresh() forces the refetch: the empty feed parses to zero channels and
  // is treated as a failure, so the last good (armed) list is still served.
  await source.refresh();
  const categories = await source.listCategories();
  assert.equal(categories.length, 2); // last good list still served
});
