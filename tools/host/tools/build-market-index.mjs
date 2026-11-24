#!/usr/bin/env node
// Community Bot Market Registry Builder CLI for ProkBot Host2 (Stage 2).
//
// Zero-dependency ESM tool that validates a directory of declarative Bot folders
// (`<source>/<bot>/meta.json`, `recipe.json`, optional `skills/<name>/SKILL.md`),
// enforces secret scanning, zero-memory, and paused-routine guardrails, builds
// deterministic ProkBot Share v1 ZIP packages, and emits a ProkBot Market v1 `index.json`.
//
// Usage:
//   node host/tools/build-market-index.mjs \
//     --source <bots-dir> \
//     --output <dist-dir> \
//     [--base-url <url>] \
//     [--registry-name <name>] \
//     [--check]

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_CATALOG_META,
  BOT_MARKET_CATEGORIES,
} from '../server/bot-market-catalog.mjs';
import { parseRegistryIndex } from '../server/bot-market.mjs';
import { assertSafeMarketText } from '../server/market-secrets.mjs';
import { check, HttpError } from '../server/security.mjs';
import {
  normalizeRecipe,
  normalizeSharePackage,
  packShare,
  unpackShare,
} from '../server/sharing-package.mjs';

export { assertSafeMarketText };

const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SKILL_DIR_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const AVATAR_TOKEN_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VALID_CATEGORIES = new Set(BOT_MARKET_CATEGORIES.map((c) => c.id));
const FORBIDDEN_FILE_RE =
  /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:db|sqlite|sqlite3|key|p8|p12|pem|mobileprovision)|credentials?\.json|cookies?\.json)$/i;
const MAX_BOT_COUNT = 1000;
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_ZIP_BYTES = 10 * 1024 * 1024;

const DEFAULT_AVATAR_COLORS = [
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

function pickAvatarColor(seed) {
  let sum = 7;
  for (const ch of String(seed || 'bot')) {
    sum = (sum * 31 + ch.codePointAt(0)) >>> 0;
  }
  return DEFAULT_AVATAR_COLORS[sum % DEFAULT_AVATAR_COLORS.length];
}

function cleanLine(value, maxLen) {
  const s = String(value ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

function validateBilingualField(raw, fieldName, maxLen, botLabel) {
  check(
    raw && typeof raw === 'object' && !Array.isArray(raw),
    400,
    `${botLabel}: meta.${fieldName} must be a bilingual object with "zh-CN" and "en" strings`,
  );
  const zh = typeof raw['zh-CN'] === 'string' ? raw['zh-CN'].trim() : '';
  const en = typeof raw.en === 'string' ? raw.en.trim() : '';
  check(
    zh.length > 0 && zh.length <= maxLen && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(zh),
    400,
    `${botLabel}: meta.${fieldName}["zh-CN"] must be a non-empty string (<= ${maxLen} chars)`,
  );
  check(
    en.length > 0 && en.length <= maxLen && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(en),
    400,
    `${botLabel}: meta.${fieldName}.en must be a non-empty string (<= ${maxLen} chars)`,
  );
  const out = { 'zh-CN': zh, en };
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'zh-CN' || k === 'en') continue;
    if (typeof v === 'string' && v.trim() && v.trim().length <= maxLen) {
      out[k] = v.trim();
    }
  }
  return out;
}

function validateAppList(raw, fieldName, botLabel) {
  if (raw === undefined) return [];
  check(Array.isArray(raw) && raw.length <= 50, 400, `${botLabel}: meta.${fieldName} must be an array (<= 50 items)`);
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    check(
      typeof entry === 'string' && APP_ID_RE.test(entry.trim()),
      400,
      `${botLabel}: invalid app ID "${String(entry)}" in meta.${fieldName}`,
    );
    const id = entry.trim();
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function validateBotMeta(rawMeta, folderName) {
  check(
    rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta),
    400,
    `${folderName}: meta.json must be a JSON object`,
  );
  assertSafeMarketText(JSON.stringify(rawMeta), `${folderName}/meta.json`);
  const slug = typeof rawMeta.slug === 'string' ? rawMeta.slug.trim() : '';
  check(
    SLUG_RE.test(slug),
    400,
    `${folderName}: invalid slug "${slug}" (must match ${SLUG_RE})`,
  );
  const version = typeof rawMeta.version === 'string' ? rawMeta.version.trim() : '';
  check(
    version.length > 0 && version.length <= 64 && SEMVER_RE.test(version),
    400,
    `${slug}: invalid semver version "${version}"`,
  );
  const category = typeof rawMeta.category === 'string' ? rawMeta.category.trim().toLowerCase() : '';
  check(
    VALID_CATEGORIES.has(category),
    400,
    `${slug}: invalid category "${category}" (expected one of: ${[...VALID_CATEGORIES].join(', ')})`,
  );

  const name = validateBilingualField(rawMeta.name, 'name', 100, slug);
  const tagline = validateBilingualField(rawMeta.tagline, 'tagline', 200, slug);
  const description = validateBilingualField(rawMeta.description, 'description', 2000, slug);
  const requiredApps = validateAppList(rawMeta.requiredApps, 'requiredApps', slug);
  const optionalApps = validateAppList(rawMeta.optionalApps, 'optionalApps', slug);

  const requiredSet = new Set(requiredApps);
  const dedupedOptionalApps = optionalApps.filter((id) => !requiredSet.has(id));

  let tags = [];
  if (rawMeta.tags !== undefined) {
    check(Array.isArray(rawMeta.tags) && rawMeta.tags.length <= 20, 400, `${slug}: meta.tags must be an array (<= 20 items)`);
    const seen = new Set();
    for (const tag of rawMeta.tags) {
      check(typeof tag === 'string' && tag.trim().length > 0 && tag.trim().length <= 40, 400, `${slug}: invalid tag`);
      const clean = cleanLine(tag, 40);
      const key = clean.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tags.push(clean);
      }
    }
  }

  const author =
    typeof rawMeta.author === 'string' && rawMeta.author.trim()
      ? cleanLine(rawMeta.author, 100)
      : 'ProkBot Community';
  const license =
    typeof rawMeta.license === 'string' && rawMeta.license.trim()
      ? cleanLine(rawMeta.license, 80)
      : 'ProkBot-Noncommercial-1.0';
  const rawShape = typeof rawMeta.avatarShape === 'string' ? rawMeta.avatarShape.trim() : '';
  const rawColor = typeof rawMeta.avatarColor === 'string' ? rawMeta.avatarColor.trim().toLowerCase() : '';
  check(!rawShape || AVATAR_TOKEN_RE.test(rawShape), 400, `${slug}: invalid avatarShape`);
  check(!rawColor || AVATAR_TOKEN_RE.test(rawColor), 400, `${slug}: invalid avatarColor`);

  const meta = {
    slug,
    version,
    category,
    name,
    tagline,
    description,
    author,
    license,
    tags,
    avatarShape: rawShape || 'blob',
    avatarColor: rawColor || pickAvatarColor(slug),
    requiredApps,
    optionalApps: dedupedOptionalApps,
  };
  assertSafeMarketText(JSON.stringify(meta), `${slug}/meta.json`);
  return meta;
}

function parseSkillMarkdown(rawMarkdown, skillFolderName) {
  const text = String(rawMarkdown ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  check(text.length > 0, 400, `Skill "${skillFolderName}" SKILL.md is empty`);
  let name = '';
  let description = '';
  let body = text;

  const fmMatch = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (fmMatch) {
    const yaml = fmMatch[1];
    body = text.slice(fmMatch[0].length).trim() || text;
    for (const line of yaml.split('\n')) {
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      let val = kv[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
      ) {
        val = val.slice(1, -1);
      }
      if (key === 'name' && val) name = cleanLine(val, 100);
      if (key === 'description' && val) description = cleanLine(val, 2000);
    }
  }

  if (!name) {
    const heading = /^#{1,2}\s+(.+)$/m.exec(body);
    name = heading ? cleanLine(heading[1].replace(/#+\s*$/, ''), 100) : cleanLine(skillFolderName.replace(/[-_]+/g, ' '), 100);
  }
  if (!description) {
    for (const block of body.split(/\n{2,}/)) {
      const trimmed = block.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```') || trimmed.startsWith('---')) continue;
      description = cleanLine(trimmed.replace(/^[-*>\d.]+\s+/, ''), 2000);
      if (description) break;
    }
  }
  return {
    name: name || skillFolderName,
    description: description || name || skillFolderName,
    content: body,
  };
}

async function scanForbiddenFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const entry of entries) {
    check(!entry.isSymbolicLink(), 400, `Symlinks are not allowed in bot directory: ${entry.name}`);
    const full = join(currentDir, entry.name);
    const rel = relative(rootDir, full).split('\\').join('/');
    check(
      !FORBIDDEN_FILE_RE.test(rel),
      400,
      `Forbidden credential or database file in bot directory: ${rel}`,
    );
    if (entry.isDirectory()) {
      await scanForbiddenFiles(rootDir, full);
    }
  }
}

async function readTextBounded(filePath, label) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HttpError(400, `Missing required file: ${label}`);
    }
    throw error;
  }
  check(info.isFile(), 400, `${label} must be a regular file`);
  check(info.size > 0 && info.size <= MAX_TEXT_FILE_BYTES, 413, `${label} exceeds size limit`);
  const text = await readFile(filePath, 'utf8');
  check(!text.includes('\0'), 400, `Binary NUL byte not allowed in ${label}`);
  assertSafeMarketText(text, label);
  return text;
}

async function loadFolderSkills(botDir, slug) {
  const skillsDir = join(botDir, 'skills');
  let dirInfo;
  try {
    dirInfo = await stat(skillsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  check(dirInfo.isDirectory(), 400, `${slug}: skills path must be a directory`);
  const entries = await readdir(skillsDir, { withFileTypes: true });
  entries.sort((a, b) => compareCodeUnits(a.name, b.name));
  const skills = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    check(entry.isDirectory(), 400, `${slug}: expected skills/<name>/SKILL.md directory, found "${entry.name}"`);
    check(SKILL_DIR_RE.test(entry.name), 400, `${slug}: invalid skill directory name "${entry.name}"`);
    const skillPath = join(skillsDir, entry.name, 'SKILL.md');
    let raw;
    try {
      raw = await readTextBounded(skillPath, `${slug}/skills/${entry.name}/SKILL.md`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new HttpError(400, `${slug}: missing SKILL.md inside skills/${entry.name}/`);
      }
      throw error;
    }
    skills.push(parseSkillMarkdown(raw, entry.name));
  }
  return skills;
}

/**
 * Normalizes a declarative Bot recipe with hard safety guardrails (zero memory,
 * all routines paused, secret-scanned) and packs a deterministic ProkBot Share v1 ZIP.
 */
export function packageBotRecipe(rawRecipe, { meta = null, extraSkills = [], dependencies = null } = {}) {
  check(
    rawRecipe && typeof rawRecipe === 'object' && !Array.isArray(rawRecipe),
    400,
    'recipe.json must be a JSON object',
  );
  const label = meta?.slug || 'bot';

  // Scan raw recipe fields (including any instructions or extra fields) before normalization.
  assertSafeMarketText(JSON.stringify(rawRecipe), `${label}/recipe.json`);

  const rawProfile =
    rawRecipe.profile && typeof rawRecipe.profile === 'object' && !Array.isArray(rawRecipe.profile)
      ? rawRecipe.profile
      : {};
  const profileName =
    (typeof rawProfile.name === 'string' && rawProfile.name.trim()) ||
    meta?.name?.en ||
    meta?.name?.['zh-CN'] ||
    '';
  const profileTitle =
    (typeof rawProfile.title === 'string' && rawProfile.title.trim()) ||
    meta?.tagline?.en ||
    meta?.tagline?.['zh-CN'] ||
    profileName;
  const profileDescription =
    (typeof rawProfile.description === 'string' && rawProfile.description.trim()) ||
    (typeof rawProfile.instructions === 'string' && rawProfile.instructions.trim()) ||
    (typeof rawRecipe.instructions === 'string' && rawRecipe.instructions.trim()) ||
    '';
  check(
    profileDescription.length > 0,
    400,
    `${label}: recipe.profile.description (or instructions) is required`,
  );

  const inlineSkills = Array.isArray(rawRecipe.skills) ? rawRecipe.skills : [];
  const mergedSkills = [...inlineSkills];
  const seenSkillNames = new Set(
    inlineSkills
      .filter((s) => s && typeof s.name === 'string')
      .map((s) => s.name.trim().toLowerCase()),
  );
  for (const skill of extraSkills) {
    const key = skill.name.trim().toLowerCase();
    check(!seenSkillNames.has(key), 400, `${label}: duplicate skill name "${skill.name}"`);
    seenSkillNames.add(key);
    mergedSkills.push(skill);
  }

  check(
    rawRecipe.routines === undefined || Array.isArray(rawRecipe.routines),
    400,
    `${label}: recipe.routines must be an array`,
  );
  const routines = (rawRecipe.routines ?? []).map((routine) => {
    check(routine && typeof routine === 'object' && !Array.isArray(routine), 400, `${label}: invalid routine entry`);
    return { ...routine, isEnabled: false };
  });

  // Merge plugins from recipe.plugins and meta requiredApps/optionalApps deterministically.
  check(
    rawRecipe.plugins === undefined || Array.isArray(rawRecipe.plugins),
    400,
    `${label}: recipe.plugins must be an array`,
  );
  const plugins = [];
  const seenPlugins = new Set();
  for (const plugin of rawRecipe.plugins ?? []) {
    check(plugin && typeof plugin === 'object' && !Array.isArray(plugin), 400, `${label}: invalid plugin entry`);
    const id = typeof plugin.pluginId === 'string' ? plugin.pluginId.trim() : '';
    if (!id || seenPlugins.has(id)) continue;
    seenPlugins.add(id);
    plugins.push(plugin);
  }
  for (const appId of [...(meta?.requiredApps ?? []), ...(meta?.optionalApps ?? [])]) {
    if (seenPlugins.has(appId)) continue;
    seenPlugins.add(appId);
    const catalogMeta = APP_CATALOG_META[appId];
    plugins.push({
      pluginId: appId,
      name: catalogMeta?.name?.en ?? appId,
      ...(catalogMeta?.description?.en ? { description: catalogMeta.description.en } : {}),
    });
  }

  // Deliberate allowlist: strips memory, transcripts, messages, and any unknown fields.
  const normalizedRecipe = normalizeRecipe({
    profile: {
      name: profileName,
      title: profileTitle,
      description: profileDescription,
      ...(rawProfile.avatarShape || meta?.avatarShape
        ? { avatarShape: rawProfile.avatarShape || meta.avatarShape }
        : {}),
      ...(rawProfile.avatarColor || meta?.avatarColor
        ? { avatarColor: rawProfile.avatarColor || meta.avatarColor }
        : {}),
    },
    memory: [],
    skills: mergedSkills,
    routines,
    plugins,
  });

  assertSafeMarketText(JSON.stringify(normalizedRecipe), `${label} normalized recipe`);

  const shareDeps = Array.isArray(dependencies)
    ? dependencies
    : Array.isArray(rawRecipe.dependencies)
      ? rawRecipe.dependencies
      : normalizedRecipe.plugins.map((plugin) => ({
          pluginId: plugin.pluginId,
          name: plugin.name || plugin.pluginId,
          ...(plugin.version ? { version: plugin.version } : {}),
          tools: [],
        }));

  const sharePackage = normalizeSharePackage({
    schemaVersion: 1,
    kind: 'bot',
    content: normalizedRecipe,
    dependencies: shareDeps,
  });

  const bytes = packShare(sharePackage);
  check(bytes.length <= MAX_ZIP_BYTES, 413, `${label}: packaged ZIP exceeds 10 MiB limit`);
  // Self-verify round-trip decode.
  const verified = unpackShare(bytes);
  check(verified.kind === 'bot' && verified.content.memory.length === 0, 500, `${label}: ZIP verification failed`);
  for (const r of verified.content.routines) {
    check(r.isEnabled === false, 500, `${label}: routine "${r.slug}" must remain disabled`);
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { recipe: normalizedRecipe, sharePackage, bytes, sha256 };
}

function normalizeBaseUrl(rawBaseUrl) {
  if (!rawBaseUrl) return '';
  const trimmed = String(rawBaseUrl).trim();
  check(trimmed.length <= 2048 && !/[\0\r\n]/.test(trimmed), 400, 'Invalid --base-url');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, `Invalid --base-url: ${trimmed}`);
  }
  check(parsed.protocol === 'https:' || parsed.protocol === 'http:', 400, '--base-url must use http or https');
  check(!parsed.username && !parsed.password, 400, '--base-url must not contain credentials');
  parsed.hash = '';
  parsed.search = '';
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname += '/';
  }
  return parsed.href;
}

export async function buildMarketIndex({
  sourceDir,
  outputDir = '',
  baseUrl = '',
  registryName = 'ProkBot Community Market',
  checkOnly = false,
  updatedAt = new Date().toISOString(),
} = {}) {
  check(typeof sourceDir === 'string' && sourceDir.trim().length > 0, 400, 'sourceDir is required');
  if (!checkOnly) {
    check(typeof outputDir === 'string' && outputDir.trim().length > 0, 400, 'outputDir is required unless checkOnly is true');
  }
  const cleanRegistryName = cleanLine(registryName || 'ProkBot Community Market', 100) || 'ProkBot Community Market';
  assertSafeMarketText(cleanRegistryName, 'registryName');
  const normalizedBase = normalizeBaseUrl(baseUrl);

  const absSource = resolve(sourceDir);
  const srcInfo = await stat(absSource);
  check(srcInfo.isDirectory(), 400, `Source path is not a directory: ${absSource}`);

  const dirEntries = await readdir(absSource, { withFileTypes: true });
  dirEntries.sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const entry of dirEntries) {
    check(!entry.isSymbolicLink(), 400, `Symlinks are not allowed in source directory: ${entry.name}`);
  }

  const botFolders = dirEntries.filter((entry) => !entry.name.startsWith('.') && entry.isDirectory());
  check(botFolders.length <= MAX_BOT_COUNT, 400, `Registry exceeds maximum limit of ${MAX_BOT_COUNT} bots`);

  const seenSlugs = new Set();
  const bots = [];
  const packages = [];

  for (const folder of botFolders) {
    const botDir = join(absSource, folder.name);
    await scanForbiddenFiles(botDir);

    const metaRaw = await readTextBounded(join(botDir, 'meta.json'), `${folder.name}/meta.json`);
    const recipeRaw = await readTextBounded(join(botDir, 'recipe.json'), `${folder.name}/recipe.json`);

    let metaJson;
    let recipeJson;
    try {
      metaJson = JSON.parse(metaRaw);
    } catch {
      throw new HttpError(400, `${folder.name}/meta.json is not valid JSON`);
    }
    try {
      recipeJson = JSON.parse(recipeRaw);
    } catch {
      throw new HttpError(400, `${folder.name}/recipe.json is not valid JSON`);
    }

    const meta = validateBotMeta(metaJson, folder.name);
    check(!seenSlugs.has(meta.slug), 400, `Duplicate bot slug: "${meta.slug}"`);
    seenSlugs.add(meta.slug);

    const folderSkills = await loadFolderSkills(botDir, meta.slug);
    const packaged = packageBotRecipe(recipeJson, { meta, extraSkills: folderSkills });
    const filename = `${meta.slug}-${meta.version}.zip`;
    const packageUrl = normalizedBase
      ? new URL(`packages/${filename}`, normalizedBase).href
      : `./packages/${filename}`;

    bots.push({
      slug: meta.slug,
      version: meta.version,
      category: meta.category,
      name: meta.name,
      tagline: meta.tagline,
      description: meta.description,
      author: meta.author,
      license: meta.license,
      tags: meta.tags,
      avatarShape: meta.avatarShape,
      avatarColor: meta.avatarColor,
      requiredApps: meta.requiredApps,
      optionalApps: meta.optionalApps,
      skillsCount: packaged.recipe.skills.length,
      routinesCount: packaged.recipe.routines.length,
      packageUrl,
      sha256: packaged.sha256,
    });

    packages.push({
      slug: meta.slug,
      version: meta.version,
      filename,
      sha256: packaged.sha256,
      bytes: packaged.bytes,
    });
  }

  bots.sort((a, b) => compareCodeUnits(a.slug, b.slug));
  packages.sort((a, b) => compareCodeUnits(a.slug, b.slug));

  const index = {
    schemaVersion: 1,
    name: cleanRegistryName,
    registryName: cleanRegistryName,
    updatedAt,
    bots,
  };

  // Validate emitted index against Host2's own parser.
  const verifySourceUrl = normalizedBase
    ? new URL('index.json', normalizedBase).href
    : 'https://registry.example.invalid/index.json';
  const parsedCheck = parseRegistryIndex(index, verifySourceUrl);
  check(parsedCheck.format === 'prokbot-v1' && parsedCheck.bots.length === bots.length, 500, 'Generated index failed parser verification');

  const indexJsonText = `${JSON.stringify(index, null, 2)}\n`;
  assertSafeMarketText(indexJsonText, 'index.json');

  if (!checkOnly) {
    const absOutput = resolve(outputDir);
    const packagesDir = join(absOutput, 'packages');
    await mkdir(packagesDir, { recursive: true });
    for (const pkg of packages) {
      await writeFile(join(packagesDir, pkg.filename), pkg.bytes);
    }
    await writeFile(join(absOutput, 'index.json'), indexJsonText, 'utf8');
  }

  return {
    index,
    packages,
    checked: true,
    wrote: !checkOnly,
  };
}

function parseCliArgs(argv) {
  const opts = {
    sourceDir: '',
    outputDir: '',
    baseUrl: '',
    registryName: 'ProkBot Community Market',
    checkOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source' || arg === '-s') opts.sourceDir = argv[++i] ?? '';
    else if (arg === '--output' || arg === '-o') opts.outputDir = argv[++i] ?? '';
    else if (arg === '--base-url') opts.baseUrl = argv[++i] ?? '';
    else if (arg === '--registry-name') opts.registryName = argv[++i] ?? '';
    else if (arg === '--check') opts.checkOnly = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new HttpError(400, `Unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(
      'Usage: node host/tools/build-market-index.mjs --source <bots-dir> [--output <dist-dir>] [--base-url <url>] [--registry-name <name>] [--check]',
    );
    process.exit(0);
  }
  if (!opts.sourceDir) {
    console.error('Error: --source <bots-dir> is required');
    process.exit(2);
  }
  if (!opts.checkOnly && !opts.outputDir) {
    console.error('Error: --output <dist-dir> is required (or pass --check)');
    process.exit(2);
  }
  try {
    const result = await buildMarketIndex(opts);
    const mode = opts.checkOnly ? 'Checked' : 'Built';
    console.log(
      `${mode} "${result.index.registryName}": ${result.index.bots.length} bot(s) verified${
        result.wrote ? ` -> ${resolve(opts.outputDir)}` : ''
      }`,
    );
  } catch (error) {
    console.error(`Build failed: ${error?.message || error}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
