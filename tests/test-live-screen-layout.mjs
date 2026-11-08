// Layout helpers for the Live TV screen (Android TV reference style).
// Pure functions only: no DOM, no network, no i18n — node --test must run
// fully offline. The screen module exports these helpers alongside its
// rendering methods; this file pins their exact observable behaviour.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  sourceNameFromChannelId,
  sourceNameFromColumnId,
  formatChipLabel,
  formatChannelRowLabel,
  channelLogoInfo,
  normalizeSearchText,
  channelMatchesQuery,
  FAVORITES_STORAGE_KEY,
  readFavoriteIds,
  writeFavoriteIds,
  toggleFavoriteId
} from "../js/ui/screens/live/liveScreenMethods-02-render.js";

describe("sourceNameFromChannelId", () => {
  test("maps a Magis channel id to its source name", () => {
    assert.equal(sourceNameFromChannelId("magis:live:cnn"), "Magis");
  });

  test("maps a PremiumTV channel id to its source name", () => {
    assert.equal(sourceNameFromChannelId("premiumtv:8f3a2b"), "PremiumTV");
  });

  test("returns an empty string for an unknown prefix", () => {
    assert.equal(sourceNameFromChannelId("hbo:demo"), "");
  });

  test("returns an empty string for missing input", () => {
    assert.equal(sourceNameFromChannelId(""), "");
    assert.equal(sourceNameFromChannelId(null), "");
  });
});

describe("formatChipLabel", () => {
  test("prefixes the source for a PremiumTV group", () => {
    assert.equal(
      formatChipLabel({ columnId: "premiumtv:El Salvador – TCS", name: "El Salvador – TCS" }),
      "PremiumTV · El Salvador – TCS"
    );
  });

  test("prefixes Magis for an unprefixed (numeric) Magis column id", () => {
    assert.equal(formatChipLabel({ columnId: 42, name: "Deportes" }), "Magis · Deportes");
  });

  test("falls back to a placeholder name when the category has none", () => {
    assert.equal(formatChipLabel({ columnId: "premiumtv:Grupo A", name: "" }), "PremiumTV · Unnamed");
  });

  test("omits the prefix when the column id has no known source", () => {
    assert.equal(formatChipLabel({ columnId: "", name: "Deportes" }), "Deportes");
  });
});

describe("formatChannelRowLabel", () => {
  test("formats the number separately from the bold name", () => {
    const label = formatChannelRowLabel({ number: 12, name: "A3S" });
    assert.equal(label.number, "12.");
    assert.equal(label.name, "A3S");
  });

  test("omits the number part when the channel has none", () => {
    const label = formatChannelRowLabel({ number: null, name: "A3S" });
    assert.equal(label.number, "");
    assert.equal(label.name, "A3S");
  });

  test("falls back to a placeholder name when the channel has none", () => {
    const label = formatChannelRowLabel({ number: 0, name: "" });
    assert.equal(label.number, "0.");
    assert.equal(label.name, "Canal en vivo");
  });
});

describe("sourceNameFromColumnId", () => {
  test("maps the PremiumTV column prefix", () => {
    assert.equal(sourceNameFromColumnId("premiumtv:El Salvador – TCS"), "PremiumTV");
  });

  test("maps unprefixed (numeric) Magis columns", () => {
    assert.equal(sourceNameFromColumnId(42), "Magis");
  });

  test("empty id has no source", () => {
    assert.equal(sourceNameFromColumnId(""), "");
  });
});

describe("channelMatchesQuery", () => {
  test("case-insensitive substring match", () => {
    assert.equal(channelMatchesQuery({ name: "CNN Internacional" }, "cnn"), true);
    assert.equal(channelMatchesQuery({ name: "CNN Internacional" }, "NACION"), true);
  });

  test("accent-insensitive match", () => {
    assert.equal(channelMatchesQuery({ name: "Televisión Española" }, "television"), true);
    assert.equal(channelMatchesQuery({ name: "Deportes" }, "deportes"), true);
  });

  test("no match returns false", () => {
    assert.equal(channelMatchesQuery({ name: "CNN" }, "antena"), false);
  });

  test("empty or blank query matches everything", () => {
    assert.equal(channelMatchesQuery({ name: "CNN" }, ""), true);
    assert.equal(channelMatchesQuery({ name: "CNN" }, "   "), true);
  });
});

describe("favourites", () => {
  const memoryStorage = () => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key)
    };
  };

  test("toggle adds and removes by the stable channel id", () => {
    const added = toggleFavoriteId([], "magis:live:cnn");
    assert.deepEqual(added, ["magis:live:cnn"]);
    const removed = toggleFavoriteId(added, "magis:live:cnn");
    assert.deepEqual(removed, []);
  });

  test("toggle keeps ids unique and preserves order", () => {
    const ids = ["magis:live:a", "premiumtv:b"];
    assert.deepEqual(toggleFavoriteId(ids, "premiumtv:b"), ["magis:live:a"]);
    assert.deepEqual(toggleFavoriteId(ids, "premiumtv:c"), ["magis:live:a", "premiumtv:b", "premiumtv:c"]);
  });

  test("round-trips through a namespaced storage key", () => {
    const storage = memoryStorage();
    assert.equal(FAVORITES_STORAGE_KEY.startsWith("nuvio."), true);
    assert.deepEqual(readFavoriteIds(storage), []);
    writeFavoriteIds(["premiumtv:8f3a2b"], storage);
    assert.deepEqual(readFavoriteIds(storage), ["premiumtv:8f3a2b"]);
  });

  test("corrupt storage payload reads as empty, not a crash", () => {
    const storage = memoryStorage();
    storage.setItem(FAVORITES_STORAGE_KEY, "{not json");
    assert.deepEqual(readFavoriteIds(storage), []);
  });

  test("a storage that throws never breaks the caller", () => {
    const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    assert.deepEqual(readFavoriteIds(throwing), []);
    assert.doesNotThrow(() => writeFavoriteIds(["magis:live:a"], throwing));
  });
});

describe("channelLogoInfo", () => {
  test("keeps the logo url and derives the letter fallback from the name", () => {
    const info = channelLogoInfo({ name: "Antena 3", logo: "http://example.test/a3.png" });
    assert.equal(info.logo, "http://example.test/a3.png");
    assert.equal(info.letter, "A");
  });

  test("missing logo falls back to the letter", () => {
    const info = channelLogoInfo({ name: "Antena 3", logo: "" });
    assert.equal(info.logo, "");
    assert.equal(info.letter, "A");
  });

  test("whitespace-only logo counts as missing and empty names get a question mark", () => {
    const info = channelLogoInfo({ name: "", logo: "   " });
    assert.equal(info.logo, "");
    assert.equal(info.letter, "?");
  });
});
