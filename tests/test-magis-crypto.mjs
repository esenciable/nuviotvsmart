// Magis crypto acceptance tests: the measured TripleDES vector, a round trip,
// and the mismatch error path. No network, no live portal.
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAGIS_CRYPTO_ACCEPTANCE_PLAINTEXT,
  MAGIS_CRYPTO_ACCEPTANCE_VECTOR,
  createMagisCrypto
} from "../js/core/magis/magisCrypto.js";

const MEASURED_KEY_HEX = "e7af1ed7de1ffddd7bd3fe37ebdffde9ef3fe1ae39edfeb8";

test("acceptance vector: {hola:mundo} encrypts to the measured hex", () => {
  const crypto = createMagisCrypto({ threeDesKeyHex: MEASURED_KEY_HEX });
  const payload = JSON.parse(MAGIS_CRYPTO_ACCEPTANCE_PLAINTEXT);
  assert.equal(payload.hola, "mundo");
  assert.equal(crypto.encryptPayload(payload), MAGIS_CRYPTO_ACCEPTANCE_VECTOR);
});

test("round trip: decryptData reproduces the original payload", () => {
  const crypto = createMagisCrypto({ threeDesKeyHex: MEASURED_KEY_HEX });
  const payload = { returnCode: "", userId: "u1", nested: { ok: true, n: 2 } };
  assert.deepEqual(crypto.decryptData(crypto.encryptPayload(payload)), payload);
});

test("round trip: unicode and compact JSON survive", () => {
  const crypto = createMagisCrypto({ threeDesKeyHex: MEASURED_KEY_HEX });
  const payload = { value: "Señor de los Cielos: 深夜", empty: "" };
  assert.deepEqual(crypto.decryptData(crypto.encryptPayload(payload)), payload);
});

test("mismatch: assertMatchesAcceptanceVector throws a clear error", () => {
  const crypto = createMagisCrypto({ threeDesKeyHex: MEASURED_KEY_HEX });
  assert.throws(
    () => crypto.assertMatchesAcceptanceVector("deadbeef"),
    /acceptance vector/i
  );
});

test("verifyAcceptanceVector passes with the measured key", () => {
  const crypto = createMagisCrypto({ threeDesKeyHex: MEASURED_KEY_HEX });
  assert.doesNotThrow(() => crypto.verifyAcceptanceVector());
});

test("md5Hex matches the measured sn derivation", () => {
  const crypto = createMagisCrypto({ threeDesKeyHex: MEASURED_KEY_HEX });
  assert.equal(
    crypto.md5Hex("tok123" + "ntFT65w6itH!lHCPw7D=@qnsFC5adD28"),
    "42b4f88294fe2151d1aac51003a06b0c"
  );
});
