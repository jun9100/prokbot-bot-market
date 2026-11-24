// Bot Market service for ProkBot Host2.
//
// Aggregates built-in templates, local published shares, and optional remote registries
// (ProkBot Market v1 & LobeChat Agents index), plus direct GitHub/URL import across
// 4 declarative formats (ProkBot ZIP, ProkBot JSON, LobeChat JSON, Agency/OpenClaw/SKILL Markdown).
// Zero external npm dependencies; strict SSRF, size, secret, and zero-memory guardrails.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { lookup as defaultDnsLookup } from 'node:dns/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  APP_CATALOG_META,
  BOT_MARKET_CATEGORIES,
  BUILTIN_BOT_TEMPLATES,
  CURATED_GITHUB_EXAMPLES,
} from './bot-market-catalog.mjs';
import { normalizeLocaleTag, pickLocalized } from './locale.mjs';
import { assertSafeMarketText } from './market-secrets.mjs';
import { check, HttpError } from './security.mjs';
import {
  assertShareableText,
  normalizeRecipe,
  normalizeSharePackage,
  packShare,
  shareDigest,
  unpackShare,
} from './sharing-package.mjs';
import { JsonStore } from './storage.mjs';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FEDERATION_CACHE_TTL_MS = 60 * 1000;
const MAX_SOURCES = 50;
const MAX_INSTALLED_HISTORY = 200;
const MAX_INDEX_ITEMS = 1000;
const MAX_FEDERATION_ITEMS = 100;

export const ITEM_ID_RE = /^[a-zA-Z0-9._:@-]{1,200}$/;
export const SOURCE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const FED_ITEM_RE = /^fed:([a-f0-9]{12,64}):([A-Za-z0-9_-]{1,128})$/;

export function projectItemForDevice(item) {
  if (!item || typeof item !== 'object') return item;
  const { peerId: _omittedPeerId, ...safe } = item;
  return safe;
}

export function projectForDevice(listResult) {
  const categories = Array.isArray(listResult?.categories) ? listResult.categories : [];
  const items = Array.isArray(listResult?.items) ? listResult.items.map(projectItemForDevice) : [];
  return { categories, items };
}
const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REGISTRY_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SLUG_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const AVATAR_TOKEN_RE = /^[a-zA-Z0-9_-]{1,80}$/;

const AVATAR_COLORS = [
  'blue',
  'emerald',
  'indigo',
  'orange',
  'violet',
  'rose',
  'teal',
  'amber',
  'slate',
  'cyan',
];

const CATEGORY_MAP = new Map(BOT_MARKET_CATEGORIES.map((cat) => [cat.id, cat]));
const BUILTIN_MAP = new Map(BUILTIN_BOT_TEMPLATES.map((tpl) => [tpl.id, tpl]));

const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'instance-data',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
]);

function parseIpv4Octets(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function parseIpv6Groups(value) {
  const clean = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  if (!clean || !clean.includes(':')) return null;
  const halves = clean.split('::');
  if (halves.length > 2) return null;

  const expandHalf = (part, allowTrailingIpv4) => {
    if (!part) return [];
    const tokens = part.split(':');
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (allowTrailingIpv4 && i === tokens.length - 1 && tok.includes('.')) {
        const octets = parseIpv4Octets(tok);
        if (!octets) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(parseInt(tok, 16));
      }
    }
    return out;
  };

  if (halves.length === 1) {
    const groups = expandHalf(halves[0], true);
    return groups && groups.length === 8 ? groups : null;
  }
  const left = expandHalf(halves[0], false);
  const right = expandHalf(halves[1], true);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

function isBlockedIpv4Octets(octets) {
  if (!octets || octets.length !== 4) return false;
  const [a, b, c, d] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified / "this" network)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 100 && b === 100 && c === 100 && d === 200) return true; // Alibaba Cloud metadata
  return false;
}

export function isBlockedIp(ip) {
  const norm = String(ip || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!norm) return true;
  const v4 = parseIpv4Octets(norm);
  if (v4) return isBlockedIpv4Octets(v4);
  const g = parseIpv6Groups(norm);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  // Unspecified :: and loopback ::1
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    (g7 === 0 || g7 === 1)
  ) {
    return true;
  }
  // Link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // AWS IPv6 IMDS fd00:ec2::254
  if (
    g0 === 0xfd00 &&
    g1 === 0x0ec2 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 0x0254
  ) {
    return true;
  }
  // IPv6-embedded IPv4 encodings in (g6, g7):
  // ::ffff:0:0/96 (IPv4-mapped), ::ffff:0:0:0/96 (SIIT IPv4-translated),
  // ::/96 (IPv4-compatible: ::a9fe:..., ::7f00:..., ::0:...), 64:ff9b::/96 & 64:ff9b:1::/96 (NAT64)
  const embeddedV4 = [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff];
  const isV4Mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const isV4Translated = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0;
  const isV4Compat = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  const isNat64 =
    g0 === 0x0064 &&
    g1 === 0xff9b &&
    (g2 === 0 || g2 === 1) &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0;
  if ((isV4Mapped || isV4Translated || isV4Compat || isNat64) && isBlockedIpv4Octets(embeddedV4)) {
    return true;
  }
  // 6to4 2002::/16 embeds IPv4 in (g1, g2)
  if (g0 === 0x2002) {
    const v4From6to4 = [(g1 >> 8) & 0xff, g1 & 0xff, (g2 >> 8) & 0xff, g2 & 0xff];
    if (isBlockedIpv4Octets(v4From6to4)) return true;
  }
  return false;
}

function isBlockedMetadataHost(hostname) {
  const norm = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (!norm) return true;
  if (BLOCKED_HOSTS.has(norm)) return true;
  if (norm.endsWith('.localhost')) return true;
  return isBlockedIp(norm);
}

async function assertSafeResolvedHost(url, dnsLookup, label = 'URL') {
  if (typeof dnsLookup !== 'function') return;
  const host = String(url.hostname || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (!host || isIP(host) !== 0) return;
  let records;
  try {
    records = await dnsLookup(host, { all: true });
  } catch (error) {
    throw new HttpError(502, `DNS lookup failed for ${label}: ${error?.message || 'lookup error'}`);
  }
  const list = Array.isArray(records) ? records : records ? [records] : [];
  check(list.length > 0, 502, `DNS lookup returned no addresses for ${label}`);
  for (const rec of list) {
    const ip = typeof rec === 'string' ? rec : rec?.address;
    check(typeof ip === 'string' && ip.length > 0, 502, `Invalid DNS record for ${label}`);
    check(!isBlockedIp(ip), 400, `${label} resolves to a blocked host`);
  }
}

function assertSafeHttpUrl(rawUrl, label = 'URL') {
  check(
    typeof rawUrl === 'string' &&
      rawUrl.trim().length > 0 &&
      rawUrl.length <= 2048 &&
      !/[\0\r\n]/.test(rawUrl),
    400,
    `Invalid ${label}`,
  );
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    check(false, 400, `Invalid ${label}`);
  }
  check(
    url.protocol === 'http:' || url.protocol === 'https:',
    400,
    `${label} must use http or https`,
  );
  check(!url.username && !url.password, 400, `${label} must not contain credentials`);
  check(
    !isBlockedMetadataHost(url.hostname),
    400,
    `${label} points to a blocked loopback, link-local, or metadata host`,
  );
  return url;
}

/**
 * Validates an HTTP(S) URL (rejecting credentials and blocked loopback/metadata hosts) and
 * auto-converts GitHub blob/raw web URLs to raw.githubusercontent.com URLs.
 */
export function normalizeGithubRawUrl(rawUrl) {
  const url = assertSafeHttpUrl(rawUrl, 'URL');
  url.hash = '';
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 5 && (parts[2] === 'blob' || parts[2] === 'raw')) {
      const owner = parts[0];
      const repo = parts[1];
      const rest = parts.slice(3).join('/');
      return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
    }
  }
  return url.href;
}

function isZipMagic(bytes) {
  return (
    bytes &&
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/**
 * Fetches bytes with manual redirects (<= 3 hops), per-hop SSRF/DNS/downgrade checks,
 * one-way cross-origin Authorization stripping, timeout, and strict body size enforcement.
 */
export async function safeFetchBytes(
  rawUrl,
  {
    fetchImpl = globalThis.fetch,
    dnsLookup = fetchImpl === globalThis.fetch ? defaultDnsLookup : null,
    token = '',
    maxBytes = MAX_TEXT_BYTES,
    zipMaxBytes = MAX_ZIP_BYTES,
    detectZipLimit = false,
    maxRedirects = MAX_REDIRECTS,
    timeoutMs = FETCH_TIMEOUT_MS,
    accept = '*/*',
  } = {},
) {
  check(typeof fetchImpl === 'function', 503, 'HTTP fetch implementation unavailable');
  let currentUrl = assertSafeHttpUrl(rawUrl, 'URL');
  const initialOrigin = currentUrl.origin;
  let allowToken = Boolean(token);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeResolvedHost(currentUrl, dnsLookup, hop === 0 ? 'URL' : 'Redirect URL');
    const headers = {
      accept,
      'user-agent': 'ProkBot-Host2-BotMarket/1.0',
    };
    if (allowToken && currentUrl.origin === initialOrigin) {
      headers.authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl.href, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') {
        throw new HttpError(504, 'Remote fetch timed out');
      }
      throw new HttpError(502, `Remote fetch failed: ${error?.message || 'network error'}`);
    }

    const status = Number(response?.status ?? 0);
    if ([301, 302, 303, 307, 308].includes(status)) {
      clearTimeout(timer);
      response.body?.cancel?.().catch(() => {});
      check(hop < maxRedirects, 502, 'Too many redirects');
      const location = response.headers?.get?.('location');
      check(location, 502, 'Redirect response missing Location header');
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl.href);
      } catch {
        check(false, 502, 'Invalid redirect Location URL');
      }
      assertSafeHttpUrl(nextUrl.href, 'Redirect URL');
      check(
        !(currentUrl.protocol === 'https:' && nextUrl.protocol === 'http:'),
        400,
        'Refusing HTTPS to HTTP redirect downgrade',
      );
      if (nextUrl.origin !== initialOrigin) {
        allowToken = false;
      }
      currentUrl = nextUrl;
      continue;
    }

    if (status < 200 || status >= 300) {
      clearTimeout(timer);
      response.body?.cancel?.().catch(() => {});
      throw new HttpError(502, `Remote server returned HTTP ${status}`);
    }

    const contentType = String(response.headers?.get?.('content-type') || '');
    const hintZip =
      detectZipLimit &&
      (/\.zip$/i.test(currentUrl.pathname) || /application\/zip/i.test(contentType));
    const upperCap = detectZipLimit ? Math.max(maxBytes, zipMaxBytes) : maxBytes;
    const contentLengthHeader = response.headers?.get?.('content-length');
    if (contentLengthHeader != null && contentLengthHeader !== '') {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > upperCap) {
        clearTimeout(timer);
        response.body?.cancel?.().catch(() => {});
        throw new HttpError(413, 'Remote file exceeds size limit');
      }
    }

    try {
      let bytes;
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        let limit = hintZip ? zipMaxBytes : maxBytes;
        let magicChecked = !detectZipLimit || hintZip;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          chunks.push(chunk);
          total += chunk.length;
          if (!magicChecked && total >= 4) {
            const head = Buffer.concat(chunks, Math.min(total, 4));
            if (isZipMagic(head)) limit = zipMaxBytes;
            magicChecked = true;
          }
          if (total > limit) {
            await reader.cancel().catch(() => {});
            throw new HttpError(413, 'Remote file exceeds size limit');
          }
        }
        bytes = Buffer.concat(chunks, total);
      } else {
        const ab = await response.arrayBuffer();
        bytes = Buffer.from(ab);
        const limit =
          detectZipLimit && (hintZip || isZipMagic(bytes)) ? zipMaxBytes : maxBytes;
        check(bytes.length <= limit, 413, 'Remote file exceeds size limit');
      }
      return { bytes, contentType, finalUrl: currentUrl.href };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error?.name === 'AbortError') {
        throw new HttpError(504, 'Remote fetch timed out');
      }
      throw new HttpError(502, `Failed reading remote body: ${error?.message || 'stream error'}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(502, 'Too many redirects');
}

function hashSeed(value) {
  let sum = 7;
  for (const ch of String(value || 'bot')) {
    sum = (sum * 31 + ch.codePointAt(0)) >>> 0;
  }
  return sum;
}

function pickAvatarColor(seed) {
  return AVATAR_COLORS[hashSeed(seed) % AVATAR_COLORS.length];
}

function cleanLine(value, maxLen) {
  const s = String(value ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

function cleanOptionalLine(value, maxLen) {
  if (typeof value !== 'string') return '';
  return cleanLine(value, maxLen);
}

function cleanMultiline(value, maxLen) {
  const s = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '')
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

function normalizeTags(raw) {
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const clean = cleanLine(item, 40);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 20) break;
  }
  return out;
}

function stripYamlInlineComment(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let quote = '';
  let inBracket = 0;
  let canStartQuote = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && i + 1 < s.length) {
        i++;
      } else if (quote === "'" && ch === "'" && s[i + 1] === "'") {
        i++;
      } else if (ch === quote) {
        quote = '';
        canStartQuote = false;
      }
      continue;
    }
    if (canStartQuote && (ch === '"' || ch === "'")) {
      quote = ch;
      canStartQuote = false;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
    if (ch === '[') {
      inBracket++;
      canStartQuote = true;
    } else if (ch === ']' && inBracket > 0) {
      inBracket--;
      canStartQuote = false;
    } else if (ch === ',' && inBracket > 0) {
      canStartQuote = true;
    } else if (!/\s/.test(ch)) {
      canStartQuote = false;
    }
  }
  return s;
}

function parseYamlScalar(raw) {
  const trimmed = stripYamlInlineComment(raw);
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    const quote = trimmed[0];
    const inner = trimmed.slice(1, -1);
    if (quote === '"') {
      return inner.replace(
        /\\([nt"\\])/g,
        (_, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[c]),
      );
    }
    return inner.replace(/''/g, "'");
  }
  return trimmed;
}

function parseYamlInlineArray(raw) {
  const inner = stripYamlInlineComment(raw).slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        current += ch + inner[++i];
      } else if (ch === "'" && quote === "'" && inner[i + 1] === "'") {
        current += "''";
        i++;
      } else if (ch === quote) {
        quote = '';
        current += ch;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      const val = parseYamlScalar(current);
      if (val) items.push(val);
      current = '';
    } else {
      current += ch;
    }
  }
  const tail = parseYamlScalar(current);
  if (tail) items.push(tail);
  return items;
}

function parseMarkdownFrontmatter(rawText) {
  const text = String(rawText ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n(?:---[ \t]*(?:\n|$)|([\s\S]*?)\n---[ \t]*(?:\n|$))/.exec(text);
  if (!match) {
    return { frontmatter: {}, body: text.trim(), hasFrontmatter: false };
  }
  const yamlBlock = match[1] ?? '';
  const body = text.slice(match[0].length).trim();
  const frontmatter = {};
  const lines = yamlBlock ? yamlBlock.split('\n') : [];

  let currentListKey = null;
  let multiline = null;

  const flushMultiline = () => {
    if (!multiline) return;
    const joined =
      multiline.style === '>'
        ? multiline.lines.map((l) => l.trim()).join(' ').trim()
        : multiline.lines.join('\n').trim();
    frontmatter[multiline.key] = joined;
    multiline = null;
  };

  for (const line of lines) {
    if (multiline) {
      if (line.trim() === '') {
        multiline.lines.push('');
        continue;
      }
      const indent = line.match(/^\s*/)[0].length;
      if (indent > multiline.baseIndent) {
        if (multiline.contentIndent === null) multiline.contentIndent = indent;
        multiline.lines.push(line.slice(Math.min(indent, multiline.contentIndent)));
        continue;
      }
      flushMultiline();
    }

    if (!line.trim() || /^\s*#/.test(line)) continue;

    if (currentListKey) {
      const itemMatch = /^\s*-\s+(.*)$/.exec(line);
      if (itemMatch) {
        const val = parseYamlScalar(itemMatch[1]);
        if (val) {
          if (!Array.isArray(frontmatter[currentListKey])) frontmatter[currentListKey] = [];
          frontmatter[currentListKey].push(val);
        }
        continue;
      }
      currentListKey = null;
    }

    const kvMatch = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kvMatch) continue;
    const baseIndent = kvMatch[1].length;
    if (baseIndent > 0) continue;
    const key = kvMatch[2].toLowerCase();
    const rawVal = stripYamlInlineComment(kvMatch[3]);

    if (rawVal === '') {
      currentListKey = key;
      if (!(key in frontmatter)) frontmatter[key] = [];
    } else if (/^[|>](?:[0-9]+[+-]?|[+-][0-9]*|)$/.test(rawVal)) {
      const indentDigits = rawVal.slice(1).replace(/[+-]/g, '');
      const explicitIndent = indentDigits ? Number(indentDigits) : 0;
      multiline = {
        key,
        style: rawVal[0],
        baseIndent,
        contentIndent: explicitIndent > 0 ? baseIndent + explicitIndent : null,
        lines: [],
      };
    } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      frontmatter[key] = parseYamlInlineArray(rawVal);
    } else {
      frontmatter[key] = parseYamlScalar(rawVal);
    }
  }
  flushMultiline();

  return { frontmatter, body, hasFrontmatter: true };
}

function smartNameFromUrl(sourceUrl) {
  if (!sourceUrl) return '';
  try {
    const pathname = decodeURIComponent(new URL(sourceUrl).pathname);
    const parts = pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    const last = parts.at(-1).replace(/\.(?:md|markdown|json|zip)$/i, '');
    const generic = new Set(['skill', 'soul', 'readme', 'agent', 'index', 'prompt', 'identity']);
    const chosen =
      generic.has(last.toLowerCase()) && parts.length >= 2 ? parts.at(-2) : last;
    return cleanLine(chosen.replace(/[-_]+/g, ' '), 100);
  } catch {
    return '';
  }
}

function firstMarkdownHeading(body) {
  const match = /^#{1,2}\s+(.+)$/m.exec(body || '');
  if (!match) return '';
  return cleanLine(match[1].replace(/#+\s*$/, ''), 100);
}

function firstMarkdownParagraph(body) {
  for (const block of String(body || '').split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('---')) {
      continue;
    }
    const line = cleanLine(trimmed.replace(/^[-*>\d.]+\s+/, ''), 200);
    if (line) return line;
  }
  return '';
}

function forceSafeBotRecipe(rawRecipe) {
  check(rawRecipe && typeof rawRecipe === 'object' && !Array.isArray(rawRecipe), 400, 'Invalid Bot recipe');
  const routines = Array.isArray(rawRecipe.routines)
    ? rawRecipe.routines.map((r) =>
        r && typeof r === 'object' && !Array.isArray(r) ? { ...r, isEnabled: false } : r,
      )
    : [];
  return normalizeRecipe({
    ...rawRecipe,
    memory: [],
    routines,
  });
}

function mapExternalCategory(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (CATEGORY_MAP.has(key)) return key;
  if (['programming', 'code', 'developer', 'development', 'engineering', 'software'].includes(key)) {
    return 'coding';
  }
  if (['copywriting', 'writing', 'translation', 'editorial', 'content', 'docs'].includes(key)) {
    return 'writing';
  }
  if (['academic', 'research', 'science', 'analysis', 'data'].includes(key)) {
    return 'research';
  }
  if (['finance', 'business', 'economy', 'accounting', 'investing'].includes(key)) {
    return 'finance';
  }
  if (['life', 'travel', 'food', 'health', 'lifestyle', 'entertainment'].includes(key)) {
    return 'life';
  }
  if (['education', 'learning', 'language', 'career', 'study'].includes(key)) {
    return 'learning';
  }
  if (['ops', 'devops', 'sre', 'infrastructure', 'security', 'sysadmin'].includes(key)) {
    return 'ops';
  }
  return 'productivity';
}

function recipeToShareDependencies(recipe) {
  return (recipe.plugins ?? []).map((plugin) => ({
    pluginId: plugin.pluginId,
    name: plugin.name || plugin.pluginId,
    ...(plugin.version ? { version: plugin.version } : {}),
    tools: [],
  }));
}

function splitToolList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[, ]+/);
  return [];
}

/**
 * Auto-detects and parses ProkBot Sharing ZIP, ProkBot Sharing JSON, LobeChat Agent JSON,
 * or Agency-Agents / OpenClaw / SKILL.md Markdown into a safe, normalized ProkBot Bot recipe.
 */
export function parseExternalBotContent(input, { sourceUrl = '', locale = 'zh-CN' } = {}) {
  let bytes;
  let text = null;
  if (typeof input === 'string') {
    text = input;
    bytes = Buffer.from(input, 'utf8');
  } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    bytes = Buffer.from(input);
  } else {
    check(false, 400, 'Bot content must be a string or binary buffer');
  }
  check(bytes.length > 0, 400, 'Bot content is empty');

  let format = '';
  let recipe;
  let author = '';
  let tags = [];
  let title = '';
  let dependencies = [];

  // 1. ProkBot Sharing ZIP
  if (isZipMagic(bytes)) {
    check(bytes.length <= MAX_ZIP_BYTES, 413, 'ZIP exceeds size limit');
    const pkg = unpackShare(bytes);
    check(pkg.kind === 'bot', 400, 'Only Bot sharing packages are supported in Bot Market');
    recipe = forceSafeBotRecipe(pkg.content);
    dependencies =
      Array.isArray(pkg.dependencies) && pkg.dependencies.length > 0
        ? pkg.dependencies
        : recipeToShareDependencies(recipe);
    title = recipe.profile.title;
    format = 'prokbot-zip';
  } else {
    check(bytes.length <= MAX_TEXT_BYTES, 413, 'Bot definition exceeds 2 MiB size limit');
    check(!bytes.includes(0), 400, 'Unsupported binary file format');
    if (text === null) text = bytes.toString('utf8');
    assertShareableText(text);
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    check(trimmed.length > 0, 400, 'Bot content is empty');

    let urlPathname = '';
    if (sourceUrl) {
      try {
        urlPathname = new URL(sourceUrl).pathname;
      } catch {
        urlPathname = String(sourceUrl);
      }
    }
    const isJsonUrl = /\.json$/i.test(urlPathname);

    let parsedJson = null;
    let treatAsJson = false;
    if (trimmed.startsWith('{')) {
      treatAsJson = true;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch {
        check(false, 400, 'Invalid JSON bot file');
      }
    } else if (trimmed.startsWith('[')) {
      try {
        parsedJson = JSON.parse(trimmed);
        treatAsJson = true;
      } catch {
        if (isJsonUrl) {
          check(false, 400, 'Invalid JSON bot file');
        }
      }
    }

    if (treatAsJson) {
      const parsed = parsedJson;
      check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'JSON bot must be an object');

      // 2. ProkBot Sharing JSON
      if (parsed.schemaVersion === 1 && parsed.kind === 'bot') {
        check(parsed.content && typeof parsed.content === 'object', 400, 'Missing Bot content in sharing JSON');
        const safeContent = forceSafeBotRecipe(parsed.content);
        const pkg = normalizeSharePackage({
          schemaVersion: 1,
          kind: 'bot',
          content: safeContent,
          dependencies: Array.isArray(parsed.dependencies)
            ? parsed.dependencies
            : recipeToShareDependencies(safeContent),
        });
        recipe = pkg.content;
        dependencies = pkg.dependencies;
        title = recipe.profile.title;
        author = cleanOptionalLine(parsed.author, 100);
        tags = normalizeTags(parsed.tags);
        format = 'prokbot-json';
      } else if (parsed.schemaVersion === 1 && parsed.kind === 'skill') {
        check(false, 400, 'Only Bot sharing packages are supported in Bot Market');
      } else if (
        typeof parsed.config?.systemRole === 'string' ||
        (parsed.meta &&
          typeof parsed.meta === 'object' &&
          !Array.isArray(parsed.meta) &&
          (parsed.meta.title || parsed.meta.name))
      ) {
        // 3. LobeChat Agent JSON (lobehub/lobe-chat-agents)
        const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
        const name = cleanLine(
          meta.title || meta.name || parsed.identifier || smartNameFromUrl(sourceUrl) || 'Imported Agent',
          100,
        );
        check(name, 400, 'LobeChat agent is missing a valid name');
        const tagline = cleanLine(meta.description || name, 200) || name;
        const systemRole = cleanMultiline(
          typeof parsed.config?.systemRole === 'string' ? parsed.config.systemRole : '',
          30_000,
        );
        check(systemRole.length > 0, 400, 'LobeChat agent is missing config.systemRole');
        author = cleanOptionalLine(parsed.author, 100);
        tags = normalizeTags(meta.tags);
        title = tagline;
        recipe = forceSafeBotRecipe({
          profile: {
            name,
            title: tagline,
            description: systemRole,
            avatarShape: 'blob',
            avatarColor: pickAvatarColor(name),
          },
          memory: [],
          skills: [],
          routines: [],
          plugins: [],
        });
        dependencies = [];
        format = 'lobe-json';
      } else {
        check(false, 400, 'Unsupported JSON bot format');
      }
    } else {
      // 4. Agency-Agents / OpenClaw SOUL.md / SKILL.md Markdown
      const { frontmatter: fm, body } = parseMarkdownFrontmatter(trimmed);
      const fmInstructions = typeof fm.instructions === 'string' ? fm.instructions.trim() : '';
      const fmDesc = typeof fm.description === 'string' ? fm.description.trim() : '';
      const fmVibe = typeof fm.vibe === 'string' ? fm.vibe.trim() : '';
      const rawPrompt =
        body && fmInstructions && !body.includes(fmInstructions)
          ? `${fmInstructions}\n\n${body}`
          : body || fmInstructions || fmDesc;
      const prompt = cleanMultiline(rawPrompt, 30_000);
      check(prompt.length > 0, 400, 'Markdown bot file has no instructions or body');

      const isSkillStyle =
        /(?:^|\/)skill\.md$/i.test(urlPathname) ||
        Boolean(fmInstructions) ||
        Boolean(fm['allowed-tools'] || fm.allowed_tools);
      const isOpenClawStyle =
        !isSkillStyle &&
        (/(?:^|\/)soul\.md$/i.test(urlPathname) ||
          /openclaw/i.test(sourceUrl) ||
          Boolean(fm.soul || fm.openclaw));
      format = isSkillStyle ? 'skill-md' : isOpenClawStyle ? 'openclaw-md' : 'agency-md';

      const name = cleanLine(
        (typeof fm.name === 'string' ? fm.name : '') ||
          (typeof fm.title === 'string' ? fm.title : '') ||
          firstMarkdownHeading(body) ||
          smartNameFromUrl(sourceUrl) ||
          (normalizeLocaleTag(locale).startsWith('zh') ? '导入的 Bot' : 'Imported Bot'),
        100,
      );
      const tagline =
        cleanLine(
          fmDesc ||
            fmVibe ||
            (typeof fm.tagline === 'string' ? fm.tagline : '') ||
            (typeof fm.summary === 'string' ? fm.summary : '') ||
            firstMarkdownParagraph(body) ||
            name,
          200,
        ) || name;
      author = cleanOptionalLine(typeof fm.author === 'string' ? fm.author : '', 100);
      tags = normalizeTags([
        ...(Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === 'string' ? fm.tags.split(',') : []),
        ...(Array.isArray(fm.tools) ? fm.tools : typeof fm.tools === 'string' ? fm.tools.split(',') : []),
        ...splitToolList(fm['allowed-tools']),
        ...splitToolList(fm.allowed_tools),
        ...(typeof fm.category === 'string' ? [fm.category] : []),
      ]);
      const rawColor = typeof fm.color === 'string' ? fm.color.trim().toLowerCase() : '';
      const avatarColor = AVATAR_TOKEN_RE.test(rawColor) ? rawColor : pickAvatarColor(name);

      const skills = isSkillStyle
        ? [
            {
              name: cleanLine(name, 100),
              description: cleanLine(tagline, 2000),
              content: cleanMultiline(rawPrompt, 200_000),
            },
          ]
        : [];

      title = tagline;
      recipe = forceSafeBotRecipe({
        profile: {
          name,
          title: tagline,
          description: prompt,
          avatarShape: 'blob',
          avatarColor,
        },
        memory: [],
        skills,
        routines: [],
        plugins: [],
      });
      dependencies = [];
    }
  }

  const sharePkg = normalizeSharePackage({
    schemaVersion: 1,
    kind: 'bot',
    content: recipe,
    dependencies,
  });
  const digest = shareDigest(sharePkg);

  return {
    format,
    name: recipe.profile.name,
    title: title || recipe.profile.title,
    description: title || recipe.profile.title,
    prompt: recipe.profile.description,
    author,
    tags,
    sourceUrl,
    recipe,
    dependencies: sharePkg.dependencies,
    digest,
    skills: recipe.skills,
    routines: recipe.routines,
  };
}

function resolveIndexItemUrl(rawRelativeOrAbsolute, sourceUrl) {
  check(typeof rawRelativeOrAbsolute === 'string' && rawRelativeOrAbsolute.trim(), 400, 'Invalid packageUrl');
  let resolved;
  try {
    resolved = new URL(rawRelativeOrAbsolute.trim(), sourceUrl).href;
  } catch {
    check(false, 400, 'Invalid packageUrl in registry index');
  }
  return normalizeGithubRawUrl(resolved);
}

function normalizeLocalizedField(value, fallback = '') {
  if (typeof value === 'string') return cleanLine(value, 2000) || fallback;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && v.trim()) {
        out[k] = cleanLine(v, 2000);
      }
    }
    if (Object.keys(out).length > 0) return out;
  }
  return fallback;
}

/**
 * Parses a remote Bot Market registry index in either ProkBot Market v1 format
 * (`schemaVersion === 1 && Array.isArray(json.bots)`) or LobeChat Agents index format
 * (`Array.isArray(json.agents)`), resolving relative URLs cleanly against `sourceUrl`.
 */
export function parseRegistryIndex(json, sourceUrl) {
  const baseUrl = assertSafeHttpUrl(sourceUrl, 'Registry source URL').href;
  check(json && typeof json === 'object' && !Array.isArray(json), 400, 'Registry index must be a JSON object');

  // Format 1: ProkBot Market v1
  if (json.schemaVersion === 1 && Array.isArray(json.bots)) {
    check(json.bots.length <= MAX_INDEX_ITEMS, 400, 'Registry index exceeds maximum item limit');
    const seenSlugs = new Set();
    const bots = [];
    for (const entry of json.bots) {
      check(entry && typeof entry === 'object' && !Array.isArray(entry), 400, 'Invalid bot entry in index');
      const slug = String(entry.slug ?? entry.id ?? '').trim();
      check(SLUG_RE.test(slug) && !slug.includes('..'), 400, `Invalid bot slug in index: ${slug}`);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      const packageUrl = entry.packageUrl ? resolveIndexItemUrl(entry.packageUrl, baseUrl) : '';
      const inlineRecipe = entry.recipe ? forceSafeBotRecipe(entry.recipe) : null;
      check(packageUrl || inlineRecipe, 400, `Bot "${slug}" must provide packageUrl or inline recipe`);

      let sha256 = '';
      if (entry.sha256 != null && entry.sha256 !== '') {
        check(
          typeof entry.sha256 === 'string' && SHA256_RE.test(entry.sha256.trim()),
          400,
          `Invalid sha256 for bot "${slug}"`,
        );
        sha256 = entry.sha256.trim().toLowerCase();
      }

      const name = normalizeLocalizedField(entry.name, inlineRecipe?.profile.name || slug);
      const tagline = normalizeLocalizedField(
        entry.tagline,
        inlineRecipe?.profile.title || (typeof name === 'string' ? name : slug),
      );
      const description = normalizeLocalizedField(entry.description, tagline);
      const rawShape = typeof entry.avatarShape === 'string' ? entry.avatarShape.trim() : '';
      const rawColor = typeof entry.avatarColor === 'string' ? entry.avatarColor.trim().toLowerCase() : '';

      bots.push({
        slug,
        version: cleanOptionalLine(entry.version, 40) || '1.0.0',
        category: mapExternalCategory(entry.category),
        name,
        tagline,
        description,
        author: cleanOptionalLine(entry.author, 100),
        license: cleanOptionalLine(entry.license, 80),
        tags: normalizeTags(entry.tags),
        avatarShape: AVATAR_TOKEN_RE.test(rawShape) ? rawShape : 'blob',
        avatarColor: AVATAR_TOKEN_RE.test(rawColor) ? rawColor : pickAvatarColor(slug),
        requiredApps: Array.isArray(entry.requiredApps)
          ? entry.requiredApps.map((a) => cleanLine(a, 64)).filter(Boolean)
          : [],
        optionalApps: Array.isArray(entry.optionalApps)
          ? entry.optionalApps.map((a) => cleanLine(a, 64)).filter(Boolean)
          : [],
        skillsCount: inlineRecipe
          ? inlineRecipe.skills.length
          : Number.isInteger(entry.skillsCount) && entry.skillsCount >= 0
            ? entry.skillsCount
            : 0,
        routinesCount: inlineRecipe
          ? inlineRecipe.routines.length
          : Number.isInteger(entry.routinesCount) && entry.routinesCount >= 0
            ? entry.routinesCount
            : 0,
        packageUrl,
        sha256,
        recipe: inlineRecipe,
      });
    }
    return {
      format: 'prokbot-v1',
      name: cleanOptionalLine(json.name || json.registryName, 100),
      bots,
    };
  }

  // Format 2: LobeChat Agents index (lobehub/lobe-chat-agents)
  if (Array.isArray(json.agents)) {
    const urlPath = new URL(baseUrl).pathname;
    const localeSuffixMatch = /\/index\.([a-z]{2}(?:-[A-Za-z0-9]{2,4})?)\.json$/i.exec(urlPath);
    const localeSuffix = localeSuffixMatch ? `.${localeSuffixMatch[1]}` : '';

    const seenSlugs = new Set();
    const bots = [];
    for (const entry of json.agents.slice(0, MAX_INDEX_ITEMS)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rawId = String(entry.identifier ?? entry.slug ?? entry.id ?? '').trim();
      if (!SLUG_RE.test(rawId) || rawId.includes('..')) continue;
      if (seenSlugs.has(rawId)) continue;
      seenSlugs.add(rawId);

      const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
      const explicitRef = entry.packageUrl || entry.url || entry.file || '';
      const packageUrl = explicitRef
        ? resolveIndexItemUrl(explicitRef, baseUrl)
        : resolveIndexItemUrl(`${rawId}${localeSuffix}.json`, baseUrl);

      const name = cleanLine(meta.title || meta.name || rawId, 100) || rawId;
      const tagline = cleanLine(meta.description || name, 200) || name;
      let inlineRecipe = null;
      if (typeof entry.config?.systemRole === 'string' && entry.config.systemRole.trim()) {
        try {
          inlineRecipe = forceSafeBotRecipe({
            profile: {
              name,
              title: tagline,
              description: cleanMultiline(entry.config.systemRole, 30_000),
              avatarShape: 'blob',
              avatarColor: pickAvatarColor(rawId),
            },
            memory: [],
            skills: [],
            routines: [],
            plugins: [],
          });
        } catch {
          continue;
        }
      }

      bots.push({
        slug: rawId,
        version: cleanOptionalLine(entry.version, 40) || '1.0.0',
        category: mapExternalCategory(meta.category || entry.category),
        name,
        tagline,
        description: tagline,
        author: cleanOptionalLine(entry.author, 100),
        license: cleanOptionalLine(entry.license, 80),
        tags: normalizeTags(meta.tags),
        avatarShape: 'blob',
        avatarColor: pickAvatarColor(rawId),
        requiredApps: [],
        optionalApps: [],
        skillsCount: 0,
        routinesCount: 0,
        packageUrl,
        sha256: '',
        recipe: inlineRecipe,
      });
    }
    return {
      format: 'lobe-chat-index',
      name: cleanOptionalLine(json.name, 100) || 'LobeChat Agents',
      bots,
    };
  }

  check(false, 400, 'Unsupported Bot Market registry index format');
}

function toRegistrySlug(raw) {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+/g, '-')
    .replace(/[-_]+$/, '')
    .slice(0, 64);
  return REGISTRY_SLUG_RE.test(cleaned) ? cleaned : 'bot-template';
}

function toSemver(raw) {
  const s = String(raw ?? '').trim().replace(/^v/i, '');
  if (SEMVER_RE.test(s)) return s;
  if (/^\d+$/.test(s)) {
    return `${Math.max(1, Number.parseInt(s, 10))}.0.0`;
  }
  const twoPart = /^(\d+)\.(\d+)$/.exec(s);
  if (twoPart) {
    return `${Number.parseInt(twoPart[1], 10)}.${Number.parseInt(twoPart[2], 10)}.0`;
  }
  return '1.0.0';
}

export class BotMarket {
  constructor(
    dataDir,
    {
      sharing,
      applications,
      connectors,
      federation = null,
      fetchImpl = globalThis.fetch,
      dnsLookup,
      now = Date.now,
    } = {},
  ) {
    this.dataDir = dataDir;
    this.sharing = sharing;
    this.applications = applications;
    this.connectors = connectors;
    this.federation = federation;
    this.fetchImpl = fetchImpl;
    this.dnsLookup = dnsLookup;
    this.now = now;
    this.store = new JsonStore(join(dataDir, 'bot-market.json'), {
      version: 1,
      sources: [],
      installed: [],
    });
    this.cache = new Map();
    this.federationCache = new Map();
    this.localKey = null;
  }

  setFederation(federation) {
    this.federation = federation ?? null;
    this.federationCache.clear();
  }

  fetchNetworkOptions(extra = {}) {
    return {
      fetchImpl: this.fetchImpl,
      ...(this.dnsLookup !== undefined ? { dnsLookup: this.dnsLookup } : {}),
      ...extra,
    };
  }

  async load() {
    await this.store.load();
    if (!Array.isArray(this.store.value.sources)) this.store.value.sources = [];
    if (!Array.isArray(this.store.value.installed)) this.store.value.installed = [];
    return this;
  }

  async ensureLocalKey() {
    if (this.localKey) return this.localKey;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const keyFile = join(this.dataDir, 'bot-market.key');
    try {
      this.localKey = await readFile(keyFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.localKey = randomBytes(32);
      try {
        await writeFile(keyFile, this.localKey, { flag: 'wx', mode: 0o600 });
      } catch (writeErr) {
        if (writeErr.code !== 'EEXIST') throw writeErr;
        this.localKey = await readFile(keyFile);
      }
    }
    check(this.localKey.length === 32, 500, 'Invalid Bot Market encryption key');
    return this.localKey;
  }

  async sealToken(token) {
    if (!token) return null;
    if (typeof this.connectors?.store?.seal === 'function') {
      return { engine: 'connectors', payload: this.connectors.store.seal(token) };
    }
    const key = await this.ensureLocalKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(token)), cipher.final()]);
    return {
      engine: 'local',
      payload: {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      },
    };
  }

  async unsealToken(sealed) {
    if (!sealed) return '';
    if (sealed.engine === 'connectors' && typeof this.connectors?.store?.unseal === 'function') {
      return String(this.connectors.store.unseal(sealed.payload) ?? '');
    }
    if (!sealed.engine && sealed.iv && sealed.tag && sealed.data) {
      if (typeof this.connectors?.store?.unseal === 'function') {
        return String(this.connectors.store.unseal(sealed) ?? '');
      }
    }
    const payload = sealed.payload ?? sealed;
    const key = await this.ensureLocalKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]);
    return String(JSON.parse(plain.toString('utf8')) ?? '');
  }

  resolveDependencies(requiredApps = [], optionalApps = [], locale = 'zh-CN', fallbackNames = null) {
    const installedApps = this.applications?.list?.() ?? [];
    const byId = new Map(installedApps.map((app) => [app.id, app]));
    const seen = new Set();
    const deps = [];

    const add = (appId, required) => {
      if (!appId || seen.has(appId)) return;
      seen.add(appId);
      const app = byId.get(appId);
      const fallbackMeta = APP_CATALOG_META[appId];
      const fallbackName = fallbackNames?.get?.(appId) || appId;
      const name = pickLocalized(app?.name ?? fallbackMeta?.name, fallbackName, locale);
      const category = app?.category ?? fallbackMeta?.category ?? 'Host';
      const connected = Boolean(
        app &&
          app.enabled !== false &&
          app.installed &&
          (app.auth?.type === 'none' || app.hasCredential || app.auth?.hasCredential),
      );
      deps.push({ appId, name, required, connected, category });
    };

    for (const appId of requiredApps) add(appId, true);
    for (const appId of optionalApps) add(appId, false);
    return deps;
  }

  resolveShareDependencies(
    recipe,
    shareDeps = [],
    locale = 'zh-CN',
    requiredApps = [],
    extraOptionalApps = [],
  ) {
    const fallbackNames = new Map();
    for (const plugin of recipe?.plugins ?? []) {
      if (plugin?.pluginId && plugin?.name && !fallbackNames.has(plugin.pluginId)) {
        fallbackNames.set(plugin.pluginId, plugin.name);
      }
    }
    for (const dep of shareDeps ?? []) {
      if (dep?.pluginId && dep?.name && !fallbackNames.has(dep.pluginId)) {
        fallbackNames.set(dep.pluginId, dep.name);
      }
    }
    const optionalApps = [
      ...(extraOptionalApps ?? []),
      ...(recipe?.plugins ?? []).map((p) => p.pluginId),
      ...(shareDeps ?? []).map((d) => d.pluginId),
    ].filter(Boolean);
    return this.resolveDependencies(requiredApps, optionalApps, locale, fallbackNames);
  }

  installedCounts() {
    const counts = new Map();
    for (const rec of this.store.value.installed ?? []) {
      if (!rec.templateId) continue;
      counts.set(rec.templateId, (counts.get(rec.templateId) || 0) + 1);
    }
    return counts;
  }

  categoryLabel(categoryId, locale) {
    const cat = CATEGORY_MAP.get(categoryId);
    return cat ? pickLocalized(cat.label, categoryId, locale) : categoryId;
  }

  publicSource(src) {
    return {
      id: src.id,
      name: src.name,
      url: src.url,
      enabled: src.enabled !== false,
      hasToken: Boolean(src.token),
      format: src.format || '',
      botCount: Number(src.botCount ?? 0),
      lastSyncAt: src.lastSyncAt ?? null,
      lastError: src.lastError ?? null,
      createdAt: src.createdAt ?? null,
    };
  }

  listSources() {
    return (this.store.value.sources ?? []).map((src) => this.publicSource(src));
  }

  async fetchSourceIndex(source, { force = false } = {}) {
    const cached = this.cache.get(source.id);
    if (!force && cached && this.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }
    const token = await this.unsealToken(source.token);
    const { bytes, finalUrl } = await safeFetchBytes(
      source.url,
      this.fetchNetworkOptions({
        token,
        maxBytes: MAX_TEXT_BYTES,
        accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
      }),
    );
    let json;
    try {
      json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new HttpError(400, 'Remote registry did not return valid JSON');
    }
    const parsed = parseRegistryIndex(json, finalUrl || source.url);
    const entry = {
      fetchedAt: this.now(),
      format: parsed.format,
      indexName: parsed.name,
      bots: parsed.bots,
    };
    if ((this.store.value.sources ?? []).some((s) => s.id === source.id)) {
      this.cache.set(source.id, entry);
    }
    return entry;
  }

  async recordSourceStatus(sourceId, patch) {
    try {
      await this.store.mutate((state) => {
        const target = state.sources.find((s) => s.id === sourceId);
        if (!target) return;
        Object.assign(target, patch);
      });
    } catch {
      const target = this.store.value.sources.find((s) => s.id === sourceId);
      if (target) Object.assign(target, patch);
    }
  }

  buildBuiltinItem(tpl, locale, counts) {
    const id = `builtin:${tpl.id}`;
    const recipe = tpl.buildRecipe(locale);
    const zh = normalizeLocaleTag(locale).startsWith('zh');
    return {
      id,
      slug: tpl.id,
      sourceType: 'builtin',
      sourceId: 'builtin',
      sourceName: zh ? '内置精选' : 'Built-in',
      version: tpl.version,
      category: tpl.category,
      categoryLabel: this.categoryLabel(tpl.category, locale),
      name: pickLocalized(tpl.name, tpl.id, locale),
      tagline: pickLocalized(tpl.tagline, '', locale),
      description: pickLocalized(tpl.description, '', locale),
      author: tpl.author,
      license: tpl.license,
      tags: [...tpl.tags],
      avatarShape: tpl.avatarShape,
      avatarColor: tpl.avatarColor,
      skillsCount: recipe.skills.length,
      routinesCount: recipe.routines.length,
      dependencies: this.resolveDependencies(tpl.requiredApps, tpl.optionalApps, locale),
      installedCount: counts.get(id) || 0,
    };
  }

  buildLocalItems(locale, counts) {
    const shared = this.sharing?.list?.() ?? [];
    const zh = normalizeLocaleTag(locale).startsWith('zh');
    const out = [];
    for (const item of shared) {
      if (item.kind !== 'bot' || item.published !== true || item.activeVersion == null) continue;
      const shareId = String(item.shareId || item.id || '').trim();
      if (!shareId || !ITEM_ID_RE.test(`local:${shareId}`) || shareId.includes('..')) continue;
      let details;
      try {
        details = this.sharing?.details?.(shareId, item.activeVersion);
      } catch {
        continue;
      }
      if (
        !details ||
        details.kind !== 'bot' ||
        details.published !== true ||
        details.activeVersion == null ||
        details.immutable !== true ||
        !details.package?.content
      ) {
        continue;
      }
      let recipe;
      try {
        recipe = forceSafeBotRecipe(details.package.content);
      } catch {
        continue;
      }
      const shareDeps = Array.isArray(details.package.dependencies)
        ? details.package.dependencies
        : recipeToShareDependencies(recipe);
      const id = `local:${shareId}`;
      const profile = recipe.profile;
      out.push({
        id,
        slug: shareId,
        sourceType: 'local',
        sourceId: 'local',
        sourceName: zh ? '本机分享' : 'Local Sharing',
        version: String(item.activeVersion),
        category: 'productivity',
        categoryLabel: this.categoryLabel('productivity', locale),
        name: profile.name || shareId,
        tagline: profile.title || profile.name || '',
        description: profile.title || profile.name || '',
        author: this.sharing?.hostName?.() || 'Local Host',
        license: 'Local',
        tags: ['local-share'],
        avatarShape: AVATAR_TOKEN_RE.test(profile.avatarShape || '') ? profile.avatarShape : 'blob',
        avatarColor: AVATAR_TOKEN_RE.test(profile.avatarColor || '')
          ? profile.avatarColor
          : pickAvatarColor(shareId),
        skillsCount: recipe.skills.length,
        routinesCount: recipe.routines.length,
        dependencies: this.resolveShareDependencies(recipe, shareDeps, locale),
        installedCount: counts.get(id) || 0,
      });
    }
    return out;
  }

  buildRemoteItem(src, bot, locale, counts, fallbackNames = null) {
    const id = `remote:${src.id}:${bot.slug}`;
    const name = pickLocalized(bot.name, bot.slug, locale);
    const tagline = pickLocalized(bot.tagline, name, locale);
    const description = pickLocalized(bot.description, tagline, locale);
    return {
      id,
      slug: bot.slug,
      sourceType: 'remote',
      sourceId: src.id,
      sourceName: src.name,
      version: bot.version || '1.0.0',
      category: bot.category,
      categoryLabel: this.categoryLabel(bot.category, locale),
      name,
      tagline,
      description,
      author: bot.author || src.name,
      license: bot.license || '',
      tags: [...(bot.tags ?? [])],
      avatarShape: bot.avatarShape || 'blob',
      avatarColor: bot.avatarColor || pickAvatarColor(bot.slug),
      skillsCount: bot.skillsCount ?? 0,
      routinesCount: bot.routinesCount ?? 0,
      dependencies: this.resolveDependencies(bot.requiredApps, bot.optionalApps, locale, fallbackNames),
      installedCount: counts.get(id) || 0,
    };
  }

  listPublishedForFederation() {
    const shared = this.sharing?.list?.() ?? [];
    const out = [];
    for (const item of shared) {
      if (out.length >= MAX_FEDERATION_ITEMS) break;
      if (item.kind !== 'bot' || item.published !== true || item.activeVersion == null) continue;
      const shareId = String(item.shareId || item.id || '').trim();
      if (!shareId || !SHARE_ID_RE.test(shareId) || shareId.includes('..')) continue;
      let details;
      try {
        details = this.sharing?.details?.(shareId, item.activeVersion);
      } catch {
        continue;
      }
      if (
        !details ||
        details.kind !== 'bot' ||
        details.published !== true ||
        details.activeVersion == null ||
        details.immutable !== true ||
        !details.package?.content
      ) {
        continue;
      }
      let recipe;
      try {
        recipe = forceSafeBotRecipe(details.package.content);
      } catch {
        continue;
      }
      const shareDeps = Array.isArray(details.package.dependencies)
        ? details.package.dependencies
        : recipeToShareDependencies(recipe);
      const optionalApps = [
        ...new Set(
          [
            ...(recipe.plugins ?? []).map((p) => p.pluginId),
            ...(shareDeps ?? []).map((d) => d.pluginId),
          ].filter(Boolean),
        ),
      ];
      const profile = recipe.profile;
      const entry = {
        shareId,
        version: String(item.activeVersion),
        name: cleanLine(profile.name || shareId, 100) || shareId,
        tagline: cleanLine(profile.title || profile.name || '', 200),
        description: cleanLine(profile.title || profile.name || '', 500),
        category: 'productivity',
        author: cleanLine(this.sharing?.hostName?.() || 'Peer Host', 100),
        license: 'Federation',
        tags: ['federation-share'],
        avatarShape: AVATAR_TOKEN_RE.test(profile.avatarShape || '') ? profile.avatarShape : 'blob',
        avatarColor: AVATAR_TOKEN_RE.test(profile.avatarColor || '')
          ? profile.avatarColor
          : pickAvatarColor(shareId),
        skillsCount: recipe.skills.length,
        routinesCount: recipe.routines.length,
        requiredApps: [],
        optionalApps,
        digest: typeof details.digest === 'string' ? details.digest : '',
        updatedAt: Number.isSafeInteger(item.updatedAtMs) ? item.updatedAtMs : null,
      };
      try {
        assertSafeMarketText(JSON.stringify(entry), `federation share ${shareId}`);
        assertSafeMarketText(JSON.stringify(recipe), `federation recipe ${shareId}`);
      } catch {
        continue;
      }
      out.push(entry);
    }
    return out;
  }

  readPublishedPackageForFederation(shareId) {
    check(typeof shareId === 'string' && SHARE_ID_RE.test(shareId), 400, 'Invalid share ID');
    check(this.sharing, 503, 'Local sharing service unavailable');
    const summary = (this.sharing.list?.() ?? []).find(
      (entry) => (entry.shareId || entry.id) === shareId,
    );
    check(
      summary && summary.kind === 'bot' && summary.published === true && summary.activeVersion != null,
      404,
      'Shared Bot not found',
    );
    const details = this.sharing.details(shareId, summary.activeVersion);
    check(
      details &&
        details.kind === 'bot' &&
        details.published === true &&
        details.activeVersion != null &&
        details.immutable === true &&
        details.package?.content,
      404,
      'Shared Bot not found',
    );
    const recipe = forceSafeBotRecipe(details.package.content);
    const shareDeps = Array.isArray(details.package.dependencies)
      ? details.package.dependencies
      : recipeToShareDependencies(recipe);
    const sharePkg = {
      schemaVersion: 1,
      kind: 'bot',
      content: recipe,
      dependencies: shareDeps,
    };
    assertSafeMarketText(JSON.stringify(sharePkg), `federation package ${shareId}`);
    const bytes = packShare(sharePkg);
    check(bytes.length <= MAX_ZIP_BYTES, 413, 'Shared Bot package exceeds size limit');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      shareId,
      bytes,
      sha256,
      filename: `bot-${shareId}-v${summary.activeVersion}.zip`,
    };
  }

  federationMarketProvider() {
    return {
      listPublished: () => this.listPublishedForFederation(),
      readPackage: (shareId) => this.readPublishedPackageForFederation(shareId),
    };
  }

  buildFederationItem(
    peer,
    hostName,
    entry,
    locale,
    counts,
    fallbackNames = null,
    { useFullPeerId = false } = {},
  ) {
    const peerKey = useFullPeerId ? peer.id : peer.id.slice(0, 12);
    const id = `fed:${peerKey}:${entry.shareId}`;
    const cat = mapExternalCategory(entry.category);
    const displayHost = cleanLine(hostName || peer.name || 'Peer Host', 100) || 'Peer Host';
    return {
      id,
      slug: entry.shareId,
      sourceType: 'federation',
      sourceId: `fed:${peerKey}`,
      sourceName: displayHost,
      peerId: peer.id,
      peerName: displayHost,
      version: cleanOptionalLine(entry.version, 40) || '1',
      category: cat,
      categoryLabel: this.categoryLabel(cat, locale),
      name: cleanLine(entry.name || entry.shareId, 100) || entry.shareId,
      tagline: cleanLine(entry.tagline || entry.name || '', 200),
      description: cleanLine(entry.description || entry.tagline || entry.name || '', 500),
      author: cleanOptionalLine(entry.author, 100) || displayHost,
      license: cleanOptionalLine(entry.license, 80) || 'Federation',
      tags: normalizeTags(entry.tags?.length ? entry.tags : ['federation-share']),
      avatarShape: AVATAR_TOKEN_RE.test(entry.avatarShape || '') ? entry.avatarShape : 'blob',
      avatarColor: AVATAR_TOKEN_RE.test(entry.avatarColor || '')
        ? entry.avatarColor
        : pickAvatarColor(entry.shareId),
      skillsCount: Number.isInteger(entry.skillsCount) && entry.skillsCount >= 0 ? entry.skillsCount : 0,
      routinesCount:
        Number.isInteger(entry.routinesCount) && entry.routinesCount >= 0 ? entry.routinesCount : 0,
      dependencies: this.resolveDependencies(
        entry.requiredApps ?? [],
        entry.optionalApps ?? [],
        locale,
        fallbackNames,
      ),
      installedCount: counts.get(id) || 0,
    };
  }

  async fetchFederationPeerCatalog(peer, { force = false } = {}) {
    const cached = this.federationCache.get(peer.id);
    if (!force && cached && this.now() - cached.fetchedAt < FEDERATION_CACHE_TTL_MS) {
      return cached;
    }
    const res = await this.federation.fetchPeerMarketList(peer.id);
    const entry = {
      fetchedAt: this.now(),
      hostName: res.hostName || peer.name || 'Peer Host',
      peerName: peer.name || res.hostName || 'Peer Host',
      items: res.items ?? [],
    };
    const stillEnabled = (this.federation?.enabledPeers?.() ?? []).some((p) => p.id === peer.id);
    if (stillEnabled) {
      this.federationCache.set(peer.id, entry);
    }
    return entry;
  }

  async list({ locale = 'zh-CN', category = '', query = '', source = '', refresh = false } = {}) {
    const counts = this.installedCounts();
    const items = [];

    for (const tpl of BUILTIN_BOT_TEMPLATES) {
      items.push(this.buildBuiltinItem(tpl, locale, counts));
    }

    items.push(...this.buildLocalItems(locale, counts));

    for (const src of this.store.value.sources ?? []) {
      if (src.enabled === false) continue;
      const hadCache = !refresh && this.cache.has(src.id) && this.now() - this.cache.get(src.id).fetchedAt < CACHE_TTL_MS;
      try {
        const idx = await this.fetchSourceIndex(src, { force: Boolean(refresh) });
        if (!hadCache) {
          await this.recordSourceStatus(src.id, {
            format: idx.format,
            botCount: idx.bots.length,
            lastSyncAt: idx.fetchedAt,
            lastError: null,
          });
        }
        for (const bot of idx.bots) {
          items.push(this.buildRemoteItem(src, bot, locale, counts));
        }
      } catch (error) {
        if (refresh) {
          this.cache.delete(src.id);
        }
        const message = error?.message || 'Failed to sync remote source';
        await this.recordSourceStatus(src.id, { lastError: message });
      }
    }

    if (this.federation && typeof this.federation.enabledPeers === 'function') {
      const peers = this.federation.enabledPeers();
      const activeIds = new Set(peers.map((p) => p.id));
      for (const cachedPeerId of this.federationCache.keys()) {
        if (!activeIds.has(cachedPeerId)) {
          this.federationCache.delete(cachedPeerId);
        }
      }
      const prefixCounts = new Map();
      for (const peer of peers) {
        const prefix = peer.id.slice(0, 12);
        prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
      }
      const peerResults = await Promise.all(
        peers.map(async (peer) => {
          try {
            const catalog = await this.fetchFederationPeerCatalog(peer, { force: Boolean(refresh) });
            return { peer, catalog };
          } catch {
            const cached = this.federationCache.get(peer.id);
            if (refresh || (cached && this.now() - cached.fetchedAt >= FEDERATION_CACHE_TTL_MS)) {
              this.federationCache.delete(peer.id);
            }
            return null;
          }
        }),
      );
      for (const entry of peerResults) {
        if (!entry) continue;
        const useFullPeerId = (prefixCounts.get(entry.peer.id.slice(0, 12)) || 0) > 1;
        for (const bot of entry.catalog.items) {
          items.push(
            this.buildFederationItem(entry.peer, entry.catalog.hostName, bot, locale, counts, null, {
              useFullPeerId,
            }),
          );
        }
      }
    }

    const catFilter = String(category || '').trim().toLowerCase();
    const sourceFilter = String(source || '').trim();
    const queryFilter = String(query || '').trim().toLowerCase();

    const filtered = items.filter((item) => {
      if (catFilter && catFilter !== 'all' && item.category !== catFilter) return false;
      if (
        sourceFilter &&
        sourceFilter !== 'all' &&
        item.sourceType !== sourceFilter &&
        item.sourceId !== sourceFilter
      ) {
        return false;
      }
      if (queryFilter) {
        const haystack = [
          item.name,
          item.tagline,
          item.description,
          item.slug,
          item.author,
          item.categoryLabel,
          ...(item.tags ?? []),
          ...(item.dependencies ?? []).map((d) => `${d.appId} ${d.name}`),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(queryFilter)) return false;
      }
      return true;
    });

    return {
      categories: BOT_MARKET_CATEGORIES.map((cat) => ({
        id: cat.id,
        label: pickLocalized(cat.label, cat.id, locale),
      })),
      items: filtered,
      sources: this.listSources(),
      installed: [...(this.store.value.installed ?? [])].reverse(),
      githubExamples: CURATED_GITHUB_EXAMPLES.map((ex) => ({
        repo: ex.repo,
        url: ex.url,
        formats: [...ex.formats],
        name: pickLocalized(ex.name, ex.repo, locale),
        description: pickLocalized(ex.description, '', locale),
      })),
    };
  }

  async resolveTemplateInternal(itemId, { locale = 'zh-CN' } = {}) {
    check(
      typeof itemId === 'string' && ITEM_ID_RE.test(itemId) && !itemId.includes('..'),
      400,
      'Invalid Bot Market item ID',
    );
    const counts = this.installedCounts();

    if (itemId.startsWith('builtin:')) {
      const slug = itemId.slice('builtin:'.length);
      const tpl = BUILTIN_MAP.get(slug);
      check(tpl, 404, 'Built-in Bot template not found');
      const recipe = tpl.buildRecipe(locale);
      const item = this.buildBuiltinItem(tpl, locale, counts);
      const shareDeps = recipeToShareDependencies(recipe);
      const pkg = normalizeSharePackage({
        schemaVersion: 1,
        kind: 'bot',
        content: recipe,
        dependencies: shareDeps,
      });
      return { item, recipe, shareDeps, digest: shareDigest(pkg) };
    }

    if (itemId.startsWith('local:')) {
      check(this.sharing, 404, 'Local sharing service unavailable');
      const shareId = itemId.slice('local:'.length);
      const summary = (this.sharing.list?.() ?? []).find(
        (entry) => (entry.shareId || entry.id) === shareId,
      );
      check(
        summary && summary.kind === 'bot' && summary.published === true && summary.activeVersion != null,
        404,
        'Shared Bot not found',
      );
      const details = this.sharing.details(shareId, summary.activeVersion);
      check(
        details &&
          details.kind === 'bot' &&
          details.published === true &&
          details.activeVersion != null &&
          details.immutable === true &&
          details.package?.content,
        404,
        'Shared Bot not found',
      );
      const recipe = forceSafeBotRecipe(details.package.content);
      const shareDeps = Array.isArray(details.package.dependencies)
        ? details.package.dependencies
        : recipeToShareDependencies(recipe);
      const pkg = normalizeSharePackage({
        schemaVersion: 1,
        kind: 'bot',
        content: recipe,
        dependencies: shareDeps,
      });
      const zh = normalizeLocaleTag(locale).startsWith('zh');
      const item = {
        id: itemId,
        slug: shareId,
        sourceType: 'local',
        sourceId: 'local',
        sourceName: zh ? '本机分享' : 'Local Sharing',
        version: String(summary.activeVersion),
        category: 'productivity',
        categoryLabel: this.categoryLabel('productivity', locale),
        name: recipe.profile.name,
        tagline: recipe.profile.title,
        description: recipe.profile.title,
        author: this.sharing?.hostName?.() || 'Local Host',
        license: 'Local',
        tags: ['local-share'],
        avatarShape: AVATAR_TOKEN_RE.test(recipe.profile.avatarShape || '')
          ? recipe.profile.avatarShape
          : 'blob',
        avatarColor: AVATAR_TOKEN_RE.test(recipe.profile.avatarColor || '')
          ? recipe.profile.avatarColor
          : pickAvatarColor(shareId),
        skillsCount: recipe.skills.length,
        routinesCount: recipe.routines.length,
        dependencies: this.resolveShareDependencies(recipe, shareDeps, locale),
        installedCount: counts.get(itemId) || 0,
      };
      return { item, recipe, shareDeps, digest: shareDigest(pkg) };
    }

    if (itemId.startsWith('remote:')) {
      const rest = itemId.slice('remote:'.length);
      const sep = rest.indexOf(':');
      check(sep > 0 && sep < rest.length - 1, 400, 'Invalid remote Bot item ID');
      const sourceId = rest.slice(0, sep);
      const slug = rest.slice(sep + 1);
      const src = (this.store.value.sources ?? []).find((s) => s.id === sourceId);
      check(src, 404, 'Bot Market source not found');
      check(src.enabled !== false, 404, 'Bot Market source is disabled');

      const idx = await this.fetchSourceIndex(src);
      const bot = idx.bots.find((b) => b.slug === slug);
      check(bot, 404, 'Remote Bot template not found');

      let recipe;
      let shareDeps;
      if (bot.recipe) {
        recipe = forceSafeBotRecipe(bot.recipe);
        shareDeps = recipeToShareDependencies(recipe);
      } else {
        check(bot.packageUrl, 400, 'Remote Bot entry has no packageUrl');
        const sourceOrigin = new URL(src.url).origin;
        const packageOrigin = new URL(bot.packageUrl).origin;
        const token = sourceOrigin === packageOrigin ? await this.unsealToken(src.token) : '';
        const { bytes, finalUrl } = await safeFetchBytes(
          bot.packageUrl,
          this.fetchNetworkOptions({
            token,
            detectZipLimit: true,
          }),
        );
        if (bot.sha256) {
          const actual = createHash('sha256').update(bytes).digest('hex');
          check(
            actual === bot.sha256.toLowerCase(),
            409,
            'Remote Bot package SHA-256 checksum mismatch',
          );
        }
        const parsed = parseExternalBotContent(bytes, {
          sourceUrl: finalUrl || bot.packageUrl,
          locale,
        });
        recipe = parsed.recipe;
        shareDeps = Array.isArray(parsed.dependencies)
          ? parsed.dependencies
          : recipeToShareDependencies(recipe);
      }

      const pkg = normalizeSharePackage({
        schemaVersion: 1,
        kind: 'bot',
        content: recipe,
        dependencies: shareDeps,
      });
      const fallbackNames = new Map();
      for (const plugin of recipe.plugins ?? []) {
        if (plugin?.pluginId && plugin?.name && !fallbackNames.has(plugin.pluginId)) {
          fallbackNames.set(plugin.pluginId, plugin.name);
        }
      }
      for (const dep of shareDeps ?? []) {
        if (dep?.pluginId && dep?.name && !fallbackNames.has(dep.pluginId)) {
          fallbackNames.set(dep.pluginId, dep.name);
        }
      }
      const optionalApps = [
        ...(bot.optionalApps ?? []),
        ...(recipe.plugins ?? []).map((p) => p.pluginId),
        ...(shareDeps ?? []).map((d) => d.pluginId),
      ].filter(Boolean);
      const item = this.buildRemoteItem(
        src,
        {
          ...bot,
          optionalApps,
          skillsCount: recipe.skills.length,
          routinesCount: recipe.routines.length,
        },
        locale,
        counts,
        fallbackNames,
      );
      return { item, recipe, shareDeps, digest: shareDigest(pkg) };
    }

    if (itemId.startsWith('fed:')) {
      const match = FED_ITEM_RE.exec(itemId);
      check(match, 400, 'Invalid federated Bot item ID');
      const [, peerPrefix, shareId] = match;
      check(
        this.federation &&
          typeof this.federation.enabledPeers === 'function' &&
          typeof this.federation.fetchPeerMarketPackage === 'function',
        404,
        'Federation service unavailable',
      );
      const enabledPeers = this.federation.enabledPeers();
      const matchingPeers = enabledPeers.filter((p) => p.id.startsWith(peerPrefix));
      check(matchingPeers.length > 0, 404, 'Federated peer not found or disabled');
      check(matchingPeers.length === 1, 409, 'Ambiguous federated peer prefix');
      const peer = matchingPeers[0];
      const hasPrefixCollision =
        enabledPeers.filter((p) => p.id.startsWith(peer.id.slice(0, 12))).length > 1;
      const useFullPeerId = hasPrefixCollision || peerPrefix.length > 12;

      const pkgRes = await this.federation.fetchPeerMarketPackage(peer.id, shareId);
      check(pkgRes && Buffer.isBuffer(pkgRes.bytes) && pkgRes.bytes.length > 0, 502, 'Invalid federated Bot package');
      check(pkgRes.bytes.length <= MAX_ZIP_BYTES, 413, 'Federated Bot package exceeds size limit');
      const actualSha256 = createHash('sha256').update(pkgRes.bytes).digest('hex');
      check(
        typeof pkgRes.sha256 === 'string' && actualSha256 === pkgRes.sha256.trim().toLowerCase(),
        409,
        'Federated Bot package SHA-256 checksum mismatch',
      );

      const parsed = parseExternalBotContent(pkgRes.bytes, {
        sourceUrl: `federation://${peerPrefix}/${shareId}.zip`,
        locale,
      });
      check(parsed.format === 'prokbot-zip', 400, 'Federated Bot package must be a ProkBot ZIP');
      const recipe = forceSafeBotRecipe(parsed.recipe);
      const shareDeps = Array.isArray(parsed.dependencies) && parsed.dependencies.length > 0
        ? parsed.dependencies
        : recipeToShareDependencies(recipe);
      const pkg = normalizeSharePackage({
        schemaVersion: 1,
        kind: 'bot',
        content: recipe,
        dependencies: shareDeps,
      });

      const rawCachedPeer = this.federationCache.get(peer.id);
      const cachedPeer =
        rawCachedPeer && this.now() - rawCachedPeer.fetchedAt < FEDERATION_CACHE_TTL_MS
          ? rawCachedPeer
          : null;
      if (rawCachedPeer && !cachedPeer) {
        this.federationCache.delete(peer.id);
      }
      const cachedMeta = cachedPeer?.items?.find((entry) => entry.shareId === shareId) ?? null;
      const hostName = cachedPeer?.hostName || peer.name || 'Peer Host';

      const fallbackNames = new Map();
      for (const plugin of recipe.plugins ?? []) {
        if (plugin?.pluginId && plugin?.name && !fallbackNames.has(plugin.pluginId)) {
          fallbackNames.set(plugin.pluginId, plugin.name);
        }
      }
      for (const dep of shareDeps ?? []) {
        if (dep?.pluginId && dep?.name && !fallbackNames.has(dep.pluginId)) {
          fallbackNames.set(dep.pluginId, dep.name);
        }
      }
      const optionalApps = [
        ...new Set(
          [
            ...(cachedMeta?.optionalApps ?? []),
            ...(recipe.plugins ?? []).map((p) => p.pluginId),
            ...(shareDeps ?? []).map((d) => d.pluginId),
          ].filter(Boolean),
        ),
      ];
      const item = this.buildFederationItem(
        peer,
        hostName,
        {
          ...(cachedMeta ?? {}),
          shareId,
          name: recipe.profile.name,
          tagline: recipe.profile.title,
          description: recipe.profile.title,
          avatarShape: AVATAR_TOKEN_RE.test(recipe.profile.avatarShape || '')
            ? recipe.profile.avatarShape
            : cachedMeta?.avatarShape || 'blob',
          avatarColor: AVATAR_TOKEN_RE.test(recipe.profile.avatarColor || '')
            ? recipe.profile.avatarColor
            : cachedMeta?.avatarColor || pickAvatarColor(shareId),
          skillsCount: recipe.skills.length,
          routinesCount: recipe.routines.length,
          requiredApps: cachedMeta?.requiredApps ?? [],
          optionalApps,
        },
        locale,
        counts,
        fallbackNames,
        { useFullPeerId },
      );
      return { item, recipe, shareDeps, digest: shareDigest(pkg) };
    }

    check(false, 404, 'Bot template not found');
  }

  async exportRegistryEntry(itemId, { locale = 'zh-CN' } = {}) {
    const resolved = await this.resolveTemplateInternal(itemId, { locale });
    const recipe = forceSafeBotRecipe(resolved.recipe);
    const item = resolved.item;
    const builtinTpl = itemId.startsWith('builtin:')
      ? BUILTIN_MAP.get(itemId.slice('builtin:'.length))
      : null;

    const slug = builtinTpl
      ? toRegistrySlug(builtinTpl.id)
      : toRegistrySlug(item.slug || item.name);
    const version = toSemver(builtinTpl?.version || item.version || '1.0.0');
    const category = CATEGORY_MAP.has(builtinTpl?.category || item.category)
      ? builtinTpl?.category || item.category
      : 'productivity';

    const fallbackName = cleanLine(item.name || recipe.profile.name || slug, 100) || slug;
    const fallbackTagline =
      cleanLine(item.tagline || recipe.profile.title || fallbackName, 200) || fallbackName;
    const fallbackDesc =
      cleanLine(item.description || fallbackTagline, 2000) || fallbackTagline;

    const name = builtinTpl
      ? { 'zh-CN': cleanLine(builtinTpl.name['zh-CN'], 100), en: cleanLine(builtinTpl.name.en, 100) }
      : { 'zh-CN': fallbackName, en: fallbackName };
    const tagline = builtinTpl
      ? {
          'zh-CN': cleanLine(builtinTpl.tagline['zh-CN'], 200),
          en: cleanLine(builtinTpl.tagline.en, 200),
        }
      : { 'zh-CN': fallbackTagline, en: fallbackTagline };
    const description = builtinTpl
      ? {
          'zh-CN': cleanLine(builtinTpl.description['zh-CN'], 2000),
          en: cleanLine(builtinTpl.description.en, 2000),
        }
      : { 'zh-CN': fallbackDesc, en: fallbackDesc };

    const requiredApps = builtinTpl
      ? [...builtinTpl.requiredApps].filter((id) => REGISTRY_SLUG_RE.test(id))
      : [
          ...new Set(
            (item.dependencies ?? [])
              .filter((d) => d.required && REGISTRY_SLUG_RE.test(String(d.appId || '')))
              .map((d) => d.appId),
          ),
        ];
    const requiredSet = new Set(requiredApps);
    const optionalApps = builtinTpl
      ? [...builtinTpl.optionalApps].filter((id) => REGISTRY_SLUG_RE.test(id) && !requiredSet.has(id))
      : [
          ...new Set(
            (item.dependencies ?? [])
              .filter((d) => !d.required && REGISTRY_SLUG_RE.test(String(d.appId || '')) && !requiredSet.has(d.appId))
              .map((d) => d.appId),
          ),
        ];

    const meta = {
      slug,
      version,
      category,
      name,
      tagline,
      description,
      author: cleanLine(builtinTpl?.author || item.author || 'Community', 100) || 'Community',
      license:
        cleanLine(builtinTpl?.license || item.license || 'ProkBot-Noncommercial-1.0', 80) ||
        'ProkBot-Noncommercial-1.0',
      tags: normalizeTags(builtinTpl?.tags ?? item.tags ?? []),
      avatarShape: AVATAR_TOKEN_RE.test(builtinTpl?.avatarShape || item.avatarShape || '')
        ? builtinTpl?.avatarShape || item.avatarShape
        : 'blob',
      avatarColor: AVATAR_TOKEN_RE.test(builtinTpl?.avatarColor || item.avatarColor || '')
        ? builtinTpl?.avatarColor || item.avatarColor
        : pickAvatarColor(slug),
      requiredApps,
      optionalApps,
    };

    assertSafeMarketText(JSON.stringify(meta), `${slug}/meta.json`);
    assertSafeMarketText(JSON.stringify(recipe), `${slug}/recipe.json`);

    const files = {
      [`bots/${slug}/meta.json`]: `${JSON.stringify(meta, null, 2)}\n`,
      [`bots/${slug}/recipe.json`]: `${JSON.stringify(recipe, null, 2)}\n`,
    };

    return { slug, meta, recipe, files };
  }

  async getTemplate(itemId, { locale = 'zh-CN' } = {}) {
    const { item, recipe, digest } = await this.resolveTemplateInternal(itemId, { locale });
    return {
      ...item,
      prompt: recipe.profile.description,
      skills: recipe.skills,
      routines: recipe.routines,
      digest,
    };
  }

  async downloadZip(itemId, { locale = 'zh-CN' } = {}) {
    const { item, recipe, shareDeps } = await this.resolveTemplateInternal(itemId, { locale });
    const bytes = packShare({
      schemaVersion: 1,
      kind: 'bot',
      content: recipe,
      dependencies: shareDeps,
    });
    const safeSlug = String(item.slug || 'bot')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'bot';
    const safeVersion = String(item.version || '1.0.0')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .slice(0, 24) || '1.0.0';
    return { bytes, name: `${safeSlug}-v${safeVersion}.zip` };
  }

  validateCustomName(customName) {
    if (customName == null || customName === '') return '';
    check(
      typeof customName === 'string' && !/[\x00-\x1f\x7f]/.test(customName),
      400,
      'Invalid custom Bot name',
    );
    const trimmed = customName.trim();
    check(trimmed.length <= 100, 400, 'Bot name must be 100 characters or fewer');
    return trimmed;
  }

  async recordInstall(record) {
    await this.store.mutate((state) => {
      if (!Array.isArray(state.installed)) state.installed = [];
      state.installed.push(record);
      if (state.installed.length > MAX_INSTALLED_HISTORY) {
        state.installed = state.installed.slice(-MAX_INSTALLED_HISTORY);
      }
    });
  }

  async installTemplate(itemId, { locale = 'zh-CN', customName = '' } = {}) {
    check(this.sharing, 503, 'Sharing service is unavailable');
    const resolved = await this.resolveTemplateInternal(itemId, { locale });
    const nextName = this.validateCustomName(customName);
    const finalRecipe = forceSafeBotRecipe({
      ...resolved.recipe,
      profile: {
        ...resolved.recipe.profile,
        ...(nextName ? { name: nextName } : {}),
      },
    });
    const pkg = normalizeSharePackage({
      schemaVersion: 1,
      kind: 'bot',
      content: finalRecipe,
      dependencies: resolved.shareDeps,
    });
    const digest = shareDigest(pkg);
    const bytes = packShare(pkg);
    const result = await this.sharing.import(bytes, {
      digest,
      importId: randomUUID(),
      memoryIndices: [],
    });

    await this.recordInstall({
      id: randomUUID(),
      botId: result.id,
      name: result.name,
      templateId: itemId,
      sourceType: resolved.item.sourceType,
      sourceId: resolved.item.sourceId,
      version: resolved.item.version,
      digest,
      installedAt: this.now(),
    });

    return {
      ok: true,
      id: result.id,
      name: result.name,
      templateId: itemId,
      routinesPaused: true,
      dependencies: resolved.item.dependencies,
    };
  }

  async previewUrlInternal(rawUrl, { locale = 'zh-CN' } = {}) {
    const normalizedUrl = normalizeGithubRawUrl(rawUrl);
    const { bytes, finalUrl } = await safeFetchBytes(
      normalizedUrl,
      this.fetchNetworkOptions({
        detectZipLimit: true,
      }),
    );
    const resolvedUrl = finalUrl || normalizedUrl;
    const parsed = parseExternalBotContent(bytes, { sourceUrl: resolvedUrl, locale });
    return { ...parsed, normalizedUrl, finalUrl: resolvedUrl };
  }

  async previewUrl(rawUrl, { locale = 'zh-CN' } = {}) {
    const parsed = await this.previewUrlInternal(rawUrl, { locale });
    return {
      format: parsed.format,
      normalizedUrl: parsed.normalizedUrl,
      name: parsed.name,
      title: parsed.title,
      description: parsed.description,
      prompt: parsed.prompt,
      author: parsed.author,
      tags: parsed.tags,
      skills: parsed.skills,
      routines: parsed.routines,
      dependencies: this.resolveShareDependencies(parsed.recipe, parsed.dependencies, locale),
      digest: parsed.digest,
    };
  }

  async installFromUrl(rawUrl, { locale = 'zh-CN', customName = '', expectedDigest = '' } = {}) {
    check(this.sharing, 503, 'Sharing service is unavailable');
    const preview = await this.previewUrlInternal(rawUrl, { locale });
    if (expectedDigest !== undefined && expectedDigest !== null && expectedDigest !== '') {
      check(
        typeof expectedDigest === 'string' &&
          expectedDigest.trim().toLowerCase() === preview.digest,
        409,
        'Remote Bot content changed since preview; please preview again',
      );
    }
    const nextName = this.validateCustomName(customName);
    const finalRecipe = forceSafeBotRecipe({
      ...preview.recipe,
      profile: {
        ...preview.recipe.profile,
        ...(nextName ? { name: nextName } : {}),
      },
    });
    const shareDeps = Array.isArray(preview.dependencies)
      ? preview.dependencies
      : recipeToShareDependencies(finalRecipe);
    const pkg = normalizeSharePackage({
      schemaVersion: 1,
      kind: 'bot',
      content: finalRecipe,
      dependencies: shareDeps,
    });
    const digest = shareDigest(pkg);
    const bytes = packShare(pkg);
    const result = await this.sharing.import(bytes, {
      digest,
      importId: randomUUID(),
      memoryIndices: [],
    });

    await this.recordInstall({
      id: randomUUID(),
      botId: result.id,
      name: result.name,
      templateId: null,
      sourceType: 'url',
      sourceUrl: preview.normalizedUrl,
      format: preview.format,
      digest,
      installedAt: this.now(),
    });

    return {
      ok: true,
      id: result.id,
      name: result.name,
      sourceUrl: preview.normalizedUrl,
      format: preview.format,
      routinesPaused: true,
      dependencies: this.resolveShareDependencies(finalRecipe, shareDeps, locale),
    };
  }

  async addSource({ name = '', url, token = '', enabled = true } = {}) {
    check(
      (this.store.value.sources ?? []).length < MAX_SOURCES,
      400,
      `At most ${MAX_SOURCES} Bot Market sources are allowed`,
    );
    const normalizedUrl = normalizeGithubRawUrl(url);
    check(
      !(this.store.value.sources ?? []).some((s) => s.url === normalizedUrl),
      409,
      'This Bot Market source URL is already registered',
    );
    check(typeof enabled === 'boolean', 400, 'Invalid enabled flag');
    if (name !== undefined && name !== null && name !== '') {
      check(
        typeof name === 'string' && !/[\x00-\x1f\x7f]/.test(name) && name.trim().length <= 100,
        400,
        'Invalid source name',
      );
    }
    const rawToken = typeof token === 'string' ? token.trim() : '';
    check(
      rawToken.length <= 4096 && !/[\0\r\n]/.test(rawToken),
      400,
      'Invalid source access token',
    );

    const { bytes, finalUrl } = await safeFetchBytes(
      normalizedUrl,
      this.fetchNetworkOptions({
        token: rawToken,
        maxBytes: MAX_TEXT_BYTES,
        accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
      }),
    );
    let json;
    try {
      json = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new HttpError(400, 'Registry source must return a valid JSON index');
    }
    const parsed = parseRegistryIndex(json, finalUrl || normalizedUrl);
    const resolvedName =
      (typeof name === 'string' ? name.trim() : '') ||
      parsed.name ||
      new URL(normalizedUrl).hostname;
    const sealedToken = rawToken ? await this.sealToken(rawToken) : null;
    const now = this.now();
    const record = {
      id: `src-${randomBytes(6).toString('hex')}`,
      name: resolvedName,
      url: normalizedUrl,
      enabled,
      token: sealedToken,
      format: parsed.format,
      botCount: parsed.bots.length,
      lastSyncAt: now,
      lastError: null,
      createdAt: now,
    };

    await this.store.mutate((state) => {
      if (!Array.isArray(state.sources)) state.sources = [];
      check(
        state.sources.length < MAX_SOURCES,
        400,
        `At most ${MAX_SOURCES} Bot Market sources are allowed`,
      );
      check(
        !state.sources.some((s) => s.url === normalizedUrl),
        409,
        'This Bot Market source URL is already registered',
      );
      state.sources.push(record);
    });

    if ((this.store.value.sources ?? []).some((s) => s.id === record.id)) {
      this.cache.set(record.id, {
        fetchedAt: now,
        format: parsed.format,
        indexName: parsed.name,
        bots: parsed.bots,
      });
    }

    return { source: this.publicSource(record), botCount: parsed.bots.length };
  }

  async updateSource(sourceId, { enabled, name } = {}) {
    check(typeof sourceId === 'string' && SOURCE_ID_RE.test(sourceId), 400, 'Invalid source ID');
    check(
      enabled !== undefined || name !== undefined,
      400,
      'Provide enabled or name to update source',
    );
    if (enabled !== undefined) {
      check(typeof enabled === 'boolean', 400, 'Invalid enabled value');
    }
    let trimmedName;
    if (name !== undefined) {
      check(
        typeof name === 'string' &&
          !/[\x00-\x1f\x7f]/.test(name) &&
          name.trim().length > 0 &&
          name.trim().length <= 100,
        400,
        'Invalid source name',
      );
      trimmedName = name.trim();
    }

    let updated;
    await this.store.mutate((state) => {
      const src = state.sources.find((s) => s.id === sourceId);
      check(src, 404, 'Bot Market source not found');
      if (enabled !== undefined) src.enabled = enabled;
      if (trimmedName !== undefined) src.name = trimmedName;
      updated = { ...src };
    });

    return { source: this.publicSource(updated) };
  }

  async removeSource(sourceId) {
    check(typeof sourceId === 'string' && SOURCE_ID_RE.test(sourceId), 400, 'Invalid source ID');
    await this.store.mutate((state) => {
      const index = state.sources.findIndex((s) => s.id === sourceId);
      check(index >= 0, 404, 'Bot Market source not found');
      state.sources.splice(index, 1);
    });
    this.cache.delete(sourceId);
    return { ok: true };
  }

  async refreshSource(sourceId) {
    check(typeof sourceId === 'string' && SOURCE_ID_RE.test(sourceId), 400, 'Invalid source ID');
    const src = (this.store.value.sources ?? []).find((s) => s.id === sourceId);
    check(src, 404, 'Bot Market source not found');
    this.cache.delete(sourceId);

    try {
      const idx = await this.fetchSourceIndex(src, { force: true });
      await this.recordSourceStatus(sourceId, {
        format: idx.format,
        botCount: idx.bots.length,
        lastSyncAt: idx.fetchedAt,
        lastError: null,
      });
      const latest = this.store.value.sources.find((s) => s.id === sourceId) ?? src;
      return { source: this.publicSource(latest), botCount: idx.bots.length };
    } catch (error) {
      await this.recordSourceStatus(sourceId, {
        lastError: error?.message || 'Refresh failed',
      });
      throw error;
    }
  }
}
