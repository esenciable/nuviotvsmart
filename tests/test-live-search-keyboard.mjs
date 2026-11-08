// On-screen keyboard for the Live TV search (IME replacement). Pure functions
// only: no DOM, no network, no i18n — node --test must run fully offline.
// The keyboard is deterministic: a fixed grid of keys, row-aware D-pad
// movement, pure query application and a pure query-line model (the blinking
// caret is always rendered after the typed text; the placeholder only exists
// while the query is empty).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildKeyboardLayout,
  keyboardFlatKeys,
  keyboardMove,
  applyKeyboardKey,
  queryLineView,
  KEYBOARD_KEY_COUNT,
  KEYBOARD_KEYS,
  KEYBOARD_MAX_QUERY,
  KEYBOARD_QUERY_PLACEHOLDER,
  channelMatchesQuery,
  normalizeSearchText
} from "../js/ui/screens/live/liveScreenMethods-02-render.js";

describe("buildKeyboardLayout (the fixed key grid)", () => {
  const rows = buildKeyboardLayout();
  const flat = keyboardFlatKeys(rows);

  test("every letter A-Z and Ñ is present exactly once as a char key", () => {
    const chars = flat.filter((entry) => entry.key.type === "char").map((entry) => entry.key.value);
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZÑ".split("")) {
      assert.equal(chars.filter((ch) => ch === letter).length, 1, `missing or duplicated: ${letter}`);
    }
  });

  test("every digit 0-9 is present exactly once as a char key", () => {
    const chars = flat.filter((entry) => entry.key.type === "char").map((entry) => entry.key.value);
    for (const digit of "0123456789".split("")) {
      assert.equal(chars.filter((ch) => ch === digit).length, 1, `missing or duplicated: ${digit}`);
    }
  });

  test("the four actions exist exactly once: space, borrar (backspace), limpiar (clear), Listo", () => {
    const types = flat.map((entry) => entry.key.type);
    for (const type of ["space", "backspace", "clear", "done"]) {
      assert.equal(types.filter((entry) => entry === type).length, 1, `missing or duplicated action: ${type}`);
    }
    const labels = flat.map((entry) => entry.key.label);
    assert.equal(labels.includes("ESPACIO"), true);
    assert.equal(labels.includes("BORRAR"), true);
    assert.equal(labels.includes("LIMPIAR"), true);
    assert.equal(labels.includes("LISTO"), true);
  });

  test("every row is non-empty and every key id is unique", () => {
    assert.ok(rows.length >= 4, "the grid has several rows");
    for (const row of rows) {
      assert.ok(Array.isArray(row) && row.length > 0, "no empty rows");
    }
    const ids = flat.map((entry) => entry.key.id);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    assert.equal(flat.length, KEYBOARD_KEY_COUNT);
  });

  test("rows and cols are contiguous and consistent between build and flat views", () => {
    assert.deepEqual(KEYBOARD_KEYS, flat, "the exported KEYBOARD_KEYS matches the built layout");
    rows.forEach((row, r) => {
      row.forEach((_, c) => {
        const entry = flat.find((candidate) => candidate.row === r && candidate.col === c);
        assert.ok(entry, `key at row ${r} col ${c} exists in the flat view`);
      });
    });
  });
});

describe("keyboardMove (row-aware D-pad movement)", () => {
  // A small deterministic ragged grid for exact assertions:
  //   row 0: A B C
  //   row 1: D E
  //   row 2: F
  const layout = [["A", "B", "C"], ["D", "E"], ["F"]];
  const flat = keyboardFlatKeys(
    layout.map((row) => row.map((value) => ({ id: value, label: value, type: "char", value })))
  );
  const indexOf = (value) => flat.findIndex((entry) => entry.key.value === value);

  test("horizontal movement clamps inside the row", () => {
    assert.equal(flat[keyboardMove(flat, indexOf("A"), -1, 0)].key.value, "A");
    assert.equal(flat[keyboardMove(flat, indexOf("A"), 1, 0)].key.value, "B");
    assert.equal(flat[keyboardMove(flat, indexOf("C"), 1, 0)].key.value, "C");
  });

  test("vertical movement lands in the adjacent row at the nearest column", () => {
    assert.equal(flat[keyboardMove(flat, indexOf("A"), 0, 1)].key.value, "D");
    assert.equal(flat[keyboardMove(flat, indexOf("B"), 0, 1)].key.value, "E");
    // Row 1 has only 2 columns: coming down from column 2 clamps to the last.
    assert.equal(flat[keyboardMove(flat, indexOf("C"), 0, 1)].key.value, "E");
  });

  test("vertical movement clamps at the first and last rows", () => {
    assert.equal(flat[keyboardMove(flat, indexOf("A"), 0, -1)].key.value, "A");
    assert.equal(flat[keyboardMove(flat, indexOf("F"), 0, 1)].key.value, "F");
  });

  test("shorter target rows never dead-end: movement always returns a valid index", () => {
    for (let index = 0; index < flat.length; index += 1) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const next = keyboardMove(flat, index, dx, dy);
        assert.ok(Number.isInteger(next) && next >= 0 && next < flat.length, `valid move from ${index} (${dx},${dy})`);
      }
    }
  });

  test("garbage input collapses to the first key instead of throwing", () => {
    assert.equal(keyboardMove([], 0, 1, 0), 0);
    assert.equal(keyboardMove(null, 3, 1, 0), 0);
    assert.equal(flat[keyboardMove(flat, 99, 0, 0)].key.value, "F"); // clamped start index
  });

  test("the real grid moves with the same helper", () => {
    const real = KEYBOARD_KEYS;
    // From the first key, DOWN lands on the first key of row 1.
    assert.equal(real[keyboardMove(real, 0, 0, 1)].row, 1);
    assert.equal(real[keyboardMove(real, 0, 0, 1)].col, 0);
  });
});

describe("applyKeyboardKey (typing / backspace / clear are pure query updates)", () => {
  const char = (value) => ({ id: `char:${value}`, label: value, type: "char", value });
  const space = { id: "action:space", label: "ESPACIO", type: "space", value: " " };
  const backspace = { id: "action:backspace", label: "BORRAR", type: "backspace", value: "" };
  const clear = { id: "action:clear", label: "LIMPIAR", type: "clear", value: "" };
  const done = { id: "action:done", label: "LISTO", type: "done", value: "" };

  test("char keys append their value", () => {
    assert.equal(applyKeyboardKey("", char("C")), "C");
    assert.equal(applyKeyboardKey("CN", char("N")), "CNN");
  });

  test("space appends a space", () => {
    assert.equal(applyKeyboardKey("A", space), "A ");
  });

  test("backspace removes exactly one character and never goes negative", () => {
    assert.equal(applyKeyboardKey("CNN", backspace), "CN");
    assert.equal(applyKeyboardKey("C", backspace), "");
    assert.equal(applyKeyboardKey("", backspace), "");
  });

  test("clear empties the query", () => {
    assert.equal(applyKeyboardKey("Televisión", clear), "");
    assert.equal(applyKeyboardKey("", clear), "");
  });

  test("done (Listo) leaves the query unchanged — closing is the caller's job", () => {
    assert.equal(applyKeyboardKey("CNN", done), "CNN");
  });

  test("the query is capped so typing can never grow unbounded", () => {
    let query = "";
    for (let i = 0; i < KEYBOARD_MAX_QUERY + 10; i += 1) {
      query = applyKeyboardKey(query, char("a"));
    }
    assert.equal(query.length, KEYBOARD_MAX_QUERY);
  });

  test("an unknown key type is a no-op", () => {
    assert.equal(applyKeyboardKey("CNN", { id: "x", type: "mystery", value: "!" }), "CNN");
  });
});

describe("queryLineView (caret invariant + placeholder when empty)", () => {
  test("the caret is always rendered after the typed text", () => {
    for (const query of ["", "C", "CNN", "Espacio "]) {
      const view = queryLineView(query);
      assert.equal(view.caretAfterText, true, `caret present for "${query}"`);
      assert.equal(view.text, query);
    }
  });

  test("a placeholder exists only while the query is empty", () => {
    const empty = queryLineView("");
    assert.equal(empty.placeholder, KEYBOARD_QUERY_PLACEHOLDER);
    assert.ok(String(empty.placeholder).length > 0, "the placeholder is real text, never blank");

    const typed = queryLineView("CNN");
    assert.equal(typed.placeholder, "", "no placeholder once the query is non-empty");
  });

  test("the caret position is always the end of the text (deterministic append-only)", () => {
    const view = queryLineView("Tele");
    assert.equal(view.caretPosition, 4);
    assert.equal(view.caretPosition, view.text.length);
  });
});

describe("accent-insensitive filtering (the query the keyboard produces)", () => {
  test("typed without accents matches accented channel names", () => {
    assert.equal(channelMatchesQuery({ name: "Televisión Española" }, "TELEVISION"), true);
    assert.equal(channelMatchesQuery({ name: "Televisión Española" }, "espa"), true);
    assert.equal(channelMatchesQuery({ name: "Deportes Ñ" }, "n"), true);
  });

  test("the Ñ key itself matches names containing Ñ", () => {
    assert.equal(normalizeSearchText("Ñ").length > 0, true);
    assert.equal(channelMatchesQuery({ name: "Año" }, "AÑ"), true);
  });

  test("spaces typed via ESPACIO participate in the match", () => {
    assert.equal(channelMatchesQuery({ name: "Fox Sports" }, "fox sports"), true);
    assert.equal(channelMatchesQuery({ name: "Fox Sports" }, "fox  sports"), false);
  });
});
