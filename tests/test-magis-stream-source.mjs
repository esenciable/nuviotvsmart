// Magis stream source tests: drive createMagisStreamSource with a fake Magis
// client and a fake titleLookup. No network, no portal, no localStorage.
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAGIS_STREAM_SOURCE_ID,
  MAGIS_STREAM_SOURCE_NAME,
  createMagisStreamSource
} from "../js/core/magis/magisStreamSource.js";

const RESOLVED_STREAM = {
  url: "https://cdn-b.vod.example/vod/m-play_media.mp4",
  headers: {
    "Content-Auth": "auth-b",
    "Content-License": "lic-play",
    "User-Agent": "Ranger/4.9.4-17294ac0",
    App: "com.android.msandroid",
    "App-Version": "49902"
  },
  contentId: "m-play",
  media: { quality: "1080P", videoFormat: "mp4", encodeFormat: "H264" },
  diagnostics: { cdnAnswered: "cdn-b.vod.example", cdnFailed: [] }
};

// The fake client counts every interaction that would touch the portal:
// session minting and stream resolution both go through the portal in the
// real client. sessionMints counts actual mints only; reuses are free.
function createFakeMagisClient({ resolveResult = RESOLVED_STREAM, resolveError = null } = {}) {
  const counters = { sessionMints: 0, sessionReuses: 0, resolveCalls: 0 };
  const resolveRequests = [];
  let sessionState = null;
  const client = {
    session: {
      async getOrCreate() {
        if (sessionState) {
          counters.sessionReuses += 1;
          return sessionState;
        }
        counters.sessionMints += 1;
        sessionState = { userId: "u1", userToken: "ut1", sn: "sn1" };
        return sessionState;
      }
    },
    async resolveStream(request) {
      counters.resolveCalls += 1;
      resolveRequests.push(request);
      if (resolveError) throw resolveError;
      return resolveResult;
    }
  };
  return { client, counters, resolveRequests };
}

function createTitleLookup(identity = { title: "The Matrix", year: "1999", isSeries: false }) {
  const calls = [];
  const titleLookup = async (videoId, type) => {
    calls.push({ videoId, type });
    return identity;
  };
  return { titleLookup, calls };
}

test("a resolved stream produces one group whose stream carries the required headers and the resolved URL", async () => {
  const { client, counters, resolveRequests } = createFakeMagisClient();
  const { titleLookup, calls } = createTitleLookup();
  const source = createMagisStreamSource({ client, persistence: {}, titleLookup });
  assert.equal(source.isAvailable(), true);

  const group = await source.resolveStreamGroup({ type: "movie", videoId: "tt0133093" });

  assert.ok(group, "expected a stream group");
  assert.equal(group.addonId, MAGIS_STREAM_SOURCE_ID);
  assert.equal(group.addonName, MAGIS_STREAM_SOURCE_NAME);
  assert.equal(group.streamOrigin.kind, "magis");
  assert.equal(group.streams.length, 1);

  const stream = group.streams[0];
  assert.equal(stream.name, MAGIS_STREAM_SOURCE_NAME);
  assert.equal(stream.url, RESOLVED_STREAM.url);
  // The player reads request headers from behaviorHints.proxyHeaders.request.
  const requestHeaders = stream.behaviorHints?.proxyHeaders?.request;
  assert.ok(requestHeaders, "stream must carry request headers");
  assert.equal(requestHeaders["Content-Auth"], "auth-b");
  assert.equal(requestHeaders["Content-License"], "lic-play");
  assert.equal(requestHeaders["User-Agent"], "Ranger/4.9.4-17294ac0");
  assert.equal(requestHeaders.App, "com.android.msandroid");
  assert.equal(requestHeaders["App-Version"], "49902");
  assert.equal(group.streams[0].addonId, MAGIS_STREAM_SOURCE_ID);

  // The title lookup was consulted once with (videoId, type).
  assert.deepEqual(calls, [{ videoId: "tt0133093", type: "movie" }]);
  // The client resolved with the looked-up identity.
  assert.equal(resolveRequests.length, 1);
  assert.equal(resolveRequests[0].title, "The Matrix");
  assert.equal(resolveRequests[0].year, "1999");
  assert.equal(resolveRequests[0].isSeries, false);
  assert.equal(counters.resolveCalls, 1);
});

test("a null title lookup performs no portal call and returns null", async () => {
  const { client, counters } = createFakeMagisClient();
  const source = createMagisStreamSource({
    client,
    persistence: {},
    titleLookup: async () => null
  });

  const group = await source.resolveStreamGroup({ type: "movie", videoId: "tt0000000" });

  assert.equal(group, null);
  // Session mint and stream resolve both hit the portal; neither may happen.
  assert.equal(counters.sessionMints, 0);
  assert.equal(counters.resolveCalls, 0);
  assert.ok(String(source.getDiagnostic() || ""), "a diagnostic is kept for logging");
});

test("a rejected client promise returns null and does not throw", async () => {
  const { client, counters } = createFakeMagisClient({
    resolveError: new Error("portal down")
  });
  const { titleLookup } = createTitleLookup();
  const source = createMagisStreamSource({ client, persistence: {}, titleLookup });

  const group = await source.resolveStreamGroup({ type: "movie", videoId: "tt0133093" });

  assert.equal(group, null);
  assert.equal(counters.resolveCalls, 1);
  assert.match(String(source.getDiagnostic() || ""), /portal down/);
});

test("a rejected session promise returns null and does not throw", async () => {
  const client = {
    session: {
      getOrCreate: async () => {
        throw new Error("session activation failed");
      }
    },
    resolveStream: async () => RESOLVED_STREAM
  };
  const { titleLookup } = createTitleLookup();
  const source = createMagisStreamSource({ client, persistence: {}, titleLookup });

  const group = await source.resolveStreamGroup({ type: "movie", videoId: "tt0133093" });

  assert.equal(group, null);
  assert.match(String(source.getDiagnostic() || ""), /session activation failed/);
});

test("the session is minted once and reused on a second call", async () => {
  const { client, counters } = createFakeMagisClient();
  const { titleLookup } = createTitleLookup();
  const source = createMagisStreamSource({ client, persistence: {}, titleLookup });

  const first = await source.resolveStreamGroup({ type: "movie", videoId: "tt0133093" });
  const second = await source.resolveStreamGroup({ type: "movie", videoId: "tt0234215" });

  assert.ok(first && second, "both resolutions produce groups");
  assert.equal(counters.sessionMints, 1, "the session must be minted exactly once");
  assert.ok(counters.sessionReuses >= 1, "the second call must reuse the minted session");
  assert.equal(counters.resolveCalls, 2);
});

test("a series video id splits season and episode and marks the request as a series", async () => {
  const { client, resolveRequests } = createFakeMagisClient();
  const { titleLookup } = createTitleLookup({
    title: "Game of Thrones",
    year: "2011",
    isSeries: true
  });
  const source = createMagisStreamSource({ client, persistence: {}, titleLookup });

  const group = await source.resolveStreamGroup({ type: "series", videoId: "tt0944947:1:2" });

  assert.ok(group, "expected a stream group");
  assert.equal(resolveRequests.length, 1);
  assert.equal(resolveRequests[0].title, "Game of Thrones");
  assert.equal(resolveRequests[0].year, "2011");
  assert.equal(resolveRequests[0].isSeries, true);
  assert.equal(resolveRequests[0].season, 1);
  assert.equal(resolveRequests[0].episode, 2);
});

test("a thrown title lookup returns null without any portal call", async () => {
  const { client, counters } = createFakeMagisClient();
  const source = createMagisStreamSource({
    client,
    persistence: {},
    titleLookup: async () => {
      throw new Error("meta lookup exploded");
    }
  });

  const group = await source.resolveStreamGroup({ type: "movie", videoId: "tt0133093" });

  assert.equal(group, null);
  assert.equal(counters.sessionMints, 0);
  assert.equal(counters.resolveCalls, 0);
});

test("the source is unavailable without a title lookup or a way to reach Magis", () => {
  const { client } = createFakeMagisClient();
  const { titleLookup } = createTitleLookup();

  assert.equal(createMagisStreamSource({ client, persistence: {} }).isAvailable(), false);
  assert.equal(createMagisStreamSource({ persistence: {}, titleLookup }).isAvailable(), true);
});
