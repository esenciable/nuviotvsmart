// Magis LIVE flow test: drives portal/session/live with a fake transport that
// replays the response shapes measured against the live portal (see
// /tmp/magis-live-final.mjs). The media probe transport is faked too, so the
// cdn candidate loop is genuinely exercised. No real network in any test.
import test from "node:test";
import assert from "node:assert/strict";

import { createMagisCrypto } from "../js/core/magis/magisCrypto.js";
import { createMagisPortal } from "../js/core/magis/magisPortal.js";
import { createMagisSession } from "../js/core/magis/magisSession.js";
import { createMagisLive, defaultLiveMediaTransport } from "../js/core/magis/magisLive.js";
import { createMagisVodClient } from "../js/core/magis/index.js";

const CONFIG = {
  hosts: ["osuhk.m3x8o50te.com", "oogoy.f30c96w8.com"],
  appId: "com.android.msandroid",
  apkVersion: "49902",
  apkVerHeader: "43404",
  spkgVer: "2025-08-07 05:40:11_36_16_",
  threeDesKeyHex: "e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8"
};
const SN = "42b4f88294fe2151d1aac51003a06b0c";

const crypto = createMagisCrypto({ threeDesKeyHex: CONFIG.threeDesKeyHex });

// Fake portal transport: path -> response payload (wrapped in the measured
// hex-encrypted `data` envelope) or a function of the recorded calls. Every
// call is recorded; no real network anywhere.
function createFakeTransport({ responses, onCall } = {}) {
  const calls = [];
  const transport = async ({ host, path, headers, body }) => {
    calls.push({ host, path, headers, body });
    if (onCall) onCall({ host, path, headers, body });
    const route = responses[path];
    if (!route) throw new Error(`unexpected portal path: ${path}`);
    const answer = typeof route === "function" ? route(calls) : route;
    return { status: 200, bodyText: JSON.stringify({ returnCode: "", data: crypto.encryptPayload(answer) }) };
  };
  return { transport, calls };
}

function createHarness({ responses, mediaTransport } = {}) {
  const fake = createFakeTransport({ responses });
  const portal = createMagisPortal({ config: CONFIG, transport: fake.transport });
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
      const entry = (responses.__media || []).find((m) => url.startsWith(m.prefix));
      if (!entry) throw new Error(`unexpected media probe: ${url}`);
      return { status: entry.status, bodyPrefix: entry.bodyPrefix ?? "" };
    });
  const live = createMagisLive({ portal, config: CONFIG, session, mediaTransport: probe });
  return { live, session, portal, calls: fake.calls, probedRequests };
}

const SESSION_RESPONSES = {
  "v3/snToken": { snToken: "tok123" },
  "v8/active": { userId: "u1", userToken: "ut1" }
};

// --- categories ---

const LIVE_COLUMNS = {
  recommendList: [
    { id: 1, columnId: 76206, name: "Canales TV", alias: "tv", code: "live_tv", type: "live", free: 1 },
    { id: 2, columnId: 76207, name: "Deportes", alias: "dep", code: "live_sports", type: "live", free: 0 },
    { id: 3, columnId: 76206, name: "duplicated column", alias: "dup", code: "dup", type: "live", free: 1 }
  ]
};

test("live: categories come from recommendList, de-duplicated by columnId, and are cached", async () => {
  const harness = createHarness({
    responses: { ...SESSION_RESPONSES, getNextColumns: LIVE_COLUMNS }
  });
  const categories = await harness.live.listCategories();
  assert.deepEqual(categories, [
    { columnId: 76206, name: "Canales TV", code: "live_tv", free: 1 },
    { columnId: 76207, name: "Deportes", code: "live_sports", free: 0 }
  ]);
  // measured payload: masnew_live with pageSize 200 (30 silently truncates)
  const call = harness.calls.find((c) => c.path === "getNextColumns");
  const payload = crypto.decryptData(call.body);
  assert.equal(payload.columnCode, "masnew_live");
  assert.equal(payload.pageNum, 1);
  assert.equal(payload.pageSize, 200);
  assert.equal(payload.version, "");
  // cached in memory: a second call makes no new portal call
  const again = await harness.live.listCategories();
  assert.deepEqual(again, categories);
  assert.equal(harness.calls.filter((c) => c.path === "getNextColumns").length, 1);
});

// --- channels ---

function makeChannelRow(index, spelling = "channel") {
  if (spelling === "channel") {
    return {
      channelCode: `ch${index}`,
      channelName: `Canal ${index}`,
      channelNumber: 100 + index,
      posterUrl: `http://logo/${index}.png`
    };
  }
  return {
    code: `ch${index}`,
    name: `Canal ${index}`,
    number: 100 + index,
    logo: `http://logo/${index}.png`
  };
}

test("live: channels paginate until a short page and cache per (columnId, page)", async () => {
  const harness = createHarness({
    responses: {
      ...SESSION_RESPONSES,
      "v6/getLiveData": (calls) => {
        const pageNum = crypto.decryptData(calls[calls.length - 1].body).pageNum;
        // page 1 is full (pageSize 100), page 2 is short -> stop there
        const count = pageNum === 1 ? 100 : 3;
        return {
          channelList: Array.from({ length: count }, (_, i) => makeChannelRow((pageNum - 1) * 100 + i + 1))
        };
      }
    }
  });
  const channels = await harness.live.listChannels({ columnId: 76206 });
  assert.equal(channels.length, 103);
  assert.deepEqual(channels[0], {
    code: "ch1",
    name: "Canal 1",
    number: 101,
    logo: "http://logo/1.png"
  });
  const liveCalls = harness.calls.filter((c) => c.path === "v6/getLiveData");
  assert.equal(liveCalls.length, 2, "pagination must stop after the short page");
  assert.equal(crypto.decryptData(liveCalls[0].body).pageNum, 1);
  assert.equal(crypto.decryptData(liveCalls[1].body).pageNum, 2);
  assert.equal(crypto.decryptData(liveCalls[0].body).pageSize, 100);
  // per-(columnId, page) cache: the second call refetches nothing
  const again = await harness.live.listChannels({ columnId: 76206 });
  assert.deepEqual(again, channels);
  assert.equal(harness.calls.filter((c) => c.path === "v6/getLiveData").length, 2);
});

test("live: channels tolerate the liveList key and the short field spellings", async () => {
  const harness = createHarness({
    responses: {
      ...SESSION_RESPONSES,
      "v6/getLiveData": (calls) => {
        // page 1 carries the short-spelling rows; later pages are empty
        if (crypto.decryptData(calls[calls.length - 1].body).pageNum > 1) return { liveList: [] };
        return { liveList: [makeChannelRow(1, "short"), makeChannelRow(2, "short")] };
      }
    }
  });
  const channels = await harness.live.listChannels({ columnId: 1, pageSize: 2 });
  assert.deepEqual(channels, [
    { code: "ch1", name: "Canal 1", number: 101, logo: "http://logo/1.png" },
    { code: "ch2", name: "Canal 2", number: 102, logo: "http://logo/2.png" }
  ]);
});

// --- resolveChannel ---

function liveResponses({ media }) {
  return {
    ...SESSION_RESPONSES,
    __media: media,
    // Measured: playCode and license live INSIDE liveAddressList entries, never
    // at the root. The first entry here lacks a playCode, so it must be skipped.
    "v4/startPlayLive": {
      name: "Win Sports",
      liveAddressList: [
        { cdnType: "ys", quality: "hd", tag: "ys", AVFormat: "hls", playCode: "", license: "lic-empty" },
        { cdnType: "ys", quality: "sd", tag: "ys", AVFormat: "hls", playCode: "pc-live-1", license: "lic-live-1" }
      ]
    },
    // Measured: live cdns carry a path in main_addr that must be stripped.
    "v14/getSlbInfo": {
      cdn_list: [
        { tag: "vod", main_addr: "cdn-vod.example", url_list: [] },
        { tag: "live", main_addr: "http://cdn-a.example/v3/youshi/", url_list: [{ tag: "free", url: "auth-a" }] },
        { tag: "live", main_addr: "cdn-b.example", url_list: [{ tag: "free", url: "auth-b" }] }
      ]
    }
  };
}

test("live: resolveChannel strips main_addr paths, probes in order, and returns the first m3u8 answer", async () => {
  const harness = createHarness({
    responses: liveResponses({
      media: [
        { prefix: "http://cdn-a.example/", status: 404, bodyPrefix: "" },
        { prefix: "http://cdn-b.example/", status: 200, bodyPrefix: "#EXTM3U\n#EXT-X-VERSION:3\n" }
      ]
    })
  });
  const result = await harness.live.resolveChannel({ channelCode: "chGEN" });
  assert.equal(result.url, "http://cdn-b.example/live/pc-live-1.m3u8");
  // exact header set from the shared buildMediaProbeHeaders helper
  assert.deepEqual(result.headers, {
    "Content-Auth": "auth-b",
    "Content-License": "lic-live-1",
    "User-Agent": "Ranger/4.9.4-17294ac0",
    App: CONFIG.appId,
    "App-Version": CONFIG.apkVersion
  });
  assert.equal(result.diagnostics.cdnAnswered, "cdn-b.example");
  assert.deepEqual(result.diagnostics.cdnFailed, [
    { host: "cdn-a.example", status: 404, error: null }
  ]);
  // the path was stripped from the first cdn's main_addr
  assert.equal(harness.probedRequests[0].url, "http://cdn-a.example/live/pc-live-1.m3u8");
  assert.equal(harness.probedRequests[0].headers["Content-Auth"], "auth-a");
  // measured portal payloads
  const playPayload = crypto.decryptData(harness.calls.find((c) => c.path === "v4/startPlayLive").body);
  assert.equal(playPayload.channelCode, "chGEN");
  assert.equal(playPayload.columnId, 0);
  assert.equal(playPayload.type, "1");
  const slbPayload = crypto.decryptData(harness.calls.find((c) => c.path === "v14/getSlbInfo").body);
  assert.deepEqual(slbPayload.liveCodeList, ["chGEN"]);
});

test("live: resolveChannel throws a clear error when no candidate answers", async () => {
  const harness = createHarness({
    responses: liveResponses({
      media: [
        { prefix: "http://cdn-a.example/", status: 404, bodyPrefix: "" },
        { prefix: "http://cdn-b.example/", status: 404, bodyPrefix: "" }
      ]
    })
  });
  await assert.rejects(
    () => harness.live.resolveChannel({ channelCode: "chGEN" }),
    (error) => /no live cdn candidate/.test(error.message) && error.message.includes("cdn-a.example")
  );
});

test("live: an abort signal reaches the media transport and cancels resolution", async () => {
  const controller = new AbortController();
  const probeSeen = [];
  const mediaTransport = async ({ url, headers, signal }) => {
    probeSeen.push({ url, headers, signal });
    controller.abort();
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  const harness = createHarness({ responses: liveResponses({ media: [] }), mediaTransport });
  await assert.rejects(
    () => harness.live.resolveChannel({ channelCode: "chGEN", signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
  assert.equal(probeSeen[0].signal, controller.signal, "the caller signal must reach the probe transport");
});

test("live: an already-aborted signal rejects before any portal call", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = createHarness({
    responses: { ...SESSION_RESPONSES, "v4/startPlayLive": { liveAddressList: [] } }
  });
  await assert.rejects(
    () => harness.live.resolveChannel({ channelCode: "chGEN", signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
  assert.equal(harness.calls.length, 0);
});

// --- default probe transport: small prefix only, never the whole body ---

test("live probe transport: reads only a small prefix and cancels the body", async () => {
  let cancelled = false;
  let seen = null;
  const result = await defaultLiveMediaTransport({
    url: "http://cdn.example/live/pc.m3u8",
    headers: { "Content-Auth": "auth" },
    fetchImpl: (url, init) => {
      seen = { url, init };
      return Promise.resolve({
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              Promise.resolve({ value: new TextEncoder().encode("#EXTM3U\n#EXT-X-VERSION:3"), done: false }),
            cancel: () => {
              cancelled = true;
              return Promise.resolve();
            }
          })
        }
      });
    }
  });
  assert.equal(result.status, 200);
  assert.ok(result.bodyPrefix.startsWith("#EXTM3U"));
  assert.equal(cancelled, true, "the body must be cancelled after the prefix");
  assert.equal(seen.url, "http://cdn.example/live/pc.m3u8");
});

test("live probe transport: a stalled candidate aborts on the timeout", async () => {
  await assert.rejects(
    () =>
      defaultLiveMediaTransport({
        url: "http://cdn.example/live/pc.m3u8",
        headers: {},
        timeoutMs: 20,
        fetchImpl: (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          })
      }),
    /timed out/
  );
});

// --- factory wiring ---

function createFetchSpy(responseBodyFactory) {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ returnCode: "", data: crypto.encryptPayload(responseBodyFactory(url, init)) })
    };
  };
  return { fetchImpl, requested };
}

test("factory: createMagisVodClient wires an optional live member sharing portal/session", async () => {
  const { fetchImpl } = createFetchSpy(() => ({ recommendList: [] }));
  const client = await createMagisVodClient({
    config: CONFIG,
    fetchImpl,
    persistence: { load: () => ({ userId: "u1", userToken: "ut1", sn: SN }) }
  });
  assert.equal(typeof client.live.listCategories, "function");
  assert.equal(typeof client.live.listChannels, "function");
  assert.equal(typeof client.live.resolveChannel, "function");
  // shares the wired portal/session: no extra activation calls, just the column query
  const categories = await client.live.listCategories();
  assert.deepEqual(categories, []);
});
