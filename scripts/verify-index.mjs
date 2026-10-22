#!/usr/bin/env node
// Phase 2 gate: validate site/index.json with the official parseMarketIndex and
// enforce: >=50 plugins, every plugin has >=1 version that declares engines.dsh.
import { readFile } from 'node:fs/promises';
import { parseMarketIndex, MarketIndexError } from '@deepseek-ai/dsh-plugin-market-index';

const OUT = new URL('../site/index.json', import.meta.url);
const INDEX_URL = 'https://market.dsh.local/index.json';

async function main() {
  let raw;
  try { raw = await readFile(OUT, 'utf8'); }
  catch (e) { console.error('FAIL: cannot read index:', e.message); process.exit(1); }

  let value;
  try { value = JSON.parse(raw); }
  catch (e) { console.error('FAIL: index is not valid JSON:', e.message); process.exit(1); }

  let index;
  try {
    index = parseMarketIndex(value, INDEX_URL);
  } catch (e) {
    if (e instanceof MarketIndexError) {
      console.error(`FAIL: format-1 validation rejected at ${e.path}: ${e.reason}`);
      process.exit(1);
    }
    console.error('FAIL: unexpected error during validation:', e.stack || e.message);
    process.exit(1);
  }

  const plugins = index.plugins;
  let noDsh = 0, totalVersions = 0;
  const levelCount = { 0: 0, 1: 0, 2: 0 };
  const sortKeyIds = Object.keys(index.metadata?.sortKeys || {});
  const declaredLabels = Object.keys(index.metadata?.labels || {});
  let badEvidenceLabel = 0, badSortKeys = 0;
  for (const p of plugins) {
    const hasDsh = p.versions.some(v => v.engines && typeof v.engines.dsh === 'string' && v.engines.dsh.length > 0);
    if (!hasDsh) noDsh++;
    totalVersions += p.versions.length;

    // Phase 3: evidence label present and sort-key values present
    const labels = (p.metadata?.labels) || [];
    const ev = labels.find(l => /^evidence-l[0-2]$/.test(l));
    if (!ev) { badEvidenceLabel++; }
    else { const lvl = Number(ev.replace('evidence-l', '')); levelCount[lvl] = (levelCount[lvl] || 0) + 1; }
    const sk = p.metadata?.sortKeys || {};
    if (typeof sk.evidence !== 'number' || typeof sk.updated !== 'number' || typeof sk.stars !== 'number') badSortKeys++;
  }

  // Phase 3 gate
  const sortKeyOk = sortKeyIds.length >= 3 && 'evidence' in (index.metadata?.sortKeys || {});
  const evidenceDefaultOk = (index.metadata?.sortKeys?.evidence?.order === 'desc'); // strongest first = default
  const labelDeclOk = declaredLabels.includes('evidence-l0') && declaredLabels.includes('evidence-l1') && declaredLabels.includes('evidence-l2');
  const phase3Ok = sortKeyOk && evidenceDefaultOk && labelDeclOk && badEvidenceLabel === 0 && badSortKeys === 0;

  const countOk = plugins.length >= 50;
  const dshOk = noDsh === 0;
  console.log(`[verify] format-1 parse: PASS`);
  console.log(`[verify] plugins: ${plugins.length} (>=50: ${countOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] plugins missing engines.dsh: ${noDsh} (must be 0: ${dshOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] total versions: ${totalVersions}`);
  console.log(`[verify] index title: ${JSON.stringify(index.title)}`);
  console.log(`[verify] Phase 3 sortKeys declared: ${sortKeyIds.join(', ')} (>=3 + evidence default: ${sortKeyOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] Phase 3 evidence labels declared: ${declaredLabels.filter(l => l.startsWith('evidence-l')).join(', ')} (all 3: ${labelDeclOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] Phase 3 evidence level distribution: L0=${levelCount[0]} L1=${levelCount[1]} L2=${levelCount[2]}`);
  console.log(`[verify] Phase 3 plugins missing evidence label: ${badEvidenceLabel}, missing sort-key values: ${badSortKeys}`);

  if (!countOk || !dshOk) {
    console.error('FAIL: Phase 2 gate not satisfied.');
    process.exit(1);
  }
  if (!phase3Ok) {
    console.error('FAIL: Phase 3 gate not satisfied.');
    process.exit(1);
  }
  console.log('PASS: Phase 2 + Phase 3 index gates satisfied.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
