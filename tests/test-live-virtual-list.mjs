// Virtualized channel list (windowing helpers). Pure functions only: no DOM,
// no network — node --test must run fully offline.
//
// Samsung's memory guide requires any TV list over ~100 items to be
// virtualized; the Live TV channel list can hold 500 rows. These tests pin
// the PURE windowing model the DOM sync implements:
//   1. the visible window plus a buffer (about 8 rows above and below),
//   2. clamping at both ends of the list,
//   3. short lists (fewer rows than the window) render fully,
//   4. the focused index is forced inside the window (both the focus-move
//      re-anchor and the scroll-path extension, so the focused node always
//      exists and plain focus() can reveal it natively),
//   5. the spacer arithmetic preserves the full scroll height exactly (the
//      flex gap between the spacer and its rows is part of the pitch math).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as liveModule from "../js/ui/screens/live/liveScreenMethods-02-render.js";
import { createLiveScreenMethods03 } from "../js/ui/screens/live/liveScreenMethods-03-tune-in.js";

// Helpers resolve through the namespace so this file loads (and the existing
// module contract still runs) even before they exist: each helper test then
// fails observably instead of the whole module failing to link.
const LIVE_ROW_HEIGHT = liveModule.LIVE_ROW_HEIGHT;
const LIVE_ROW_GAP = liveModule.LIVE_ROW_GAP;
const LIVE_ROW_PITCH = liveModule.LIVE_ROW_PITCH;
const LIVE_VIRTUAL_BUFFER = liveModule.LIVE_VIRTUAL_BUFFER;
const computeChannelWindow = liveModule.computeChannelWindow;
const channelSpacerHeights = liveModule.channelSpacerHeights;

describe("virtual list constants (fixed geometry)", () => {
  test("the row pitch is the fixed row height plus the fixed flex gap", () => {
    assert.equal(LIVE_ROW_HEIGHT, 51);
    assert.equal(LIVE_ROW_GAP, 6);
    assert.equal(LIVE_ROW_PITCH, 57);
  });

  test("the buffer is about 8 rows above and below the viewport", () => {
    assert.equal(LIVE_VIRTUAL_BUFFER, 8);
  });
});

describe("computeChannelWindow (viewport window + buffer, clamped at both ends)", () => {
  const VIEWPORT = 570; // exactly 10 rows at the 57px pitch

  test("at the top the window never starts before row 0", () => {
    const win = computeChannelWindow({ total: 500, scrollTop: 0, viewportHeight: VIEWPORT });
    assert.equal(win.start, 0);
    assert.equal(win.end, 10 + LIVE_VIRTUAL_BUFFER); // visible rows + bottom buffer
  });

  test("mid-list the window covers the viewport plus the buffer on both sides", () => {
    const win = computeChannelWindow({ total: 500, scrollTop: 100 * 57, viewportHeight: VIEWPORT });
    assert.equal(win.start, 100 - LIVE_VIRTUAL_BUFFER);
    assert.equal(win.end, 110 + LIVE_VIRTUAL_BUFFER);
  });

  test("at the bottom the window never ends past the last row", () => {
    const win = computeChannelWindow({ total: 500, scrollTop: 490 * 57, viewportHeight: VIEWPORT });
    assert.equal(win.end, 500);
    assert.equal(win.start, 500 - 10 - LIVE_VIRTUAL_BUFFER);
  });

  test("garbage scroll and viewport input degrade to a safe window, not a crash", () => {
    const win = computeChannelWindow({ total: 500, scrollTop: Number.NaN, viewportHeight: Number.NaN });
    assert.equal(win.start, 0);
    assert.ok(win.end > win.start);
    const empty = computeChannelWindow({ total: 0, scrollTop: 0, viewportHeight: VIEWPORT });
    assert.deepEqual(empty, { start: 0, end: 0 });
  });

  test("a short list (fewer rows than the window) renders fully", () => {
    const win = computeChannelWindow({ total: 5, scrollTop: 0, viewportHeight: VIEWPORT });
    assert.deepEqual(win, { start: 0, end: 5 });
    const win2 = computeChannelWindow({ total: 12, scrollTop: 0, viewportHeight: VIEWPORT });
    assert.deepEqual(win2, { start: 0, end: 12 });
  });
});

describe("computeChannelWindow (the focused index is forced inside the window)", () => {
  const VIEWPORT = 570;

  test("focus mode (a focus move): the window re-anchors around the focused row so its node exists and focus() can reveal it", () => {
    const win = computeChannelWindow({
      total: 500,
      scrollTop: 0, // the browser has not scrolled yet
      viewportHeight: VIEWPORT,
      focusIndex: 450,
      mode: "focus"
    });
    assert.equal(win.start, 450 - LIVE_VIRTUAL_BUFFER);
    assert.equal(win.end, 450 + 1 + LIVE_VIRTUAL_BUFFER);
  });

  test("focus mode keeps the viewport window when the focused row is already inside it (no churn on normal moves)", () => {
    const win = computeChannelWindow({
      total: 500,
      scrollTop: 100 * 57,
      viewportHeight: VIEWPORT,
      focusIndex: 105, // inside the viewport window
      mode: "focus"
    });
    assert.equal(win.start, 100 - LIVE_VIRTUAL_BUFFER);
    assert.equal(win.end, 110 + LIVE_VIRTUAL_BUFFER);
  });

  test("scroll mode: the window extends to include a focused row the wheel moved away from — the recompute never drops its node", () => {
    const win = computeChannelWindow({
      total: 500,
      scrollTop: 200 * 57, // the wheel is at rows ~200-210
      viewportHeight: VIEWPORT,
      focusIndex: 450, // far away
      mode: "scroll"
    });
    assert.equal(win.start, 200 - LIVE_VIRTUAL_BUFFER); // viewport side kept
    assert.equal(win.end, 450 + 1 + LIVE_VIRTUAL_BUFFER); // focus side forced in
    assert.ok(win.start <= 450 && 450 < win.end);
  });

  test("both modes force a focused row just outside the buffer into the window", () => {
    for (const mode of ["focus", "scroll"]) {
      const win = computeChannelWindow({
        total: 500,
        scrollTop: 0,
        viewportHeight: VIEWPORT,
        focusIndex: 30, // past the default bottom buffer (18)
        mode
      });
      assert.ok(win.start <= 30 && 30 < win.end, `mode ${mode}: focus 30 must be inside`);
    }
  });

  test("no focus (rail zone) leaves the plain viewport window", () => {
    const win = computeChannelWindow({ total: 500, scrollTop: 100 * 57, viewportHeight: VIEWPORT, focusIndex: -1 });
    assert.equal(win.start, 100 - LIVE_VIRTUAL_BUFFER);
    assert.equal(win.end, 110 + LIVE_VIRTUAL_BUFFER);
  });

  test("an out-of-range focus index is ignored, never thrown on", () => {
    for (const focusIndex of [-5, 500, 999, Number.NaN, undefined]) {
      const win = computeChannelWindow({ total: 500, scrollTop: 0, viewportHeight: VIEWPORT, focusIndex });
      assert.equal(win.start, 0);
    }
  });
});

describe("channelSpacerHeights (spacer arithmetic preserves the exact scroll height)", () => {
  test("top spacer covers the rows above the window, minus the flex gap the spacer-to-row gap contributes", () => {
    const spacers = channelSpacerHeights({ start: 10, end: 40, total: 500 });
    assert.equal(spacers.topSpacerHeight, 10 * 57 - 6);
    assert.equal(spacers.bottomSpacerHeight, 460 * 57 - 6);
  });

  test("a window at the top emits no top spacer; a window at the end emits no bottom spacer", () => {
    const top = channelSpacerHeights({ start: 0, end: 18, total: 500 });
    assert.equal(top.topSpacerHeight, 0);
    const bottom = channelSpacerHeights({ start: 492, end: 500, total: 500 });
    assert.equal(bottom.bottomSpacerHeight, 0);
  });

  test("spacers + window rows reproduce the full list height exactly (row pitch includes the gap)", () => {
    const total = 500;
    const start = 10;
    const end = 40;
    const { topSpacerHeight, bottomSpacerHeight } = channelSpacerHeights({ start, end, total });
    const rowCount = end - start;
    // DOM children: [top spacer, rowCount rows, bottom spacer] -> rowCount+1 gaps.
    const windowedHeight =
      topSpacerHeight + bottomSpacerHeight + rowCount * LIVE_ROW_HEIGHT + (rowCount + 1) * LIVE_ROW_GAP;
    const fullHeight = total * LIVE_ROW_HEIGHT + (total - 1) * LIVE_ROW_GAP;
    assert.equal(windowedHeight, fullHeight);
  });

  test("a fully rendered short list needs no spacers and keeps the full height", () => {
    const { topSpacerHeight, bottomSpacerHeight } = channelSpacerHeights({ start: 0, end: 5, total: 5 });
    assert.equal(topSpacerHeight, 0);
    assert.equal(bottomSpacerHeight, 0);
    const fullHeight = 5 * LIVE_ROW_HEIGHT + 4 * LIVE_ROW_GAP;
    assert.equal(5 * LIVE_ROW_HEIGHT + 4 * LIVE_ROW_GAP, fullHeight);
  });
});

// ---------------------------------------------------------------------------
// Focus-index → window → paint ordering (pure).
//
// The movement contract: a keypress updates the focus index FIRST, the window
// is then derived from that index (never from a stale scroll position alone),
// and the paint puts the focused row's node in the DOM BEFORE focus is
// applied. These tests pin the window half of that ordering with the browser
// reveal lagging behind (held keys, deferred scroll events).
// ---------------------------------------------------------------------------
describe("computeChannelWindow (focus index → window ordering while the reveal lags)", () => {
  const VIEWPORT = 570; // 10 rows at the 57px pitch

  test("walking the focus index one row per press over a STALE scroll position always yields a window containing the focus", () => {
    // Held-key auto-repeat: the browser reveal (and its scroll events) lags
    // behind the focus index, so every press must recompute the window from
    // the focus index against whatever scrollTop the browser still reports.
    let scrollTop = 0;
    for (let focusIndex = 0; focusIndex <= 60; focusIndex += 1) {
      const win = computeChannelWindow({ total: 500, scrollTop, viewportHeight: VIEWPORT, focusIndex, mode: "focus" });
      assert.ok(win.start <= focusIndex && focusIndex < win.end, `focus ${focusIndex} with stale scrollTop ${scrollTop} must be inside its window`);
      // the reveal only catches up when the platform dispatches the scroll
      if (focusIndex % 5 === 0) scrollTop = Math.max(0, focusIndex * LIVE_ROW_PITCH);
    }
  });

  test("the boundary rows keep the window clamped: row 0 never starts below 0, the last row never ends past the list", () => {
    const first = computeChannelWindow({ total: 500, scrollTop: 0, viewportHeight: VIEWPORT, focusIndex: 0, mode: "focus" });
    assert.equal(first.start, 0);
    assert.ok(first.end > 0);
    const last = computeChannelWindow({ total: 500, scrollTop: 0, viewportHeight: VIEWPORT, focusIndex: 499, mode: "focus" });
    assert.equal(last.end, 500);
    assert.ok(last.start <= 499 && 499 < last.end);
  });
});

// ---------------------------------------------------------------------------
// The pooled-row paint (fake DOM).
//
// A minimal deterministic DOM stub drives the REAL syncChannelWindow /
// fillChannelRowNode / applyFocusState / moveRows code paths offline. The
// stub models the one platform behaviour the defect lives on: focus() on a
// node without a tabindex is a NO-OP (no ring, no native reveal).
// ---------------------------------------------------------------------------

// The one "active element" of the fake document.
let fakeActiveElement = null;

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag);
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this._classes = new Set();
    // tabIndex starts UNSET: the platform treats such a node as not focusable.
    this.tabIndex;
    this.focusCalls = 0;
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
        return next;
      },
      contains: (name) => classes.has(name)
    };
  }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() {
    return Array.from(this._classes).join(" ");
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  get innerHTML() {
    return this._innerHTML || "";
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get nextSibling() {
    const i = this.parent ? this.parent.children.indexOf(this) : -1;
    return i >= 0 ? this.parent.children[i + 1] ?? null : null;
  }
  appendChild(node) {
    this.insertBefore(node, null);
    return node;
  }
  insertBefore(node, anchor) {
    // A real DOM insertBefore MOVES the node: detach it from the old parent.
    if (node.parent) {
      const old = node.parent.children.indexOf(node);
      if (old >= 0) node.parent.children.splice(old, 1);
    }
    node.parent = this;
    const i = anchor ? this.children.indexOf(anchor) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) {
      // the real DOM camelizes: data-row-index -> dataset.rowIndex
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    }
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  matches(selector) {
    const attrs = [];
    const rest = String(selector).replace(/\[data-([a-zA-Z-]+)="([^"]*)"\]/g, (_, key, value) => {
      attrs.push([`data-${key}`, value]);
      return "";
    });
    const classTokens = rest.split(".").filter(Boolean);
    for (const token of classTokens) {
      if (!this._classes.has(token)) return false;
    }
    for (const [name, value] of attrs) {
      if (String(this.attributes[name] ?? "") !== value) return false;
    }
    return true;
  }
  descendants() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.descendants().find((node) => node.matches(selector)) ?? null;
  }
  querySelectorAll(selector) {
    return this.descendants().filter((node) => node.matches(selector));
  }
  // Platform behaviour: focus() on a node without a focusable tabindex does
  // NOTHING — no focus, no native scroll reveal.
  focus() {
    if (this.tabIndex == null || Number(this.tabIndex) < 0) return false;
    this.focusCalls += 1;
    fakeActiveElement = this;
    return true;
  }
}

// The whole press path of the rows zone: moveRows (methods-03) then
// applyFocusState (methods-02) — the real production ordering.
function buildFakeListScreen(total, viewportHeight) {
  const documentStub = { createElement: (tag) => new FakeElement(tag) };
  const previousDocument = globalThis.document;
  globalThis.document = documentStub;

  const methods02 = liveModule.createLiveScreenMethods02();
  const harness = Object.create(methods02);
  // moveRows / the press path live in the key-handling methods object.
  Object.assign(harness, createLiveScreenMethods03());
  harness.channels = Array.from({ length: total }, (_, index) => ({ id: `ch:${index}`, name: `Canal ${index}`, number: index + 1 }));
  harness.focusZone = "rows";
  harness.rowIndex = 0;
  harness.rowFocusTarget = "row";
  harness.railIndex = 0;
  harness.railFocusId = null;
  harness.railSelection = "";
  harness.heroChannel = null;
  harness.favoriteSet = new Set();
  harness.recentChannels = [];
  harness.categories = [];
  harness.channelsByColumn = new Map();
  harness.isFavoriteId = () => false;
  harness.keyboardOpen = false;
  harness.notice = null;

  const container = new FakeElement("div");
  const body = new FakeElement("div");
  body.className = "live-body";
  const list = new FakeElement("div");
  list.className = "live-channel-list";
  list.setAttribute("data-virtual-list", "true");
  body.appendChild(list);
  container.appendChild(body);
  harness.container = container;
  harness.list = list;
  list.scrollTop = 0;

  // prepareChannelWindow minus the measurement/binding: fixed viewport,
  // initial paint anchored on the focused row (mode "focus").
  harness._virtualMeasurePending = false;
  harness._virtualViewportHeight = viewportHeight;
  harness._virtualWindow = null;
  harness._virtualPendingScrollTop = null;
  harness.syncChannelWindow({ focusIndex: 0, mode: "focus" });
  // render() ends with ScreenUtils.indexFocusables(this.container): every row
  // of the INITIAL paint gets its tabindex there.
  list.querySelectorAll(".live-channel-row").forEach((node) => {
    node.tabIndex = 0;
  });

  // The browser reveal: after a successful focus(), the platform scrolls the
  // focused row into view (minimal scroll) and a scroll event follows later.
  let pendingScroll = false;
  harness.revealIfFocused = (node) => {
    if (!node || node.focusCalls === 0) return;
    const index = Number(node.dataset.rowIndex);
    const top = index * LIVE_ROW_PITCH;
    const bottom = top + LIVE_ROW_HEIGHT;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + viewportHeight;
    if (top < viewTop) list.scrollTop = top;
    else if (bottom > viewBottom) list.scrollTop = bottom - viewportHeight;
    pendingScroll = true;
  };
  harness.pumpScrollEvents = () => {
    if (!pendingScroll) return;
    pendingScroll = false;
    harness.syncChannelWindow({ focusIndex: harness.focusZone === "rows" ? harness.rowIndex : -1, mode: "scroll" });
  };
  // One press of the rows zone, exactly as onKeyDown → handleVertical runs it.
  harness.pressRow = (delta) => {
    fakeActiveElement = null;
    harness.moveRows(delta);
    const focusedIndexBefore = harness.rowIndex;
    harness.applyFocusState();
    const node = list.querySelector(`[data-row-index="${focusedIndexBefore}"]`);
    harness.revealIfFocused(node);
    harness.pumpScrollEvents();
    return node;
  };
  harness.dispose = () => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    fakeActiveElement = null;
  };
  return harness;
}

describe("channel window sync (fake DOM): each press moves exactly one row and focus always lands on a focusable node", () => {
  const VIEWPORT = 570; // 10 visible rows at the 57px pitch

  test("walking DOWN from the top: every press lands on the right row, the ring never lands on an unfocusable node, and the reveal engages", () => {
    const harness = buildFakeListScreen(500, VIEWPORT);
    try {
      for (let expected = 1; expected <= 40; expected += 1) {
        harness.pressRow(1);
        assert.equal(harness.rowIndex, expected, `press ${expected}: exactly one row per press`);
        const focused = harness.list.querySelector(`[data-row-index="${expected}"]`);
        assert.ok(focused, `press ${expected}: the focused row exists in the DOM`);
        assert.equal(focused.tabIndex, 0, `press ${expected}: the focused row is focusable (tabindex stamped)`);
        assert.ok(focused.focusCalls > 0, `press ${expected}: focus() engaged on the focused row (native reveal possible)`);
        assert.equal(fakeActiveElement, focused, `press ${expected}: the ring is on the row the model points at`);
      }
    } finally {
      harness.dispose();
    }
  });

  test("the first row past the pre-rendered buffer is the exact boundary where the pool grows — it must be focusable", () => {
    const harness = buildFakeListScreen(500, VIEWPORT);
    try {
      for (let expected = 1; expected < LIVE_VIRTUAL_BUFFER * 2 + 2; expected += 1) harness.pressRow(1);
      const boundary = LIVE_VIRTUAL_BUFFER * 2 + 2; // the row just past the initial 18-row paint
      assert.equal(harness.rowIndex, boundary - 1);
      harness.pressRow(1);
      const node = harness.list.querySelector(`[data-row-index="${boundary}"]`);
      assert.ok(node, "the boundary row exists");
      assert.equal(node.tabIndex, 0, "the pool-growth node is focusable");
      assert.ok(node.focusCalls > 0, "focus() engaged on the boundary row (no dead press, no lost ring)");
    } finally {
      harness.dispose();
    }
  });

  test("held DOWN (auto-repeat, scroll events deferred in batches): one row per press, no skipped or duplicated rows, every focus engages", () => {
    const harness = buildFakeListScreen(500, VIEWPORT);
    try {
      for (let expected = 1; expected <= 60; expected += 1) {
        // Held key: several repeats land before the platform dispatches the
        // reveal's scroll event — pump it only every 5th press. moveRows ends
        // in applyFocusState, exactly like the production press path.
        harness.moveRows(1);
        if (expected % 5 === 0) harness.pumpScrollEvents();
        assert.equal(harness.rowIndex, expected, `repeat ${expected}: exactly one row, none skipped`);
      }
      harness.pumpScrollEvents();
      const indexes = harness.list.querySelectorAll(".live-channel-row").map((node) => Number(node.dataset.rowIndex));
      assert.equal(new Set(indexes).size, indexes.length, "no duplicated row nodes in the DOM");
      const focused = harness.list.querySelector(`[data-row-index="${harness.rowIndex}"]`);
      assert.ok(focused && focused.focusCalls > 0, "the last focused row took focus");
    } finally {
      harness.dispose();
    }
  });

  test("UP past the window top: the window extends above and every press keeps the ring on a focusable node", () => {
    const harness = buildFakeListScreen(500, VIEWPORT);
    try {
      for (let i = 0; i < 30; i += 1) harness.pressRow(1);
      assert.equal(harness.rowIndex, 30);
      for (let expected = 29; expected >= 0; expected -= 1) {
        harness.pressRow(-1);
        assert.equal(harness.rowIndex, expected, `press UP: exactly one row down to ${expected}`);
        const focused = harness.list.querySelector(`[data-row-index="${expected}"]`);
        assert.ok(focused && focused.tabIndex === 0 && focused.focusCalls > 0, `row ${expected}: focusable and focused`);
      }
    } finally {
      harness.dispose();
    }
  });

  test("the list ends stop cleanly: DOWN at the last row and UP at row 0 hold position with the ring intact", () => {
    const harness = buildFakeListScreen(500, VIEWPORT);
    try {
      harness.rowIndex = 499;
      harness.syncChannelWindow({ focusIndex: 499, mode: "focus" });
      harness.applyFocusState();
      harness.pressRow(1);
      assert.equal(harness.rowIndex, 499, "DOWN at the last row stays put");
      const last = harness.list.querySelector('[data-row-index="499"]');
      assert.ok(last && last.tabIndex === 0 && last.focusCalls > 0, "the last row is focusable and holds the ring");
      for (let i = 0; i < 3; i += 1) harness.pressRow(-1);
      for (let expected = 495; expected >= 0; expected -= 1) harness.pressRow(-1);
      assert.equal(harness.rowIndex, 0, "UP reaches row 0");
      harness.pressRow(-1);
      assert.equal(harness.rowIndex, 0, "UP at row 0 stays put (the handler lifts to the rail)");
    } finally {
      harness.dispose();
    }
  });
});
