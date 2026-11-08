// Disposable diagnostic beacon. It exists only so a TV that exposes no device
// logs can report a plugin runtime outcome to a listener on the local network.
// It is safe to delete once the runtime is understood; nothing else depends on
// it and a beacon failure must never change plugin behaviour.

export function sendRuntimeBeacon(payload = {}) {
  try {
    const url = String(globalThis.__NUVIO_ENV__?.NUVIO_RUNTIME_BEACON_URL || "").trim();
    if (!url) return;
    const body = JSON.stringify({ ...payload, at: new Date().toISOString() });
    Promise.resolve(
      globalThis.fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain" },
        body
      })
    ).catch(() => {
      // Fire and forget: a beacon failure must never surface to a caller.
    });
  } catch (_) {
    // Never throw: beacon failures must not change plugin behaviour.
  }
}
