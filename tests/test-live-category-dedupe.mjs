// Category dedupe contract for the Live TV screen (owner-approved rule).
// Pure functions only: no DOM, no network, no i18n — node --test must run
// fully offline. Ownership: each channel lives in exactly ONE category — a
// SPECIFIC category beats the generic catalogue (`ChannelList`,
// case-insensitive), and among specific categories the FIRST one in catalog
// order that contains the channel owns it. The generic catalogue shows only
// the channels no specific category owns. Search, favourites and recents keep
// using the FULL set (no category dedupe).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GENERIC_CATEGORY_NAME,
  isGenericCategoryName,
  computeCategoryOwnership,
  filterChannelsByOwnership,
  buildRailItems,
  channelMatchesQuery,
  categoryRailId
} from "../js/ui/screens/live/liveScreenMethods-02-render.js";

// Catalog fixtures: Deportes (42) then Cine (43) then the generic
// ChannelList (7). Channels may span categories; ids are the stable ids.
const CATEGORIES = [
  { columnId: 42, name: "Deportes" },
  { columnId: 43, name: "Cine y Series" },
  { columnId: 7, name: "ChannelList" }
];
const DEPORTES = [
  { id: "magis:live:espn", name: "ESPN" },
  { id: "magis:live:fox", name: "Fox Sports" }
];
const CINE = [
  { id: "magis:live:hbo", name: "HBO" },
  { id: "magis:live:espn", name: "ESPN" }, // also in Deportes: Deportes (first specific) owns it
  { id: "magis:live:tcm", name: "TCM" }
];
const CHANNELLIST = [
  { id: "magis:live:espn", name: "ESPN" }, // owned by Deportes
  { id: "magis:live:hbo", name: "HBO" }, // owned by Cine y Series
  { id: "magis:live:ztv", name: "ZTV" }, // only here: the generic keeps it
  { id: "magis:live:orphan", name: "Orphan" } // only here too
];

function ownershipFor(caches) {
  return computeCategoryOwnership({ categories: CATEGORIES, channelsByColumn: caches });
}

describe("isGenericCategoryName (the catalogue page, not a genre)", () => {
  test("matches the Magis catalogue name case-insensitively", () => {
    assert.equal(isGenericCategoryName("ChannelList"), true);
    assert.equal(isGenericCategoryName("channellist"), true);
    assert.equal(isGenericCategoryName("CHANNELLIST"), true);
    assert.equal(isGenericCategoryName(" ChannelList "), true);
  });

  test("never matches a specific genre or a differently-spelled name", () => {
    assert.equal(isGenericCategoryName("Deportes"), false);
    assert.equal(isGenericCategoryName("Channel List"), false);
    assert.equal(isGenericCategoryName("Channels"), false);
    assert.equal(isGenericCategoryName(""), false);
    assert.equal(isGenericCategoryName(null), false);
  });

  test("the constant is the documented catalogue page name", () => {
    assert.equal(GENERIC_CATEGORY_NAME, "ChannelList");
  });
});

describe("computeCategoryOwnership (specific beats generic, first specific wins)", () => {
  test("a channel in a specific category and the generic catalogue is owned by the SPECIFIC one", () => {
    const owners = ownershipFor(
      new Map([
        ["42", DEPORTES],
        ["7", CHANNELLIST]
      ])
    );
    assert.equal(owners.get("magis:live:espn"), "42");
  });

  test("among specific categories, the FIRST one in catalog order wins ties", () => {
    const owners = ownershipFor(
      new Map([
        ["42", DEPORTES],
        ["43", CINE]
      ])
    );
    assert.equal(owners.get("magis:live:espn"), "42"); // Deportes precedes Cine y Series
    assert.equal(owners.get("magis:live:hbo"), "43");
  });

  test("a channel only in the generic catalogue stays there (owned by ChannelList)", () => {
    const owners = ownershipFor(new Map([["7", CHANNELLIST]]));
    assert.equal(owners.get("magis:live:ztv"), "7");
    assert.equal(owners.get("magis:live:orphan"), "7");
  });

  test("a channel in NO category has no owner", () => {
    const owners = ownershipFor(new Map([["42", DEPORTES]]));
    assert.equal(owners.has("magis:live:nowhere"), false);
    assert.equal(owners.get("magis:live:nowhere"), undefined);
  });

  test("uncached categories contribute nothing (progressive: ownership refines as the preload walks)", () => {
    // Only the generic is walked so far: it still shows everything.
    const before = ownershipFor(new Map([["7", CHANNELLIST]]));
    assert.equal(before.get("magis:live:espn"), "7");
    // Deportes' cache arrives: its channels are stolen from the generic, never given back.
    const after = ownershipFor(
      new Map([
        ["42", DEPORTES],
        ["7", CHANNELLIST]
      ])
    );
    assert.equal(after.get("magis:live:espn"), "42");
    assert.equal(after.get("magis:live:ztv"), "7");
  });
});

describe("filterChannelsByOwnership (a category list excludes channels owned by another)", () => {
  const owners = ownershipFor(
    new Map([
      ["42", DEPORTES],
      ["43", CINE],
      ["7", CHANNELLIST]
    ])
  );

  test("a specific category keeps exactly the channels it owns", () => {
    assert.deepEqual(filterChannelsByOwnership(CINE, "43", owners).map((c) => c.id), ["magis:live:hbo", "magis:live:tcm"]);
    assert.deepEqual(filterChannelsByOwnership(DEPORTES, "42", owners).map((c) => c.id), ["magis:live:espn", "magis:live:fox"]);
  });

  test("the generic ChannelList shows ONLY the channels with no specific owner", () => {
    assert.deepEqual(filterChannelsByOwnership(CHANNELLIST, "7", owners).map((c) => c.id), ["magis:live:ztv", "magis:live:orphan"]);
  });

  test("does not mutate the input list", () => {
    assert.equal(CHANNELLIST.length, 4);
  });
});

describe("union-without-duplicates invariant (no channel lost, none repeated)", () => {
  const caches = new Map([
    ["42", DEPORTES],
    ["43", CINE],
    ["7", CHANNELLIST]
  ]);
  const owners = ownershipFor(caches);

  test("the union of all filtered category lists equals the union of the raw caches, exactly once each", () => {
    const allIds = new Set();
    for (const [columnId, list] of caches) {
      for (const channel of filterChannelsByOwnership(list, columnId, owners)) {
        const id = String(channel.id);
        assert.equal(allIds.has(id), false, `channel ${id} rendered twice`);
        allIds.add(id);
      }
    }
    const rawIds = new Set();
    for (const list of caches.values()) for (const channel of list) rawIds.add(String(channel.id));
    assert.equal(allIds.size, rawIds.size);
    for (const id of rawIds) assert.equal(allIds.has(id), true, `channel ${id} was lost`);
  });

  test("the same invariant holds while the walk is partial (generic cached only, then one specific)", () => {
    for (const partial of [new Map([["7", CHANNELLIST]]), new Map([["42", DEPORTES], ["7", CHANNELLIST]])]) {
      const partialOwners = ownershipFor(partial);
      const seen = new Set();
      for (const [columnId, list] of partial) {
        for (const channel of filterChannelsByOwnership(list, columnId, partialOwners)) {
          const id = String(channel.id);
          assert.equal(seen.has(id), false, `channel ${id} duplicated in partial state`);
          seen.add(id);
        }
      }
    }
  });

  test("progressive refinement only REMOVES items from a category list, never re-adds them", () => {
    const before = filterChannelsByOwnership(CHANNELLIST, "7", ownershipFor(new Map([["7", CHANNELLIST]])));
    const after = filterChannelsByOwnership(CHANNELLIST, "7", ownershipFor(new Map([["42", DEPORTES], ["7", CHANNELLIST]])));
    const afterIds = new Set(after.map((c) => c.id));
    for (const channel of after) assert.equal(before.some((c) => c.id === channel.id), true);
    assert.equal(afterIds.size < before.length, true); // strictly refined
  });
});

describe("rail counts reflect the deduplicated lists (… while unknown)", () => {
  test("a cached category's count is its deduplicated length; an uncached one stays null", () => {
    const caches = new Map([
      ["42", DEPORTES],
      ["7", CHANNELLIST]
    ]);
    const items = buildRailItems({ categories: CATEGORIES, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const deportes = items.find((item) => item.railId === categoryRailId(42));
    const cines = items.find((item) => item.railId === categoryRailId(43));
    const generic = items.find((item) => item.railId === categoryRailId(7));
    assert.equal(deportes.count, 2); // Deportes owns both of its channels
    assert.equal(cines.count, null); // not walked yet: "…"
    // 4 raw minus espn (owned by Deportes); hbo/z/orphan have no cached specific owner yet.
    assert.equal(generic.count, 3);
  });

  test("counts refine when a specific category's cache arrives (channels leave the generic once)", () => {
    const beforeItems = buildRailItems({
      categories: CATEGORIES,
      channelsByColumn: new Map([["7", CHANNELLIST]]),
      favoriteCount: 0,
      recentCount: 0
    });
    const genericBefore = beforeItems.find((item) => item.railId === categoryRailId(7));
    assert.equal(genericBefore.count, 4); // nothing walked yet: shows as-is

    const afterItems = buildRailItems({
      categories: CATEGORIES,
      channelsByColumn: new Map([
        ["42", DEPORTES],
        ["7", CHANNELLIST]
      ]),
      favoriteCount: 0,
      recentCount: 0
    });
    const genericAfter = afterItems.find((item) => item.railId === categoryRailId(7));
    assert.equal(genericAfter.count, 3); // espn left the generic (owned by Deportes)
  });

  test("a source's count is the sum of its deduplicated category counts once every one is cached", () => {
    const caches = new Map([
      ["42", DEPORTES],
      ["43", CINE],
      ["7", CHANNELLIST]
    ]);
    const items = buildRailItems({ categories: CATEGORIES, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const magis = items.find((item) => item.type === "source");
    // Deportes 2 (both owned) + Cine 2 (hbo, tcm; espn owned by Deportes) +
    // ChannelList 2 (ztv, orphan) = 6 unique channels of the 7 raw entries.
    assert.equal(magis.count, 6);
  });
});

describe("search, favourites and recents keep the FULL set (no category dedupe)", () => {
  test("a channel that lives in Deportes is still findable by search", () => {
    assert.equal(channelMatchesQuery({ name: "ESPN Deportes" }, "espn"), true);
    assert.equal(channelMatchesQuery({ name: "Fox Sports" }, "sports"), true);
  });

  test("the search pipeline in the mount module builds the raw union and never applies ownership filtering", () => {
    const mountSource = readFileSync(
      new URL("../js/ui/screens/live/liveScreenMethods-01-mount-and-load.js", import.meta.url),
      "utf8"
    );
    const start = mountSource.indexOf("refreshVisibleChannels()");
    const end = mountSource.indexOf("selectRailItem(", start);
    assert.ok(start >= 0 && end > start, "refreshVisibleChannels exists before selectRailItem");
    const body = mountSource.slice(start, end);
    const searchStart = body.indexOf("if (query)");
    const searchEnd = body.indexOf("} else {", searchStart);
    const searchBranch = body.slice(searchStart, searchEnd);
    assert.match(searchBranch, /union/);
    assert.doesNotMatch(searchBranch, /filterChannelsByOwnership/);
    assert.match(body, /filterChannelsByOwnership/); // the category branch does dedupe
  });
});
