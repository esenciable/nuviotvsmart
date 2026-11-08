// Background release for the Live TV screen (Samsung memory guide): on
// document.visibilitychange -> hidden, a mounted Live TV screen releases
// everything the return path can rebuild and keeps only light state, then
// restores on return. These tests pin the PURE pieces of that plan:
//   1. which per-category caches are dropped and which are kept,
//   2. the retained light state shape (what makes the return feel instant),
//   3. the restore plan (what gets refetched vs reused),
// plus the lifecycle guards: the release is a no-op when the screen is not
// mounted, cleanup aborts the mount listeners, and a Router-left screen only
// ever loses its rebuildable caches. No DOM, no network — node --test runs
// fully offline.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as liveModule from "../js/ui/screens/live/liveScreenMethods-02-render.js";
import { createLiveScreenMethods01 } from "../js/ui/screens/live/liveScreenMethods-01-mount-and-load.js";
import { forgetLiveSelection } from "../js/ui/screens/live/liveScreen.js";

const planBackgroundCacheRelease = liveModule.planBackgroundCacheRelease;
const retainedLightState = liveModule.retainedLightState;
const planForegroundRestore = liveModule.planForegroundRestore;

describe("planBackgroundCacheRelease (which caches are dropped, which are kept)", () => {
  test("drops every cached category list except the currently selected one", () => {
    const caches = new Map([
      ["catA", [{ id: "a" }]],
      ["catB", [{ id: "b" }]],
      ["catC", []]
    ]);
    const plan = planBackgroundCacheRelease({ channelsByColumn: caches, railSelection: "cat:catB" });
    assert.equal(plan.selectedColumnId, "catB");
    assert.deepEqual([...plan.keep], ["catB"]);
    assert.deepEqual([...plan.drop].sort(), ["catA", "catC"]);
  });

  test("a non-category selection (favourites / recents / search) keeps no cache", () => {
    const caches = new Map([
      ["catA", [{ id: "a" }]],
      ["catB", [{ id: "b" }]]
    ]);
    for (const railSelection of ["__favorites__", "__recents__", "__search__", ""]) {
      const plan = planBackgroundCacheRelease({ channelsByColumn: caches, railSelection });
      assert.equal(plan.selectedColumnId, null, railSelection);
      assert.deepEqual([...plan.keep], [], railSelection);
      assert.deepEqual([...plan.drop].sort(), ["catA", "catB"], railSelection);
    }
  });

  test("garbage input degrades to an empty plan, never a throw", () => {
    const plan = planBackgroundCacheRelease({ channelsByColumn: "not a map", railSelection: null });
    assert.deepEqual(plan, { keep: [], drop: [], selectedColumnId: null });
    const empty = planBackgroundCacheRelease();
    assert.deepEqual(empty, { keep: [], drop: [], selectedColumnId: null });
  });
});

describe("retainedLightState (the light state a release keeps)", () => {
  test("retains exactly the instant-return fields and nothing heavy", () => {
    const snapshot = retainedLightState(
      {
        railSelection: "cat:catB",
        railFocusId: "cat:catB",
        railIndex: 3,
        rowIndex: 12,
        rowFocusTarget: "row",
        focusZone: "rows",
        searchActive: true,
        searchQuery: " deport",
        keyboardIndex: 5,
        favoriteIds: ["magis:live:1", "premiumtv:9"],
        recentChannels: [{ id: "magis:live:1", name: "A", number: 1 }],
        // Heavy state that must NEVER leak into the snapshot:
        channels: [{ id: "x" }],
        channelsByColumn: new Map([["catB", [{ id: "x" }]]]),
        categories: [{ columnId: "catB", name: "B" }],
        heroChannel: { id: "x" }
      },
      { scrollTop: 456 }
    );
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "favoriteIds",
      "focusZone",
      "keyboardIndex",
      "railFocusId",
      "railIndex",
      "railSelection",
      "recentChannels",
      "rowFocusTarget",
      "rowIndex",
      "scrollTop",
      "searchActive",
      "searchQuery"
    ]);
    assert.equal(snapshot.railSelection, "cat:catB");
    assert.equal(snapshot.railFocusId, "cat:catB");
    assert.equal(snapshot.railIndex, 3);
    assert.equal(snapshot.rowIndex, 12);
    assert.equal(snapshot.searchQuery, " deport");
    assert.equal(snapshot.scrollTop, 456);
  });

  test("the snapshot is a copy: mutating it can never alias the live state", () => {
    const favoriteIds = ["a", "b"];
    const recentChannels = [{ id: "a", name: "A", number: 1 }];
    const snapshot = retainedLightState({ favoriteIds, recentChannels }, { scrollTop: 57 });
    snapshot.favoriteIds.push("c");
    snapshot.recentChannels[0].name = "changed";
    assert.deepEqual(favoriteIds, ["a", "b"]);
    assert.equal(recentChannels[0].name, "A");
  });

  test("garbage input clamps to safe defaults", () => {
    const snapshot = retainedLightState(null, { scrollTop: -30 });
    assert.equal(snapshot.scrollTop, 0);
    assert.equal(snapshot.railIndex, 0);
    assert.equal(snapshot.rowFocusTarget, "row");
    assert.equal(snapshot.focusZone, "rail");
    assert.deepEqual(snapshot.favoriteIds, []);
    assert.deepEqual(snapshot.recentChannels, []);
    const defaults = retainedLightState({}, {});
    assert.equal(defaults.scrollTop, 0);
    assert.equal(defaults.searchActive, false);
  });
});

describe("planForegroundRestore (what gets refetched vs reused)", () => {
  test("a selected category whose cache survived is reused, not refetched", () => {
    const plan = planForegroundRestore({
      railSelection: "cat:catB",
      cachedColumnIds: ["catB"],
      droppedColumnIds: ["catA", "catC"]
    });
    assert.equal(plan.selectedColumnId, "catB");
    assert.equal(plan.selectionWasDropped, false);
    assert.deepEqual([...plan.refetchColumnIds], []);
    assert.deepEqual([...plan.reuseColumnIds].sort(), ["catB"]);
    assert.equal(plan.rearmPreload, true); // the dropped ones come back via the preload
  });

  test("a selected category whose cache was dropped is refetched from the network", () => {
    const plan = planForegroundRestore({
      railSelection: "cat:catB",
      cachedColumnIds: ["catA"],
      droppedColumnIds: ["catB"]
    });
    assert.equal(plan.selectedColumnId, "catB");
    assert.equal(plan.selectionWasDropped, true);
    assert.deepEqual([...plan.refetchColumnIds], ["catB"]);
    assert.deepEqual([...plan.reuseColumnIds].sort(), ["catA"]);
    assert.equal(plan.rearmPreload, true);
  });

  test("favourites / recents / search repaint from the surviving caches while the preload refetches the dropped ones", () => {
    const plan = planForegroundRestore({
      railSelection: "__favorites__",
      cachedColumnIds: ["catB"],
      droppedColumnIds: ["catA", "catC"]
    });
    assert.equal(plan.selectedColumnId, null);
    assert.equal(plan.selectionWasDropped, true);
    assert.deepEqual([...plan.refetchColumnIds].sort(), ["catA", "catC"]);
    assert.deepEqual([...plan.reuseColumnIds], ["catB"]);
    assert.equal(plan.rearmPreload, true);
  });

  test("nothing dropped: nothing is refetched and the preload is not re-armed", () => {
    const plan = planForegroundRestore({
      railSelection: "__recents__",
      cachedColumnIds: ["catA", "catB"],
      droppedColumnIds: []
    });
    assert.deepEqual([...plan.refetchColumnIds], []);
    assert.deepEqual([...plan.reuseColumnIds].sort(), ["catA", "catB"]);
    assert.equal(plan.rearmPreload, false);
    assert.equal(plan.selectionWasDropped, false);
  });
});

describe("release / restore lifecycle guards (methods over a fake screen state)", () => {
  function makeMethods() {
    return createLiveScreenMethods01();
  }

  // A fake screen state that still resolves sibling methods (release calls
  // dropBackgroundCaches, cleanup calls clearNoticeTimer).
  function screenWith(methods, state) {
    return Object.assign(Object.create(methods), state);
  }

  test("the release is a no-op when the screen is not mounted", () => {
    const methods = makeMethods();
    const state = {
      _liveMounted: false,
      railSelection: "cat:a",
      noticeTimer: 5,
      channelsByColumn: new Map([["a", [{ id: "a" }]]]),
      container: null
    };
    methods.releaseForBackground.call(screenWith(methods, state));
    assert.equal(state.channelsByColumn.size, 1); // nothing dropped
    assert.equal(state.noticeTimer, 5); // no timer work either
  });

  test("when the Router already left the screen the release is a no-op beyond clearing caches", () => {
    const methods = makeMethods();
    const state = {
      _liveMounted: true,
      railSelection: "cat:b",
      noticeTimer: 5,
      channelsByColumn: new Map([
        ["a", [{ id: "a" }]],
        ["b", [{ id: "b" }]]
      ]),
      container: null
    };
    // In node the Router stub has no getCurrent, so the screen counts as left.
    methods.releaseForBackground.call(screenWith(methods, state));
    assert.equal(state.channelsByColumn.has("a"), false); // rebuildable cache cleared
    assert.equal(state.channelsByColumn.has("b"), true); // the selected one kept
    assert.equal(state.noticeTimer, 5); // no timer, DOM or focus work
    assert.equal(state._releasedForBackground, undefined);
    assert.equal(state._backgroundRetained, undefined);
  });

  test("cleanup aborts the mount listeners and every pending controller", () => {
    const methods = makeMethods();
    const aborted = [];
    const state = {
      loadToken: 1,
      railSelection: "cat:a",
      rowIndex: 3,
      noticeTimer: 7,
      categoriesController: { abort: () => aborted.push("categories") },
      categoryLoadController: { abort: () => aborted.push("categoryLoad") },
      resolveController: { abort: () => aborted.push("resolve") },
      _mountListeners: { abort: () => aborted.push("listeners") },
      clearNoticeTimer() {
        this.noticeTimer = 0;
      },
      container: null
    };
    const screen = screenWith(methods, state);
    methods.cleanup.call(screen);
    assert.deepEqual(aborted.sort(), ["categories", "categoryLoad", "listeners", "resolve"]);
    assert.equal(screen._liveMounted, false);
    assert.equal(screen._mountListeners, null);
    assert.equal(screen.noticeTimer, 0);
    forgetLiveSelection(); // cleanup remembered the selection; reset the memory
  });
});
