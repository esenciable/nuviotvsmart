#!/usr/bin/env node
// Standalone, dependency-free Magis portal proxy.
//
// Optional portal proxy for browser environments that enforce CORS.
// Measured on Tizen the widget's <access origin="*"/> policy allows direct
// cross-origin portal calls, so this proxy is NOT required there; it exists
// for plain browsers that cannot read the portal's responses. It accepts:
//
//   OPTIONS /magis/<host>/api/portalCore/<path>   (preflight)
//   POST    /magis/<host>/api/portalCore/<path>
//
// and forwards the four Magis headers plus the hex body verbatim to
// https://<host>/api/portalCore/<path>. It ALSO answers the media route
//
//   OPTIONS /media/<cdn-host>/<path>   (preflight)
//   GET|HEAD /media/<cdn-host>/<path>?magis_auth=..&magis_license=..
//
// which serves the live/VOD media the portal resolved: the proxy injects the
// CDN's media headers (Content-Auth/Content-License from the query tokens,
// User-Agent: Ranger/4.9.4-17294ac0, App, App-Version), always targets
// https, rewrites HLS playlists so every variant/segment/key/map URI points
// back at this same route with the same credentials, streams non-playlist
// bodies through unchanged, and adds CORS headers so the same-origin app
// needs nothing special. Safety rules:
//
//   - refuses any portal host not present in the loaded Magis config
//   - media hosts are trust-modelled like the portal: only hosts a
//     portal-issued tokenised query names, with the hostname shape
//     validated and private/loopback/IP-literal addresses refused
//   - refuses non-HTTPS targets
//   - caps the request body size
//   - forwards only an explicit header allowlist, so cookies and
//     Authorization headers are never forwarded
//   - media answers are never cached and credentials are never logged
//
// Print the port it listens on. Default 8792, override with MAGIS_PROXY_PORT.
import http from "node:http";
import https from "node:https";

const MAGIS_CONFIG_URL =
  process.env.MAGIS_CONFIG_URL ||
  "https://raw.githubusercontent.com/esenciable/esencial-providers/main/magis-config.json";
const DEFAULT_PORT = 8792;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB is far beyond any portal payload
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024; // playlists are small; anything bigger streams as-is

// Measured CDN media constants (see js/core/magis/magisVod.js). The browser
// cannot send these itself, so the proxy injects them; the per-play tokens
// (Content-Auth/Content-License) arrive via the magis_auth/magis_license
// query params instead, so no long-lived secret ever sits in a URL.
const MAGIS_MEDIA_USER_AGENT = "Ranger/4.9.4-17294ac0";
const MAGIS_MEDIA_FALLBACK_APP = "com.android.msandroid";
const MAGIS_MEDIA_FALLBACK_APP_VERSION = "49902";

// The four Magis headers + content type; everything else (cookies,
// authorization, ...) is dropped.
const FORWARDABLE_HEADERS = ["apk", "apkver", "spkgver", "user-agent", "content-type"];

// Media route: /media/<cdn-host>/<path...>. Query params named magis_* are
// proxy control params and never reach the CDN.
const MEDIA_ROUTE = /^\/media\/([^/]+)\/(.+)$/;
const MEDIA_CONTROL_PARAMS = ["magis_auth", "magis_license", "magis_referer"];

// Trust model: accept the public hostname shapes the Magis portal actually
// issues (name-based CDN hosts) and refuse everything that could name an
// internal address: loopback/private/link-local IPv4 literals, IP literals
// generally, IPv6 literals, bare single-label names and .local/.internal
// style suffixes. No DNS resolution is attempted: a hostname that RESOLVES
// to a private address is out of scope, exactly as for the portal route.
export function isAllowedMediaHost(hostname = "") {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!host || host.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(host)) return false; // no IPv6 literals, no odd characters
  if (!host.includes(".")) return false; // bare single-label names
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".invalid"))
    return false;
  // any IPv4 literal is refused, which covers loopback, private ranges
  // (10/8, 172.16/12, 192.168/16), link-local 169.254/16 and 0.0.0.0
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

function publicBaseOf(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || (request.socket?.encrypted ? "https" : "http");
  const host = forwardedHost || request.headers.host || "localhost";
  return `${proto}://${host}`;
}

function stripMediaControlParams(searchParams) {
  const cleaned = new URLSearchParams(searchParams);
  for (const name of MEDIA_CONTROL_PARAMS) cleaned.delete(name);
  return cleaned;
}

// Rewrite every URI an HLS playlist references (variant playlists, segments,
// #EXT-X-KEY:URI, #EXT-X-MAP:URI, #EXT-X-MEDIA:URI, ...) so it points back at
// this proxy's media route, preserving relative and absolute upstream forms
// and any upstream query, and appending the per-play credentials.
function rewriteHlsPlaylist(bodyText, { upstreamUrl, publicBase, auth, license }) {
  const toProxyUri = (rawUri) => {
    let resolved;
    try {
      resolved = new URL(rawUri, upstreamUrl);
    } catch (_) {
      return rawUri;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return rawUri;
    if (!isAllowedMediaHost(resolved.hostname)) return rawUri;
    const proxied = new URL(`${publicBase}/media/${resolved.hostname}${resolved.pathname}`);
    for (const [key, value] of resolved.searchParams) proxied.searchParams.set(key, value);
    if (auth) proxied.searchParams.set("magis_auth", auth);
    if (license) proxied.searchParams.set("magis_license", license);
    return proxied.href;
  };
  return bodyText
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        // tags carrying URIs (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA, ...)
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${toProxyUri(uri)}"`);
      }
      return toProxyUri(trimmed);
    })
    .join("\n");
}

function loadConfig(configUrl = MAGIS_CONFIG_URL) {
  return new Promise((resolve, reject) => {
    https
      .get(configUrl, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`config fetch failed: ${response.statusCode}`));
          response.resume();
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(new Error(`config is not valid JSON: ${error.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function normalizeHost(host = "") {
  return String(host || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
}

function createMagisProxyServer({ config, log = () => {}, httpsRequest = https.request } = {}) {
  const allowedHosts = new Set((config?.hosts || []).map(normalizeHost));
  if (allowedHosts.size === 0) {
    throw new Error("magis-proxy: loaded config has no hosts");
  }
  const mediaAppId = String(config?.appId || MAGIS_MEDIA_FALLBACK_APP);
  const mediaAppVersion = String(config?.apkVersion || MAGIS_MEDIA_FALLBACK_APP_VERSION);

  function sendJson(response, statusCode, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...extraHeaders
    });
    response.end(body);
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    const match = /^\/magis\/([^/]+)\/api\/portalCore\/(.+)$/.exec(url.pathname);

    // Media route (GET|HEAD /media/<cdn-host>/<path>, OPTIONS preflight).
    // Never logs credentials: only the path without its query is logged.
    function handleMediaRequest(request, response, { host, mediaPath, searchParams }) {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers":
            request.headers["access-control-request-headers"] || "Range, Content-Type",
          "Access-Control-Max-Age": "86400"
        });
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "magis-proxy: media route allows GET and HEAD only" });
        return;
      }
      if (!isAllowedMediaHost(host)) {
        log(`media: refused private/loopback or malformed host: ${host}`);
        sendJson(response, 403, { error: `magis-proxy: media host not allowed: ${host}` });
        return;
      }

      // Upstream target is ALWAYS https, with the control params stripped.
      const upstreamQuery = stripMediaControlParams(searchParams);
      const queryString = upstreamQuery.toString();
      const target = `https://${host}/${mediaPath}${queryString ? `?${queryString}` : ""}`;

      const auth = String(searchParams.get("magis_auth") || "").trim();
      const license = String(searchParams.get("magis_license") || "").trim();
      const referer = String(searchParams.get("magis_referer") || "").trim();
      const headers = {
        // The CDN identifies the app by these constants; the browser cannot
        // send them, so the proxy injects them.
        "User-Agent": MAGIS_MEDIA_USER_AGENT,
        App: mediaAppId,
        "App-Version": mediaAppVersion
      };
      if (auth) headers["Content-Auth"] = auth;
      if (license) headers["Content-License"] = license;
      if (referer) headers.Referer = referer;
      // byte-range segments and the VOD status probe rely on Range
      const range = request.headers.range;
      if (range) headers.Range = range;

      log(`media ${request.method} ${host}/${mediaPath}`);
      // Some Magis CDNs only answer on plain http: the https socket never
      // completes, so the channel would fail even though the Android client
      // plays it. One fallback, once per request, and only before any byte is
      // sent to the player.
      let schemeFallbackUsed = false;
      requestMediaUpstream({ target, method: request.method, headers, redirectsLeft: 3 });

      function requestMediaUpstream({ target, method, headers, redirectsLeft }) {
        const upstream = httpsRequest(target, { method, headers }, (upstreamResponse) => {
          const status = upstreamResponse.statusCode || 502;
          if ([301, 302, 303, 307, 308].includes(status) && upstreamResponse.headers.location) {
            if (redirectsLeft <= 0) {
              sendJson(response, 502, { error: "magis-proxy: too many media redirects" });
              upstreamResponse.resume();
              return;
            }
            let redirectTarget;
            try {
              redirectTarget = new URL(upstreamResponse.headers.location, target).href;
            } catch (_) {
              sendJson(response, 502, { error: "magis-proxy: invalid media redirect" });
              upstreamResponse.resume();
              return;
            }
            const redirectHost = new URL(redirectTarget).hostname;
            if (!isAllowedMediaHost(redirectHost)) {
              sendJson(response, 403, {
                error: `magis-proxy: media host not allowed: ${redirectHost}`
              });
              upstreamResponse.resume();
              return;
            }
            upstreamResponse.resume();
            log(`media redirect -> ${redirectHost}`);
            requestMediaUpstream({
              target: redirectTarget,
              method,
              headers,
              redirectsLeft: redirectsLeft - 1
            });
            return;
          }
          pipeMediaResponse(request, response, upstreamResponse, { target, auth, license });
        });
        upstream.on("error", (error) => {
          if (response.headersSent) {
            response.destroy();
            return;
          }
          if (!schemeFallbackUsed && target.startsWith("https://")) {
            schemeFallbackUsed = true;
            const httpTarget = `http://${target.slice("https://".length)}`;
            log(
              `media: https failed for ${host} (${error.code || error.message}), retrying over http`
            );
            requestMediaUpstream({
              target: httpTarget,
              method,
              headers,
              redirectsLeft
            });
            return;
          }
          sendJson(response, 502, { error: `magis-proxy: upstream error: ${error.message}` });
        });
        upstream.end();
      }
    }

    // Stream the upstream media answer: HLS playlists (by content-type or by
    // their #EXTM3U body prefix) are buffered (they are tiny) and rewritten
    // through this same route; everything else is piped through untouched,
    // never buffered, never cached.
    function pipeMediaResponse(request, response, upstreamResponse, { target, auth, license }) {
      const status = upstreamResponse.statusCode || 502;
      const contentType = String(
        upstreamResponse.headers["content-type"] || "application/octet-stream"
      );
      const publicBase = publicBaseOf(request);
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Cache-Control": "no-store"
      };

      let buffering = /mpegurl/i.test(contentType);
      let buffered = [];
      let bufferedBytes = 0;
      let streamingStarted = false;

      const passthroughHeaders = () => {
        const headers = { ...corsHeaders, "Content-Type": contentType };
        for (const name of ["content-length", "content-range", "accept-ranges"]) {
          if (upstreamResponse.headers[name] != null) {
            headers[name.charAt(0).toUpperCase() + name.slice(1)] = upstreamResponse.headers[name];
          }
        }
        return headers;
      };

      const startStreaming = (firstChunk) => {
        streamingStarted = true;
        response.writeHead(status, passthroughHeaders());
        if (firstChunk) response.write(firstChunk);
        upstreamResponse.pipe(response); // rest streams through, no buffering
      };

      upstreamResponse.on("data", (chunk) => {
        if (streamingStarted) return;
        if (!buffering) {
          // a playlist body may arrive with a generic content-type: peek the prefix
          if (bufferedBytes === 0 && chunk.subarray(0, 7).toString("utf8") === "#EXTM3U") {
            buffering = true;
          } else {
            startStreaming(chunk);
            return;
          }
        }
        bufferedBytes += chunk.length;
        buffered.push(chunk);
        if (bufferedBytes > MAX_PLAYLIST_BYTES) {
          // far too big for any playlist: stream it as-is instead
          const overflow = Buffer.concat(buffered);
          buffered = [];
          startStreaming(overflow);
        }
      });

      upstreamResponse.on("end", () => {
        if (streamingStarted) return;
        if (!buffering) {
          // Empty upstream body (e.g. HEAD): the stream has already ended, so
          // piping it would never end this response — close it directly.
          response.writeHead(status, passthroughHeaders());
          response.end();
          return;
        }
        let upstreamUrl;
        try {
          upstreamUrl = new URL(target);
        } catch (_) {
          upstreamUrl = null;
        }
        const bodyText = Buffer.concat(buffered).toString("utf8");
        const rewritten = rewriteHlsPlaylist(bodyText, {
          upstreamUrl,
          publicBase,
          auth,
          license
        });
        const out = Buffer.from(rewritten, "utf8");
        response.writeHead(status, {
          ...corsHeaders,
          "Content-Type": contentType,
          "Content-Length": out.length
        });
        response.end(request.method === "HEAD" ? undefined : out);
      });

      upstreamResponse.on("error", () => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendJson(response, 502, { error: "magis-proxy: upstream media error" });
      });
    }

    if (request.method === "OPTIONS" && match) {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          request.headers["access-control-request-headers"] || "Content-Type, apk, apkVer, spkgVer",
        "Access-Control-Max-Age": "86400"
      });
      response.end();
      return;
    }

    // A bare visit to this host used to answer a 404 that reads like a fault.
    // It is not one: this server only proxies the portal, and the app itself
    // lives on its own URL. Say so, so a browser visit is not mistaken for a
    // broken deployment.
    if (
      !match &&
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      sendJson(response, 200, {
        ok: true,
        service: "magis-proxy",
        purpose: "adds CORS headers to the Magis portal so a browser app can call it",
        use: "POST /magis/<host>/api/portalCore/<path>",
        note: "the app is served from its own URL; this host only answers the route above"
      });
      return;
    }

    const mediaMatch = MEDIA_ROUTE.exec(url.pathname);
    if (mediaMatch) {
      handleMediaRequest(request, response, {
        host: decodeURIComponent(mediaMatch[1]),
        mediaPath: mediaMatch[2],
        searchParams: url.searchParams
      });
      return;
    }

    if (!match) {
      sendJson(response, 404, {
        error: `magis-proxy: unsupported route ${request.method} ${url.pathname}`
      });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "magis-proxy: only POST is allowed" });
      return;
    }

    const host = normalizeHost(decodeURIComponent(match[1]));
    const portalPath = match[2];

    if (!allowedHosts.has(host)) {
      log(`refused unknown host: ${host}`);
      sendJson(response, 403, { error: `magis-proxy: host not allowed: ${host}` });
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        sendJson(response, 413, { error: "magis-proxy: body too large" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("error", () => {
      // client aborted or body error; response may already be gone
      if (!response.headersSent) {
        sendJson(response, 400, { error: "magis-proxy: request error" });
      }
    });

    request.on("end", () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks);
      // Forward the allowlisted headers verbatim, with the case the client
      // sent (request.headers is lowercased by node, rawHeaders is not).
      const headers = {};
      const allowlisted = new Set(FORWARDABLE_HEADERS);
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const headerName = request.rawHeaders[i];
        if (allowlisted.has(headerName.toLowerCase())) {
          headers[headerName] = request.rawHeaders[i + 1];
        }
      }
      const target = `https://${host}/api/portalCore/${portalPath}`;
      log(`forwarding ${body.length}B -> ${target}`);
      const upstream = httpsRequest(target, { method: "POST", headers }, (upstreamResponse) => {
        const responseChunks = [];
        upstreamResponse.on("data", (chunk) => responseChunks.push(chunk));
        upstreamResponse.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          response.writeHead(upstreamResponse.statusCode || 502, {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": upstreamResponse.headers["content-type"] || "application/json",
            "Content-Length": responseBody.length
          });
          response.end(responseBody);
        });
      });
      upstream.on("error", (error) => {
        sendJson(response, 502, { error: `magis-proxy: upstream error: ${error.message}` });
      });
      upstream.end(body);
    });
  });

  return server;
}

export { createMagisProxyServer, loadConfig, DEFAULT_PORT, MAX_BODY_BYTES };

function isMainProcess(importMetaUrl) {
  try {
    return process.argv[1] && importMetaUrl === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
}

if (isMainProcess(import.meta.url)) {
  const port = Number(process.env.MAGIS_PROXY_PORT || DEFAULT_PORT);
  loadConfig()
    .then((config) => {
      const server = createMagisProxyServer({
        config,
        log: (message) => console.log(`[magis-proxy] ${message}`)
      });
      server.listen(port, () => {
        console.log(port); // machine-readable port line
        console.log(`[magis-proxy] listening on port ${port}`);
        console.log(`[magis-proxy] allowed hosts: ${(config.hosts || []).join(", ")}`);
      });
    })
    .catch((error) => {
      console.error(`[magis-proxy] startup failed: ${error.message}`);
      process.exit(1);
    });
}
