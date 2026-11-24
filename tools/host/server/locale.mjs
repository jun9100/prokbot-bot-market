// Request and Host system locale resolution for localized Connected Apps catalogs.
//
// Resolution priority for HTTP requests:
//   1. Explicit `x-grokbot-locale` header (or explicit `locale` option)
//   2. Standard HTTP `accept-language` header (q-weighted BCP-47 negotiation)
//   3. Host default locale (`GROKBOT_LOCALE` -> `LC_ALL`/`LC_MESSAGES`/`LANG` -> `TZ` Chinese timezones -> `en`)

const CHINESE_TIMEZONES = new Set([
  'asia/shanghai',
  'asia/chongqing',
  'asia/chungking',
  'asia/harbin',
  'asia/urumqi',
  'asia/kashgar',
  'asia/hong_kong',
  'asia/taipei',
  'asia/macau',
  'asia/macao',
  'prc',
  'roc',
  'hongkong',
]);

export function normalizeLocaleTag(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/_/g, '-').toLowerCase();
  if (!cleaned || cleaned === '*') return '';
  // Strip encoding/modifier suffixes like zh_CN.UTF-8 or C.UTF-8 or en_US@euro
  const tag = cleaned.split('.')[0].split('@')[0];
  if (!tag || tag === 'c' || tag === 'posix') return '';
  if (tag === 'zh' || tag.startsWith('zh-')) {
    if (/^zh-(tw|hk|mo|hant)\b/.test(tag)) return 'zh-TW';
    return 'zh-CN';
  }
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  return tag.split('-')[0];
}

export function parseAcceptLanguage(header) {
  if (typeof header !== 'string' || !header.trim()) return '';
  const entries = [];
  for (const part of header.split(',')) {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = normalizeLocaleTag(rawTag);
    if (!tag) continue;
    let q = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/i.exec(p.trim());
      if (m) {
        const parsed = Number(m[1]);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) q = parsed;
      }
    }
    if (q > 0) entries.push({ tag, q, index: entries.length });
  }
  entries.sort((a, b) => b.q - a.q || a.index - b.index);
  for (const entry of entries) {
    if (entry.tag === 'zh-CN' || entry.tag === 'zh-TW') return entry.tag;
    if (entry.tag === 'en') return 'en';
  }
  return entries[0]?.tag || '';
}

export function detectDefaultHostLocale(env = process.env) {
  const explicit = normalizeLocaleTag(env?.GROKBOT_LOCALE);
  if (explicit) return explicit;

  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const parsed = normalizeLocaleTag(env?.[key]);
    if (parsed) return parsed;
  }

  const tz = String(env?.TZ || '').trim().toLowerCase();
  if (tz && CHINESE_TIMEZONES.has(tz)) return 'zh-CN';

  try {
    const runtimeTz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim().toLowerCase();
    if (runtimeTz && CHINESE_TIMEZONES.has(runtimeTz)) return 'zh-CN';
  } catch {
    // Ignore Intl errors in stripped environments.
  }
  return 'en';
}

export function resolveRequestLocale(request, { fallback, env = process.env } = {}) {
  const headers = request?.headers ?? {};
  const explicit = normalizeLocaleTag(headers['x-grokbot-locale']);
  if (explicit) return explicit;

  const negotiated = parseAcceptLanguage(headers['accept-language']);
  if (negotiated) return negotiated;

  return fallback ? normalizeLocaleTag(fallback) || 'en' : detectDefaultHostLocale(env);
}

export function pickLocalized(value, fallback = '', locale = 'en') {
  if (typeof value === 'string') return value || fallback;
  if (!value || typeof value !== 'object') return fallback;
  const norm = normalizeLocaleTag(locale) || 'en';
  if (typeof value[norm] === 'string' && value[norm]) return value[norm];
  if (norm.startsWith('zh')) {
    if (typeof value['zh-CN'] === 'string' && value['zh-CN']) return value['zh-CN'];
    if (typeof value['zh-TW'] === 'string' && value['zh-TW']) return value['zh-TW'];
  }
  if (typeof value.en === 'string' && value.en) return value.en;
  for (const v of Object.values(value)) {
    if (typeof v === 'string' && v) return v;
  }
  return fallback;
}
