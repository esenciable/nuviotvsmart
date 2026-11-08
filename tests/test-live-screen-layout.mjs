// Layout contract for the Live TV screen (Android TV reference, left rail).
// Pure functions only: no DOM, no network, no i18n — node --test must run
// fully offline. The screen module exports these helpers alongside its
// rendering methods; this file pins their exact observable behaviour.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  sourceNameFromChannelId,
  sourceNameFromColumnId,
  formatChannelRowLabel,
  channelLogoInfo,
  normalizeSearchText,
  channelMatchesQuery,
  FAVORITES_STORAGE_KEY,
  readFavoriteIds,
  writeFavoriteIds,
  toggleFavoriteId,
  RECENTS_STORAGE_KEY,
  MAX_RECENT_CHANNELS,
  readRecentChannels,
  writeRecentChannels,
  pushRecentChannel,
  RAIL_SEARCH_ID,
  RAIL_FAVORITES_ID,
  RAIL_RECENTS_ID,
  RAIL_ALL_ID,
  categoryRailId,
  buildRailItems,
  collapsedSourceIdsRef,
  isSourceExpanded,
  toggleSourceCollapsed,
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

describe("recently watched (persisted last tuned channels)", () => {
  const memoryStorage = () => {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key)
    };
  };

  test("push moves the channel to the front, deduped by stable id", () => {
    let recents = pushRecentChannel([], { id: "magis:live:a", name: "A" });
    recents = pushRecentChannel(recents, { id: "premiumtv:b", name: "B" });
    assert.deepEqual(recents.map((r) => r.id), ["premiumtv:b", "magis:live:a"]);
    recents = pushRecentChannel(recents, { id: "magis:live:a", name: "A" });
    assert.deepEqual(recents.map((r) => r.id), ["magis:live:a", "premiumtv:b"]);
    assert.equal(recents.length, 2);
  });

  test("keeps a snapshot (id, name, logo, number) so rows render before caches warm", () => {
    const recents = pushRecentChannel([], {
      id: "magis:live:a",
      name: "Antena 3",
      logo: "http://example.test/a.png",
      number: 7,
      code: "a",
      group: "x"
    });
    assert.deepEqual(recents[0], { id: "magis:live:a", name: "Antena 3", logo: "http://example.test/a.png", number: 7 });
  });

  test("caps the list at MAX_RECENT_CHANNELS", () => {
    assert.equal(MAX_RECENT_CHANNELS, 12);
    let recents = [];
    for (let i = 0; i < MAX_RECENT_CHANNELS + 3; i += 1) {
      recents = pushRecentChannel(recents, { id: `magis:live:c${i}`, name: `C${i}` });
    }
    assert.equal(recents.length, MAX_RECENT_CHANNELS);
    assert.equal(recents[0].id, `magis:live:c${MAX_RECENT_CHANNELS + 2}`);
    assert.equal(recents.at(-1).id, `magis:live:c3`); // oldest three dropped
  });

  test("a channel without an id is never pushed", () => {
    assert.deepEqual(pushRecentChannel([], { name: "no id" }), []);
    assert.deepEqual(pushRecentChannel([], null), []);
  });

  test("round-trips through a namespaced storage key", () => {
    const storage = memoryStorage();
    assert.equal(RECENTS_STORAGE_KEY.startsWith("nuvio."), true);
    assert.deepEqual(readRecentChannels(storage), []);
    writeRecentChannels([{ id: "premiumtv:8f3a2b", name: "TCS", logo: "", number: null }], storage);
    assert.deepEqual(readRecentChannels(storage), [{ id: "premiumtv:8f3a2b", name: "TCS", logo: "", number: null }]);
  });

  test("corrupt storage payload reads as empty, not a crash", () => {
    const storage = memoryStorage();
    storage.setItem(RECENTS_STORAGE_KEY, "{not json");
    assert.deepEqual(readRecentChannels(storage), []);
  });

  test("a storage that throws never breaks the caller", () => {
    const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    assert.deepEqual(readRecentChannels(throwing), []);
    assert.doesNotThrow(() => writeRecentChannels([], throwing));
  });
});

describe("buildRailItems (left column: search, favorites, recents, all, source sections)", () => {
  const categories = [
    { columnId: 42, name: "Deportes" },
    { columnId: 43, name: "Noticias" },
    { columnId: "premiumtv:El Salvador – TCS", name: "El Salvador – TCS" }
  ];
  const caches = new Map([
    ["42", [{ id: "magis:live:a" }, { id: "magis:live:b" }, { id: "magis:live:a2" }]],
    ["43", [{ id: "magis:live:c" }]],
    ["premiumtv:El Salvador – TCS", [{ id: "premiumtv:x" }, { id: "premiumtv:y" }]]
  ]);

  test("search first, then Favoritos (always), then Vistos recientemente only when non-empty, then Todos", () => {
    const withRecents = buildRailItems({
      categories,
      channelsByColumn: caches,
      favoriteCount: 2,
      recentCount: 3
    });
    assert.deepEqual(
      withRecents.map((item) => item.railId),
      [RAIL_SEARCH_ID, RAIL_FAVORITES_ID, RAIL_RECENTS_ID, RAIL_ALL_ID, "source:Magis", categoryRailId(42), categoryRailId(43), "source:PremiumTV", categoryRailId("premiumtv:El Salvador – TCS")]
    );

    const withoutRecents = buildRailItems({
      categories,
      channelsByColumn: caches,
      favoriteCount: 0,
      recentCount: 0
    });
    assert.equal(withoutRecents.some((item) => item.railId === RAIL_RECENTS_ID), false);
  });

  test("Todos carries the deduplicated union total of the cached lists", () => {
    const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const all = items.find((item) => item.railId === RAIL_ALL_ID);
    // 4 magis + 2 premiumtv, no overlaps
    assert.equal(all.count, 6);
  });

  test("one section per SOURCE (not per category), in first-appearance order", () => {
    const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const sources = items.filter((item) => item.type === "source");
    assert.deepEqual(sources.map((s) => s.label), ["Magis", "PremiumTV"]);
  });

  test("a source's count is the sum of its cached categories; '…' while any is pending", () => {
    const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const magis = items.find((item) => item.railId === "source:Magis");
    const premium = items.find((item) => item.railId === "source:PremiumTV");
    assert.equal(magis.count, 4); // both Magis categories cached
    assert.equal(premium.count, 2);
    assert.equal(magis.expanded, true);

    const pending = buildRailItems({
      categories,
      channelsByColumn: new Map([["42", [{ id: "a" }]]]),
      favoriteCount: 0,
      recentCount: 0
    });
    const magisPending = pending.find((item) => item.railId === "source:Magis");
    assert.equal(magisPending.count, null); // renders as "…"
  });

  test("category rows live under their source section with plain names and counts", () => {
    const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    const magis = items.find((item) => item.railId === "source:Magis");
    const premium = items.find((item) => item.railId === "source:PremiumTV");
    assert.deepEqual(
      magis.categories.map((c) => [c.label, c.count, c.loading]),
      [["Deportes", 3, false], ["Noticias", 1, false]]
    );
    assert.deepEqual(premium.categories.map((c) => [c.label, c.count]), [["El Salvador – TCS", 2]]);
    assert.equal(magis.categories[0].railId, categoryRailId(42));
  });

  test("malformed categories are skipped, not thrown on", () => {
    const items = buildRailItems({
      categories: [null, { columnId: "", name: "x" }, { columnId: "premiumtv:ok", name: "Ok" }],
      channelsByColumn: new Map(),
      favoriteCount: 0,
      recentCount: 0
    });
    assert.deepEqual(
      items.filter((i) => i.type === "source").map((s) => s.railId),
      ["source:PremiumTV"]
    );
  });

  test("the rail never collapses to empty: search, favorites and all always exist", () => {
    const items = buildRailItems({ categories: [], channelsByColumn: new Map(), favoriteCount: 0, recentCount: 0 });
    assert.deepEqual(items.map((item) => item.railId), [RAIL_SEARCH_ID, RAIL_FAVORITES_ID, RAIL_ALL_ID]);
  });
});

describe("source collapse state (expanded by default, remembered)", () => {
  test("a source is expanded unless explicitly collapsed", () => {
    const collapsed = new Set();
    assert.equal(isSourceExpanded("source:Magis", collapsed), true);
    collapsed.add("source:Magis");
    assert.equal(isSourceExpanded("source:Magis", collapsed), false);
    assert.equal(isSourceExpanded("source:PremiumTV", collapsed), true);
  });

  test("toggleSourceCollapsed flips exactly one source", () => {
    const collapsed = new Set();
    toggleSourceCollapsed(collapsed, "source:Magis");
    assert.equal(isSourceExpanded("source:Magis", collapsed), false);
    toggleSourceCollapsed(collapsed, "source:Magis");
    assert.equal(isSourceExpanded("source:Magis", collapsed), true);
  });

  test("the module-level set is the one shared owner", () => {
    assert.equal(collapsedSourceIdsRef() instanceof Set, true);
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

describe("Android TV reference layout (source contract)", () => {
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

  test("a hero panel on top: badge, preview box, no invented EPG", () => {
    assert.match(renderSource, /live-hero\b/);
    assert.match(renderSource, /live-hero-badge/);
    assert.match(renderSource, /EN VIVO/);
    assert.match(renderSource, /live-hero-preview/);
    assert.match(renderSource, /Sin información de programa/);
    // No EPG: no progress bar, no fake times.
    assert.doesNotMatch(renderSource, /live-hero-progress/);
  });

  test("the hero preview keeps the channel logo centred instead of a fake thumbnail", () => {
    assert.match(renderSource, /\.live-hero-preview img\s*\{[^}]*object-fit:\s*contain/);
  });

  test("a left vertical rail with search, fixed rows and per-source sections", () => {
    assert.match(renderSource, /live-rail\b/);
    assert.match(renderSource, /live-rail-search/);
    assert.match(renderSource, /live-rail-row/);
    assert.match(renderSource, /live-source-header/);
    assert.match(renderSource, /live-rail-category/);
    // rotating chevron: expanded ▾, collapsed ›
    assert.match(renderSource, /▾/);
    assert.match(renderSource, /›/);
  });

  test("the rail is the narrow left column (~21%) next to the channel list", () => {
    assert.match(renderSource, /\.live-rail\s*\{[^}]*flex:\s*0\s+0\s+21%/);
    assert.match(renderSource, /live-channel-list/);
  });

  test("focused rows use the white rounded outline of the reference", () => {
    assert.match(renderSource, /outline:\s*3px solid\s*(var\(--secondary-color, ?)?#f+f/i);
    assert.match(renderSource, /transition:\s*background-color/);
  });

  test("the old layouts are gone: no chips row, no mobile group cards, no full-width header", () => {
    assert.doesNotMatch(renderSource, /live-chips-row/);
    assert.doesNotMatch(renderSource, /live-group-header/);
  });

  test("channel rows keep the existing design: number, logo, name, source, star", () => {
    assert.match(renderSource, /live-row-logo/);
    assert.match(renderSource, /live-row-number/);
    assert.match(renderSource, /live-row-name/);
    assert.match(renderSource, /live-row-source/);
    assert.match(renderSource, /live-star/);
  });

  test("focus movement toggles classes instead of re-rendering, and coalesces repeats", () => {
    assert.match(tuneSource, /MOVE_CADENCE_MS/);
    assert.match(tuneSource, /moveRail|moveRows/);
    assert.match(tuneSource, /applyFocusState/);
  });

  test("short eased scroll, never a long smooth scroll", () => {
    assert.match(tuneSource, /SCROLL_ANIMATE_MS/);
    assert.doesNotMatch(tuneSource, /behavior:\s*"smooth"/);
  });

  test("tuning persists the channel into Vistos recientemente and hands off with returnRoute live", () => {
    assert.match(tuneSource, /pushRecentChannel/);
    assert.match(tuneSource, /writeRecentChannels/);
    assert.match(tuneSource, /returnRoute:\s*"live"/);
  });

  test("errors are reported through the live-error beacon, never swallowed silently", () => {
    assert.match(tuneSource, /phase:\s*"live-error"/);
    assert.match(renderSource, /phase:\s*"live-error"/);
    assert.match(renderSource, /catch \(error\)/);
    assert.match(tuneSource, /catch \(error\)/);
  });

  test("the mount module keeps the background preload that feeds per-category counts", () => {
    assert.match(mountSource, /preloadRemainingCategories/);
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

describe("search text normalization", () => {
  test("strips accents and case", () => {
    assert.equal(normalizeSearchText("  Televisión Española "), "television espanola");
  });
});
