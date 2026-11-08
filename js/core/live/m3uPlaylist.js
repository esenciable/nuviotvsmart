// Pure M3U playlist parser for the PremiumTV live source. No network, no DOM,
// no storage: everything here is derived from the text handed in. Built
// against the MEASURED feed facts (esenciable.github.io esencial.m3u: BOM-less
// in practice but tolerant anyway, CRLF, `#EXTM3U url-tvg=...`, `#EXTINF:-1
// tvg-logo="..." group-title="...",Title`, `#EXTVLCOPT:http-user-agent=` /
// `#EXTVLCOPT:http-referrer=` pairs before each stream URL).
//
// Hard-won Android lessons encoded here:
// - Per-entry headers win; a global Referer breaks channels that validate
//   their own. The samsung default applies ONLY when an entry declares no
//   referrer AND its host is jmp2.uk or a samsung host.
// - Channel identity must survive list reordering: it is derived from the
//   stream URL (FNV-1a), never from the array index.

// Strips `key="value"` pairs out of an attribute string. Quoted values may
// contain commas, spaces and `=`; they may not contain a raw double quote.
function parseQuotedAttributes(text) {
  const attributes = {};
  const pattern = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    attributes[match[1].toLowerCase()] = match[2];
  }
  return attributes;
}

// Index of the first comma that is not inside a double-quoted span.
function indexOfUnquotedComma(text) {
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && inQuotes) {
      i += 1; // skip the escaped character
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) return i;
  }
  return -1;
}

// `#EXTINF:<duration> <attrs>,<title>` -> the pending-entry fields. A missing
// comma is malformed but must not throw: the attributes are still read and the
// title stays empty.
function parseExtinf(line) {
  const rest = line.slice("#EXTINF:".length);
  const commaIndex = indexOfUnquotedComma(rest);
  const attributes = parseQuotedAttributes(commaIndex === -1 ? rest : rest.slice(0, commaIndex));
  const title = commaIndex === -1 ? "" : rest.slice(commaIndex + 1).trim();
  const chno = attributes["tvg-chno"];
  const number = chno ? Number(chno) : NaN;
  return {
    name: title,
    group: attributes["group-title"] || null,
    logo: attributes["tvg-logo"] || null,
    tvgId: attributes["tvg-id"] || null,
    tvgName: attributes["tvg-name"] || null,
    number: Number.isFinite(number) ? number : null
  };
}

export function parseM3u(text) {
  const result = { urlTvg: null, entries: [] };
  if (typeof text !== "string") return result;

  let pending = null; // EXTVLCOPT pairs attach to the entry that follows
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTM3U")) {
      const attributes = parseQuotedAttributes(line);
      result.urlTvg = attributes["url-tvg"] || attributes["x-tvg-url"] || null;
      continue;
    }

    if (line.startsWith("#EXTINF")) {
      pending = parseExtinf(line);
      continue;
    }

    if (line.startsWith("#EXTVLCOPT:")) {
      if (!pending) continue; // orphan option: belongs to no entry we know
      const body = line.slice("#EXTVLCOPT:".length);
      const equals = body.indexOf("=");
      if (equals === -1) continue;
      const key = body.slice(0, equals).trim().toLowerCase();
      const value = body.slice(equals + 1).trim();
      if (key === "http-user-agent") pending.userAgent = value || null;
      else if (key === "http-referrer") pending.referrer = value || null;
      continue;
    }

    if (line.startsWith("#")) continue; // comments and unknown directives

    // A URL line closes the pending entry. Anything else is malformed junk:
    // skip it and keep the rest (never throw).
    if (!/^[A-Za-z][A-Za-z0-9+.\-]*:\/\//.test(line)) continue;
    result.entries.push({
      name: pending?.name ?? "",
      url: line,
      group: pending?.group ?? null,
      logo: pending?.logo ?? null,
      tvgId: pending?.tvgId ?? null,
      tvgName: pending?.tvgName ?? null,
      number: pending?.number ?? null,
      userAgent: pending?.userAgent ?? null,
      referrer: pending?.referrer ?? null
    });
    pending = null;
  }
  return result;
}

// FNV-1a over the URL: short, stable, and identical across list reorderings.
export function premiumTvChannelId(url) {
  const raw = String(url ?? "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Samsung default applies ONLY when the entry declares no referrer and its
// host is jmp2.uk (or a subdomain) or a samsung host. Entry values always win.
const SAMSUNG_REFERER = "https://www.samsung.com/";

function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isJmp2Host(host) {
  return host === "jmp2.uk" || host.endsWith(".jmp2.uk");
}

export function headersForEntry(entry) {
  const headers = {};
  const userAgent = String(entry?.userAgent ?? "").trim();
  const referrer = String(entry?.referrer ?? "").trim();
  if (userAgent) headers["User-Agent"] = userAgent;
  if (referrer) {
    headers.Referer = referrer;
    return headers;
  }
  const host = hostOf(entry?.url);
  if (host && (isJmp2Host(host) || host.includes("samsung"))) {
    headers.Referer = SAMSUNG_REFERER;
  }
  return headers;
}
