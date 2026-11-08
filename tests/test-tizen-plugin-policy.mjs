import assert from "node:assert/strict";
import { test } from "node:test";

// A The Frame panel reports a Tizen version the old numeric gate rejects while
// WebAssembly and the packaged PluginService are both present and running.
const FRAME_UA =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36";
const TIZEN_6_UA =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36";

function installRuntime({ userAgent = FRAME_UA, pluginService = true, engine = true } = {}) {
  globalThis.__NUVIO_PLATFORM__ = "tizen";
  globalThis.__NUVIO_TIZEN_PLUGIN_SERVICE_ENABLED__ = pluginService;
  globalThis.Worker = class {};
  if (engine) {
    globalThis.WebAssembly = {};
  } else {
    delete globalThis.WebAssembly;
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent }
  });
}

installRuntime();
const { getPluginCapabilitySnapshot, PLUGIN_QUOTAS } = await import(
  "../js/core/player/pluginPolicy.js"
);
const { resetTizenCapabilitiesCache } = await import(
  "../js/platform/tizen/tizenCapabilities.js"
);

function snapshot(options) {
  resetTizenCapabilitiesCache();
  installRuntime(options);
  return getPluginCapabilitySnapshot();
}

test("a WebAssembly-capable Tizen TV keeps plugin execution reachable when the firmware version is rejected", () => {
  const capabilities = snapshot();
  assert.notEqual(
    capabilities.supportLevel,
    "unsupported",
    `unexpected refusal: ${capabilities.reason}`
  );
  assert.equal(capabilities.candidate, true);
  assert.equal(
    capabilities.reason,
    "Waiting for the packaged plugin service and QuickJS worker handshake"
  );
  assert.equal(
    capabilities.executable,
    false,
    "execution still needs the worker and service handshake"
  );
  assert.equal(capabilities.tizenVersion, "5.5");
  assert.equal(capabilities.pluginServicePackaged, true);
  assert.equal(
    capabilities.quota,
    PLUGIN_QUOTAS.limited,
    "an engine below the plugin baseline keeps the bounded quota"
  );
});

test("Tizen 6.0 keeps the full quota the numeric gate used to grant", () => {
  const capabilities = snapshot({ userAgent: TIZEN_6_UA });
  assert.equal(capabilities.supportLevel, "full");
  assert.equal(capabilities.candidate, true);
  assert.equal(capabilities.quota, PLUGIN_QUOTAS.modern);
});

test("a Tizen engine without WebAssembly is refused with its own reason", () => {
  const capabilities = snapshot({ engine: false });
  assert.equal(capabilities.supportLevel, "unsupported");
  assert.equal(capabilities.candidate, false);
  assert.match(capabilities.reason, /WebAssembly/);
});

test("a package without the Tizen plugin service is still refused", () => {
  const capabilities = snapshot({ pluginService: false });
  assert.equal(capabilities.supportLevel, "unsupported");
  assert.equal(capabilities.candidate, false);
  assert.equal(capabilities.reason, "The packaged Tizen plugin service is missing");
});
