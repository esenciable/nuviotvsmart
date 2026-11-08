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
