// Magis proxy MEDIA route tests: the proxy must also serve live/VOD media
// (GET|HEAD /media/<cdn-host>/<path...>) so a browser can play what the
// portal resolved. The upstream https.request is injected, so no test ever
// touches the real network; the proxy itself is reached over the loopback
// listener like a real browser would.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import http from "node:http";

import { createMagisProxyServer } from "../scripts/magis-proxy.mjs";

const CONFIG = {
  hosts: ["portal-a.example"],
  appId: "com.android.msandroid",
  apkVersion: "49902"
};

// A fake https.request seam: records every upstream call, answers from a
// handler that returns { response } or { error }.
function createUpstreamStub(handler) {
  const calls = [];
  const httpsRequest = (targetUrl, options, onResponse) => {
    calls.push({ targetUrl, options });
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = () => {};
    setImmediate(() => {
      let outcome;
      try {
        outcome = handler({ targetUrl, options }) || {};
      } catch (error) {
        request.emit("error", error);
        return;
      }
      if (outcome.error) {
        request.emit("error", outcome.error);
        return;
      }
      setImmediate(() => onResponse(outcome.response));
    });
    return request;
  };
  return { httpsRequest, calls };
}

function fakeUpstreamResponse({ statusCode = 200, headers = {}, chunks = [] } = {}) {
  const stream = new Readable({ read() {} });
  for (const chunk of chunks) {
    stream.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  stream.push(null); // terminate the body: a fake upstream that never ends
  // would stall the proxy forever (pipe never ends the client response and
  // playlist rewriting waits on 'end') — a real https response always ends.
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function startProxy({ upstream, config = CONFIG, logs = [] } = {}) {
  const server = createMagisProxyServer({
    config,
    httpsRequest: upstream?.httpsRequest,
    log: (message) => logs.push(message)
  });
  const close = () => new Promise((resolve) => server.close(resolve));
  return { server, close };
}

// --- media route: forwarding and headers ---------------------------------

test("media: GET forwards to https with the injected media headers and no cookies/origin", async () => {
  const upstream = createUpstreamStub(({ targetUrl }) => ({
    response: fakeUpstreamResponse({
      statusCode: 206,
      headers: { "content-type": "video/mp2t", "content-length": "5" },
      chunks: ["12345"]
    })
  }));
  const logs = [];
  const { server, close } = startProxy({ upstream, logs });
  try {
    const base = await listen(server);
    const response = await fetch(
      `${base}/media/cdn-live.example/live/pc-1.m3u8?magis_auth=auth-tok&magis_license=lic-tok`,
      {
        method: "GET",
        headers: { Origin: "https://app.example", Cookie: "session=private", Range: "bytes=0-2047" }
      }
    );
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "12345");
    const call = upstream.calls[0];
    assert.equal(call.targetUrl, "https://cdn-live.example/live/pc-1.m3u8");
    assert.equal(call.options.method, "GET");
    // the media headers the CDN needs are injected by the proxy, not the browser
    assert.equal(call.options.headers["Content-Auth"], "auth-tok");
    assert.equal(call.options.headers["Content-License"], "lic-tok");
    assert.equal(call.options.headers["User-Agent"], "Ranger/4.9.4-17294ac0");
    assert.equal(call.options.headers.App, CONFIG.appId);
    assert.equal(call.options.headers["App-Version"], String(CONFIG.apkVersion));
    // a Range the browser sent reaches the CDN (byte-range segments, VOD probe)
    assert.equal(call.options.headers.Range, "bytes=0-2047");
    // browser-only headers never reach the CDN
    assert.equal(call.options.headers.Origin, undefined);
    assert.equal(call.options.headers.Cookie, undefined);
    // never log credentials: the query string must not appear in any log line
    assert.ok(!logs.some((line) => line.includes("auth-tok") || line.includes("lic-tok")));
  } finally {
    await close();
  }
});

test("media: absent magis_auth/magis_license params forward no auth headers without breaking", async () => {
  const upstream = createUpstreamStub(() => ({
    response: fakeUpstreamResponse({
      headers: { "content-type": "video/mp4" },
      chunks: ["video"]
    })
  }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/media/cdn-vod.example/vod/m1_media.mp4`);
    assert.equal(response.status, 200);
    const call = upstream.calls[0];
    assert.equal(call.targetUrl, "https://cdn-vod.example/vod/m1_media.mp4");
    assert.equal(call.options.headers["Content-Auth"], undefined);
    assert.equal(call.options.headers["Content-License"], undefined);
    // the constant media headers are still injected
    assert.equal(call.options.headers["User-Agent"], "Ranger/4.9.4-17294ac0");
  } finally {
    await close();
  }
});

test("media: HEAD forwards as HEAD and answers with no body", async () => {
  const upstream = createUpstreamStub(() => ({
    response: fakeUpstreamResponse({
      headers: { "content-type": "video/mp4", "content-length": "100" },
      chunks: []
    })
  }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/media/cdn-vod.example/vod/m1_media.mp4`, {
      method: "HEAD"
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.equal(upstream.calls[0].options.method, "HEAD");
  } finally {
    await close();
  }
});

// --- media route: host trust model ---------------------------------------

for (const [path, description] of [
  ["/media/127.0.0.1/live/pc.m3u8", "loopback IPv4"],
  ["/media/localhost/live/pc.m3u8", "localhost"],
  ["/media/sub.localhost/live/pc.m3u8", "localhost subdomain"],
  ["/media/10.1.2.3/live/pc.m3u8", "private 10/8"],
  ["/media/192.168.1.10/live/pc.m3u8", "private 192.168/16"],
  ["/media/172.16.0.9/live/pc.m3u8", "private 172.16/12"],
  ["/media/172.31.255.1/live/pc.m3u8", "private 172.31"],
  ["/media/169.254.169.254/live/pc.m3u8", "link-local"],
  ["/media/0.0.0.0/live/pc.m3u8", "unspecified IPv4"],
  ["/media/host.invalid/x", "invalid suffix"],
  ["/media/no-dots/x", "single-label host"],
  ["/media/bad%2Fhost/x", "malformed host"]
]) {
  test(`media: refuses the private/loopback or malformed host ${path} (${description})`, async () => {
    const upstream = createUpstreamStub(() => ({
      response: fakeUpstreamResponse({ chunks: ["secret"] })
    }));
    const { server, close } = startProxy({ upstream });
    try {
      const base = await listen(server);
      const response = await fetch(`${base}${path}?magis_auth=a`);
      assert.equal(response.status, 403);
      assert.equal(upstream.calls.length, 0, "no upstream request may be made");
    } finally {
      await close();
    }
  });
}

test("media: public portal-issued cdn hostnames are accepted", async () => {
  const upstream = createUpstreamStub(() => ({
    response: fakeUpstreamResponse({ headers: { "content-type": "video/mp4" }, chunks: ["x"] })
  }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/media/auuy2136a.xh09je1qy.com/live/pc.m3u8`);
    assert.equal(response.status, 200);
    assert.equal(upstream.calls.length, 1);
  } finally {
    await close();
  }
});

// --- media route: playlist rewriting --------------------------------------

const MASTER_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  '#EXT-X-KEY:URI="key.bin?k=1",IV=0x9c7db8778570d05c3177c349fd9236aa',
  '#EXT-X-MAP:URI="init.mp4"',
  "variant.m3u8?v=2",
  "https://other-cdn.example/live/seg0.ts",
  "/abs/live/seg1.ts",
  "#EXT-X-ENDLIST",
  ""
].join("\n");

function expectedProxied(uri) {
  return `http://127.0.0.1:${EXPECTED_PORT}/media/${uri}`;
}

let EXPECTED_PORT = 0;

test("media: every URI in an HLS playlist is rewritten back through this route with the credentials", async () => {
  const upstream = createUpstreamStub(() => ({
    response: fakeUpstreamResponse({
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      chunks: [MASTER_PLAYLIST]
    })
  }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    EXPECTED_PORT = Number(new URL(base).port);
    const response = await fetch(
      `${base}/media/cdn-live.example/live/pc-1.m3u8?magis_auth=auth-tok&magis_license=lic-tok`
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /mpegurl/i);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    const lines = body.split("\n");

    // comments and tags without URIs stay untouched
    assert.equal(lines[0], "#EXTM3U");
    assert.equal(lines[1], "#EXT-X-VERSION:3");
    assert.equal(lines[7], "#EXT-X-ENDLIST");

    // #EXT-X-KEY URI, query preserved, credentials appended
    assert.equal(
      lines[2],
      `#EXT-X-KEY:URI="${expectedProxied("cdn-live.example/live/key.bin?k=1")}&magis_auth=auth-tok&magis_license=lic-tok",IV=0x9c7db8778570d05c3177c349fd9236aa`
    );
    // #EXT-X-MAP URI (no upstream query: the credentials start the query)
    assert.equal(lines[3], `#EXT-X-MAP:URI="${expectedProxied("cdn-live.example/live/init.mp4")}?magis_auth=auth-tok&magis_license=lic-tok"`);
    // relative variant
    assert.equal(lines[4], `${expectedProxied("cdn-live.example/live/variant.m3u8")}?v=2&magis_auth=auth-tok&magis_license=lic-tok`);
    // absolute URI on another portal-issued cdn host
    assert.equal(lines[5], `${expectedProxied("other-cdn.example/live/seg0.ts")}?magis_auth=auth-tok&magis_license=lic-tok`);
    // root-relative URI
    assert.equal(lines[6], `${expectedProxied("cdn-live.example/abs/live/seg1.ts")}?magis_auth=auth-tok&magis_license=lic-tok`);

    // every URI line must point back at this proxy route
    for (const line of lines) {
      if (!line || line.startsWith("#")) continue;
      assert.ok(line.includes("/media/"), `rewritten line must use the proxy route: ${line}`);
    }
  } finally {
    await close();
  }
});

test("media: a playlist body starting with #EXTM3U is rewritten even with a generic content-type", async () => {
  const upstream = createUpstreamStub(() => ({
    response: fakeUpstreamResponse({
      headers: { "content-type": "application/octet-stream" },
      chunks: ["#EXTM3U\nseg.ts\n"]
    })
  }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    EXPECTED_PORT = Number(new URL(base).port);
    const response = await fetch(`${base}/media/cdn-live.example/live/pc-2.m3u8?magis_auth=a`);
    const body = await response.text();
    assert.ok(body.includes(`${expectedProxied("cdn-live.example/live/seg.ts")}?magis_auth=a`));
  } finally {
    await close();
  }
});

test("media: a non-playlist body is streamed through with the upstream status and content-type", async () => {
  const upstream = createUpstreamStub(() => ({
    response: fakeUpstreamResponse({
      statusCode: 206,
      headers: { "content-type": "video/mp2t", "content-length": "10", "content-range": "bytes 0-10/100" },
      chunks: ["01234", "56789"]
    })
  }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/media/cdn-vod.example/vod/m1_media.ts?magis_auth=a`);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "video/mp2t");
    assert.equal(response.headers.get("content-range"), "bytes 0-10/100");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "0123456789");
  } finally {
    await close();
  }
});

// --- media route: preflight, methods, upstream errors ---------------------

test("media: OPTIONS preflight answers 204 with permissive CORS", async () => {
  const upstream = createUpstreamStub(() => ({ response: fakeUpstreamResponse() }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/media/cdn.example/live/pc.m3u8`, {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range" }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.match(response.headers.get("access-control-allow-methods"), /GET/i);
    assert.match(response.headers.get("access-control-allow-headers"), /range/i);
    assert.equal(upstream.calls.length, 0);
  } finally {
    await close();
  }
});

test("media: POST is refused with 405", async () => {
  const upstream = createUpstreamStub(() => ({ response: fakeUpstreamResponse() }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/media/cdn.example/live/pc.m3u8`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(upstream.calls.length, 0);
  } finally {
    await close();
  }
});

test("media: an upstream failure answers 502 without leaking the query", async () => {
  const upstream = createUpstreamStub(() => ({ error: new Error("dns failure") }));
  const logs = [];
  const { server, close } = startProxy({ upstream, logs });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/media/cdn.example/live/pc.m3u8?magis_auth=secret-auth`);
    assert.equal(response.status, 502);
    assert.ok(!logs.some((line) => line.includes("secret-auth")));
  } finally {
    await close();
  }
});

// --- /magis/ portal route stays byte-compatible ---------------------------

test("portal: POST /magis/<host>/api/portalCore/<path> forwards the allowlisted headers verbatim", async () => {
  const upstream = createUpstreamStub(() => ({
    response: fakeUpstreamResponse({
      headers: { "content-type": "application/json" },
      chunks: ['{"ok":true}']
    })
  }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/magis/portal-a.example/api/portalCore/v3/ping`, {
      method: "POST",
      headers: {
        apk: "com.android.msandroid",
        apkVer: "43404",
        spkgVer: "2025-08-07 05:40:11_36_16_",
        "User-Agent": "okhttp/3.12.12",
        "Content-Type": "application/json",
        Cookie: "private=1"
      },
      body: "abcd"
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
    const call = upstream.calls[0];
    assert.equal(call.targetUrl, "https://portal-a.example/api/portalCore/v3/ping");
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers.apk, "com.android.msandroid");
    assert.equal(call.options.headers.apkVer, "43404");
    assert.equal(call.options.headers.spkgVer, "2025-08-07 05:40:11_36_16_");
    assert.equal(call.options.headers["User-Agent"], "okhttp/3.12.12");
    assert.equal(call.options.headers["Content-Type"], "application/json");
    assert.equal(call.options.headers.Cookie, undefined);
  } finally {
    await close();
  }
});

test("portal: an unknown portal host is refused exactly as before", async () => {
  const upstream = createUpstreamStub(() => ({ response: fakeUpstreamResponse() }));
  const { server, close } = startProxy({ upstream });
  try {
    const base = await listen(server);
    const response = await fetch(`${base}/magis/evil.example/api/portalCore/v3/ping`, {
      method: "POST",
      body: "abcd"
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "magis-proxy: host not allowed: evil.example");
    assert.equal(upstream.calls.length, 0);
  } finally {
    await close();
  }
});

// Several Magis CDNs answer only on plain http: the https socket never
// completes. Measured from the server: http gives 401 (auth required, as the
// proxy supplies) while https never connects. Forcing https turned a playable
// channel into a 502 and, worse, once crashed the process because
// https.request rejects an http target with ERR_INVALID_PROTOCOL.
test("media: an https socket failure retries the same request once over http", async () => {
  const https = createUpstreamStub(() => ({
    error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
  }));
  const http = createUpstreamStub(() => ({
    response: fakeUpstreamResponse({
      statusCode: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      chunks: ["#EXTM3U\n#EXTINF:4,\nseg1.ts\n"]
    })
  }));
  const server = createMagisProxyServer({
    config: CONFIG,
    httpsRequest: https.httpsRequest,
    httpRequest: http.httpsRequest
  });
  const base = await listen(server);
  try {
    const response = await fetch(
      `${base}/media/cdn-vod.example/live/pc-1.m3u8?magis_auth=auth-1&magis_license=lic-1`
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /#EXTM3U/);
    assert.match(body, /\/media\/cdn-vod\.example\/live\/seg1\.ts/, "segments come back through the proxy");
    assert.equal(https.calls.length, 1, "https is tried first");
    assert.equal(http.calls.length, 1, "http is tried exactly once");
    assert.match(http.calls[0].targetUrl, /^http:\/\/cdn-vod\.example\/live\/pc-1\.m3u8/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
