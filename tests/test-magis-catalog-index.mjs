// Generated Magis catalog index: the ownership rule is computed OFFLINE by
// scripts/magis-catalog-index.mjs (`npm run catalog:index`) and shipped as
// js/core/magis/catalog-index.json. The TV never computes it and never walks
// the portal to fill rail counts. These tests pin the pure computation the
// generator uses (fixtures only — no network) and the shipped index shape.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GENERIC_CATEGORY_NAME,
  isGenericCategoryName,
  computeCatalogOwnership,
  buildCatalogIndex
} from "../scripts/magis-catalog-index.mjs";

// Catalog fixtures: Deportes (42) then Cine (43) then the generic
// ChannelList (7) — the same catalog order the portal reports. Channels may
// span categories; ids/codes are the stable portal codes.
const CATEGORIES = [
  { columnId: 42, name: "Deportes" },
  { columnId: 43, name: "Cine y Series" },
  { columnId: 7, name: "ChannelList" }
];
const DEPORTES = [
  { code: "espn", name: "ESPN", number: 1 },
  { code: "fox", name: "Fox Sports", number: 2 }
];
const CINE = [
  { code: "hbo", name: "HBO", number: 3 },
  { code: "espn", name: "ESPN", number: 1 }, // also in Deportes: Deportes (first specific) owns it
  { code: "tcm", name: "TCM", number: 4 }
];
const CHANNELLIST = [
  { code: "espn", name: "ESPN", number: 1 }, // owned by Deportes
  { code: "hbo", name: "HBO", number: 3 }, // owned by Cine y Series
  { code: "ztv", name: "ZTV", number: 5 }, // only here: the generic keeps it
  { code: "orphan", name: "Orphan", number: null } // only here too
];

function cachesFor(entries) {
  return new Map(entries.map(([columnId, list]) => [String(columnId), list]));
}

function ownershipFor(entries) {
  return computeCatalogOwnership({ categories: CATEGORIES, channelsByCategory: cachesFor(entries) });
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

describe("computeCatalogOwnership (specific beats generic, first specific wins)", () => {
  test("a channel in a specific category and the generic catalogue is owned by the SPECIFIC one", () => {
    const { owners } = ownershipFor([
      ["42", DEPORTES],
      ["7", CHANNELLIST]
    ]);
    assert.equal(owners.get("espn"), "42");
  });

  test("among specific categories, the FIRST one in catalog order wins ties", () => {
    const { owners } = ownershipFor([
      ["42", DEPORTES],
      ["43", CINE]
    ]);
    assert.equal(owners.get("espn"), "42"); // Deportes precedes Cine y Series
    assert.equal(owners.get("hbo"), "43");
  });

  test("the rule holds whatever the catalog order puts first (generic listed before specifics)", () => {
    const genericFirst = [
      { columnId: 7, name: "ChannelList" },
      { columnId: 42, name: "Deportes" }
    ];
    const { owners } = computeCatalogOwnership({
      categories: genericFirst,
      channelsByCategory: cachesFor([
        ["7", CHANNELLIST],
        ["42", DEPORTES]
      ])
    });
    assert.equal(owners.get("espn"), "42"); // the specific still beats the generic
    assert.equal(owners.get("ztv"), "7");
  });

  test("a channel only in the generic catalogue stays there (owned by ChannelList)", () => {
    const { owners } = ownershipFor([["7", CHANNELLIST]]);
    assert.equal(owners.get("ztv"), "7");
    assert.equal(owners.get("orphan"), "7");
  });

  test("a channel in NO category has no owner", () => {
    const { owners } = ownershipFor([["42", DEPORTES]]);
    assert.equal(owners.has("nowhere"), false);
    assert.equal(owners.get("nowhere"), undefined);
  });

  test("malformed rows (no code) are skipped, not thrown on", () => {
    const { owners } = computeCatalogOwnership({
      categories: CATEGORIES,
      channelsByCategory: cachesFor([["42", [{ name: "no code" }, { code: "ok", name: "Ok" }]]])
    });
    assert.equal(owners.size, 1);
    assert.equal(owners.get("ok"), "42");
  });
});

describe("counts AFTER dedupe (what the rail shows without any portal call)", () => {
  test("a specific category counts exactly the channels it owns; the generic counts its leftovers", () => {
    const { counts } = ownershipFor([
      ["42", DEPORTES],
      ["43", CINE],
      ["7", CHANNELLIST]
    ]);
    assert.equal(counts.get("42"), 2); // espn, fox (both owned)
    assert.equal(counts.get("43"), 2); // hbo, tcm (espn owned by Deportes)
    assert.equal(counts.get("7"), 2); // ztv, orphan only
  });

  test("the same invariant holds with partial walks (only the generic cached)", () => {
    const { counts } = ownershipFor([["7", CHANNELLIST]]);
    assert.equal(counts.get("7"), 4); // nothing specific walked yet
  });
});

describe("leftovers (exactly the channels no specific category owns)", () => {
  test("the generic's unclaimed channels, with code/name/number preserved", () => {
    const { leftovers } = ownershipFor([
      ["42", DEPORTES],
      ["43", CINE],
      ["7", CHANNELLIST]
    ]);
    assert.deepEqual(leftovers, [
      { code: "ztv", name: "ZTV", number: 5 },
      { code: "orphan", name: "Orphan", number: null }
    ]);
  });

  test("leftovers is empty when every generic channel is owned by a specific category", () => {
    const everythingOwned = [{ code: "espn", name: "ESPN", number: 1 }];
    const { leftovers } = computeCatalogOwnership({
      categories: CATEGORIES,
      channelsByCategory: cachesFor([
        ["42", everythingOwned],
        ["7", everythingOwned]
      ])
    });
    assert.deepEqual(leftovers, []);
  });

  test("no generic category at all: no leftovers", () => {
    const { leftovers } = ownershipFor([
      ["42", DEPORTES],
      ["43", CINE]
    ]);
    assert.deepEqual(leftovers, []);
  });
});

describe("buildCatalogIndex (the shipped JSON shape)", () => {
  test("carries generatedAt, the generic name, deduped counts and leftovers", () => {
    const index = buildCatalogIndex({
      categories: CATEGORIES,
      channelsByCategory: cachesFor([
        ["42", DEPORTES],
        ["43", CINE],
        ["7", CHANNELLIST]
      ]),
      generatedAt: "2026-02-11T00:00:00.000Z"
    });
    assert.deepEqual(Object.keys(index).sort(), ["categories", "generatedAt", "genericCategoryName", "leftovers"]);
    assert.equal(index.generatedAt, "2026-02-11T00:00:00.000Z");
    assert.equal(index.genericCategoryName, "ChannelList");
    assert.deepEqual(
      index.categories.map((entry) => [entry.columnId, entry.name, entry.count]),
      [
        [42, "Deportes", 2],
        [43, "Cine y Series", 2],
        [7, "ChannelList", 2]
      ]
    );
    assert.deepEqual(index.leftovers, [
      { code: "ztv", name: "ZTV", number: 5 },
      { code: "orphan", name: "Orphan", number: null }
    ]);
  });

  test("categories keep the portal's catalog order and every category appears (even empty ones)", () => {
    const index = buildCatalogIndex({
      categories: [
        { columnId: 1, name: "Vacia" },
        { columnId: 2, name: "ChannelList" }
      ],
      channelsByCategory: cachesFor([
        ["1", []],
        ["2", [{ code: "a", name: "A", number: 1 }]]
      ]),
      generatedAt: "2026-02-11T00:00:00.000Z"
    });
    assert.deepEqual(index.categories.map((entry) => entry.columnId), [1, 2]);
    assert.equal(index.categories[0].count, 0);
    assert.equal(index.categories[1].count, 1);
  });
});

describe("the shipped js/core/magis/catalog-index.json", () => {
  const raw = readFileSync(new URL("../js/core/magis/catalog-index.json", import.meta.url), "utf8");
  const index = JSON.parse(raw);

  test("has exactly the four contract keys", () => {
    assert.deepEqual(Object.keys(index).sort(), ["categories", "generatedAt", "genericCategoryName", "leftovers"]);
    assert.equal(index.genericCategoryName, "ChannelList");
  });

  test("every category entry is { columnId, name, count } with a non-negative integer count", () => {
    assert.ok(Array.isArray(index.categories));
    for (const entry of index.categories) {
      assert.deepEqual(Object.keys(entry).sort(), ["columnId", "count", "name"]);
      assert.equal(Number.isInteger(entry.count) && entry.count >= 0, true, `count for ${entry.columnId}`);
      assert.equal(String(entry.name ?? "").trim() !== "", true);
    }
  });

  test("every leftover entry is { code, name, number } with a non-empty code", () => {
    assert.ok(Array.isArray(index.leftovers));
    for (const entry of index.leftovers) {
      assert.deepEqual(Object.keys(entry).sort(), ["code", "name", "number"]);
      assert.equal(String(entry.code ?? "").trim() !== "", true);
    }
  });

  test("counts and leftovers agree: leftovers length is the generic category's count", () => {
    const generic = (index.categories || []).find(
      (entry) => isGenericCategoryName(entry?.name, index.genericCategoryName)
    );
    if (generic) {
      assert.equal(index.leftovers.length, generic.count);
    }
  });
});
