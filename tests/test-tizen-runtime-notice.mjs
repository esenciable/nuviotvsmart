import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__NUVIO_PLATFORM__ = "tizen";
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.Worker = class {};
globalThis.WebAssembly = Object;

const { runtimeNotice } = await import("../js/ui/screens/plugin/pluginsScreen.js");
const { PLUGIN_QUOTAS } = await import("../js/core/player/pluginPolicy.js");

function candidateModel(extra = {}) {
  return {
    runtime: {
      platform: "tizen",
      candidate: true,
      executable: false,
      supportLevel: "limited",
      reason: "Waiting for the packaged plugin service and QuickJS worker handshake",
      runtimeStatus: "idle",
      runtimeError: "",
      quota: PLUGIN_QUOTAS.limited,
      tizenVersion: "5.5",
      chromiumMajorVersion: 69,
      ...extra
    }
  };
}

function unsupportedModel(extra = {}) {
  return {
    runtime: {
      platform: "tizen",
      candidate: false,
      executable: false,
      supportLevel: "unsupported",
      reason: "Worker and WebAssembly are required",
      runtimeStatus: "idle",
      runtimeError: "",
      quota: PLUGIN_QUOTAS.limited,
      tizenVersion: "5.5",
      chromiumMajorVersion: 69,
      ...extra
    }
  };
}

test("a candidate snapshot with a runtimeError renders that exact string on the TV", () => {
  const html = runtimeNotice(
    candidateModel({ runtimeError: "Tizen application control API unavailable" })
  );
  assert.ok(html.includes("Tizen application control API unavailable"));
});

test("a candidate snapshot with only a reason shows the reason, status and technical facts", () => {
  const html = runtimeNotice(candidateModel());
  assert.ok(html.includes("Waiting for the packaged plugin service and QuickJS worker handshake"));
  assert.ok(html.includes("Runtime status: idle"));
  const technicalLine = html.split("\n").find((line) => line.includes("chromium")) || html;
  assert.ok(/tizen/.test(html));
  assert.ok(/5\.5/.test(html));
  assert.ok(/chromium\s*69/.test(technicalLine));
});

test("a candidate snapshot separates runtime status and runtime error onto distinct lines", () => {
  const html = runtimeNotice(
    candidateModel({ runtimeStatus: "error", runtimeError: "Worker self-test failed" })
  );
  assert.ok(html.includes("Runtime status: error"));
  assert.ok(html.includes("Runtime error: Worker self-test failed"));
});

test("an unsupported snapshot shows the generic label and the raw reason", () => {
  const html = runtimeNotice(unsupportedModel());
  assert.ok(html.includes("Execution unavailable on this TV runtime"));
  assert.ok(html.includes("Worker and WebAssembly are required"));
  assert.ok(/tizen/.test(html));
  assert.ok(/5\.5/.test(html));
});

test("the technical line names the engine quota (modern vs limited)", () => {
  const html = runtimeNotice(candidateModel({ quota: PLUGIN_QUOTAS.modern }));
  assert.ok(/quota\s*modern/.test(html));
  const htmlLimited = runtimeNotice(candidateModel());
  assert.ok(/quota\s*limited/.test(htmlLimited));
});

test("dangerous runtime diagnostics text is escaped", () => {
  const html = runtimeNotice(candidateModel({ runtimeError: 'Bad <script>"tag"</script>' }));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("limited and executable keeps the current soft notice", () => {
  const html = runtimeNotice(
    candidateModel({
      executable: true,
      supportLevel: "limited",
      runtimeStatus: "ready",
      runtimeError: ""
    })
  );
  assert.ok(
    html.includes(
      "Plugin support is limited on this TV. Some providers may be slower or unavailable."
    )
  );
  assert.ok(!html.includes("Runtime status"));
  assert.ok(!html.includes("Runtime error"));
});
