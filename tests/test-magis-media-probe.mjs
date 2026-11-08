import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultMediaTransport } from "../js/core/magis/magisVod.js";

// Measured against a real CDN: draining the probe body hangs the resolver,
// because a live MPEG-TS stream never ends. The probe must decide on the status
// line alone.
function responseThatNeverEnds(status, onCancel) {
  return {
    status,
    body: { cancel: onCancel },
    // If anything awaits this, the test times out on purpose: reading the body
    // is exactly the defect this covers.
    arrayBuffer: () => new Promise(() => {})
  };
}

test("the media probe decides on the status line without draining the stream", async () => {
  let cancelled = false;
  let seen = null;
  const transport = defaultMediaTransport({
    url: "https://cdn.example/vod/abc_media.ts",
    headers: { "Content-Auth": "auth", "Content-License": "lic" },
    fetchImpl: (url, init) => {
      seen = { url, init };
      return Promise.resolve(
        responseThatNeverEnds(206, () => {
          cancelled = true;
        })
      );
    }
  });
  const result = await transport;
  assert.equal(result.status, 206);
  assert.equal(cancelled, true, "the stream body must be cancelled, not read");
  assert.equal(seen.url, "https://cdn.example/vod/abc_media.ts");
  assert.equal(seen.init.headers.Range, "bytes=0-2047");
  assert.equal(seen.init.headers["Content-Auth"], "auth");
  assert.ok(seen.init.signal, "the probe must carry an abort signal");
});

test("a 403 candidate resolves with its status so the loop can move on", async () => {
  const transport = defaultMediaTransport({
    url: "https://cdn.example/vod/abc_media.ts",
    headers: {},
    fetchImpl: () => Promise.resolve(responseThatNeverEnds(403, () => {}))
  });
  const result = await transport;
  assert.equal(result.status, 403);
});
