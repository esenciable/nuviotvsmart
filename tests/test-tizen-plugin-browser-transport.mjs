import assert from "node:assert/strict";
import { test } from "node:test";

// Measured on the owner's The Frame (Tizen 5.5 / Chromium 69): the packaged
// plugin network service can never run there (web.service=false, both start
// methods fail), but the TV itself reaches the network directly. VIDAA already
// proves the direct browser transport works, so Tizen must fall back to it
// instead of refusing or pointing guest fetches at 127.0.0.1:2711.
const FRAME_UA =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36";

globalThis.__NUVIO_PLATFORM__ = "tizen";
globalThis.__NUVIO_TIZEN_PLUGIN_SERVICE_ENABLED__ = false;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.Worker = class {};
globalThis.WebAssembly = {};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: FRAME_UA }
});

const { PluginServiceClient } = await import("../js/platform/pluginServiceClient.js");
const { getPluginCapabilitySnapshot } = await import("../js/core/player/pluginPolicy.js");
const { Platform } = await import("../js/platform/index.js");
const { TizenPluginService } = await import("../js/platform/tizen/tizenPluginService.js");
const { resetTizenCapabilitiesCache } = await import(
  "../js/platform/tizen/tizenCapabilities.js"
);

const SERVICE_DOWN = "No Tizen plugin service responded";

function mockUnreachableService(context) {
  context.mock.method(TizenPluginService, "health", async () => {
    throw new Error(SERVICE_DOWN);
  });
}

test("a Tizen package without the plugin service stays a browser-transport candidate", () => {
  resetTizenCapabilitiesCache();
  const capabilities = getPluginCapabilitySnapshot();
  assert.notEqual(
    capabilities.supportLevel,
    "unsupported",
    `unexpected refusal: ${capabilities.reason}`
  );
  assert.equal(capabilities.candidate, true);
  assert.equal(capabilities.networkMode, "browser");
  assert.match(capabilities.reason, /browser transport/);
  assert.equal(capabilities.pluginServicePackaged, false);
  assert.equal(
    capabilities.executable,
    false,
    "execution still needs the QuickJS worker self-test"
  );
});

test("Tizen readiness falls back to the direct browser transport when the service is unreachable", async (context) => {
  mockUnreachableService(context);
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error("network must not be contacted by readiness");
  };
  try {
    PluginServiceClient.resetHealthCache();
    const health = await PluginServiceClient.ensureReady({ force: true });
    assert.equal(health.returnValue, true);
    assert.equal(health.networkMode, "browser");
    assert.equal(health.networkBoundary, false);
    assert.equal(health.serviceVersion, undefined);
    assert.match(health.detail, /browser transport/);
    assert.equal(fetchCalls.length, 0, "readiness must not touch the network");
  } finally {
    globalThis.fetch = originalFetch;
    PluginServiceClient.resetHealthCache();
  }
});

test("without the Fetch API Tizen readiness keeps rejecting", async (context) => {
  mockUnreachableService(context);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    PluginServiceClient.resetHealthCache();
    await assert.rejects(
      PluginServiceClient.ensureReady({ force: true }),
      new RegExp(SERVICE_DOWN)
    );
  } finally {
    globalThis.fetch = originalFetch;
    PluginServiceClient.resetHealthCache();
  }
});

test("guest fetches ride the direct browser transport after the fallback", async (context) => {
  mockUnreachableService(context);
  const originalFetch = globalThis.fetch;
  let directCalls = 0;
  globalThis.fetch = async (url) => {
    directCalls += 1;
    assert.equal(url, "https://provider.example/api");
    return new Response('{"items":[]}', {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    PluginServiceClient.resetHealthCache();
    await PluginServiceClient.ensureReady({ force: true });
    const result = await PluginServiceClient.fetch({ url: "https://provider.example/api" });
    assert.equal(result.returnValue, true);
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"items":[]}');
    assert.equal(directCalls, 1, "the guest fetch must use the direct transport, not 127.0.0.1:2711");
  } finally {
    globalThis.fetch = originalFetch;
    PluginServiceClient.resetHealthCache();
  }
});

test("the VIDAA snapshot keeps its browser-mode shape", () => {
  globalThis.__NUVIO_PLATFORM__ = "vidaa";
  Platform.current = null;
  try {
    const capabilities = getPluginCapabilitySnapshot();
    assert.equal(capabilities.supportLevel, "full");
    assert.equal(capabilities.candidate, true);
    assert.equal(capabilities.networkMode, "browser");
    assert.equal(capabilities.pluginServicePackaged, false);
    assert.equal(capabilities.reason, "Waiting for the QuickJS worker self-test");
  } finally {
    globalThis.__NUVIO_PLATFORM__ = "tizen";
    Platform.current = null;
  }
});
