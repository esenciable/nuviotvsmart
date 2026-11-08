import assert from "node:assert/strict";
import { test } from "node:test";

const { sendRuntimeBeacon } = await import("../js/core/diagnostics/runtimeBeacon.js");

const BEACON_URL = "http://192.168.18.5:8791/beacon";

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("an empty beacon URL performs no fetch at all", async () => {
  const originalEnv = globalThis.__NUVIO_ENV__;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.__NUVIO_ENV__ = { NUVIO_RUNTIME_BEACON_URL: "" };
  globalThis.fetch = () => {
    fetchCalls += 1;
    return Promise.resolve({});
  };
  try {
    sendRuntimeBeacon({ phase: "service", ok: true });
    await settle();
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.__NUVIO_ENV__ = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

test("a missing __NUVIO_ENV__ performs no fetch at all", async () => {
  const originalEnv = globalThis.__NUVIO_ENV__;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  delete globalThis.__NUVIO_ENV__;
  globalThis.fetch = () => {
    fetchCalls += 1;
    return Promise.resolve({});
  };
  try {
    sendRuntimeBeacon({ phase: "worker", ok: true });
    await settle();
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.__NUVIO_ENV__ = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

test("a configured URL receives exactly one POST carrying the payload plus an at timestamp", async () => {
  const originalEnv = globalThis.__NUVIO_ENV__;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.__NUVIO_ENV__ = { NUVIO_RUNTIME_BEACON_URL: BEACON_URL };
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({});
  };
  try {
    sendRuntimeBeacon({ phase: "service", ok: true, detail: "success" });
    await settle();
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(url, BEACON_URL);
    assert.equal(options.method, "POST");
    assert.equal(options.mode, "no-cors");
    assert.equal(options.headers["Content-Type"], "text/plain");
    const body = JSON.parse(options.body);
    assert.equal(body.phase, "service");
    assert.equal(body.ok, true);
    assert.equal(body.detail, "success");
    assert.equal(typeof body.at, "string");
    assert.ok(!Number.isNaN(Date.parse(body.at)), "at must be a parseable timestamp");
  } finally {
    globalThis.__NUVIO_ENV__ = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

test("a rejected fetch never throws out of sendRuntimeBeacon", async () => {
  const originalEnv = globalThis.__NUVIO_ENV__;
  const originalFetch = globalThis.fetch;
  globalThis.__NUVIO_ENV__ = { NUVIO_RUNTIME_BEACON_URL: BEACON_URL };
  globalThis.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
  try {
    assert.doesNotThrow(() => sendRuntimeBeacon({ phase: "worker", ok: false, error: "boom" }));
    // node:test fails the run on unhandled rejections, so settling cleanly
    // here is itself the assertion that the rejection was swallowed.
    await settle();
    await settle();
  } finally {
    globalThis.__NUVIO_ENV__ = originalEnv;
    globalThis.fetch = originalFetch;
  }
});
