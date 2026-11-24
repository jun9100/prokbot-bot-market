// Shared Bot Market & Federation secret scanner enforcing zero credential leakage.
import { assertShareableText } from './sharing-package.mjs';
import { HttpError } from './security.mjs';

export const EXTRA_MARKET_SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._+/=-]{20,}/i,
  /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]{8,}/i,
  /\b(?:grokbot_admin|grokbot_web|grokbot_session|grokbot_vnc_(?:desktop|fork)|JSESSIONID|connect\.sid)=[A-Za-z0-9._+/=-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

export function assertSafeMarketText(text, label = 'content') {
  const str = String(text ?? '');
  assertShareableText(str);
  for (const pattern of EXTRA_MARKET_SECRET_PATTERNS) {
    if (pattern.test(str)) {
      throw new HttpError(400, `Secret or sensitive credential pattern detected in ${label}`);
    }
  }
}
