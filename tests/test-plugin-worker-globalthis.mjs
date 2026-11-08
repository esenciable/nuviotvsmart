import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const workerPath = path.join(rootDir, "dist", "assets", "runtime", "plugin-worker.js");

// The exact assignment form required by the worker fix. A hoisted
// `var globalThis` declaration would break the `typeof globalThis` feature
// test inside pluginWorker.js, so the shim must be an assignment.
const GLOBALTHIS_SHIM = 'typeof self!=="undefined"&&(self.globalThis=self);';

test(
  "plugin worker bundle defines globalThis before any other statement",
  async () => {
    const build = spawnSync(
      process.execPath,
      ["./scripts/build.mjs", "--plugin-worker-only"],
      { cwd: rootDir, encoding: "utf8" }
    );
    assert.equal(
      build.status,
      0,
      `worker build failed (exit ${build.status}):\n${build.stderr || build.stdout}`
    );

    const source = await readFile(workerPath, "utf8");
    assert.ok(
      source.startsWith(GLOBALTHIS_SHIM),
      `plugin worker bundle must start with the globalThis shim assignment; ` +
        `file starts with: ${JSON.stringify(source.slice(0, 120))}`
    );

    // The QuickJS loader (importScripts) must not execute before the shim,
    // otherwise the very first globalThis use still throws on Chromium < 71.
    const importScriptsIndex = source.indexOf("importScripts");
    assert.ok(
      importScriptsIndex === -1 || importScriptsIndex >= GLOBALTHIS_SHIM.length,
      "importScripts must not appear before the globalThis shim"
    );
  }
);
