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
  categoryRailId,
  buildRailItems,
  collapsedSourceIdsRef,
  isSourceExpanded,
  toggleSourceCollapsed,
  clampIndex
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

  test("keeps a snapshot (id, name, number) so rows render before caches warm — no logo, nothing to decode", () => {
    const recents = pushRecentChannel([], {
      id: "magis:live:a",
      name: "Antena 3",
      logo: "http://example.test/a.png",
      number: 7,
      code: "a",
      group: "x"
    });
    assert.deepEqual(recents[0], { id: "magis:live:a", name: "Antena 3", number: 7 });
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
    writeRecentChannels([{ id: "premiumtv:8f3a2b", name: "TCS", number: null }], storage);
    assert.deepEqual(readRecentChannels(storage), [{ id: "premiumtv:8f3a2b", name: "TCS", number: null }]);
  });

  test("a legacy persisted snapshot that still carries a logo field reads back WITHOUT it", () => {
    const storage = memoryStorage();
    storage.setItem(RECENTS_STORAGE_KEY, JSON.stringify([{ id: "magis:live:a", name: "A", logo: "http://x/y.png", number: 1 }]));
    assert.deepEqual(readRecentChannels(storage), [{ id: "magis:live:a", name: "A", number: 1 }]);
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

describe("buildRailItems (left column: search, favorites, recents, source sections — no aggregate row)", () => {
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

  test("search first, then Favoritos (always), then Vistos recientemente only when non-empty — and NO aggregate row", () => {
    const withRecents = buildRailItems({
      categories,
      channelsByColumn: caches,
      favoriteCount: 2,
      recentCount: 3
    });
    assert.deepEqual(
      withRecents.map((item) => item.railId),
      [RAIL_SEARCH_ID, RAIL_FAVORITES_ID, RAIL_RECENTS_ID, "source:Magis", categoryRailId(42), categoryRailId(43), "source:PremiumTV", categoryRailId("premiumtv:El Salvador – TCS")]
    );

    const withoutRecents = buildRailItems({
      categories,
      channelsByColumn: caches,
      favoriteCount: 0,
      recentCount: 0
    });
    assert.equal(withoutRecents.some((item) => item.railId === RAIL_RECENTS_ID), false);
  });

  test("the removed 'Todos los canales' aggregate row exists nowhere, even with warm caches", () => {
    const items = buildRailItems({ categories, channelsByColumn: caches, favoriteCount: 0, recentCount: 0 });
    assert.equal(items.some((item) => item.railId === "__all__"), false);
    assert.equal(items.some((item) => item.type === "all"), false);
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

  test("the rail never collapses to empty: search and favorites always exist", () => {
    const items = buildRailItems({ categories: [], channelsByColumn: new Map(), favoriteCount: 0, recentCount: 0 });
    assert.deepEqual(items.map((item) => item.railId), [RAIL_SEARCH_ID, RAIL_FAVORITES_ID]);
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

  test("a hero panel on top: number, name, source, search control — a compact text block; no invented EPG", () => {
    assert.match(renderSource, /live-hero\b/);
    assert.match(renderSource, /live-hero-number/);
    assert.match(renderSource, /live-hero-name/);
    assert.match(renderSource, /live-hero-source/);
    assert.match(renderSource, /data-action="openSearch"/);
    // No EPG: no badge (we cannot know when the programme is on air), no
    // programme info line, no progress bar, no fake times.
    assert.doesNotMatch(renderSource, /live-hero-badge/);
    assert.doesNotMatch(renderSource, /EN VIVO/);
    assert.doesNotMatch(renderSource, /live-hero-noprogram/);
    assert.doesNotMatch(renderSource, /live-hero-progress/);
  });

  test("the screen never creates, loads or decodes an image: no <img>, no background-image, no data URIs, no logo plumbing", () => {
    const screenSource = readFileSync(
      new URL("../js/ui/screens/live/liveScreen.js", import.meta.url),
      "utf8"
    );
    const all = renderSource + tuneSource + mountSource + screenSource;
    // No <img> node, no CSS or inline background-image, no data: URI payload,
    // no lazy-image plumbing, no logo probe, no logo helper usage at all.
    assert.doesNotMatch(all, /<img/i);
    assert.doesNotMatch(all, /background-image/);
    assert.doesNotMatch(all, /data:image/);
    assert.doesNotMatch(all, /object-fit/);
    assert.doesNotMatch(all, /loading=["']lazy|decoding=/);
    assert.doesNotMatch(all, /channelLogoInfo/);
    assert.doesNotMatch(all, /probeChannelLogos|logoProbeCount|hasLogos/);
    assert.doesNotMatch(all, /live-row-logo|live-hero-logo|live-hero-preview/);
    // The repository may still return `logo` fields; the screen simply never
    // reads them (only the data layer and its own tests mention them).
    assert.doesNotMatch(renderSource + tuneSource, /\.logo\b/);
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

  test("the rail is a fixed-px narrow left column next to the channel list", () => {
    // Static layout: the rail width is a px constant, never a percentage that
    // could recompute when the body's content or scrollbars change.
    assert.match(renderSource, /\.live-rail\s*\{[^}]*flex:\s*0\s+0\s+\d+px/);
    assert.match(renderSource, /live-channel-list/);
  });

  test("focus is a #303030 fill plus a 2px white ring painted INSIDE the element", () => {
    // No scale, no elevation, no layout change: the focus state only swaps a
    // fill and an inner ring, never geometry.
    assert.match(renderSource, /\.live-rail-row\.focused\s*\{[^}]*#303030/);
    assert.match(renderSource, /\.live-rail-row\s*\{[^}]*outline:\s*2px solid transparent[^}]*outline-offset:\s*-2px/);
    assert.match(renderSource, /\.live-channel-row\.focused\s*\{[^}]*#303030/);
    // Instant focus, like the Android TV reference: the fill and the ring
    // appear in the same frame — no transition on the focused row or rail item.
    assert.doesNotMatch(renderSource, /transition:\s*background-color/);
  });

  test("the old layouts are gone: no chips row, no mobile group cards, no full-width header", () => {
    assert.doesNotMatch(renderSource, /live-chips-row/);
    assert.doesNotMatch(renderSource, /live-group-header/);
  });

  test("channel rows keep the existing design: number, name, source, star — no logo box", () => {
    assert.doesNotMatch(renderSource, /live-row-logo/);
    assert.match(renderSource, /live-row-number/);
    assert.match(renderSource, /live-row-name/);
    assert.match(renderSource, /live-row-source/);
    assert.match(renderSource, /live-star/);
  });

  test("focus movement toggles classes instead of re-rendering, with no repeat throttling", () => {
    assert.match(tuneSource, /moveRail|moveRows/);
    assert.match(tuneSource, /applyFocusState/);
    // Held arrows move at the platform's own rate: the auto-repeat coalescing
    // that dropped repeats faster than 90ms is gone.
    assert.doesNotMatch(tuneSource, /MOVE_CADENCE_MS/);
    assert.doesNotMatch(tuneSource, /shouldAcceptRepeatMove\s*\(/);
    assert.doesNotMatch(tuneSource, /Date\.now/);
  });

  test("native reveal: focus calls node.focus() with the browser's default scrolling", () => {
    // No eased scrollTop, no cancel/replace bookkeeping, no smooth behaviour.
    assert.doesNotMatch(tuneSource, /SCROLL_ANIMATE_MS|animateListScroll|ensureFocusVisible/);
    assert.doesNotMatch(renderSource, /animateListScroll|ensureFocusVisible/);
    assert.doesNotMatch(renderSource + tuneSource, /behavior:\s*["']smooth["']/);
    // The focus application path must use the browser's native reveal.
    const applyStart = renderSource.indexOf("applyFocusState() {");
    assert.ok(applyStart >= 0, "applyFocusState exists");
    const applyEnd = renderSource.indexOf("focusedNode() {", applyStart);
    assert.ok(applyEnd > applyStart, "focusedNode follows applyFocusState");
    const applyPath = renderSource.slice(applyStart, applyEnd);
    assert.match(applyPath, /target\.focus\(\)/);
    assert.doesNotMatch(applyPath, /preventScroll|focusWithoutAutoScroll/);
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

  test("the category list renderer applies dedupe, and the background preload refines the visible list without extra portal calls", () => {
    // The category branch of refreshVisibleChannels must filter through the
    // ownership map; search/favourites keep the full set (pinned in
    // tests/test-live-category-dedupe.mjs).
    const start = mountSource.indexOf("refreshVisibleChannels()");
    const end = mountSource.indexOf("selectRailItem(", start);
    const body = mountSource.slice(start, end);
    assert.match(body, /filterChannelsByOwnership/);
    // The preload hands its cache to the same recompute (no separate portal
    // call path for ownership) instead of only refreshing search/favourites.
    assert.match(mountSource, /categorySelectionDependsOnCaches/);
  });
});

describe("player Back exits playback without pushing a route (no re-open loop)", () => {
  const playerSource = readFileSync(
    new URL("../js/ui/screens/player/playerScreenMethods-70-on-pointer-activate.js", import.meta.url),
    "utf8"
  );

  test("exitPlayerOnBack never pushes a fresh live navigate (the old push made history [live, player, live])", () => {
    assert.doesNotMatch(
      playerSource,
      /Router\.navigate\(\s*["']live["']\s*,\s*\{\}\s*,\s*\{\s*isBackNavigation:\s*true\s*\}\s*\)/,
      "a bare isBackNavigation navigate PUSHES a live entry on top of the player — the Back loop"
    );
  });

  test("exitPlayerOnBack prefers the router's return-to-existing-route helper and reports the history traversal", () => {
    assert.match(playerSource, /popToExistingRoute\?*\.?\(\s*["']live["']/);
    assert.match(playerSource, /return\s+["']history["']/, "the caller must know a browser traversal is in flight");
  });

  test("the fallback consumes the player's own entry instead of pushing (skipStackPush + replaceHistory)", () => {
    assert.match(playerSource, /skipStackPush:\s*true/);
    assert.match(playerSource, /replaceHistory:\s*true/);
    assert.match(playerSource, /isBackNavigation:\s*true/);
  });
});

describe("static layout contract (no reflow on focus)", () => {
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

  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const styleStart = renderSource.indexOf('<style id="live-screen-style">');
  const styleEnd = renderSource.indexOf("</style>", styleStart);
  assert.ok(styleStart >= 0 && styleEnd > styleStart, "the live screen ships its stylesheet inline");
  const style = renderSource.slice(styleStart, styleEnd);

  // Body of one CSS rule, matched exactly (a selector followed directly by '{').
  const ruleBody = (selector) => {
    const match = style.match(new RegExp(`${escapeRegex(selector)}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `CSS rule ${selector} exists`);
    return match[1];
  };

  test("fixed geometry: compact hero text block, px rail width, fixed row and header heights", () => {
    const hero = ruleBody(".live-hero");
    // The hero is a compact text block now: a smaller fixed height than the
    // old 264px logo+preview panel, still static (never content-sized).
    assert.match(hero, /(?<!min-)height:\s*152px/);
    assert.doesNotMatch(hero, /min-height/);
    const rail = ruleBody(".live-rail");
    assert.match(rail, /flex:\s*0\s+0\s+\d+px/);
    assert.doesNotMatch(rail, /\d+%/);
    const railRow = ruleBody(".live-rail-row");
    assert.match(railRow, /(?<!min-)height:\s*\d+px/);
    assert.doesNotMatch(railRow, /min-height/);
    const category = ruleBody(".live-rail-category");
    assert.match(category, /(?<!min-)height:\s*\d+px/);
    assert.doesNotMatch(category, /min-height/);
    const row = ruleBody(".live-channel-row");
    assert.match(row, /(?<!min-)height:\s*\d+px/);
    assert.doesNotMatch(row, /min-height/);
  });

  test("channel names use a fixed line-height and a 2-line clamp so long names never reflow", () => {
    const name = ruleBody(".live-row-name");
    assert.match(name, /line-height:\s*\d+px/);
    assert.match(name, /-webkit-line-clamp:\s*2/);
    assert.match(name, /overflow:\s*hidden/);
    assert.doesNotMatch(name, /white-space:\s*nowrap/);
  });

  test("no size transitions and no focus transition: only opacity and transform may transition", () => {
    const declarations = style.match(/transition:[^;}]*/g) || [];
    assert.ok(declarations.length > 0, "the stylesheet declares transitions");
    const allowed = new Set(["opacity", "transform"]);
    for (const declaration of declarations) {
      const properties = declaration
        .replace(/^transition:/, "")
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean);
      assert.ok(properties.length > 0, `transition declares properties: ${declaration}`);
      for (const property of properties) {
        assert.ok(
          allowed.has(property),
          `transition property "${property}" is not allowed (the focus fill/ring must appear in one frame, and size properties must never transition): ${declaration}`
        );
      }
    }
  });

  test("updateHeroForFocus is patch-only and knows no image node", () => {
    const start = renderSource.indexOf("updateHeroForFocus({ force = false }");
    const end = renderSource.indexOf("// LEFT RAIL", start);
    assert.ok(start >= 0 && end > start, "updateHeroForFocus exists before patchHeroImage");
    const heroPath = renderSource.slice(start, end);
    assert.match(heroPath, /textContent/);
    assert.doesNotMatch(heroPath, /innerHTML/);
    assert.doesNotMatch(heroPath, /replaceWith|removeChild|appendChild|insertAdjacentHTML|renderHero/);
  });

  test("the offsets cache is gone: the browser reveals the focused row, not a manual scrollTop", () => {
    assert.doesNotMatch(tuneSource, /cacheLayoutMetrics|layoutMetrics|ensureFocusVisible|animateListScroll|SCROLL_ANIMATE_MS/);
    assert.doesNotMatch(renderSource, /cacheLayoutMetrics/);
    assert.doesNotMatch(mountSource, /onLiveResize/, "the resize listener only refreshed the offsets cache");
    // The keypress handler itself never measures and never sends per-key
    // telemetry: it may only change state and toggle classes.
    const keydownStart = tuneSource.indexOf("onKeyDown(event)");
    const keydownEnd = tuneSource.indexOf("handleHorizontal(delta)", keydownStart);
    assert.ok(keydownStart >= 0 && keydownEnd > keydownStart, "onKeyDown exists before handleHorizontal");
    const keydownPath = tuneSource.slice(keydownStart, keydownEnd);
    for (const banned of ["getBoundingClientRect", "offsetTop", "clientHeight", "scrollHeight", "liveFocusSnapshot"]) {
      assert.doesNotMatch(keydownPath, new RegExp(banned));
    }
  });

  test("the shell fills the screen; rail and list are shrinkable flex children", () => {
    const shell = ruleBody(".live-shell");
    assert.match(shell, /inset:\s*0/);
    assert.match(shell, /overflow:\s*hidden/);
    const body = ruleBody(".live-body");
    assert.match(body, /min-height:\s*0/);
    assert.match(body, /min-width:\s*0/);
    const rail = ruleBody(".live-rail");
    assert.match(rail, /min-height:\s*0/);
    assert.match(rail, /min-width:\s*0/);
    const list = ruleBody(".live-channel-list");
    assert.match(list, /min-height:\s*0/);
    assert.match(list, /min-width:\s*0/);
    assert.match(list, /overflow-y:\s*auto/);
  });

  test("no image css remains: no logo boxes, no object-fit, no img selectors", () => {
    assert.doesNotMatch(style, /live-row-logo|live-hero-logo|live-hero-preview/);
    assert.doesNotMatch(style, /\bimg\b|object-fit/);
  });
});

describe("on-screen search keyboard (no system IME, no <input>)", () => {
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

  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const styleStart = renderSource.indexOf('<style id="live-screen-style">');
  const styleEnd = renderSource.indexOf("</style>", styleStart);
  const style = renderSource.slice(styleStart, styleEnd);
  const ruleBody = (selector) => {
    const match = style.match(new RegExp(`${escapeRegex(selector)}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `CSS rule ${selector} exists`);
    return match[1];
  };

  test("no <input> and no system-IME dependency remains in the live screen", () => {
    assert.doesNotMatch(renderSource, /<input/i);
    assert.doesNotMatch(renderSource, /live-search-input/);
    assert.doesNotMatch(renderSource, /type="text"/);
    assert.doesNotMatch(tuneSource, /bindSearchInput/);
    assert.doesNotMatch(tuneSource, /addEventListener\(\s*["']input["']/);
    assert.doesNotMatch(mountSource, /bindSearchInput/);
  });

  test("the keyboard is a fixed-size panel with a fixed-height query line and fixed keys", () => {
    assert.match(renderSource, /live-keyboard\b/);
    assert.match(renderSource, /live-keyboard-grid/);
    assert.match(renderSource, /live-key\b/);
    const panel = ruleBody(".live-keyboard");
    assert.match(panel, /(?<!min-)width:\s*\d+px/);
    assert.match(panel, /(?<!min-)height:\s*\d+px/);
    const query = ruleBody(".live-keyboard-query");
    assert.match(query, /(?<!min-)height:\s*\d+px/);
    const key = ruleBody(".live-key");
    assert.match(key, /(?<!min-)height:\s*\d+px/);
    // Same focus convention as the rest of the screen: fill + inner ring.
    assert.match(key, /outline:\s*2px solid transparent/);
    assert.match(key, /outline-offset:\s*-2px/);
  });

  test("the blinking caret is an opacity animation, never a layout change", () => {
    assert.match(style, /@keyframes\s+live-caret-blink/);
    const caret = ruleBody(".live-keyboard-caret");
    assert.match(caret, /animation:[^;]*live-caret-blink/);
    assert.doesNotMatch(caret, /(?<!min-)width:\s*auto|width:\s*\d+%/);
  });

  test("keyboard keys use the shared .focusable machinery", () => {
    assert.match(renderSource, /live-keyboard-grid/);
    assert.match(renderSource, /data-action="keyboardKey"/);
    assert.match(renderSource, /data-key-index=/, "keys are addressable through the flat key model");
  });
  test("the keyboard grid is a shrinkable scroll panel like rail and channel list", () => {
    const grid = ruleBody(".live-keyboard-grid");
    assert.match(grid, /overflow-y:\s*auto/);
    assert.match(grid, /min-height:\s*0/);
  });
});

describe("search text normalization", () => {
  test("strips accents and case", () => {
    assert.equal(normalizeSearchText("  Televisión Española "), "television espanola");
  });
});

describe("virtualized channel list (only a window of rows exists in the DOM)", () => {
  const renderSource = readFileSync(
    new URL("../js/ui/screens/live/liveScreenMethods-02-render.js", import.meta.url),
    "utf8"
  );

  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const styleStart = renderSource.indexOf('<style id="live-screen-style">');
  const styleEnd = renderSource.indexOf("</style>", styleStart);
  const style = renderSource.slice(styleStart, styleEnd);
  const ruleBody = (selector) => {
    const match = style.match(new RegExp(`${escapeRegex(selector)}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `CSS rule ${selector} exists`);
    return match[1];
  };
  const functionBody = (name, nextAnchor) => {
    const start = renderSource.indexOf(`${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = renderSource.indexOf(nextAnchor, start);
    assert.ok(end > start, `${name} is followed by ${nextAnchor}`);
    return renderSource.slice(start, end);
  };
  test("the renderer emits a windowed list container with top and bottom spacers, never every row inline", () => {
    const listBody = functionBody("renderChannelList", "renderChannelRowInner(");
    assert.match(listBody, /data-virtual-list/);
    assert.doesNotMatch(listBody, /renderChannelRow\(/, "the list must not map every channel into markup");
    // Spacers are created/positioned by the window sync, not inline markup.
    assert.match(renderSource, /applyChannelSpacer\(list, "top"/);
    assert.match(renderSource, /applyChannelSpacer\(list, "bottom"/);
    assert.match(renderSource, /setAttribute\(\s*"data-spacer"/);
    assert.match(style, /live-list-spacer/);
  });

  test("the window sync recycles a fixed pool of row nodes instead of creating and destroying per scroll step", () => {
    assert.match(renderSource, /syncChannelWindow/);
    assert.match(renderSource, /computeChannelWindow\(/);
    assert.match(renderSource, /channelSpacerHeights\(/);
    const syncBody = functionBody("syncChannelWindow", "prepareChannelWindow(");
    assert.match(syncBody, /fillChannelRowNode/, "entering rows are filled into pooled nodes");
    assert.match(syncBody, /insertBefore/, "rows keep ascending DOM order between the spacers");
    // Same-window early exit: a scroll step inside one window does no DOM work.
    assert.match(syncBody, /previous\.start === window\.start && previous\.end === window\.end/);
  });

  test("the scroll-path recompute is passive and never steals focus (no applyFocusState, no focus() in the handler)", () => {
    assert.match(renderSource, /addEventListener\(\s*"scroll",\s*this\.channelListScrollHandler\(\),\s*\{\s*passive:\s*true\s*\}\)/);
    const handlerBody = functionBody("channelListScrollHandler", "syncChannelWindow(");
    assert.doesNotMatch(handlerBody, /applyFocusState/);
    assert.doesNotMatch(handlerBody, /\.focus\(/);
  });

  test("the focused row exists before focus is applied: applyFocusState syncs the window anchored on the focused row", () => {
    const applyStart = renderSource.indexOf("applyFocusState() {");
    const applyEnd = renderSource.indexOf("focusedNode() {", applyStart);
    const applyPath = renderSource.slice(applyStart, applyEnd);
    assert.match(applyPath, /syncChannelWindow\(\{\s*focusIndex:\s*this\.rowIndex/);
    assert.match(applyPath, /mode:\s*"focus"/);
  });

  test("measure once per data change: the viewport height is cached and the pitch comes from the fixed constants", () => {
    assert.match(renderSource, /LIVE_ROW_HEIGHT = 51/);
    assert.match(renderSource, /LIVE_ROW_GAP = 6/);
    assert.match(renderSource, /LIVE_VIRTUAL_BUFFER = 8/);
    const syncBody = functionBody("syncChannelWindow", "prepareChannelWindow(");
    assert.match(syncBody, /_virtualMeasurePending/);
    // The scroll path itself must not read layout: clientHeight is only read
    // behind the per-data-change measure guard.
    const guarded = syncBody.slice(syncBody.indexOf("_virtualMeasurePending"));
    const beforeGuard = syncBody.slice(0, syncBody.indexOf("_virtualMeasurePending"));
    assert.doesNotMatch(beforeGuard, /clientHeight/);
    assert.match(guarded, /clientHeight/);
  });

  test("the virtual pitch matches the fixed CSS geometry (51px row + 6px gap)", () => {
    const row = ruleBody(".live-channel-row");
    assert.match(row, /height:\s*51px/);
    const list = ruleBody(".live-channel-list");
    assert.match(list, /gap:\s*6px/);
  });
});
