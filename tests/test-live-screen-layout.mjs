// Layout helpers for the Live TV screen (Android TV reference style).
// Pure functions only: no DOM, no network, no i18n — node --test must run
// fully offline. The screen module exports these helpers alongside its
// rendering methods; this file pins their exact observable behaviour.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  toggleFavoriteId,
  buildGroupSections,
  flattenSections,
  clampIndex,
  shouldAcceptRepeatMove
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

describe("buildGroupSections (mobile-style collapsible groups)", () => {
  const categories = [
    { columnId: 42, name: "Deportes" },
    { columnId: "premiumtv:El Salvador – TCS", name: "El Salvador – TCS" }
  ];
  const caches = new Map([["42", [{ id: "magis:live:a" }, { id: "magis:live:b" }]]]);

  test("the favorites group sits first and only when it has channels", () => {
    const withFavorites = buildGroupSections({
      categories,
      channelsByColumn: caches,
      favoriteChannels: [{ id: "premiumtv:x" }],
      favoritesLabel: "Favoritos"
    });
    assert.equal(withFavorites[0].groupId, "__favorites__");
    assert.equal(withFavorites[0].label, "Favoritos");
    assert.equal(withFavorites[0].count, 1);

    const withoutFavorites = buildGroupSections({
      categories,
      channelsByColumn: caches,
      favoriteChannels: [],
      favoritesLabel: "Favoritos"
    });
    assert.equal(withoutFavorites.some((s) => s.groupId === "__favorites__"), false);
  });

  test("there is no Todos group: one section per category, source-prefixed", () => {
    const sections = buildGroupSections({
      categories,
      channelsByColumn: caches,
      favoriteChannels: [],
      favoritesLabel: "Favoritos"
    });
    assert.equal(sections.some((s) => s.groupId === "__all__"), false);
    assert.equal(sections[0].groupId, "42");
    assert.equal(sections[0].label, "Magis · Deportes");
    assert.equal(sections[0].count, 2);
    assert.equal(sections[0].loading, false);
    assert.equal(sections[1].groupId, "premiumtv:El Salvador – TCS");
    assert.equal(sections[1].label, "PremiumTV · El Salvador – TCS");
  });

  test("a category whose channels are not cached yet is a loading group", () => {
    const sections = buildGroupSections({
      categories,
      channelsByColumn: caches,
      favoriteChannels: [],
      favoritesLabel: "Favoritos"
    });
    assert.equal(sections[1].loading, true);
    assert.equal(sections[1].count, null);
    assert.deepEqual(sections[1].channels, []);
  });

  test("malformed categories are skipped, not thrown on", () => {
    const sections = buildGroupSections({
      categories: [null, { columnId: "", name: "x" }, { columnId: "premiumtv:ok", name: "Ok" }],
      channelsByColumn: new Map(),
      favoriteChannels: [],
      favoritesLabel: "Favoritos"
    });
    assert.deepEqual(sections.map((s) => s.groupId), ["premiumtv:ok"]);
  });
});

describe("flattenSections (flat focus order: header, then its rows)", () => {
  const sections = [
    { groupId: "g1", label: "A", count: 2, loading: false, channels: [{ id: "a" }, { id: "b" }] },
    { groupId: "g2", label: "B", count: 1, loading: false, channels: [{ id: "c" }] }
  ];

  test("collapsed groups render only their header card", () => {
    const items = flattenSections(sections, new Set());
    assert.deepEqual(items.map((i) => [i.type, i.groupId]), [["group", "g1"], ["group", "g2"]]);
  });

  test("an expanded group renders its header followed by its own rows", () => {
    const items = flattenSections(sections, new Set(["g1"]));
    assert.deepEqual(items.map((i) => i.type), ["group", "channel", "channel", "group"]);
    assert.equal(items[1].groupId, "g1");
    assert.equal(items[1].channel.id, "a");
    assert.equal(items[2].groupId, "g1");
    assert.equal(items[3].groupId, "g2");
  });

  test("a missing expanded-set collapses everything instead of throwing", () => {
    const items = flattenSections(sections, undefined);
    assert.equal(items.length, 2);
  });
});

describe("clampIndex (focus never lands outside the list)", () => {
  test("clamps into the valid range", () => {
    assert.equal(clampIndex(-5, 3), 0);
    assert.equal(clampIndex(2, 3), 2);
    assert.equal(clampIndex(9, 3), 2);
  });

  test("an empty list collapses to index 0", () => {
    assert.equal(clampIndex(4, 0), 0);
  });

  test("garbage input collapses to index 0", () => {
    assert.equal(clampIndex(undefined, 5), 0);
    assert.equal(clampIndex(Number.NaN, 5), 0);
    assert.equal(clampIndex(1.5, 5), 0);
  });
});

describe("shouldAcceptRepeatMove (coalesce held-key repeats)", () => {
  const cadence = 90;

  test("the first move of a burst is always accepted", () => {
    assert.equal(shouldAcceptRepeatMove(undefined, 1000, cadence), true);
    assert.equal(shouldAcceptRepeatMove(0, 1000, cadence), true);
  });

  test("a repeat faster than the cadence is dropped", () => {
    assert.equal(shouldAcceptRepeatMove(1000, 1000 + cadence - 1, cadence), false);
  });

  test("a repeat at or after the cadence advances the list again", () => {
    assert.equal(shouldAcceptRepeatMove(1000, 1000 + cadence, cadence), true);
  });
});

describe("mobile-style grouped layout (source contract)", () => {
  const renderSource = readFileSync(
    new URL("../js/ui/screens/live/liveScreenMethods-02-render.js", import.meta.url),
    "utf8"
  );
  const tuneSource = readFileSync(
    new URL("../js/ui/screens/live/liveScreenMethods-03-tune-in.js", import.meta.url),
    "utf8"
  );

  test("one full-width list: no preview panel, no rail, no chips row", () => {
    assert.match(renderSource, /\.live-channel-list\s*\{[^}]*flex:\s*1/);
    assert.doesNotMatch(renderSource, /live-preview/);
    assert.doesNotMatch(renderSource, /live-rail|live-chips-row/);
    assert.doesNotMatch(renderSource, /width:\s*50%/);
  });

  test("groups are header cards with label, count and an expanded/collapsed chevron", () => {
    assert.match(renderSource, /live-group-header/);
    assert.match(renderSource, /live-group-chevron/);
    assert.match(renderSource, /live-group-count/);
    assert.match(renderSource, /aria-expanded=/);
  });

  test("channel rows are indented under their expanded group", () => {
    assert.match(renderSource, /live-group-rows/);
  });

  test("focus movement toggles classes instead of re-rendering, and coalesces repeats", () => {
    assert.match(tuneSource, /MOVE_CADENCE_MS/);
    assert.match(tuneSource, /moveFlat/);
    assert.match(renderSource, /transition:\s*background-color/);
  });

  test("short eased scroll, never a long smooth scroll", () => {
    assert.match(tuneSource, /SCROLL_ANIMATE_MS/);
    assert.doesNotMatch(tuneSource, /behavior:\s*"smooth"/);
  });

  test("errors are reported through the live-error beacon, never swallowed silently", () => {
    assert.match(tuneSource, /phase:\s*"live-error"/);
    assert.match(renderSource, /phase:\s*"live-error"/);
    assert.match(renderSource, /catch \(error\)/);
    assert.match(tuneSource, /catch \(error\)/);
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
