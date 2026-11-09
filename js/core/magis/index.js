// Single factory wiring the Magis modules together: crypto, portal (via an
// injectable transport, defaulting to the standalone proxy), session (with
// caller-provided persistence callbacks), and the VOD resolver. No UI wiring
// happens here; callers import createMagisVodClient and decide the rest.
import { createMagisCrypto } from "./magisCrypto.js";
import { createMagisPortal } from "./magisPortal.js";
import { createMagisSession } from "./magisSession.js";
import { createMagisVod } from "./magisVod.js";
import { createMagisLive } from "./magisLive.js";

export { MAGIS_LIVE_COLUMN_CODE, createMagisLive } from "./magisLive.js";

export {
  MAGIS_CRYPTO_ACCEPTANCE_PLAINTEXT,
  MAGIS_CRYPTO_ACCEPTANCE_VECTOR,
  createMagisCrypto
} from "./magisCrypto.js";
export { MAGIS_SN_SALT, createDeviceDict, createDeviceFingerprint } from "./magisSession.js";
export {
  MAGIS_STREAM_ORIGIN_KIND,
  MAGIS_STREAM_SOURCE_ID,
  MAGIS_STREAM_SOURCE_NAME,
  createMagisStreamSource
} from "./magisStreamSource.js";

// Measured provider config location. It answers CORS *, so the web app can
// fetch it directly without the proxy.
export const MAGIS_CONFIG_URL =
  "https://raw.githubusercontent.com/esenciable/esencial-providers/main/magis-config.json";

export const MAGIS_PROXY_ENV_KEY = "NUVIO_MAGIS_PROXY_URL";

export function readMagisProxyUrl(envRoot = globalThis) {
  return String(envRoot?.__NUVIO_ENV__?.[MAGIS_PROXY_ENV_KEY] || "").trim();
}

// Transport defaults. Measured on device: the Tizen widget declares
// <access origin="*" subdomains="true"/>, so the app can read cross-origin
// responses and calls the portal hosts directly. The standalone proxy
// (scripts/magis-proxy.mjs) is an OPTIONAL override for plain browsers that
// enforce CORS, selected via NUVIO_MAGIS_PROXY_URL; the client never requires
// a proxy to be configured.
export function createDirectTransport(fetchImpl = fetch) {
  return async ({ host, path, headers, body }) => {
    const url = `https://${host}/api/portalCore/${path}`;
    const response = await fetchImpl(url, { method: "POST", headers, body });
    const bodyText = await response.text();
    return { status: response.status, bodyText };
  };
}

export function createProxyTransport(proxyUrl, fetchImpl = fetch) {
  const base = String(proxyUrl || "").replace(/\/$/, "");
  return async ({ host, path, headers, body }) => {
    const url = `${base}/magis/${host}/api/portalCore/${path}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body
    });
    const bodyText = await response.text();
    return { status: response.status, bodyText };
  };
}

function resolveDefaultTransport(proxyUrl, fetchImpl) {
  return proxyUrl ? createProxyTransport(proxyUrl, fetchImpl) : createDirectTransport(fetchImpl);
}

export async function loadMagisConfig(fetchImpl = fetch, configUrl = MAGIS_CONFIG_URL) {
  const response = await fetchImpl(configUrl);
  if (!response.ok) {
    throw new Error(`magis: failed to load config (${response.status}) from ${configUrl}`);
  }
  return response.json();
}

export async function createMagisVodClient({
  config,
  configLoader,
  proxyUrl,
  transport,
  fetchImpl,
  mediaTransport,
  persistence,
  random
} = {}) {
  const resolvedConfig = config || (configLoader ? await configLoader() : await loadMagisConfig());
  const resolvedProxyUrl = proxyUrl !== undefined ? proxyUrl : readMagisProxyUrl();
  const resolvedTransport =
    transport || resolveDefaultTransport(resolvedProxyUrl, fetchImpl || fetch);
  const magisCrypto = createMagisCrypto({
    threeDesKeyHex: resolvedConfig.threeDesKeyHex
  });
  const portal = createMagisPortal({
    config: resolvedConfig,
    transport: resolvedTransport,
    crypto: magisCrypto
  });
  const session = createMagisSession({
    portal,
    config: resolvedConfig,
    persistence,
    random
  });
  const vod = createMagisVod({
    portal,
    config: resolvedConfig,
    session,
    mediaTransport,
    proxyUrl: resolvedProxyUrl
  });
  const live = createMagisLive({
    portal,
    config: resolvedConfig,
    session,
    mediaTransport,
    proxyUrl: resolvedProxyUrl
  });
  return {
    config: resolvedConfig,
    crypto: magisCrypto,
    portal,
    session,
    vod,
    live,
    proxyUrl: resolvedProxyUrl,
    resolveStream: vod.resolveStream,
    // Re-authenticate in place after aaa100027/aaa100028 without minting a new
    // device: callers retry the failed operation once after this resolves.
    refreshSession: () => session.refresh()
  };
}
