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
// https://<host>/api/portalCore/<path>. Safety rules:
//
//   - refuses any host not present in the loaded Magis config
//   - refuses non-HTTPS targets
//   - caps the request body size
//   - forwards only an explicit header allowlist, so cookies and
//     Authorization headers are never forwarded
//
// Print the port it listens on. Default 8792, override with MAGIS_PROXY_PORT.
import http from "node:http";
import https from "node:https";

const MAGIS_CONFIG_URL =
  process.env.MAGIS_CONFIG_URL ||
  "https://raw.githubusercontent.com/esenciable/esencial-providers/main/magis-config.json";
const DEFAULT_PORT = 8792;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB is far beyond any portal payload

// The four Magis headers + content type; everything else (cookies,
// authorization, ...) is dropped.
const FORWARDABLE_HEADERS = ["apk", "apkver", "spkgver", "user-agent", "content-type"];

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

function createMagisProxyServer({ config, log = () => {} } = {}) {
  const allowedHosts = new Set((config?.hosts || []).map(normalizeHost));
  if (allowedHosts.size === 0) {
    throw new Error("magis-proxy: loaded config has no hosts");
  }

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
      const headers = {};
      for (const [headerName, headerValue] of Object.entries(request.headers)) {
        if (FORWARDABLE_HEADERS.includes(headerName.toLowerCase())) {
          headers[headerName] = headerValue;
        }
      }
      const target = `https://${host}/api/portalCore/${portalPath}`;
      log(`forwarding ${body.length}B -> ${target}`);
      const upstream = https.request(target, { method: "POST", headers }, (upstreamResponse) => {
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
