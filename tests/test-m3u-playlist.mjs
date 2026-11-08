// M3U playlist parser test: pure parsing, no network. The fixture mirrors the
// MEASURED feed facts (esencial.m3u): BOM + CRLF, `#EXTM3U url-tvg=...`,
// `#EXTINF:-1 tvg-logo="..." group-title="...",Title` with quoted attributes
// containing commas, `#EXTVLCOPT:http-user-agent=` / `#EXTVLCOPT:http-referrer=`
// pairs belonging to the entry that follows, plus junk that must be skipped
// without throwing.
import test from "node:test";
import assert from "node:assert/strict";

import {
  parseM3u,
  premiumTvChannelId,
  headersForEntry
} from "../js/core/live/m3uPlaylist.js";

// BOM + CRLF, quoted attributes with commas and spaces, EXTVLCOPT pairs, a
// plain comment junk line, an unknown directive, an EXTINF with no attributes,
// and both url-tvg and x-tvg-url (url-tvg wins).
const FIXTURE = [
  "﻿#EXTM3U url-tvg=\"https://example.com/epg.xml\" x-tvg-url=\"https://alt.example/guide.xml\"",
  "#EXTINF:-1 tvg-id=\"ch1.example\" tvg-name=\"Canal Uno\" tvg-logo=\"http://logo.example/1.png\" tvg-chno=\"101\" group-title=\"Noticias, Local\",Canal 1 HD",
  "#EXTVLCOPT:http-user-agent=SmartTVAgent/2.0",
  "#EXTVLCOPT:http-referrer=https://teleon.tv/",
  "http://stream.example/one.m3u8",
  "",
  "# a plain comment junk line",
  "#EXT-X-UNKNOWN:whatever",
  "#EXTINF:-1 group-title=\"El Salvador - TCS\",Canal 2 TCS SD",
  "http://jmp2.uk/two.m3u8",
  "#EXTINF:0 tvg-logo=\"http://logo.example/3.png\",Movie, The (2020)",
  "https://samsung.stream.example/three.m3u8",
  "#EXTINF:-1",
  "http://bare.example/four.m3u8"
].join("\r\n");

test("parseM3u reads the guide url, entries, quoted attrs and EXTVLCOPT pairs", () => {
  const parsed = parseM3u(FIXTURE);

  // url-tvg wins over x-tvg-url.
  assert.equal(parsed.urlTvg, "https://example.com/epg.xml");

  assert.equal(parsed.entries.length, 4);

  const [first, second, third, fourth] = parsed.entries;

  // Entry 1: full attribute set + EXTVLCOPT pair, quoted attr containing a
  // comma must keep the whole value and the title must stop at the unquoted
  // comma only.
  assert.equal(first.url, "http://stream.example/one.m3u8");
  assert.equal(first.name, "Canal 1 HD");
  assert.equal(first.group, "Noticias, Local");
  assert.equal(first.logo, "http://logo.example/1.png");
  assert.equal(first.tvgId, "ch1.example");
  assert.equal(first.tvgName, "Canal Uno");
  assert.equal(first.number, 101);
  assert.equal(first.userAgent, "SmartTVAgent/2.0");
  assert.equal(first.referrer, "https://teleon.tv/");

  // Entry 2: no EXTVLCOPT of its own, no logo, no tvg id.
  assert.equal(second.url, "http://jmp2.uk/two.m3u8");
  assert.equal(second.name, "Canal 2 TCS SD");
  assert.equal(second.group, "El Salvador - TCS");
  assert.equal(second.logo, null);
  assert.equal(second.tvgId, null);
  assert.equal(second.userAgent, null);
  assert.equal(second.referrer, null);

  // Entry 3: a title containing a comma survives intact ("Movie, The (2020)").
  assert.equal(third.url, "https://samsung.stream.example/three.m3u8");
  assert.equal(third.name, "Movie, The (2020)");
  assert.equal(third.group, null);
  assert.equal(third.logo, "http://logo.example/3.png");

  // Entry 4: EXTINF with no attributes -> bare entry with empty name.
  assert.equal(fourth.url, "http://bare.example/four.m3u8");
  assert.equal(fourth.name, "");
  assert.equal(fourth.group, null);
});

test("headersForEntry: entry values win, samsung default only without a referrer", () => {
  const [first, second, third] = parseM3u(FIXTURE).entries;

  // Entry declares both: they win verbatim.
  assert.deepEqual(headersForEntry(first), {
    "User-Agent": "SmartTVAgent/2.0",
    Referer: "https://teleon.tv/"
  });

  // jmp2.uk host with no referrer: the samsung default applies.
  assert.deepEqual(headersForEntry(second), { Referer: "https://www.samsung.com/" });

  // samsung host with no referrer: the samsung default applies.
  assert.deepEqual(headersForEntry(third), { Referer: "https://www.samsung.com/" });

  // A declared referrer on a samsung host still wins over the default.
  assert.deepEqual(
    headersForEntry({ url: "https://samsung.stream.example/x.m3u8", referrer: "https://own.tv/" }),
    { Referer: "https://own.tv/" }
  );

  // An unrelated host with no referrer gets no default at all (the Android
  // global-Referer defect must not come back).
  assert.deepEqual(headersForEntry({ url: "http://unrelated.example/live.m3u8" }), {});

  // A bare user agent with no url still carries through.
  assert.deepEqual(headersForEntry({ url: "", userAgent: "UA/1" }), { "User-Agent": "UA/1" });
});

test("premiumTvChannelId is stable across reordering and unique per url", () => {
  const [first, second] = parseM3u(FIXTURE).entries;

  const idOne = premiumTvChannelId(first.url);
  const idTwo = premiumTvChannelId(second.url);

  // Same url, same id — the identity must survive a reordered list.
  assert.equal(premiumTvChannelId(first.url), idOne);
  assert.equal(premiumTvChannelId(second.url), idTwo);
  assert.notEqual(idOne, idTwo);

  // Short hex-ish ids, and a stable id even for a non-string/empty input.
  assert.match(idOne, /^[0-9a-f]{8}$/);
  assert.equal(typeof premiumTvChannelId(""), "string");
  assert.equal(premiumTvChannelId(""), premiumTvChannelId(""));
});

test("parseM3u never throws on malformed input", () => {
  assert.deepEqual(parseM3u(null), { urlTvg: null, entries: [] });
  assert.deepEqual(parseM3u(""), { urlTvg: null, entries: [] });
  const garbage = parseM3u("garbage\nno attrs here\n#EXTINF:-1 tvg-logo=\"unterminated\nhttp://ok.example/a.m3u8");
  assert.equal(garbage.entries.length, 1);
  assert.equal(garbage.entries[0].url, "http://ok.example/a.m3u8");
});

test("parseM3u handles LF-only line endings the same as CRLF", () => {
  const lfOnly = FIXTURE.replace(/\r\n/g, "\n");
  const parsed = parseM3u(lfOnly);
  assert.equal(parsed.urlTvg, "https://example.com/epg.xml");
  assert.equal(parsed.entries.length, 4);
  assert.equal(parsed.entries[0].name, "Canal 1 HD");
  assert.equal(parsed.entries[0].referrer, "https://teleon.tv/");
});
