#!/usr/bin/env node
// Phase 2 builder: turn site/registry-raw.json into a valid format-1 market index
// at site/index.json. Every included version is pre-validated against the same
// rules parseMarketIndex enforces, so the artifact cannot be rejected at verify time.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let semver;
try { semver = require('semver'); } catch { semver = null; }

const ROOT = new URL('..', import.meta.url);
const RAW = new URL('.cache/registry-raw.json', ROOT);
// Task acceptance form: `node scripts/build-index.mjs --output site/index.json`.
function resolveOutput() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--output');
  if (i >= 0 && args[i + 1]) return resolve(process.cwd(), args[i + 1]);
  return fileURLToPath(new URL('index.json', new URL('site/', ROOT)));
}
const OUT = resolveOutput();
const MAX_VERSIONS_PER_PLUGIN = 30;

// Mirror of the exact SemVer grammar parseMarketIndex uses for `version`.
const NUMERIC = '(?:0|[1-9]\\d*)';
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u');
const MAX_PUBLISH_TIMESTAMP = 1e11;

function humanize(name) {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function validRange(r) {
  if (typeof r !== 'string' || r.trim() === '' || r.startsWith('workspace:')) return false;
  return semver ? semver.validRange(r) !== null : true;
}
function normalizeRepoUrl(u) {
  if (typeof u !== 'string') return undefined;
  let s = u.trim();
  if (s.startsWith('git+')) s = s.slice(4);
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

async function main() {
  const raw = JSON.parse(await readFile(RAW, 'utf8'));
  const plugins = [];
  let skippedNoDsh = 0, skippedBadVersion = 0, totalVersions = 0;

  for (const pkg of raw) {
    if (!pkg.versions || pkg.versions.length === 0) continue;
    // Keep only bundle versions carrying engines.dsh (the DSH-runtime-compatible ones).
    let vers = pkg.versions
      .filter(v => typeof v.enginesDsh === 'string' && v.enginesDsh.length > 0)
      .map(v => ({ v, dsh: v.enginesDsh }));
    if (vers.length === 0) { skippedNoDsh++; continue; }

    // Validate each version string + timestamp + range; drop invalid ones.
    const clean = [];
    for (const { v, dsh } of vers) {
      if (!SEMVER.test(v.version)) { skippedBadVersion++; continue; }
      const ts = Number.isInteger(v.publishTimestamp) ? v.publishTimestamp
        : Math.floor(v.publishTimestamp);
      if (!(ts >= 0 && ts < MAX_PUBLISH_TIMESTAMP)) { skippedBadVersion++; continue; }
      if (!validRange(dsh)) continue; // drop versions with unusable dsh range
      clean.push({ version: v.version, publishTimestamp: ts, dsh });
    }
    if (clean.length === 0) { skippedNoDsh++; continue; }

    // Newest-first by SemVer precedence, cap per plugin.
    clean.sort((a, b) => (semver ? semver.rcompare(a.version, b.version) : 0) || b.publishTimestamp - a.publishTimestamp);
    const kept = clean.slice(0, MAX_VERSIONS_PER_PLUGIN);
    totalVersions += kept.length;

    const titleText = humanize(pkg.name);
    const descText = (pkg.description && pkg.description.trim()) ? pkg.description.trim() : titleText;
    const repo = normalizeRepoUrl(pkg.repository);
    const hasRepo = !!repo;
    const hasHome = typeof pkg.homepage === 'string' && /^https?:\/\//.test(pkg.homepage);
    const hasDesc = !!(pkg.description && pkg.description.trim());
    const versionCount = kept.length;

    // Evidence level (L0-L2) derived strictly from automated signals; never manually overridden (L3 not implemented).
    let level;
    if (hasRepo && hasHome && hasDesc && versionCount >= 2) level = 2;
    else if ((hasRepo || hasHome) && hasDesc) level = 1;
    else level = 0;
    const evidenceScore = level + 1; // L0->1, L1->2, L2->3 (higher = stronger)
    const updatedTs = kept.reduce((m, k) => Math.max(m, k.publishTimestamp), 0);
    const stars = 0; // optional sort key; unpopulated (no GitHub stars source) but declared

    const plugin = {
      name: pkg.name,
      // Evidence level as a literal field (pipeline-produced, never hand-edited).
      // parseMarketIndex drops members the format does not define, so the
      // evidence-l{level} label below is the carrier that survives validation.
      evidenceLevel: `L${level}`,
      title: { en: titleText, 'zh-cn': titleText },
      description: { en: descText, 'zh-cn': descText },
      author: typeof pkg.author === 'string' && pkg.author.trim() ? pkg.author.trim() : undefined,
      homepage: hasHome ? pkg.homepage : undefined,
      ...(repo ? { repository: { url: repo } } : {}),
      metadata: {
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords.filter(k => typeof k === 'string').slice(0, 20) : [],
        labels: [`evidence-l${level}`],
        sortKeys: {
          evidence: evidenceScore,
          updated: updatedTs,
          stars,
        },
      },
      versions: kept.map(k => ({
        version: k.version,
        publishTimestamp: k.publishTimestamp,
        source: { type: 'npm' },
        engines: { dsh: k.dsh },
      })),
    };
    plugins.push(plugin);
  }

  const index = {
    format: 1,
    title: { en: 'DSH Plugin Market', 'zh-cn': 'DSH 插件市场' },
    description: {
      en: 'A curated market of DSH (DeepSeek Harness) plugin bundles sourced from the npm registry.',
      'zh-cn': '从 npm registry 采集整理的 DSH（DeepSeek Harness）插件市场索引。',
    },
    metadata: {
      categories: {},
      labels: {
        'evidence-l0': { title: { en: 'Evidence L0', 'zh-cn': '证据 L0' } },
        'evidence-l1': { title: { en: 'Evidence L1', 'zh-cn': '证据 L1' } },
        'evidence-l2': { title: { en: 'Evidence L2', 'zh-cn': '证据 L2' } },
      },
      sortKeys: {
        evidence: { title: { en: 'Evidence strength', 'zh-cn': '证据强度' }, order: 'desc' },
        updated: { title: { en: 'Recently updated', 'zh-cn': '最近更新' }, order: 'desc' },
        stars: { title: { en: 'Stars', 'zh-cn': '星标' }, order: 'desc' },
      },
    },
    plugins,
  };

  await mkdir(new URL('site/', ROOT), { recursive: true });
  await writeFile(OUT, JSON.stringify(index, null, 2));
  console.log(`[build] plugins: ${plugins.length} (>=50 gate: ${plugins.length >= 50 ? 'PASS' : 'FAIL'})`);
  console.log(`[build] total versions: ${totalVersions}`);
  console.log(`[build] skipped (no usable dsh version): ${skippedNoDsh}`);
  console.log(`[build] skipped (bad version/timestamp/range): ${skippedBadVersion}`);
  console.log(`[build] -> ${OUT}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
