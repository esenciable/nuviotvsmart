// Magis portalCore client: builds the measured request (four Magis headers +
// hex body), sends it through an injectable transport, reads returnCode,
// decrypts the `data` envelope, and fails over between hosts on transport
// errors only. A portal error (returnCode other than ""/"0") stops immediately.
import { createMagisCrypto } from "./magisCrypto.js";

// "" and "0" both mean success on the measured portal.
export const MAGIS_OK_CODES = ["", "0"];

export const MAGIS_DEFAULT_HEADERS = {
  "User-Agent": "okhttp/3.12.12",
  "Content-Type": "application/json"
};

export function buildPortalHeaders(config) {
  return {
    apk: String(config.appId),
    apkVer: String(config.apkVerHeader),
    spkgVer: String(config.spkgVer),
    ...MAGIS_DEFAULT_HEADERS
  };
}

export function isPortalError(json) {
  const code = String(json?.returnCode ?? "");
  return MAGIS_OK_CODES.indexOf(code) < 0;
}

export class MagisPortalError extends Error {
  constructor(returnCode, errorMessage) {
    super(`Magis portal error ${returnCode}: ${errorMessage || ""}`.trim());
    this.name = "MagisPortalError";
    this.returnCode = returnCode;
    this.errorMessage = errorMessage || "";
  }
}

export function createMagisPortal({ config, transport, crypto } = {}) {
  if (!config || !Array.isArray(config.hosts) || config.hosts.length === 0) {
    throw new Error("magisPortal: config.hosts is required");
  }
  if (typeof transport !== "function") {
    throw new Error("magisPortal: an injectable transport function is required");
  }
  const magisCrypto = crypto || createMagisCrypto({ threeDesKeyHex: config.threeDesKeyHex });
  const headers = buildPortalHeaders(config);

  // transport contract: async ({ host, path, headers, body }) =>
  //   { status, bodyText }  |  throws for transport errors
  async function call(path, payload) {
    const body = magisCrypto.encryptPayload(payload ?? {});
    let lastTransportError = null;
    for (const host of config.hosts) {
      let response;
      try {
        response = await transport({ host, path, headers, body });
      } catch (error) {
        lastTransportError = error;
        continue; // transport error -> fail over to the next host
      }
      let json;
      try {
        json = JSON.parse(response.bodyText);
      } catch {
        lastTransportError = new Error(`magisPortal: ${host}/${path} returned non-JSON`);
        continue; // treat as transport error -> fail over
      }
      if (isPortalError(json)) {
        // portal error: stop immediately, no failover
        throw new MagisPortalError(String(json.returnCode), json.errorMessage);
      }
      return json.data !== undefined && json.data !== null
        ? magisCrypto.decryptData(json.data)
        : json;
    }
    throw lastTransportError || new Error("magisPortal: all hosts failed");
  }

  return { call, headers };
}
