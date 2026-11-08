// Navigation contract for the Live TV LEFT RAIL (pure helpers, no DOM, no
// network — node --test must run fully offline).
//
// The rail's flat item list ([search] [favorites] [recents?] [all]
// [source header, its category rows]...) is the single source of truth for
// up/down movement. These tests pin:
//   1. building the item list from mixed state (empty favourites, no recents,
//      a collapsed source contributing no category rows, all sources
//      collapsed),
//   2. index-based movement clamped at both ends (no wrap, no jump),
//   3. the collapse-removes-focused-item fallback to that source's header,
//   4. first/last boundary behaviour (UP at first -> stays so the handler can
//      lift focus to the hero; DOWN at last -> stays with the ring visible),
//   5. the source contract that the DOM renders exactly ONE row per model
//      item and that focus is re-derived by railId whenever the list changes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildRailItems,
  collapsedSourceIdsRef,
  toggleSourceCollapsed,
  isSourceExpanded,
  clampIndex,
  RAIL_SEARCH_ID,
  RAIL_FAVORITES_ID,
  RAIL_RECENTS_ID,
  RAIL_ALL_ID,
  categoryRailId
} from "../js/ui/screens/live/liveScreenMethods-02-render.js";

// New helpers are resolved through the namespace so this file loads (and the
// buildRailItems contract still runs) even before they exist: each helper
// test then fails observably instead of the whole module failing to link.
import * as railModule from "../js/ui/screens/live/liveScreenMethods-02-render.js";

const railMoveIndex = railModule.railMoveIndex;
const railFocusAfterChange = railModule.railFocusAfterChange;

// Remembered-selection helpers resolve through the namespace too, so the RED
// run fails per test instead of failing to link the module.
const rememberLiveSelection = railModule.rememberLiveSelection;
const readRememberedLiveSelection = railModule.readRememberedLiveSelection;
const forgetLiveSelection = railModule.forgetLiveSelection;
const resolveLiveSelectionRestore = railModule.resolveLiveSelectionRestore;
const LIVE_SELECTION_STORAGE_KEY = railModule.LIVE_SELECTION_STORAGE_KEY;

// The collapse set is a module-level singleton shared with the screen: every
// collapsed-state test must restore it so tests stay order-independent.
function withCollapsedSources(ids, run) {
  const shared = collapsedSourceIdsRef();
  const saved = new Set(shared);
  try {
    for (const id of ids) shared.add(String(id));
    run();
  } finally {
    shared.clear();
    for (const id of saved) shared.add(id);
  }
}

const categories = [
  { columnId: 42, name: "Deportes" },
  { columnId: 43, name: "Noticias" },
  { columnId: "premiumtv:El Salvador – TCS", name: "El Salvador – TCS" }
];
const caches = new Map([
  ["42", [{ id: "magis:live:a" }, { id: "magis:live:b" }]],
  ["43", [{ id: "magis:live:c" }]],
  ["premiumtv:El Salvador – TCS", [{ id: "premiumtv:x" }]]
]);

describe("buildRailItems from mixed state (the movement list)", () => {
  test("empty favourites and no recents: no recents row, Favoritos still present with count 0", () => {
    const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    assert.deepEqual(
      items.filter((item) => item.type !== "category").map((item) => item.railId),
      [RAIL_SEARCH_ID, RAIL_FAVORITES_ID, RAIL_ALL_ID, "source:Magis", "source:PremiumTV"]
    );
    assert.equal(items.find((item) => item.railId === RAIL_FAVORITES_ID).count, 0);
    assert.equal(items.some((item) => item.railId === RAIL_RECENTS_ID), false);
  });

  test("a collapsed source contributes NO category rows to the movement list (but keeps them on its section)", () => {
    withCollapsedSources(["source:Magis"], () => {
      const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
      // Flat movement list: header present, its category rows absent.
      const flatIds = items.map((item) => item.railId);
      assert.ok(flatIds.includes("source:Magis"));
      assert.equal(flatIds.includes(categoryRailId(42)), false);
      assert.equal(flatIds.includes(categoryRailId(43)), false);
      // PremiumTV is still expanded: its rows stay in the flat list.
      assert.ok(flatIds.includes(categoryRailId("premiumtv:El Salvador – TCS")));
      // The section keeps its categories so a later expand is surgical and a
      // focused category can fall back to its header.
      const magis = items.find((item) => item.railId === "source:Magis");
      assert.equal(isSourceExpanded(magis.railId), false);
      assert.deepEqual(magis.categories.map((category) => category.railId), [categoryRailId(42), categoryRailId(43)]);
    });
  });

  test("all sources collapsed: only the fixed rows plus the headers are focusable", () => {
    withCollapsedSources(["source:Magis", "source:PremiumTV"], () => {
      const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 2, recentCount: 1 });
      assert.deepEqual(
        items.map((item) => item.railId),
        [RAIL_SEARCH_ID, RAIL_FAVORITES_ID, RAIL_RECENTS_ID, RAIL_ALL_ID, "source:Magis", "source:PremiumTV"]
      );
      assert.equal(items.some((item) => item.type === "category"), false);
    });
  });

  test("recents appearing shifts every later index by one (movement must follow the CURRENT list)", () => {
    const without = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const withRecents = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 1 });
    const premiumBefore = without.findIndex((item) => item.railId === "source:PremiumTV");
    const premiumAfter = withRecents.findIndex((item) => item.railId === "source:PremiumTV");
    assert.equal(premiumAfter, premiumBefore + 1);
  });
});

describe("railMoveIndex (index-based movement, clamped, no wrap)", () => {
  test("exists as an exported helper", () => {
    assert.equal(typeof railMoveIndex, "function", "railMoveIndex must be exported from liveScreenMethods-02-render.js");
  });

  const items = [{ railId: "a" }, { railId: "b" }, { railId: "c" }];

  test("moves one item per step in both directions", () => {
    assert.equal(railMoveIndex(items, 0, 1), 1);
    assert.equal(railMoveIndex(items, 1, 1), 2);
    assert.equal(railMoveIndex(items, 1, -1), 0);
    assert.equal(railMoveIndex(items, 2, -1), 1);
  });

  test("UP at the first item stays at the first item (the handler lifts focus to the hero)", () => {
    assert.equal(railMoveIndex(items, 0, -1), 0);
  });

  test("DOWN at the last item stays at the last item (ring visible, no wrap, no jump)", () => {
    assert.equal(railMoveIndex(items, 2, 1), 2);
  });

  test("a stale index beyond the list clamps before moving (shorter list after a collapse)", () => {
    assert.equal(railMoveIndex(items, 9, 0), 2);
    assert.equal(railMoveIndex(items, 9, -1), 1);
  });

  test("an empty or missing list collapses to 0 and never throws", () => {
    assert.equal(railMoveIndex([], 3, 1), 0);
    assert.equal(railMoveIndex(undefined, 3, -1), 0);
  });

  test("garbage input collapses to index 0", () => {
    assert.equal(railMoveIndex(items, Number.NaN, 1), 1);
    assert.equal(railMoveIndex(items, undefined, 1), 1);
  });
});

describe("railFocusAfterChange (identity-based focus recovery when the list changes)", () => {
  test("exists as an exported helper", () => {
    assert.equal(
      typeof railFocusAfterChange,
      "function",
      "railFocusAfterChange must be exported from liveScreenMethods-02-render.js"
    );
  });

  test("the focused item's railId still present: focus follows its NEW index (recents appeared above)", () => {
    const before = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const focused = before.find((item) => item.railId === "source:PremiumTV");
    const after = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 1 });
    assert.equal(railFocusAfterChange(after, before.indexOf(focused), focused), after.findIndex((item) => item.railId === focused.railId));
    assert.ok(railFocusAfterChange(after, before.indexOf(focused), focused) > before.indexOf(focused));
  });

  test("the focused category disappeared because its source collapsed: focus moves to that source's header", () => {
    const before = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const focusedCategory = before.find((item) => item.railId === categoryRailId(43));
    withCollapsedSources(["source:Magis"], () => {
      const after = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
      assert.equal(after.some((item) => item.railId === focusedCategory.railId), false);
      // The flat item carries its source; the helper may also discover the
      // owner header from the collapsed section's retained categories.
      assert.equal(
        railFocusAfterChange(after, before.indexOf(focusedCategory), focusedCategory),
        after.findIndex((item) => item.railId === "source:Magis")
      );
    });
  });

  test("the focused category disappeared and only sourceRailId is known: still falls back to the header", () => {
    const after = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const ghost = { type: "category", railId: categoryRailId(999), sourceRailId: "source:PremiumTV" };
    assert.equal(
      railFocusAfterChange(after, 3, ghost),
      after.findIndex((item) => item.railId === "source:PremiumTV")
    );
  });

  test("the focused item is gone without a trace (e.g. recents disappeared): clamps to the last existing item", () => {
    const before = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 1 });
    const last = before[before.length - 1];
    const after = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    assert.equal(railFocusAfterChange(after, before.length - 1, last), after.length - 1);
  });

  test("no previous information at all: clamps the previous index into the list", () => {
    const items = [{ railId: "a" }, { railId: "b" }];
    assert.equal(railFocusAfterChange(items, 7, null), 1);
    assert.equal(railFocusAfterChange(items, -3, null), 0);
    assert.equal(railFocusAfterChange([], 4, { railId: "a" }), 0);
  });
});

describe("remembered Live selection (module-level memory, restore rules)", () => {
  const memoryStorage = () => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key)
    };
  };

  test("helpers exist as exported pure helpers", () => {
    assert.equal(typeof rememberLiveSelection, "function", "rememberLiveSelection must be exported");
    assert.equal(typeof readRememberedLiveSelection, "function", "readRememberedLiveSelection must be exported");
    assert.equal(typeof forgetLiveSelection, "function", "forgetLiveSelection must be exported");
    assert.equal(typeof resolveLiveSelectionRestore, "function", "resolveLiveSelectionRestore must be exported");
  });

  test("remember stores the rail id and focused row; read returns a copy", () => {
    forgetLiveSelection();
    assert.equal(readRememberedLiveSelection(), null);
    rememberLiveSelection({ railId: categoryRailId(42), rowIndex: 3 });
    const remembered = readRememberedLiveSelection();
    assert.deepEqual(remembered, { railId: categoryRailId(42), rowIndex: 3 });
    // A copy, not the live singleton: mutating it must not corrupt the memory.
    remembered.rowIndex = 99;
    assert.equal(readRememberedLiveSelection().rowIndex, 3);
    forgetLiveSelection();
  });

  test("an empty rail id is never remembered", () => {
    forgetLiveSelection();
    assert.equal(rememberLiveSelection({ railId: "", rowIndex: 2 }), null);
    assert.equal(rememberLiveSelection(null), null);
    assert.equal(readRememberedLiveSelection(), null);
  });

  test("round-trips through the namespaced storage key (cheap restart persistence)", () => {
    assert.equal(LIVE_SELECTION_STORAGE_KEY, "nuvio.live.selection.v1");
    forgetLiveSelection();
    const storage = memoryStorage();
    rememberLiveSelection({ railId: categoryRailId(43), rowIndex: 5 }, storage);
    // Memory is authoritative within the session; a fresh session (memory
    // gone) falls back to the namespaced storage.
    forgetLiveSelection();
    assert.deepEqual(readRememberedLiveSelection(storage), { railId: categoryRailId(43), rowIndex: 5 });
    forgetLiveSelection();
  });

  test("corrupt storage payload reads as null, not a crash", () => {
    forgetLiveSelection();
    const storage = memoryStorage();
    storage.setItem(LIVE_SELECTION_STORAGE_KEY, "{not json");
    assert.equal(readRememberedLiveSelection(storage), null);
  });

  test("a storage that throws never breaks the caller", () => {
    forgetLiveSelection();
    const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    assert.doesNotThrow(() => rememberLiveSelection({ railId: categoryRailId(42), rowIndex: 1 }, throwing));
    assert.deepEqual(readRememberedLiveSelection(throwing), { railId: categoryRailId(42), rowIndex: 1 });
    forgetLiveSelection();
  });

  describe("resolveLiveSelectionRestore rules", () => {
    const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 1, recentCount: 2 });

    test("existing rail id: restored at its index with the row clamped to the visible list", () => {
      const expectedIndex = items.findIndex((item) => item.railId === categoryRailId(43));
      assert.deepEqual(resolveLiveSelectionRestore(items, { railId: categoryRailId(43), rowIndex: 7 }, 4), {
        railId: categoryRailId(43),
        index: expectedIndex,
        rowIndex: 3 // 7 clamps into a 4-row list
      });
    });

    test("vanished category (source collapsed): falls back to that source's header", () => {
      withCollapsedSources(["source:Magis"], () => {
        const collapsedItems = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 1, recentCount: 2 });
        assert.equal(collapsedItems.some((item) => item.railId === categoryRailId(42)), false);
        assert.deepEqual(resolveLiveSelectionRestore(collapsedItems, { railId: categoryRailId(42), rowIndex: 2 }, 2), {
          railId: "source:Magis",
          index: collapsedItems.findIndex((item) => item.railId === "source:Magis"),
          rowIndex: 0
        });
      });
    });

    test("vanished source: falls back to the first item", () => {
      assert.deepEqual(resolveLiveSelectionRestore(items, { railId: "cat:vanished-source", rowIndex: 5 }, 3), {
        railId: null,
        index: 0,
        rowIndex: 0
      });
    });

    test("no memory at all: null, so mount keeps today's first-category default", () => {
      assert.equal(resolveLiveSelectionRestore(items, null, 3), null);
      assert.equal(resolveLiveSelectionRestore(items, undefined, 3), null);
    });
  });

  test("tune-in remembers the selection and mount restores it (wiring contract)", () => {
    const tuneSource = readFileSync(
      new URL("../js/ui/screens/live/liveScreenMethods-03-tune-in.js", import.meta.url),
      "utf8"
    );
    const mountSource = readFileSync(
      new URL("../js/ui/screens/live/liveScreenMethods-01-mount-and-load.js", import.meta.url),
      "utf8"
    );
    assert.match(tuneSource, /rememberLiveSelection\(/);
    assert.match(mountSource, /readRememberedLiveSelection\(/);
    assert.match(mountSource, /resolveLiveSelectionRestore\(/);
  });
});

describe("source contract: the DOM renders exactly one row per model item", () => {
  const renderSource = readFileSync(
    new URL("../js/ui/screens/live/liveScreenMethods-02-render.js", import.meta.url),
    "utf8"
  );
  const tuneSource = readFileSync(
    new URL("../js/ui/screens/live/liveScreenMethods-03-tune-in.js", import.meta.url),
    "utf8"
  );
  const mountSource = readFileSync(
    new URL("../js/ui/screens/live/liveScreenMethods-01-mount-and-load.js", import.meta.url),
    "utf8"
  );

  test("renderRail's source branch renders ONLY the header; category rows come from the flat items alone", () => {
    // Duplicate rows (header-inline + flat) made the DOM's data-rail-index
    // values diverge from the model after every surgical toggle, which is
    // what made rail movement get stuck or jump.
    const start = renderSource.indexOf('if (item.type === "source")');
    const end = renderSource.indexOf('if (item.type === "category")', start);
    assert.ok(start >= 0 && end > start, "the rail renders a source branch before its category branch");
    const sourceBranch = renderSource.slice(start, end);
    assert.doesNotMatch(sourceBranch, /renderRailCategory/, "the source branch must not emit category rows inline");
  });

  test("movement is index-based over the current list and clamped (railMoveIndex in moveRail)", () => {
    assert.match(tuneSource, /railMoveIndex\(/);
  });

  test("focus is re-derived by railId whenever the item list can have changed", () => {
    assert.match(renderSource, /railFocusAfterChange\(/, "normalizeFocusState recovers focus by identity");
    assert.match(tuneSource, /railFocusAfterChange\(/, "toggleSource recovers focus by identity");
    assert.match(mountSource, /railFocusId/, "the focused railId is tracked from mount");
  });

  test("the cheap path is preserved: one item per move, no per-keypress measurement, no repeat throttling", () => {
    const moveStart = tuneSource.indexOf("moveRail(delta)");
    const moveEnd = tuneSource.indexOf("moveRows(delta)", moveStart);
    assert.ok(moveStart >= 0 && moveEnd > moveStart, "moveRail exists");
    const movePath = tuneSource.slice(moveStart, moveEnd);
    for (const banned of [
      "getBoundingClientRect",
      "offsetTop",
      "offsetHeight",
      "clientHeight",
      "scrollHeight",
      "innerHTML",
      "Date.now",
      "shouldAcceptRepeatMove",
      "MOVE_CADENCE_MS"
    ]) {
      assert.doesNotMatch(movePath, new RegExp(banned));
    }
    // Native reveal removed the eased scroll and its AnimationTarget bookkeeping.
    assert.doesNotMatch(tuneSource, /SCROLL_ANIMATE_MS|animateListScroll|ensureFocusVisible/);
  });

  test("focus uses the browser's native reveal: plain focus(), no preventScroll, no smooth scroll", () => {
    const applyStart = renderSource.indexOf("applyFocusState() {");
    assert.ok(applyStart >= 0, "applyFocusState exists");
    const applyEnd = renderSource.indexOf("focusedNode() {", applyStart);
    assert.ok(applyEnd > applyStart, "focusedNode follows applyFocusState");
    const applyPath = renderSource.slice(applyStart, applyEnd);
    assert.match(applyPath, /target\.focus\(\)/, "native focus() with default scrolling");
    assert.doesNotMatch(applyPath, /preventScroll|focusWithoutAutoScroll|scrollIntoView/);
    assert.doesNotMatch(renderSource + tuneSource, /behavior:\s*["']smooth["']/);
  });
});
