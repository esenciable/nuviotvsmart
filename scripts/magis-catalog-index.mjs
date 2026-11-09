// Generates js/core/magis/catalog-index.json — the OFFLINE Magis catalog
// index the Live TV screen ships with.
//
// Why: the Live TV screen used to walk EVERY Magis category in the background
// (downloading the same channels twice) and compute channel ownership at
// runtime on a 1 GB-class TV with Samsung's 120 MB app cap. Both are wasted
// work: ownership is a pure function of the catalog, so it is computed once
// on a developer machine and shipped as a small JSON index.
//
// Usage (developer machine, hits the real portal — NEVER run at app runtime):
//
//   npm run catalog:index
//
// The ownership rule is the one the screen already shipped: a SPECIFIC
// category beats the generic catalogue page (`ChannelList`, case-insensitive),
// the FIRST specific category in catalog order containing a channel owns it,
// and the generic catalogue keeps only the unclaimed channels. The index
// carries the per-category counts AFTER dedupe, the generic catalogue's
// leftovers, and the COMPLETE channel list `{ code, name, number, owner }`
// (the global search corpus: every unique channel exactly once, each with the
// columnId of the category that owns it), so the TV renders rail counts, the
// ChannelList and a GLOBAL channel search without fetching anything extra.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createMagisVodClient } from "../js/core/magis/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_PATH = path.resolve(
  __dirname,
  "..",
  "js",
  "core",
  "magis",
  "catalog-index.json"
);

export const GENERIC_CATEGORY_NAME = "ChannelList";

// Case-insensitive identification of the catalogue page category (same rule
// the screen ships, kept byte-compatible here).
export function isGenericCategoryName(name, genericName = GENERIC_CATEGORY_NAME) {
  return (
    String(name ?? "")
      .trim()
      .toLowerCase() ===
    String(genericName ?? GENERIC_CATEGORY_NAME)
      .trim()
      .toLowerCase()
  );
}

// Pure: the ownership computation the generator ships. Walks the categories
// in catalog order over the walked channel lists:
//   - a SPECIFIC category claims a channel before the generic catalogue and
//     before any LATER specific one (first specific wins),
//   - the generic catalogue claims only channels nothing specific claimed.
// Returns { owners, counts, leftovers, channels }:
//   owners:    Map channelId(code) -> owning columnId (as string)
//   counts:    Map columnId (as string) -> count AFTER dedupe
//   leftovers: the generic catalogue's unclaimed channels, in catalog order,
//              as { code, name, number }
//   channels:  EVERY unique channel exactly once, in catalog order, as
//              { code, name, number, owner } where owner is the owning
//              category's columnId (as string) — the global search corpus.
export function computeCatalogOwnership({
  categories = [],
  channelsByCategory = new Map(),
  genericCategoryName = GENERIC_CATEGORY_NAME
} = {}) {
  const lists = channelsByCategory instanceof Map ? channelsByCategory : new Map();
  const owners = new Map();
  const specificOwned = new Set();
  const counts = new Map();
  const leftovers = [];
  const genericColumnIds = new Set();
  const channels = [];
  const seenChannelCodes = new Set();
  // Pass 1 — ownership, in catalog order (the shipped rule).
  for (const category of Array.isArray(categories) ? categories : []) {
    const columnId = String(category?.columnId ?? "").trim();
    if (!columnId) continue;
    const list = lists.get(columnId);
    if (!Array.isArray(list)) continue; // not walked: contributes nothing
    const generic = isGenericCategoryName(category?.name, genericCategoryName);
    if (generic) genericColumnIds.add(columnId);
    for (const channel of list) {
      const code = String(channel?.code ?? "").trim();
      if (!code) continue;
      if (generic) {
        if (!owners.has(code)) owners.set(code, columnId);
      } else if (!specificOwned.has(code)) {
        // Specific beats the generic catalogue and beats a later specific one.
        owners.set(code, columnId);
        specificOwned.add(code);
      }
    }
  }
  // Pass 2 — deduped counts and the generic leftovers.
  for (const category of Array.isArray(categories) ? categories : []) {
    const columnId = String(category?.columnId ?? "").trim();
    if (!columnId) continue;
    const list = lists.get(columnId);
    if (!Array.isArray(list)) {
      counts.set(columnId, 0);
      continue;
    }
    const generic = genericColumnIds.has(columnId);
    let count = 0;
    for (const channel of list) {
      const code = String(channel?.code ?? "").trim();
      if (!code) continue;
      if (owners.get(code) !== columnId) continue; // owned by an earlier category
      count += 1;
      if (generic)
        leftovers.push({
          code,
          name: String(channel?.name ?? ""),
          number: channel?.number ?? null
        });
      // The global search corpus: the owning category's own row (a channel
      // listed twice inside its category still appears exactly once).
      if (!seenChannelCodes.has(code)) {
        seenChannelCodes.add(code);
        channels.push({
          code,
          name: String(channel?.name ?? ""),
          number: channel?.number ?? null,
          owner: columnId
        });
      }
    }
    counts.set(columnId, count);
  }
  return { owners, counts, leftovers, channels };
}

// Pure: the shipped index object. `categories` keeps the portal's catalog
// order (every category appears, empty ones included, count 0); `channels`
// is the complete post-dedupe channel list (the global search corpus).
export function buildCatalogIndex({
  categories = [],
  channelsByCategory = new Map(),
  generatedAt,
  genericCategoryName = GENERIC_CATEGORY_NAME
} = {}) {
  const { counts, leftovers, channels } = computeCatalogOwnership({
    categories,
    channelsByCategory,
    genericCategoryName
  });
  return {
    generatedAt: String(generatedAt || ""),
    genericCategoryName,
    categories: (Array.isArray(categories) ? categories : [])
      .filter((category) => String(category?.columnId ?? "").trim() !== "")
      .map((category) => ({
        columnId: category.columnId,
        name: String(category?.name ?? ""),
        count: counts.get(String(category.columnId).trim()) ?? 0
      })),
    channels,
    leftovers
  };
}

// Pure: the shipped BYTES. Categories and leftovers stay pretty-printed (a
// human can audit them); the channels array — the bulk of the file at ~1k
// entries — is written as ONE compact line, because pretty-printing it would
// roughly double the JSON a memory-capped TV (Samsung's 120 MB app cap)
// inlines into the bundle. Deterministic: parsing the output reproduces the
// index exactly.
export function serializeCatalogIndex(index) {
  const CHANNELS_PLACEHOLDER = "__NUVIO_CHANNELS_ONE_LINE__";
  const text = JSON.stringify({ ...index, channels: CHANNELS_PLACEHOLDER }, null, 2);
  // A function replacement: channel names may contain `$` sequences that a
  // string replacement would misinterpret.
  return text.replace(JSON.stringify(CHANNELS_PLACEHOLDER), () =>
    JSON.stringify(index?.channels ?? [])
  );
}

// Walks every category through the real client, ONE category at a time — the
// portal measures ~150 ms per call and 2 calls per category, so sequential
// awaits are the measured pacing (no queue, no parallelism, no retries: a
// failed walk must fail loudly instead of shipping a partial index).
export async function walkCatalogCategories(client) {
  const live = client?.live;
  if (
    !live ||
    typeof live.listCategories !== "function" ||
    typeof live.listChannels !== "function"
  ) {
    throw new Error(
      "magis-catalog-index: a Magis client with live.listCategories/listChannels is required"
    );
  }
  const categories = await live.listCategories();
  const channelsByCategory = new Map();
  for (const category of Array.isArray(categories) ? categories : []) {
    const columnId = category?.columnId;
    if (columnId == null) continue;
    const channels = await live.listChannels({ columnId });
    channelsByCategory.set(String(columnId), Array.isArray(channels) ? channels : []);
  }
  return { categories, channelsByCategory };
}

async function main() {
  // In-memory session persistence: the generator is a one-shot CLI, it must
  // not read or write the app's storage keys.
  const persistence = {
    load: () => null,
    save: () => {},
    clear: () => {}
  };
  console.log("magis-catalog-index: building the Magis client (direct transport)...");
  const client = await createMagisVodClient({ persistence });
  console.log("magis-catalog-index: walking every Magis category (sequential, portal pacing)...");
  const { categories, channelsByCategory } = await walkCatalogCategories(client);
  const genericCategory = categories.find((category) => isGenericCategoryName(category?.name));
  const rawCatalogueCount = genericCategory
    ? (channelsByCategory.get(String(genericCategory.columnId)) || []).length
    : 0;
  const index = buildCatalogIndex({
    categories,
    channelsByCategory,
    generatedAt: new Date().toISOString()
  });
  await writeFile(DEFAULT_OUTPUT_PATH, `${serializeCatalogIndex(index)}\n`);
  // e.g. "500 -> 64": the raw catalogue page size vs the leftovers it keeps.
  console.log(`magis-catalog-index: ${rawCatalogueCount} -> ${index.leftovers.length}`);
  console.log(
    `magis-catalog-index: ${index.channels.length} unique channels indexed for global search`
  );
  console.log(`magis-catalog-index: wrote ${DEFAULT_OUTPUT_PATH}`);
}

// Only run the network walk when executed directly (`npm run
// catalog:index`); importing this module (the tests do) must stay offline.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error("magis-catalog-index: failed —", String(error?.message || error));
    process.exitCode = 1;
  });
}
