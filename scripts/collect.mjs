#!/usr/bin/env node
// Phase 2 collector: search npm, keep packages declaring dsh.bundle, record
// per-version engines.dsh + publish timestamps. Caches raw data to site/registry-raw.json.
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const REG = 'https://registry.npmjs.org';
const UA = { 'User-Agent': 'dsh-plugin-market-collector/0.1' };
const CONCURRENCY = 10;
const CACHE = new URL('../.cache/registry-raw.json', import.meta.url);

const SEARCH_QUERIES = [
  'keywords:dsh-plugin',
  'keywords:dsh-bundle',
  'keywords:dsh',
  'dsh-plugin',
  'dsh-bundle',
  'deepseek-harness',
  'deepseek',
  'cordis',
  'dsh',
];

function enc(n) { return n.replace('/', '%2f'); }

async function getJSON(url, { retry = 3 } = {}) {
  for (let i = 0; i < retry; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 429) { await sleep(800 * (i + 1)); continue; }
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, json: await r.json() };
    } catch (e) {
      if (i === retry - 1) return { ok: false, error: e.message };
      await sleep(400);
    }
  }
  return { ok: false, error: 'retry-exhausted' };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function searchOnce(q, from) {
  const url = `${REG}/-/v1/search?text=${encodeURIComponent(q)}&size=50&from=${from}`;
  const res = await getJSON(url);
  if (!res.ok) return [];
  return (res.json.objects || []).map(o => o.package.name);
}

async function pool(items, worker, size = CONCURRENCY) {
  const out = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      out.push(await worker(items[idx], idx));
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
  return out;
}

async function main() {
  // 1) gather candidate names
  const names = new Set();
  for (const q of SEARCH_QUERIES) {
    for (let from = 0; from < 250; from += 50) {
      const hit = await searchOnce(q, from);
      if (hit.length === 0) break;
      hit.forEach(n => names.add(n));
    }
  }
  const candidates = [...names].sort();
  console.log(`[collect] unique candidates: ${candidates.length}`);

  // 2) for each candidate: get latest via abbreviated packument, then check dsh.bundle on latest full manifest
  const results = [];
  const workers = candidates.map(name => async () => {
    const ab = await getJSON(`${REG}/${enc(name)}`, );
    if (!ab.ok) return null;
    const latest = ab.json['dist-tags']?.latest;
    if (!latest) return null;
    // check latest full manifest for dsh.bundle
    const full = await getJSON(`${REG}/${enc(name)}/${encodeURIComponent(latest)}`);
    if (!full.ok) return null;
    const m = full.json;
    const dsh = m.dsh;
    if (!dsh || !dsh.bundle) return null; // not a bundle -> drop
    return { name, latest, manifest: m };
  });
  const bundles = (await pool(candidates, (name, i) => workers[i](), CONCURRENCY)).filter(Boolean);
  console.log(`[collect] packages declaring dsh.bundle: ${bundles.length}`);

  // 3) for each bundle: fetch full packument for time + per-version engines.dsh
  const dataset = [];
  await pool(bundles, async (b) => {
    const pk = await getJSON(`${REG}/${enc(b.name)}`);
    if (!pk.ok) return;
    const pack = pk.json;
    const time = pack.time || {};
    const versions = pack.versions || {};
    const recVersions = [];
    for (const [v, m] of Object.entries(versions)) {
      if (!m.dsh || !m.dsh.bundle) continue; // only bundle versions
      const tsRaw = time[v];
      const ts = tsRaw ? Math.floor(Date.parse(tsRaw) / 1000) : 0;
      const dshRange = m.engines?.dsh;
      recVersions.push({
        version: v,
        publishTimestamp: ts,
        enginesDsh: typeof dshRange === 'string' ? dshRange : null,
      });
    }
    if (recVersions.length === 0) return;
    const withDsh = recVersions.filter(r => r.enginesDsh).length;
    dataset.push({
      name: b.name,
      latest: b.latest,
      description: (b.manifest.description || '').slice(0, 400),
      keywords: Array.isArray(b.manifest.keywords) ? b.manifest.keywords.slice(0, 20) : [],
      author: typeof b.manifest.author === 'string' ? b.manifest.author
        : b.manifest.author?.name || undefined,
      homepage: b.manifest.homepage || undefined,
      repository: b.manifest.repository?.url || undefined,
      bundleVersionCount: recVersions.length,
      withDshVersionCount: withDsh,
      versions: recVersions,
    });
  }, CONCURRENCY);

  await mkdir(new URL('..', CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(dataset, null, 2));

  const qualifying = dataset.filter(d => d.withDshVersionCount > 0);
  console.log(`[collect] bundle packages kept: ${dataset.length}`);
  console.log(`[collect] QUALIFYING (>=1 version with engines.dsh): ${qualifying.length}`);
  console.log(`[collect] total versions recorded: ${dataset.reduce((a, d) => a + d.versions.length, 0)}`);
  console.log(`[collect] cached -> ${CACHE.pathname}`);
  // top qualifying by version count
  qualifying.sort((a, b) => b.withDshVersionCount - a.withDshVersionCount);
  console.log('[collect] top qualifying packages:');
  qualifying.slice(0, 15).forEach(d => console.log(`   ${d.name}: ${d.withDshVersionCount} dsh-versions / ${d.bundleVersionCount} total`));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
