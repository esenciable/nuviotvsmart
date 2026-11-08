// Category dedupe contract for the Live TV screen — GENERATED INDEX edition.
// The ownership rule no longer runs on the TV: `npm run catalog:index`
// computes it once on a developer machine (scripts/magis-catalog-index.mjs)
// and ships the answer as js/core/magis/catalog-index.json. The screen only
// READS that index: rail counts come from it (no portal call), the generic
// ChannelList renders its leftovers from it (the 500-channel catalogue page is
// never fetched at runtime), and there is no background walk and no runtime
// ownership computation anywhere in the screen. Categories load on demand —
// one fetch each. Search, favourites and recents keep using the loaded set
// (no category dedupe). Pure functions only: node --test runs fully offline.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GENERIC_CATEGORY_NAME,
  isGenericCategoryName,
  isUsableCatalogIndex,
  catalogCountsFromIndex,
  leftoverChannelsFromIndex,
  findGenericCategory,
  buildRailItems,
  channelMatchesQuery,
  categoryRailId
} from "../js/ui/screens/live/liveScreenMethods-02-render.js";

// Catalog fixtures: Deportes (42) then Cine (43) then the generic
// ChannelList (7). The index carries the counts AFTER dedupe (see
// tests/test-magis-catalog-index.mjs): espn is owned by Deportes, so Cine
// shows 2 and the generic keeps only ztv + orphan.
const CATEGORIES = [
  { columnId: 42, name: "Deportes" },
  { columnId: 43, name: "Cine y Series" },
  { columnId: 7, name: "ChannelList" }
];
const INDEX_COUNTS = new Map([
  ["42", 2],
  ["43", 2],
  ["7", 2]
]);
const CACHES = new Map([
  ["42", [{ id: "magis:live:espn" }, { id: "magis:live:fox" }]],
  ["premiumtv:TCS", [{ id: "premiumtv:x" }, { id: "premiumtv:y" }]]
]);
const USABLE_INDEX = {
  generatedAt: "2026-02-11T00:00:00.000Z",
  genericCategoryName: "ChannelList",
  categories: [
    { columnId: 42, name: "Deportes", count: 2 },
    { columnId: 43, name: "Cine y Series", count: 2 },
    { columnId: 7, name: "ChannelList", count: 2 }
  ],
  leftovers: [
    { code: "ztv", name: "ZTV", number: 5 },
    { code: "orphan", name: "Orphan", number: null }
  ]
};

const renderSource = () =>
  readFileSync(new URL("../js/ui/screens/live/liveScreenMethods-02-render.js", import.meta.url), "utf8");
const mountSource = () =>
  readFileSync(new URL("../js/ui/screens/live/liveScreenMethods-01-mount-and-load.js", import.meta.url), "utf8");

describe("no runtime ownership computation (the rule lives in the generated index)", () => {
  test("computeCategoryOwnership and filterChannelsByOwnership are gone from the screen", () => {
    for (const source of [renderSource(), mountSource()]) {
      assert.doesNotMatch(source, /computeCategoryOwnership/);
      assert.doesNotMatch(source, /filterChannelsByOwnership/);
    }
  });

  test("the ownership memo invalidation is gone from the background release too", () => {
    assert.doesNotMatch(mountSource(), /_ownershipSignature|_categoryOwnership/);
  });
});

describe("no background walk (categories load on demand, one fetch each)", () => {
  test("preloadRemainingCategories is gone from the mount module", () => {
    assert.doesNotMatch(mountSource(), /preloadRemainingCategories/);
  });

  test("the mount wires the generated index instead", () => {
    const source = mountSource();
    assert.match(source, /loadCatalogIndex\(\)/);
    assert.match(source, /applyCatalogIndex\(/);
  });

  test("selecting a rail row loads exactly one category — no iteration over all categories", () => {
    const source = mountSource();
    const selectStart = source.indexOf("selectRailItem(railId", 0);
    assert.ok(selectStart >= 0, "selectRailItem exists");
    const selectPath = source.slice(selectStart); // through the end of the mount module
    assert.ok(selectPath.includes("loadChannelsForCategory"), "category rows load their own list");
    assert.doesNotMatch(selectPath, /for \(const .* of this\.categories/);
  });
});

describe("isUsableCatalogIndex (absent/stale index degrades, never crashes)", () => {
  test("a generated index (non-empty generatedAt) is usable", () => {
    assert.equal(isUsableCatalogIndex(USABLE_INDEX), true);
  });

  test("the empty placeholder (generatedAt null) is NOT usable: the screen falls back to on-demand loads", () => {
    assert.equal(
      isUsableCatalogIndex({ generatedAt: null, genericCategoryName: "ChannelList", categories: [], leftovers: [] }),
      false
    );
    assert.equal(isUsableCatalogIndex({ generatedAt: "", genericCategoryName: "ChannelList", categories: [], leftovers: [] }), false);
  });

  test("garbage input is not usable and never throws", () => {
    assert.equal(isUsableCatalogIndex(null), false);
    assert.equal(isUsableCatalogIndex(undefined), false);
    assert.equal(isUsableCatalogIndex("nope"), false);
    assert.equal(isUsableCatalogIndex({}), false);
    assert.equal(isUsableCatalogIndex({ generatedAt: "x" }), false); // categories missing
  });
});

describe("catalogCountsFromIndex (rail counts with no portal call)", () => {
  test("maps columnId -> count for a usable index", () => {
    const counts = catalogCountsFromIndex(USABLE_INDEX);
    assert.deepEqual([...counts.entries()].sort(), [
      ["42", 2],
      ["43", 2],
      ["7", 2]
    ]);
  });

  test("an unusable index yields an empty map: every Magis count renders '…'", () => {
    for (const index of [null, undefined, { generatedAt: null, categories: [] }]) {
      assert.equal(catalogCountsFromIndex(index).size, 0);
    }
  });

  test("malformed entries are skipped and counts clamp to non-negative integers", () => {
    const counts = catalogCountsFromIndex({
      generatedAt: "2026-02-11T00:00:00.000Z",
      genericCategoryName: "ChannelList",
      categories: [null, { columnId: "", name: "x", count: 3 }, { columnId: 9, name: "y", count: -4 }, { columnId: 11, name: "z", count: 7.9 }],
      leftovers: []
    });
    assert.deepEqual([...counts.entries()], [["9", 0], ["11", 7]]);
  });
});

describe("leftoverChannelsFromIndex (the generic catalogue renders without fetching the 500)", () => {
  test("maps leftovers to stable magis:live channel rows", () => {
    const channels = leftoverChannelsFromIndex(USABLE_INDEX);
    assert.deepEqual(
      channels.map((channel) => [channel.id, channel.code, channel.name, channel.number]),
      [
        ["magis:live:ztv", "ztv", "ZTV", 5],
        ["magis:live:orphan", "orphan", "Orphan", null]
      ]
    );
    for (const channel of channels) {
      assert.equal(channel.groupName, "ChannelList"); // the generic section, for the meta line
    }
  });

  test("duplicate codes collapse into one row", () => {
    const channels = leftoverChannelsFromIndex({
      generatedAt: "x",
      genericCategoryName: "ChannelList",
      categories: [],
      leftovers: [
        { code: "ztv", name: "ZTV", number: 5 },
        { code: "ztv", name: "ZTV dup", number: 6 }
      ]
    });
    assert.equal(channels.length, 1);
    assert.equal(channels[0].name, "ZTV");
  });

  test("an unusable index yields NO rows (the generic selection falls back to the portal fetch)", () => {
    for (const index of [null, undefined, { generatedAt: null, categories: [], leftovers: [{ code: "ztv", name: "ZTV", number: 5 }] }]) {
      assert.deepEqual(leftoverChannelsFromIndex(index), []);
    }
  });

  test("malformed leftovers are skipped; a blank name falls back to the placeholder", () => {
    const channels = leftoverChannelsFromIndex({
      generatedAt: "x",
      genericCategoryName: "ChannelList",
      categories: [],
      leftovers: [null, { code: "", name: "no code" }, { code: "ok", name: "  " }]
    });
    assert.deepEqual(channels.map((channel) => channel.code), ["ok"]);
    assert.equal(channels[0].name, "Canal en vivo");
  });
});

describe("generic catalogue identification (from the index, not a guess)", () => {
  test("matches the index's genericCategoryName case-insensitively", () => {
    const generic = findGenericCategory(CATEGORIES, "channellist");
    assert.equal(generic?.columnId, 7);
    assert.equal(findGenericCategory(CATEGORIES, "ChannelList")?.columnId, 7);
  });

  test("no match -> null (the generic selection stays on the on-demand fetch path)", () => {
    assert.equal(findGenericCategory(CATEGORIES, "Not The Catalogue"), null);
    assert.equal(findGenericCategory([], "ChannelList"), null);
    assert.equal(findGenericCategory(null, "ChannelList"), null);
  });

  test("the shared constant is still the documented catalogue page name", () => {
    assert.equal(GENERIC_CATEGORY_NAME, "ChannelList");
    assert.equal(isGenericCategoryName(" channellist "), true);
  });
});

describe("rail counts reflect the generated index (dedupe already applied offline)", () => {
  test("a Magis category's count comes from the index even before its channels are loaded", () => {
    const items = buildRailItems({ categories: CATEGORIES, channelsByColumn: new Map(), catalogCounts: INDEX_COUNTS, favoriteCount: 0, recentCount: 0 });
    const deportes = items.find((item) => item.railId === categoryRailId(42));
    const generic = items.find((item) => item.railId === categoryRailId(7));
    assert.equal(deportes.count, 2); // from the index — no portal call
    assert.equal(generic.count, 2); // the leftovers count
  });

  test("a missing index entry renders '…' (degraded, never a fake 0)", () => {
    const items = buildRailItems({
      categories: CATEGORIES,
      channelsByColumn: new Map(),
      catalogCounts: new Map([["42", 2]]),
      favoriteCount: 0,
      recentCount: 0
    });
    assert.equal(items.find((item) => item.railId === categoryRailId(43)).count, null);
    assert.equal(items.find((item) => item.railId === categoryRailId(7)).count, null);
  });

  test("PremiumTV is unaffected: its groups do not overlap and keep the on-demand cache count", () => {
    const categories = [...CATEGORIES, { columnId: "premiumtv:TCS", name: "TCS" }];
    const withoutCache = buildRailItems({ categories, channelsByColumn: new Map(), catalogCounts: INDEX_COUNTS, favoriteCount: 0, recentCount: 0 });
    const premiumPending = withoutCache.find((item) => item.railId === categoryRailId("premiumtv:TCS"));
    assert.equal(premiumPending.count, null); // not cached yet: "…"
    assert.equal(premiumPending.loading, true);

    const withCache = buildRailItems({ categories, channelsByColumn: CACHES, catalogCounts: INDEX_COUNTS, favoriteCount: 0, recentCount: 0 });
    const premium = withCache.find((item) => item.railId === categoryRailId("premiumtv:TCS"));
    assert.equal(premium.count, 2);
    assert.equal(premium.loading, false);
  });

  test("a Magis source's count is the sum of its index counts once every one is present", () => {
    const items = buildRailItems({ categories: CATEGORIES, channelsByColumn: new Map(), catalogCounts: INDEX_COUNTS, favoriteCount: 0, recentCount: 0 });
    const magis = items.find((item) => item.type === "source");
    assert.equal(magis.count, 6); // 2 + 2 + 2 deduped channels
    assert.equal(magis.loading, false);
  });

  test("a source with any missing count stays '…' (no fake sums)", () => {
    const items = buildRailItems({
      categories: CATEGORIES,
      channelsByColumn: new Map(),
      catalogCounts: new Map([["42", 2]]),
      favoriteCount: 0,
      recentCount: 0
    });
    assert.equal(items.find((item) => item.type === "source").count, null);
  });
});

describe("the generic catalogue renders leftovers through the mount's on-demand path", () => {
  test("loadChannelsForCategory serves the generic column from the index BEFORE any repository call", () => {
    const source = mountSource();
    const loadStart = source.indexOf("async loadChannelsForCategory");
    const fetchStart = source.indexOf("await liveRepository.listChannels", loadStart);
    assert.ok(loadStart >= 0 && fetchStart > loadStart, "the repository fetch exists for regular categories");
    const beforeFetch = source.slice(loadStart, fetchStart);
    assert.match(beforeFetch, /catalogGenericColumnId/);
    assert.match(beforeFetch, /leftoverChannelsFromIndex/);
    assert.match(beforeFetch, /channelsByColumn\.set\(/, "the leftovers are cached like any category list");
  });

  test("an unusable index leaves the generic on the normal fetch path (degradation)", () => {
    // The generic branch only exists when the index identified the category:
    // the guard reads this.catalogGenericColumnId, which applyCatalogIndex
    // clears when the index is unusable.
    const source = mountSource();
    assert.match(source, /applyCatalogIndex/);
    assert.match(source, /isUsableCatalogIndex/);
  });

  test("the category branch of refreshVisibleChannels renders the cached list as-is (no runtime filter)", () => {
    const start = mountSource().indexOf("refreshVisibleChannels()");
    const end = mountSource().indexOf("selectRailItem(", start);
    const body = mountSource().slice(start, end);
    const catStart = body.indexOf('selection.startsWith("cat:")');
    const catBody = body.slice(catStart);
    assert.match(catBody, /caches\.get\(columnId\)/);
    assert.doesNotMatch(catBody, /Ownership/);
  });
});

describe("search, favourites and recents keep the loaded set (no category dedupe)", () => {
  test("a channel is still findable by accent-insensitive search", () => {
    assert.equal(channelMatchesQuery({ name: "ESPN Deportes" }, "espn"), true);
    assert.equal(channelMatchesQuery({ name: "Fox Sports" }, "sports"), true);
  });

  test("the search pipeline in the mount module builds the raw union of the loaded caches", () => {
    const source = mountSource();
    const start = source.indexOf("refreshVisibleChannels()");
    const end = source.indexOf("selectRailItem(", start);
    const body = source.slice(start, end);
    const searchStart = body.indexOf("if (query)");
    const searchEnd = body.indexOf("} else {", searchStart);
    const searchBranch = body.slice(searchStart, searchEnd);
    assert.match(searchBranch, /union/);
  });
});
