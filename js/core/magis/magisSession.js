// Magis session: mint an snToken (v3/snToken), derive sn via md5(snToken +
// salt), activate (v8/active) to obtain userId/userToken. State persistence is
// delegated to caller-provided callbacks so the module never touches
// localStorage directly and stays testable.
import { createMagisCrypto } from "./magisCrypto.js";

// Measured sn derivation salt.
export const MAGIS_SN_SALT = "ntFT65w6itH!lHCPw7D=@qnsFC5adD28";

const HEX_CHARS = "0123456789abcdef";

export function createRandomHelpers(random = Math.random) {
  const randomHex = (length) => {
    let out = "";
    for (let i = 0; i < length; i += 1) {
      out += HEX_CHARS[Math.floor(random() * 16)];
    }
    return out;
  };
  const randomMac = () => Array.from({ length: 6 }, () => randomHex(2)).join(":");
  return { randomHex, randomMac };
}

// Measured device fingerprint shape (v3/snToken + v8/active spread it flat).
export function createDeviceFingerprint({ random } = {}) {
  const { randomHex, randomMac } = createRandomHelpers(random);
  return {
    androidId: randomHex(8),
    board: "goldfish_arm64",
    brand: "google",
    cpuAbi: "arm64-v8a",
    cpuId: randomHex(16),
    device: "emu64a",
    diskInfo: "8GB",
    display: "sdk_gphone64_arm64",
    etheMac: randomMac(),
    gatewayMac: randomMac(),
    wifiMac: randomMac(),
    fingerprint: "google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/11228894:user/release-keys",
    hardware: "ranchu",
    host: "abfarm",
    manufacturer: "Google",
    ramSize: "4GB",
    romSize: "8GB",
    serialNumber: randomHex(16),
    tags: "release-keys",
    verId: ""
  };
}

// Measured device dict; sn is empty until minted, then carried on every call.
export function createDeviceDict(config, sn = "") {
  return {
    loginType: "2",
    appLanguage: "en",
    apkVersion: String(config.apkVersion),
    sysVersion: String(config.spkgVer),
    appId: String(config.appId),
    hardwareInfo: "ranchu",
    model: "sdk_gphone64_arm64",
    product: "sdk_gphone64_arm64",
    cpu: "arm64-v8a",
    B29: "",
    reserve1: "",
    deviceToken: "",
    sn: sn || "",
    drmId: "",
    sdkVer: 36
  };
}

export function isValidSessionState(state) {
  return Boolean(state && state.userId && state.userToken && state.sn);
}

export function createMagisSession({ portal, config, persistence = {}, random, crypto } = {}) {
  if (!portal || typeof portal.call !== "function") {
    throw new Error("magisSession: an injectable portal is required");
  }
  if (!config) {
    throw new Error("magisSession: config is required");
  }
  const magisCrypto = crypto || createMagisCrypto({ threeDesKeyHex: config.threeDesKeyHex });
  const fingerprint = createDeviceFingerprint({ random });

  // Mint + activate exactly as measured. Returns { userId, userToken, sn }.
  async function activate() {
    const mint = await portal.call("v3/snToken", {
      ...fingerprint,
      ...createDeviceDict(config, "")
    });
    if (!mint?.snToken) {
      throw new Error("magisSession: snToken mint failed (no snToken in answer)");
    }
    const sn = mint.sn || magisCrypto.md5Hex(String(mint.snToken) + MAGIS_SN_SALT);
    const active = await portal.call("v8/active", {
      snToken: String(mint.snToken),
      authVersion: "",
      authCode: "",
      preCode: "",
      macAddr: "02:00:00:00:00:00",
      reserve1: "",
      openNum: 4,
      channel: "default",
      matadata: "",
      signdata: "",
      ...fingerprint,
      ...createDeviceDict(config, sn)
    });
    if (!active?.userToken) {
      throw new Error("magisSession: activation failed (no userToken in answer)");
    }
    const state = {
      userId: String(active.userId ?? ""),
      userToken: String(active.userToken),
      sn
    };
    if (typeof persistence.save === "function") {
      persistence.save(state);
    }
    return state;
  }

  // Reuse caller-persisted state when present; mint a fresh session otherwise.
  async function getOrCreate() {
    const saved = persistence.load?.();
    if (isValidSessionState(saved)) {
      return {
        userId: String(saved.userId),
        userToken: String(saved.userToken),
        sn: String(saved.sn)
      };
    }
    return activate();
  }

  function clear() {
    if (typeof persistence.clear === "function") {
      persistence.clear();
    }
  }

  return { activate, getOrCreate, clear, fingerprint };
}
