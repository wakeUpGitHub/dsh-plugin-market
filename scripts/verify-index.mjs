#!/usr/bin/env node
// Phase 2 + Phase 3 gate: validate site/index.json with the official
// parseMarketIndex and enforce:
//   - >= 50 plugins, every plugin with >= 1 version declaring engines.dsh
//   - every entry carries a pipeline-produced evidenceLevel (L0-L2)
//   - >= 3 sort keys with evidence as the default direction
//   - every install spec derivable through the official marketInstallTarget
//
// Task acceptance form: node scripts/verify-index.mjs site/index.json
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarketIndex, marketInstallTarget, MarketIndexError } from '@deepseek-ai/dsh-plugin-market-index';

const argPath = process.argv[2];
const OUT = argPath ? resolve(process.cwd(), argPath) : fileURLToPath(new URL('../site/index.json', import.meta.url));
const INDEX_URL = 'file://local-check';

async function main() {
  let raw;
  try { raw = await readFile(OUT, 'utf8'); }
  catch (e) { console.error('FAIL: cannot read index:', e.message); process.exit(1); }

  let value;
  try { value = JSON.parse(raw); }
  catch (e) { console.error('FAIL: index is not valid JSON:', e.message); process.exit(1); }

  // Raw-document check: parseMarketIndex drops members the format does not
  // define, so the literal evidenceLevel field is verified on the raw JSON.
  const rawPlugins = Array.isArray(value?.plugins) ? value.plugins : [];
  const missingEvidenceField = rawPlugins.filter(p => !/^L[0-2]$/.test(String(p?.evidenceLevel))).length;

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
  let noDsh = 0, totalVersions = 0, badSpec = 0;
  let specSample = '(none)';
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

    // Install specs must be produced by the official helper, never hand-built.
    const target = marketInstallTarget(p.name, p.versions[0]);
    if (!target || typeof target.spec !== 'string' || target.spec.length === 0) badSpec++;
    else if (specSample === '(none)') specSample = `${p.name} -> ${target.spec}`;
  }

  // Phase 3 gate
  const sortKeyOk = sortKeyIds.length >= 3 && 'evidence' in (index.metadata?.sortKeys || {});
  const evidenceDefaultOk = (index.metadata?.sortKeys?.evidence?.order === 'desc'); // strongest first = default
  const labelDeclOk = declaredLabels.includes('evidence-l0') && declaredLabels.includes('evidence-l1') && declaredLabels.includes('evidence-l2');
  const phase3Ok = sortKeyOk && evidenceDefaultOk && labelDeclOk && badEvidenceLabel === 0 && badSortKeys === 0;

  const countOk = plugins.length >= 50;
  const dshOk = noDsh === 0;
  const evidenceFieldOk = rawPlugins.length > 0 && missingEvidenceField === 0;
  const specOk = badSpec === 0;
  console.log(`[verify] format-1 parse: PASS`);
  console.log(`[verify] plugins: ${plugins.length} (>=50: ${countOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] plugins missing engines.dsh: ${noDsh} (must be 0: ${dshOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] total versions: ${totalVersions}`);
  console.log(`[verify] index title: ${JSON.stringify(index.title)}`);
  console.log(`[verify] entries carrying evidenceLevel (raw): ${rawPlugins.length - missingEvidenceField}/${rawPlugins.length} (must be all: ${evidenceFieldOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] marketInstallTarget derivation: ${specOk ? 'PASS' : 'FAIL'} (sample: ${specSample})`);
  console.log(`[verify] Phase 3 sortKeys declared: ${sortKeyIds.join(', ')} (>=3 + evidence default: ${sortKeyOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] Phase 3 evidence labels declared: ${declaredLabels.filter(l => l.startsWith('evidence-l')).join(', ')} (all 3: ${labelDeclOk ? 'PASS' : 'FAIL'})`);
  console.log(`[verify] Phase 3 evidence level distribution: L0=${levelCount[0]} L1=${levelCount[1]} L2=${levelCount[2]}`);
  console.log(`[verify] Phase 3 plugins missing evidence label: ${badEvidenceLabel}, missing sort-key values: ${badSortKeys}`);

  if (!countOk || !dshOk) {
    console.error('FAIL: Phase 2 gate not satisfied.');
    process.exit(1);
  }
  if (!phase3Ok || !evidenceFieldOk || !specOk) {
    console.error('FAIL: Phase 3 gate not satisfied.');
    process.exit(1);
  }
  console.log('PASS: Phase 2 + Phase 3 index gates satisfied.');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
