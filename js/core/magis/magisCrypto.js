// Magis portal crypto: TripleDES-EDE-ECB-PKCS7 with the config key, wrapped as
// hex(base64(ciphertext)), plus the MD5 helper the sn derivation needs.
// Implemented with crypto-js so it runs in the browser bundle and under node.
import CryptoJS from "crypto-js";

// Measured against the live portal with the measured key:
// {"hola":"mundo"} -> 336b6e7968596c346c48552f313276566c5134474951646642336151306b4f32
export const MAGIS_CRYPTO_ACCEPTANCE_PLAINTEXT = '{"hola":"mundo"}';
export const MAGIS_CRYPTO_ACCEPTANCE_VECTOR =
  "336b6e7968596c346c48552f313276566c5134474951646642336151306b4f32";

function keyFromHex(threeDesKeyHex) {
  const hex = String(threeDesKeyHex || "");
  if (!/^[0-9a-fA-F]{48}$/.test(hex)) {
    throw new Error(
      `magisCrypto: threeDesKeyHex must be 48 hex chars (24 bytes), got ${hex.length}`
    );
  }
  return CryptoJS.enc.Hex.parse(hex);
}

const ECB_OPTIONS = { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 };

export function createMagisCrypto({ threeDesKeyHex } = {}) {
  const key = keyFromHex(threeDesKeyHex);

  // utf8(JSON) -> 3DES-EDE-ECB-PKCS7 -> base64 -> hex of the ascii base64
  function encryptPayload(payload) {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const encrypted = CryptoJS.TripleDES.encrypt(CryptoJS.enc.Utf8.parse(text), key, ECB_OPTIONS);
    const base64 = encrypted.toString();
    return CryptoJS.enc.Hex.stringify(CryptoJS.enc.Utf8.parse(base64));
  }

  // hex -> ascii base64 -> 3DES decrypt -> utf8; JSON parsed when possible
  function decryptData(hexBlob) {
    const base64 = CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Hex.parse(String(hexBlob || "")));
    const decrypted = CryptoJS.TripleDES.decrypt(base64, key, ECB_OPTIONS);
    const text = decrypted.toString(CryptoJS.enc.Utf8);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function assertMatchesAcceptanceVector(hexValue) {
    if (hexValue !== MAGIS_CRYPTO_ACCEPTANCE_VECTOR) {
      throw new Error(
        `magisCrypto: round trip does not reproduce the acceptance vector ` +
          `(got ${String(hexValue)})`
      );
    }
    return true;
  }

  // Throws a clear error when the key/config does not reproduce the measured vector.
  function verifyAcceptanceVector() {
    return assertMatchesAcceptanceVector(
      encryptPayload(JSON.parse(MAGIS_CRYPTO_ACCEPTANCE_PLAINTEXT))
    );
  }

  function md5Hex(text) {
    return CryptoJS.MD5(String(text)).toString(CryptoJS.enc.Hex);
  }

  return {
    encryptPayload,
    decryptData,
    assertMatchesAcceptanceVector,
    verifyAcceptanceVector,
    md5Hex
  };
}
