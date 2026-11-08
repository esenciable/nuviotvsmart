// Live repository test: drives createLiveRepository with a fake live client
// that emulates the magisLive contract (paging until a short page or maxPages,
// resolveChannel). No network, no DOM, no localStorage access: the fake client
// is injected so the Magis client factory is never built.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_CHANNEL_ID_PREFIX,
  createLiveRepository,
  liveChannelId,
  stripLiveChannelId
} from "../js/data/repository/liveRepository.js";

const CATEGORIES = [
  { columnId: 101, name: "News", code: "news", free: true },
  { columnId: 102, name: "Sports", code: "sports", free: true },
  { columnId: 103, name: "Movies", code: "movies", free: false }
];

function makeRows(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({
    code: `${prefix}-${index + 1}`,
    name: `Chan ${prefix} ${index + 1}`,
    number: index + 1,
    logo: `http://logo.example/${prefix}-${index + 1}.png`
  }));
}

// Fake live client with the same surface as createMagisLive(): paging stops at
// a short page or maxPages, every portal-equivalent call is recorded.
function createFakeLiveClient({ pagesByColumn = new Map() } = {}) {
  const calls = { listCategories: 0, channelPages: [], resolveChannel: [] };
  let listCategoriesImpl = async () => CATEGORIES;
  let listChannelsImpl = null;
  let resolveChannelImpl = null;
  const live = {
    async listCategories(...args) {
      calls.listCategories += 1;
      if (listCategoriesImpl) return listCategoriesImpl(...args);
      const categories = await (listCategoriesOverride || CATEGORIES);
      return categories;
    },
    async listChannels({ columnId, pageSize = 100, maxPages = 5, signal } = {}) {
      if (listChannelsImpl) return listChannelsImpl({ columnId, pageSize, maxPages, signal });
      const pages = pagesByColumn.get(String(columnId));
      if (!pages) throw new Error(`fake live: unknown columnId ${columnId}`);
      const channels = [];
      for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
        calls.channelPages.push({ columnId: String(columnId), pageNum });
        if (signal?.aborted) {
          throw Object.assign(new Error("fake live: aborted"), { name: "AbortError" });
        }
        const rows = pages[pageNum - 1] || [];
        channels.push(...rows);
        if (rows.length < pageSize) break;
      }
      return channels;
    },
    async resolveChannel({ channelCode, signal } = {}) {
      calls.resolveChannel.push({ channelCode, signal });
      if (resolveChannelImpl) return resolveChannelImpl({ channelCode, signal });
      if (signal?.aborted) {
        throw Object.assign(new Error("fake live: aborted"), { name: "AbortError" });
      }
      return {
        url: `http://cdn.example/live/${channelCode}.m3u8`,
        headers: { Authorization: "Bearer token" },
        diagnostics: {}
      };
    }
  };
  let listCategoriesOverride = null;
  return {
    live,
    calls,
    failListCategories(message) {
      listCategoriesOverride = null;
      listCategoriesImpl = async () => {
        throw new Error(message);
      };
    },
    hangUntilAbortOnListChannels() {
      listChannelsImpl = ({ signal }) =>
        new Promise((_, reject) => {
          if (signal?.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true }
          );
        });
    }
  };
}

function standardPages() {
  return new Map([
    ["101", [makeRows("news", 100), makeRows("news-b", 100), makeRows("news-c", 40)]],
    ["102", [makeRows("sports", 90)]]
  ]);
}

test("categories are cached for the TTL: two calls hit the client once", async () => {
  const fake = createFakeLiveClient();
  let nowMs = 1_000_000;
  const repo = createLiveRepository({ live: fake.live, now: () => nowMs });

  const first = await repo.listCategories();
  const second = await repo.listCategories();
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.deepEqual(second.data, first.data);
  assert.equal(fake.calls.listCategories, 1);

  // Still inside the 5-minute TTL: no extra client call.
  nowMs += 4 * 60 * 1000;
  await repo.listCategories();
  assert.equal(fake.calls.listCategories, 1);

  // Past the TTL: the client is hit again.
  nowMs += 2 * 60 * 1000;
  await repo.listCategories();
  assert.equal(fake.calls.listCategories, 2);
});

test("channels page until a short page and the per-category cache is reused", async () => {
  const fake = createFakeLiveClient({ pagesByColumn: standardPages() });
  const repo = createLiveRepository({ live: fake.live });

  const result = await repo.listChannels({ columnId: 101 });
  assert.equal(result.status, "success");
  // 100 + 100 + 40: paging stopped at the short third page.
  assert.equal(result.data.length, 240);
  assert.deepEqual(
    fake.calls.channelPages,
    [
      { columnId: "101", pageNum: 1 },
      { columnId: "101", pageNum: 2 },
      { columnId: "101", pageNum: 3 }
    ]
  );

  // Every channel carries the stable id plus name/number/logo.
  for (const channel of result.data) {
    assert.equal(channel.id, `${LIVE_CHANNEL_ID_PREFIX}${channel.code}`);
    assert.equal(typeof channel.name, "string");
    assert.ok("number" in channel);
    assert.equal(typeof channel.logo, "string");
  }

  // Second call for the same category is served from the 60 s per-category
  // cache: no new page calls. A different category still pages.
  const second = await repo.listChannels({ columnId: 101 });
  assert.deepEqual(second.data, result.data);
  const other = await repo.listChannels({ columnId: 102 });
  assert.equal(other.status, "success");
  assert.equal(other.data.length, 90); // single short page
  assert.equal(fake.calls.channelPages.length, 4); // 3 + 1 (sports page is short)
});

test("the per-category channel cache is capped and evicts oldest entries", async () => {
  const fake = createFakeLiveClient({
    pagesByColumn: new Map([
      ["1", [makeRows("a", 2)]],
      ["2", [makeRows("b", 2)]],
      ["3", [makeRows("c", 2)]]
    ])
  });
  const repo = createLiveRepository({ live: fake.live, maxCachedCategories: 2 });

  await repo.listChannels({ columnId: "1" });
  await repo.listChannels({ columnId: "2" });
  const pagesAfterTwo = fake.calls.channelPages.length;
  await repo.listChannels({ columnId: "3" });
  // Column 1 was the oldest entry and must have been evicted.
  await repo.listChannels({ columnId: "1" });
  assert.ok(fake.calls.channelPages.length > pagesAfterTwo);
});

test("resolveChannel strips the magis:live: prefix and returns url+headers", async () => {
  const fake = createFakeLiveClient();
  const repo = createLiveRepository({ live: fake.live });

  assert.equal(liveChannelId("CCTV-1"), "magis:live:CCTV-1");
  assert.equal(stripLiveChannelId("magis:live:CCTV-1"), "CCTV-1");
  assert.equal(stripLiveChannelId("CCTV-1"), "CCTV-1");

  const prefixed = await repo.resolveChannel("magis:live:CCTV-1");
  assert.equal(prefixed.status, "success");
  assert.deepEqual(prefixed.data, {
    url: "http://cdn.example/live/CCTV-1.m3u8",
    headers: { Authorization: "Bearer token" }
  });
  assert.equal(fake.calls.resolveChannel[0]?.channelCode, "CCTV-1");

  // A bare channel code also works.
  const bare = await repo.resolveChannel("CCTV-2");
  assert.equal(bare.status, "success");
  assert.equal(fake.calls.resolveChannel[1]?.channelCode, "CCTV-2");
});

test("channel objects are EPG-ready and getChannel serves cached channels", async () => {
  const fake = createFakeLiveClient({ pagesByColumn: standardPages() });
  const repo = createLiveRepository({ live: fake.live });

  // Warm the category cache so listChannels can stamp group/groupName from it.
  await repo.listCategories();

  const result = await repo.listChannels({ columnId: 101 });
  assert.equal(result.status, "success");
  const channel = result.data[0];

  // The guide contract: Magis publishes no listings today, so both EPG ids are
  // null, while the category link is stamped on every channel.
  assert.equal(channel.epgChannelId, null);
  assert.equal(channel.tvgId, null);
  assert.equal(channel.group, 101);
  assert.equal(channel.groupName, "News");

  // getChannel is served from the per-category cache: no new client calls.
  const pagesBefore = fake.calls.channelPages.length;
  assert.equal(repo.getChannel(channel.id), channel);
  assert.equal(fake.calls.channelPages.length, pagesBefore);

  // An unknown id resolves to null without touching the client either.
  assert.equal(repo.getChannel("magis:live:does-not-exist"), null);
  assert.equal(repo.getChannel(""), null);
  assert.equal(fake.calls.channelPages.length, pagesBefore);
});

test("a client rejection yields a status object and never throws", async () => {
  const fake = createFakeLiveClient();
  fake.failListCategories("portal unreachable");
  const repo = createLiveRepository({ live: fake.live });

  const categories = await repo.listCategories();
  assert.equal(categories.status, "error");
  assert.ok(String(categories.detail).includes("portal unreachable"));

  const channels = await repo.listChannels({ columnId: "101" });
  assert.equal(channels.status, "error");
  assert.ok(String(channels.detail).length > 0);

  const resolveFailure = createFakeLiveClient();
  resolveFailure.live.resolveChannel = async () => {
    throw new Error("no cdn answered");
  };
  const repo2 = createLiveRepository({ live: resolveFailure.live });
  const resolved = await repo2.resolveChannel("magis:live:CCTV-1");
  assert.equal(resolved.status, "error");
  assert.ok(String(resolved.detail).includes("no cdn answered"));
});

test("an aborted signal stops the pending call before and during the client call", async () => {
  // Pre-aborted signal: the client is never invoked.
  const fake = createFakeLiveClient({ pagesByColumn: standardPages() });
  const repo = createLiveRepository({ live: fake.live });
  const preAborted = new AbortController();
  preAborted.abort();

  const before = await repo.listChannels({ columnId: "101", signal: preAborted.signal });
  assert.equal(before.status, "error");
  assert.equal(before.aborted, true);
  assert.equal(fake.calls.channelPages.length, 0);
  assert.equal(fake.calls.resolveChannel.length, 0);

  // Mid-flight abort: the pending promise settles with an aborted status.
  const hanging = createFakeLiveClient();
  hanging.hangUntilAbortOnListChannels();
  const repo2 = createLiveRepository({ live: hanging.live });
  const controller = new AbortController();
  const pending = repo2.listChannels({ columnId: "101", signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.equal(result.status, "error");
  assert.equal(result.aborted, true);
});
