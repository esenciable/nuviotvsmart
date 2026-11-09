// Magis LIVE media tests: when a Magis proxy is configured the live playlist
// URL (and the probe that selects the candidate) must go through the proxy's
// media route, because a plain browser can neither speak plain http to an
// https page (mixed content) nor send the CDN's Content-Auth/User-Agent
// headers. Without a proxy the Tizen path must stay exactly as it is today:
// absolute direct media URLs plus the full header set.
import test from "node:test";
import assert from "node:assert/strict";

import { createMagisCrypto } from "../js/core/magis/magisCrypto.js";
import { createMagisPortal } from "../js/core/magis/magisPortal.js";
import { createMagisSession } from "../js/core/magis/magisSession.js";
import { createMagisLive } from "../js/core/magis/magisLive.js";
import { buildProxiedMediaUrl } from "../js/core/magis/magisVod.js";
import { MAGIS_PROXY_ENV_KEY } from "../js/core/magis/index.js";

const CONFIG = {
  hosts: ["osuhk.m3x8o50te.com", "oogoy.f30c96w8.com"],
  appId: "com.android.msandroid",
  apkVersion: "49902",
  apkVerHeader: "43404",
  spkgVer: "2025-08-07 05:40:11_36_16_",
  threeDesKeyHex: "e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8"
};
const SN = "42b4f88294fe2151d1aac51003a06b0c";
const PROXY_URL = "https://tvvidaa.attendanceos.app";

const crypto = createMagisCrypto({ threeDesKeyHex: CONFIG.threeDesKeyHex });

const SESSION_RESPONSES = {
  "v3/snToken": { snToken: "tok123" },
  "v8/active": { userId: "u1", userToken: "ut1" }
};

const MEDIA_ANSWERS = [
  { prefix: "http://cdn-a.example/", status: 404, bodyPrefix: "" },
  { prefix: "http://cdn-b.example/", status: 200, bodyPrefix: "#EXTM3U\n" }
];

// Same measured shapes as tests/test-magis-live.mjs.
const LIVE_RESPONSES = {
  ...SESSION_RESPONSES,
  __media: MEDIA_ANSWERS,
  "v4/startPlayLive": {
    liveAddressList: [
      { playCode: "pc-live-1", license: "lic-live-1" }
    ]
  },
  "v14/getSlbInfo": {
    cdn_list: [
      { tag: "vod", main_addr: "cdn-vod.example", url_list: [] },
      { tag: "live", main_addr: "http://cdn-a.example/v3/youshi/", url_list: [{ tag: "free", url: "auth-a" }] },
      { tag: "live", main_addr: "cdn-b.example", url_list: [{ tag: "free", url: "auth-b" }] }
    ]
  }
};

// Same measured shapes as tests/test-magis-live.mjs.
function createHarness({ responses, proxyUrl, mediaTransport } = {}) {
  const calls = [];
  const transport = async ({ host, path, headers, body }) => {
    calls.push({ host, path, headers, body });
    const route = responses[path];
    if (!route) throw new Error(`unexpected portal path: ${path}`);
    return {
      status: 200,
      bodyText: JSON.stringify({ returnCode: "", data: crypto.encryptPayload(route) })
    };
  };
  const portal = createMagisPortal({ config: CONFIG, transport });
  const session = createMagisSession({
    portal,
    config: CONFIG,
    persistence: { load: () => ({ userId: "u1", userToken: "ut1", sn: SN }) }
  });
  const probedRequests = [];
  const probe =
    mediaTransport ||
    (async ({ url, headers, signal }) => {
      probedRequests.push({ url, headers, signal });
      const entry = (responses.__media || []).find((m) => url.includes(m.prefix.slice("http://".length)));
      if (!entry) throw new Error(`unexpected media probe: ${url}`);
      return { status: entry.status, bodyPrefix: entry.bodyPrefix ?? "" };
    });
  const live = createMagisLive({ portal, config: CONFIG, session, mediaTransport: probe, proxyUrl });
  return { live, probedRequests, calls };
}

const ENV_BACKUP = globalThis.__NUVIO_ENV__;
test.after(() => {
  if (ENV_BACKUP === undefined) delete globalThis.__NUVIO_ENV__;
  else globalThis.__NUVIO_ENV__ = ENV_BACKUP;
});

// --- buildProxiedMediaUrl -------------------------------------------------

test("buildProxiedMediaUrl: maps a direct media url onto the proxy /media route with only the per-play credentials", () => {
  const proxied = buildProxiedMediaUrl({
    proxyUrl: PROXY_URL,
    url: "http://cdn-b.example/live/pc-live-1.m3u8",
    headers: {
      "Content-Auth": "auth-b",
      "Content-License": "lic-live-1",
      "User-Agent": "Ranger/4.9.4-17294ac0",
      App: CONFIG.appId,
      "App-Version": String(CONFIG.apkVersion)
    }
  });
  assert.equal(
    proxied,
    `${PROXY_URL}/media/cdn-b.example/live/pc-live-1.m3u8?magis_auth=auth-b&magis_license=lic-live-1`
  );
  // the constants the proxy injects server-side must never travel in the URL
  assert.ok(!proxied.includes("Ranger"));
  assert.ok(!proxied.includes(CONFIG.appId));
  // and no long-lived secret may ever appear
  assert.ok(!proxied.includes("ut1"));
});

test("buildProxiedMediaUrl: absent credentials are simply omitted, and no proxy yields null", () => {
  const bare = buildProxiedMediaUrl({
    proxyUrl: PROXY_URL,
    url: "https://cdn.example/vod/m1_media.mp4",
    headers: {}
  });
  assert.equal(bare, `${PROXY_URL}/media/cdn.example/vod/m1_media.mp4`);
  assert.equal(
    buildProxiedMediaUrl({ proxyUrl: "", url: "http://cdn.example/x", headers: {} }),
    null,
    "no proxy configured -> keep the direct url"
  );
  assert.equal(buildProxiedMediaUrl({ proxyUrl: PROXY_URL, url: "", headers: {} }), null);
});

test("buildProxiedMediaUrl: preserves an existing upstream query", () => {
  const proxied = buildProxiedMediaUrl({
    proxyUrl: `${PROXY_URL}/`,
    url: "https://cdn.example/live/pc.m3u8?token=abc",
    headers: { "Content-Auth": "a" }
  });
  assert.equal(
    proxied,
    `${PROXY_URL}/media/cdn.example/live/pc.m3u8?token=abc&magis_auth=a`
  );
});

// --- live resolver through the proxy --------------------------------------

test("live: with a proxy the candidate probe and the returned playlist url both use the proxy media route", async () => {
  const harness = createHarness({ responses: LIVE_RESPONSES, proxyUrl: PROXY_URL });
  const result = await harness.live.resolveChannel({ channelCode: "chGEN" });
  // the probe must go through the proxy (https page cannot fetch http://cdn directly)
  assert.match(harness.probedRequests[0].url, /^https:\/\/tvvidaa\.attendanceos\.app\/media\/cdn-a\.example\/live\/pc-live-1\.m3u8\?magis_auth=auth-a/);
  // the winning candidate is returned as a proxied absolute https url
  assert.equal(
    result.url,
    `${PROXY_URL}/media/cdn-b.example/live/pc-live-1.m3u8?magis_auth=auth-b&magis_license=lic-live-1`
  );
  // the browser sends no custom media headers: the proxy injects them
  assert.deepEqual(result.headers, {});
  // the direct Tizen-style resolution stays available for diagnostics
  assert.equal(result.directUrl, "http://cdn-b.example/live/pc-live-1.m3u8");
  assert.equal(result.directHeaders["Content-Auth"], "auth-b");
  assert.equal(result.diagnostics.cdnAnswered, "cdn-b.example");
});

test("live: the proxied playlist url never carries the license constants or long-lived secrets", async () => {
  const harness = createHarness({ responses: LIVE_RESPONSES, proxyUrl: PROXY_URL });
  const result = await harness.live.resolveChannel({ channelCode: "chGEN" });
  assert.ok(!result.url.includes("Ranger"));
  assert.ok(!result.url.includes(CONFIG.appId));
  assert.ok(!result.url.includes("ut1"), "the session userToken is a long-lived secret");
});

// --- Tizen no-regression ---------------------------------------------------

test("tizen: without a proxy the live resolver keeps today's absolute direct url and full header set", async () => {
  delete globalThis.__NUVIO_ENV__;
  const harness = createHarness({ responses: LIVE_RESPONSES });
  const result = await harness.live.resolveChannel({ channelCode: "chGEN" });
  // the widget ignores CORS and uses absolute media URLs: assert both.
  assert.equal(result.url, "http://cdn-b.example/live/pc-live-1.m3u8");
  assert.ok(URL.canParse(result.url), "the media url must be absolute");
  assert.equal(new URL(result.url).protocol, "http:");
  assert.deepEqual(result.headers, {
    "Content-Auth": "auth-b",
    "Content-License": "lic-live-1",
    "User-Agent": "Ranger/4.9.4-17294ac0",
    App: CONFIG.appId,
    "App-Version": String(CONFIG.apkVersion)
  });
  // the probe still hits the cdn directly
  assert.equal(harness.probedRequests[0].url, "http://cdn-a.example/live/pc-live-1.m3u8");
});

// --- env-driven proxy -------------------------------------------------------

test("live: the proxy url is picked up from __NUVIO_ENV__ when not injected", async () => {
  globalThis.__NUVIO_ENV__ = { [MAGIS_PROXY_ENV_KEY]: PROXY_URL };
  const harness = createHarness({ responses: LIVE_RESPONSES });
  const result = await harness.live.resolveChannel({ channelCode: "chGEN" });
  assert.equal(
    result.url,
    `${PROXY_URL}/media/cdn-b.example/live/pc-live-1.m3u8?magis_auth=auth-b&magis_license=lic-live-1`
  );
});
