// Magis VOD flow test: drives portal/session/vod with a fake transport that
// replays the response shapes measured against the live portal. One cdn entry
// answers 403, a later one answers 206, so the candidate selection loop is
// genuinely exercised. No real network in any test.
import test from "node:test";
import assert from "node:assert/strict";

import { createMagisCrypto } from "../js/core/magis/magisCrypto.js";
import { createMagisPortal } from "../js/core/magis/magisPortal.js";
import { createMagisSession, MAGIS_SN_SALT } from "../js/core/magis/magisSession.js";
import { createMagisVod } from "../js/core/magis/magisVod.js";
import {
  createMagisVodClient,
  MAGIS_PROXY_ENV_KEY
} from "../js/core/magis/index.js";

const CONFIG = {
  hosts: ["osuhk.m3x8o50te.com", "oogoy.f30c96w8.com"],
  appId: "com.android.msandroid",
  apkVersion: "49902",
  apkVerHeader: "43404",
  spkgVer: "2025-08-07 05:40:11_36_16_",
  threeDesKeyHex: "e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8"
};
const MAGIS_HEADERS = ["apk", "apkVer", "spkgVer", "User-Agent", "Content-Type"];
const SN_TOKEN = "tok123";
const SN = "42b4f88294fe2151d1aac51003a06b0c";
const SALT = MAGIS_SN_SALT;

const crypto = createMagisCrypto({ threeDesKeyHex: CONFIG.threeDesKeyHex });

// A fake portal transport: hosts map -> path -> response payload (or a
// { transportError } to simulate a transport failure). Responses are wrapped
// in the measured hex-encrypted `data` envelope. Every call is recorded.
function createFakeTransport({ hosts = CONFIG.hosts, responses, onCall } = {}) {
  const calls = [];
  const transport = async ({ host, path, headers, body }) => {
    calls.push({ host, path, headers, body });
    if (onCall) onCall({ host, path, headers, body });
    const route = responses[path];
    if (!route) throw new Error(`unexpected portal path: ${path}`);
    if (route.transportError) throw new Error(route.transportError);
    const answer = typeof route === "function" ? route(calls) : route;
    if (answer && answer.portalError) {
      return { status: 200, bodyText: JSON.stringify(answer.portalError) };
    }
    return { status: 200, bodyText: JSON.stringify({ returnCode: "", data: crypto.encryptPayload(answer) }) };
  };
  return { transport, calls };
}

function createHarness({ responses, persistence, hosts, proxyUrl } = {}) {
  const fake = createFakeTransport({ responses, hosts });
  const portal = createMagisPortal({ config: CONFIG, transport: fake.transport });
  const session = createMagisSession({
    portal,
    config: CONFIG,
    persistence,
    random: () => 0.5
  });
  const probedRequests = [];
  const mediaTransport = async ({ url, headers }) => {
    probedRequests.push({ url, headers });
    const entry = (responses.__media || []).find((m) => url.includes(m.prefix.replace(/^https?:\/\//, "")));
    if (!entry) throw new Error(`unexpected media probe: ${url}`);
    return { status: entry.status, headers: entry.headers || {} };
  };
  const vod = createMagisVod({ portal, config: CONFIG, session, mediaTransport, proxyUrl });
  return { vod, session, portal, calls: fake.calls, probedRequests };
}

const SESSION_RESPONSES = {
  "v3/snToken": { snToken: SN_TOKEN },
  "v8/active": { userId: "u1", userToken: "ut1" }
};

test("session: mints snToken, derives sn via md5, activates, and persists", async () => {
  let calls = 0;
  const responses = {
    "v3/snToken": { snToken: SN_TOKEN },
    "v8/active": (allCalls) => {
      calls = allCalls.length;
      return { userId: "u1", userToken: "ut1" };
    }
  };
  const saved = [];
  const harness = createHarness({ responses, persistence: { save: (s) => saved.push(s) } });
  const session = await harness.session.activate();
  assert.deepEqual(saved, [{ userId: "u1", userToken: "ut1", sn: SN }]);
  assert.equal(session.userId, "u1");
  assert.equal(session.userToken, "ut1");
  assert.equal(session.sn, SN);
  // v8/active is the second call and must carry the minted snToken plus sn
  const activeCall = harness.calls[1];
  assert.equal(activeCall.path, "v8/active");
  const activePayload = crypto.decryptData(activeCall.body);
  assert.equal(activePayload.snToken, SN_TOKEN);
  assert.equal(activePayload.sn, SN);
  void calls;
});

test("session: getOrCreate reuses persisted state without portal calls", async () => {
  const harness = createHarness({
    responses: SESSION_RESPONSES,
    persistence: { load: () => ({ userId: "u9", userToken: "ut9", sn: "sn9" }) }
  });
  const session = await harness.session.getOrCreate();
  assert.deepEqual(session, { userId: "u9", userToken: "ut9", sn: "sn9" });
  assert.equal(harness.calls.length, 0);
});

test("portal: sends the four Magis headers and a hex body decryptable with the key", async () => {
  const harness = createHarness({ responses: { "v3/ping": { pong: true } } });
  const answer = await harness.portal.call("v3/ping", { hello: "world" });
  assert.deepEqual(answer, { pong: true });
  const call = harness.calls[0];
  for (const header of MAGIS_HEADERS) {
    assert.ok(call.headers[header], `missing header ${header}`);
  }
  assert.equal(call.headers.apk, CONFIG.appId);
  assert.equal(call.headers.apkVer, CONFIG.apkVerHeader);
  assert.equal(call.headers.spkgVer, CONFIG.spkgVer);
  assert.equal(call.headers["User-Agent"], "okhttp/3.12.12");
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.equal(call.headers.Cookie, undefined);
  assert.equal(call.headers.Authorization, undefined);
  assert.match(call.body, /^[0-9a-f]+$/);
  assert.deepEqual(crypto.decryptData(call.body), { hello: "world" });
});

test("portal: a portal error (returnCode) stops immediately with no failover", async () => {
  const harness = createHarness({
    responses: {
      "v3/searchByName": { portalError: { returnCode: "portal200001", errorMessage: "version" } }
    }
  });
  await assert.rejects(
    () => harness.portal.call("v3/searchByName", {}),
    (error) => error.returnCode === "portal200001"
  );
  assert.equal(harness.calls.length, 1);
});

test("portal: transport errors fail over to the next host", async () => {
  const seenHosts = [];
  let callCount = 0;
  const transport = async ({ host, path }) => {
    seenHosts.push(host);
    callCount += 1;
    if (host === CONFIG.hosts[0]) throw new Error("socket hang up");
    if (path !== "v3/ping") throw new Error(`unexpected path ${path}`);
    return {
      status: 200,
      bodyText: JSON.stringify({ returnCode: "", data: crypto.encryptPayload({ pong: true }) })
    };
  };
  const portal = createMagisPortal({ config: CONFIG, transport });
  const answer = await portal.call("v3/ping", {});
  assert.deepEqual(answer, { pong: true });
  assert.deepEqual(seenHosts, CONFIG.hosts);
  assert.equal(callCount, 2);
});

test("portal: all-transport-failure throws", async () => {
  const transport = async () => {
    throw new Error("network down");
  };
  const portal = createMagisPortal({ config: CONFIG, transport });
  await assert.rejects(() => portal.call("v3/ping", {}), /network down|all Magis hosts/i);
});

const VOD_RESPONSES = {
  ...SESSION_RESPONSES,
  __media: [
    { prefix: "https://cdn-a.vod.example/", status: 403 },
    { prefix: "https://cdn-b.vod.example/", status: 206 }
  ],
  "v3/searchByName": {
    searchItemList: [
      {
        itemList: [
          {
            name: "The Matrix",
            programType: "movie",
            contentId: "1001",
            releaseTime: "1999-03-31",
            score: "8.7"
          },
          {
            name: "The Matrix Reloaded",
            programType: "movie",
            contentId: "1002",
            releaseTime: "2003-05-15",
            score: "7.2"
          }
        ]
      }
    ]
  },
  "v10/startPlayVOD": {
    episodeList: [
      {
        totalMovieList: [
          {
            movieList: [
              {
                contentId: "m-hevc",
                videoFormat: "m3u8",
                encodeFormat: "H265",
                quality: "4K",
                licenseList: [{ license: "lic-hevc" }]
              },
              {
                contentId: "m-play",
                videoFormat: "mp4",
                encodeFormat: "H264",
                quality: "1080P",
                licenseList: [{ license: "lic-play" }]
              }
            ]
          }
        ]
      }
    ]
  },
  "v14/getSlbInfo": {
    cdn_list: [
      { tag: "record", main_addr: "rec.example.com", url_list: [] },
      { tag: "live", main_addr: "live.example.com", url_list: [{ tag: "free", url: "live-auth" }] },
      {
        tag: "vod",
        main_addr: "cdn-a.vod.example",
        url_list: [
          { tag: "paid", url: "skip-me" },
          { tag: "free", url: "auth-a" }
        ]
      },
      {
        tag: "vod",
        main_addr: "cdn-b.vod.example",
        url_list: [{ tag: "short", url: "auth-b" }]
      }
    ]
  }
};

test("vod: full flow resolves the first 200/206 candidate with its headers", async () => {
  const harness = createHarness({ responses: VOD_RESPONSES });
  const result = await harness.vod.resolveStream({ title: "The Matrix", year: "1999" });
  assert.equal(result.url, "https://cdn-b.vod.example/vod/m-play_media.mp4");
  assert.equal(result.headers["Content-Auth"], "auth-b");
  assert.equal(result.headers["Content-License"], "lic-play");
  assert.equal(result.headers["User-Agent"], "Ranger/4.9.4-17294ac0");
  assert.equal(result.headers.App, CONFIG.appId);
  assert.equal(result.headers["App-Version"], CONFIG.apkVersion);
  assert.equal(result.diagnostics.cdnAnswered, "cdn-b.vod.example");
  assert.deepEqual(result.diagnostics.cdnFailed, [
    { host: "cdn-a.vod.example", tag: "free", status: 403, error: null }
  ]);
  // probe request headers carried the auth of the probed entry
  assert.equal(harness.probedRequests[0].headers["Content-Auth"], "auth-a");
  assert.equal(harness.probedRequests[0].headers["Content-License"], "lic-play");
  // the paid entry was never probed
  assert.ok(!harness.probedRequests.some((r) => r.url.includes("cdn-a") && r.headers["Content-Auth"] === "skip-me"));
});

test("vod: search payload prepends portalCode/userId/userToken and the device dict with sn", async () => {
  const harness = createHarness({ responses: VOD_RESPONSES });
  await harness.vod.resolveStream({ title: "The Matrix", year: "1999" });
  const searchCall = harness.calls.find((c) => c.path === "v3/searchByName");
  const payload = crypto.decryptData(searchCall.body);
  assert.equal(payload.portalCode, "masnew");
  assert.equal(payload.userId, "u1");
  assert.equal(payload.userToken, "ut1");
  assert.equal(payload.value, "The Matrix");
  assert.equal(payload.sn, SN);
  const playCall = harness.calls.find((c) => c.path === "v10/startPlayVOD");
  const playPayload = crypto.decryptData(playCall.body);
  assert.equal(playPayload.contentId, "1001");
  assert.equal(playPayload.seriesContentId, "");
});

test("vod: series flow calls getItemData and targets the requested episode", async () => {
  const responses = {
    ...SESSION_RESPONSES,
    __media: [{ prefix: "https://cdn-b.vod.example/", status: 200 }],
    "v3/searchByName": {
      searchItemList: [
        {
          itemList: [
            {
              name: "Dark",
              programType: "teleplay",
              contentId: "2001",
              releaseTime: "2017-12-01"
            }
          ]
        }
      ]
    },
    // Measured shape: v4/getItemData answers assetData with the season packs and
    // the episode list, and startPlayVOD needs the episode plus the pack id.
    "v4/getItemData": {
      assetData: {
        sameSeasonSeriesList: [
          { seasonNumber: 1, contentId: "1001" },
          { seasonNumber: 2, contentId: "2001" }
        ],
        simpleProgramList: [
          { seriesNumber: 1, contentId: "e-s2e1", name: "01" },
          { seriesNumber: 2, contentId: "e-s2e2", name: "02" },
          { seriesNumber: 3, contentId: "e-s2e3", name: "03" }
        ]
      }
    },
    "v10/startPlayVOD": {
      episodeList: [
        {
          totalMovieList: [
            {
              movieList: [
                {
                  contentId: "e-s2e3",
                  videoFormat: "mp4",
                  encodeFormat: "H264",
                  quality: "720P",
                  licenseList: [{ license: "lic-ep2" }]
                }
              ]
            }
          ]
        }
      ]
    },
    "v14/getSlbInfo": VOD_RESPONSES["v14/getSlbInfo"]
  };
  const harness = createHarness({ responses });
  const result = await harness.vod.resolveStream({ title: "Dark", isSeries: true, season: 2, episode: 3 });
  const playCall = harness.calls.find((c) => c.path === "v10/startPlayVOD");
  const playPayload = crypto.decryptData(playCall.body);
  assert.equal(playPayload.contentId, "e-s2e3");
  assert.equal(playPayload.seriesContentId, "2001");
  assert.equal(
    harness.calls.filter((c) => c.path === "v4/getItemData").length,
    1,
    "the searched pack is already the requested season, so no refetch"
  );
  assert.equal(result.url, "https://cdn-b.vod.example/vod/e-s2e3_media.mp4");
  assert.equal(result.headers["Content-License"], "lic-ep2");
});

// --- transport defaults: direct fetch is the default, proxy is an override ---

function createFetchSpy(responseBodyFactory) {
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          returnCode: "",
          data: crypto.encryptPayload(responseBodyFactory(url, init))
        })
    };
  };
  return { fetchImpl, requested };
}

const ENV_BACKUP = globalThis.__NUVIO_ENV__;
test.after(() => {
  if (ENV_BACKUP === undefined) delete globalThis.__NUVIO_ENV__;
  else globalThis.__NUVIO_ENV__ = ENV_BACKUP;
});

test("factory: direct transport is the DEFAULT path (no proxy configured)", async () => {
  globalThis.__NUVIO_ENV__ = {}; // NUVIO_MAGIS_PROXY_URL absent -> direct
  const { fetchImpl, requested } = createFetchSpy(() => ({ pong: true }));
  const client = await createMagisVodClient({
    config: CONFIG,
    fetchImpl,
    persistence: { load: () => ({ userId: "u1", userToken: "ut1", sn: SN }) }
  });
  assert.equal(client.proxyUrl, "");
  const answer = await client.portal.call("v3/ping", { hello: "world" });
  assert.deepEqual(answer, { pong: true });
  assert.equal(requested.length, 1);
  // direct against the first configured portal host, not through a proxy
  assert.equal(
    requested[0].url,
    `https://${CONFIG.hosts[0]}/api/portalCore/v3/ping`
  );
  assert.equal(requested[0].init.method, "POST");
  assert.equal(requested[0].init.headers.apk, CONFIG.appId);
  assert.match(requested[0].init.body, /^[0-9a-f]+$/);
});

test("factory: proxy URL is an optional override routed through /magis/<host>/", async () => {
  const { fetchImpl, requested } = createFetchSpy(() => ({ pong: true }));
  const client = await createMagisVodClient({
    config: CONFIG,
    proxyUrl: "http://localhost:8792",
    fetchImpl,
    persistence: { load: () => ({ userId: "u1", userToken: "ut1", sn: SN }) }
  });
  assert.equal(client.proxyUrl, "http://localhost:8792");
  await client.portal.call("v3/ping", {});
  assert.equal(
    requested[0].url,
    `http://localhost:8792/magis/${CONFIG.hosts[0]}/api/portalCore/v3/ping`
  );
});

test("factory: proxy URL override is read from __NUVIO_ENV__", async () => {
  globalThis.__NUVIO_ENV__ = { [MAGIS_PROXY_ENV_KEY]: "http://proxy.example:9000" };
  const { fetchImpl, requested } = createFetchSpy(() => ({ pong: true }));
  const client = await createMagisVodClient({
    config: CONFIG,
    fetchImpl,
    persistence: { load: () => ({ userId: "u1", userToken: "ut1", sn: SN }) }
  });
  assert.equal(client.proxyUrl, "http://proxy.example:9000");
  await client.portal.call("v3/ping", {});
  assert.ok(requested[0].url.startsWith("http://proxy.example:9000/magis/"));
});

// --- media through the proxy ------------------------------------------------

// When a proxy is configured the VOD media url (and the candidate probe) must
// go through the proxy's media route: a plain browser can neither speak plain
// http to an https page nor send Content-Auth/User-Agent to the cdn.
test("vod: with a proxy the probe and the returned media url use the proxy media route", async () => {
  const harness = createHarness({ responses: VOD_RESPONSES, proxyUrl: "https://tvvidaa.attendanceos.app" });
  const result = await harness.vod.resolveStream({ title: "The Matrix", year: "1999" });
  // the probe went through the proxy media route with the credentials in the query
  assert.match(
    harness.probedRequests[0].url,
    /^https:\/\/tvvidaa\.attendanceos\.app\/media\/cdn-a\.vod\.example\/vod\/m-play_media\.mp4\?magis_auth=auth-a/
  );
  // the winning candidate is returned as a proxied absolute https url
  assert.equal(
    result.url,
    "https://tvvidaa.attendanceos.app/media/cdn-b.vod.example/vod/m-play_media.mp4?magis_auth=auth-b&magis_license=lic-play"
  );
  // the browser sends no custom media headers: the proxy injects them
  assert.deepEqual(result.headers, {});
  // the direct Tizen-style resolution stays available for diagnostics
  assert.equal(result.directUrl, "https://cdn-b.vod.example/vod/m-play_media.mp4");
  assert.equal(result.directHeaders["Content-Auth"], "auth-b");
  // no long-lived secret may ever travel in the media url
  assert.ok(!result.url.includes("ut1"));
  assert.ok(!result.url.includes("Ranger"));
});

test("tizen: without a proxy the vod resolver keeps today's absolute direct url and full header set", async () => {
  globalThis.__NUVIO_ENV__ = {}; // no NUVIO_MAGIS_PROXY_URL -> direct, as on Tizen
  const harness = createHarness({ responses: VOD_RESPONSES });
  const result = await harness.vod.resolveStream({ title: "The Matrix", year: "1999" });
  // the widget ignores CORS and uses absolute media URLs: assert both.
  assert.equal(result.url, "https://cdn-b.vod.example/vod/m-play_media.mp4");
  assert.ok(URL.canParse(result.url), "the media url must be absolute");
  assert.deepEqual(result.headers, {
    "Content-Auth": "auth-b",
    "Content-License": "lic-play",
    "User-Agent": "Ranger/4.9.4-17294ac0",
    App: CONFIG.appId,
    "App-Version": CONFIG.apkVersion
  });
  assert.equal(harness.probedRequests[0].url, "https://cdn-a.vod.example/vod/m-play_media.mp4");
  assert.equal(result.directUrl, undefined, "no diagnostics fields on the direct path");
});
