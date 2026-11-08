import assert from "node:assert/strict";
import { test } from "node:test";

// Measured on the owner's The Frame: Tizen 5.5, WebAssembly present, the
// packaged plugin service declared, and 127.0.0.1:2711 unreachable. The service
// layer used to refuse with the numeric gate before ever trying to start it, so
// the runtime reported "Tizen plugin support starts at Tizen 6.0" and the screen
// showed "Failed to fetch" with no attempt to launch anything.
const FRAME_UA =
  "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36";

globalThis.__NUVIO_PLATFORM__ = "tizen";
globalThis.__NUVIO_TIZEN_PLUGIN_SERVICE_ENABLED__ = true;
globalThis.Worker = class {};
globalThis.WebAssembly = {};
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {}
};
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: FRAME_UA }
});

const { TizenPluginService } = await import(
  "../js/platform/tizen/tizenPluginService.js"
);

test("a WebAssembly-capable Tizen TV attempts the plugin service start instead of refusing by version", async () => {
  const result = await TizenPluginService.ensureStarted();
  assert.notEqual(
    result.detail,
    "Tizen plugin support starts at Tizen 6.0",
    "the numeric gate must not short-circuit the startup sequence"
  );
  assert.notEqual(result.status, "unsupported");
  assert.equal(
    result.status,
    "error",
    `with no service APIs in this harness the start must fail loudly, got: ${result.status}`
  );
  assert.match(
    result.detail,
    /start failed|No Tizen plugin service responded|unavailable|timed out/i,
    "the failure detail must name the startup attempt"
  );
  assert.match(result.detail, /tizen=5\.5/, "the detail must keep the engine facts");
});
