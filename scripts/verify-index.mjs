#!/usr/bin/env node
// Phase 2 gate (spec 2.6): parse the index with the official
// parseMarketIndex and print VALID on success (exit 0). Any violation is
// printed verbatim as "<path> <reason>" and exits non-zero — nothing is
// swallowed. Additional phase gates are printed before the final VALID line.
//
// Acceptance form: node scripts/verify-index.mjs site/index.json
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarketIndex, marketInstallTarget, MarketIndexError } from '@deepseek-ai/dsh-plugin-market-index'

const argPath = process.argv[2]
const OUT = argPath ? resolve(process.cwd(), argPath) : fileURLToPath(new URL('../site/index.json', import.meta.url))
const INDEX_URL = 'file://local-check'

async function main() {
  let raw
  try { raw = await readFile(OUT, 'utf8') } catch (e) {
    console.error(`FAIL: cannot read index: ${e.message}`)
    process.exit(1)
  }

  let value
  try { value = JSON.parse(raw) } catch (e) {
    console.error(`FAIL: index is not valid JSON: ${e.message}`)
    process.exit(1)
  }

  let index
  try {
    index = parseMarketIndex(value, INDEX_URL)
  } catch (e) {
    if (e instanceof MarketIndexError) {
      console.error(`${e.path} ${e.reason}`)
      process.exit(1)
    }
    console.error(`FAIL: unexpected error during validation: ${e.stack || e.message}`)
    process.exit(1)
  }

  const plugins = index.plugins
  let noDsh = 0, badSpec = 0, totalVersions = 0
  let specSample = '(none)'
  const levelCount = { 0: 0, 1: 0, 2: 0 }
  const sortKeyIds = Object.keys(index.metadata?.sortKeys || {})
  const declaredLabels = Object.keys(index.metadata?.labels || {})
  let badEvidenceLabel = 0, badSortKeys = 0
  for (const p of plugins) {
    const hasDsh = p.versions.some((v) => v.engines && typeof v.engines.dsh === 'string' && v.engines.dsh.length > 0)
    if (!hasDsh) noDsh += 1
    totalVersions += p.versions.length
    const labels = p.metadata?.labels || []
    const ev = labels.find((l) => /^evidence-l[0-2]$/.test(l))
    if (!ev) badEvidenceLabel += 1
    else levelCount[Number(ev.replace('evidence-l', ''))] += 1
    const sk = p.metadata?.sortKeys || {}
    if (typeof sk.evidence !== 'number' || typeof sk.updated !== 'number' || typeof sk.stars !== 'number') badSortKeys += 1
    // Install specs are derived through the official helper only (spec 2.4).
    const target = marketInstallTarget(p.name, p.versions[0])
    if (!target || typeof target.spec !== 'string' || target.spec.length === 0) badSpec += 1
    else if (specSample === '(none)') specSample = `${p.name} -> ${target.spec}`
  }

  const rawPlugins = Array.isArray(value?.plugins) ? value.plugins : []
  const missingEvidenceField = rawPlugins.filter((p) => !/^L[0-2]$/.test(String(p?.evidenceLevel))).length
  const countOk = plugins.length >= 50
  const dshOk = noDsh === 0
  const allVersionsHaveDsh = plugins.every((p) => p.versions.every((v) => v.engines && typeof v.engines.dsh === 'string' && v.engines.dsh.length > 0))
  const allNpmSources = plugins.every((p) => p.versions.every((v) => v.source && v.source.type === 'npm'))
  const sortKeyOk = sortKeyIds.length >= 3 && 'evidence' in (index.metadata?.sortKeys || {})
  const evidenceDefaultOk = index.metadata?.sortKeys?.evidence?.order === 'desc'
  const labelDeclOk = ['evidence-l0', 'evidence-l1', 'evidence-l2'].every((l) => declaredLabels.includes(l))
  const evidenceFieldOk = rawPlugins.length > 0 && missingEvidenceField === 0
  const specOk = badSpec === 0

  console.log(`[gate] plugins: ${plugins.length} (>=50: ${countOk ? 'PASS' : 'FAIL'})`)
  console.log(`[gate] every plugin has >=1 version: ${plugins.every((p) => p.versions.length > 0) ? 'PASS' : 'FAIL'}`)
  console.log(`[gate] every version carries engines.dsh: ${allVersionsHaveDsh ? 'PASS' : 'FAIL'} (entries missing any: ${noDsh})`)
  console.log(`[gate] every source.type is npm: ${allNpmSources ? 'PASS' : 'FAIL'}`)
  console.log(`[gate] format is the integer 1: ${value.format === 1 ? 'PASS' : 'FAIL'}`)
  console.log(`[gate] entries carrying evidenceLevel (raw): ${rawPlugins.length - missingEvidenceField}/${rawPlugins.length} (${evidenceFieldOk ? 'PASS' : 'FAIL'})`)
  console.log(`[gate] marketInstallTarget derivation: ${specOk ? 'PASS' : 'FAIL'} (sample: ${specSample})`)
  console.log(`[gate] sortKeys declared: ${sortKeyIds.join(', ')} (>=3 + evidence default: ${sortKeyOk && evidenceDefaultOk ? 'PASS' : 'FAIL'})`)
  console.log(`[gate] evidence labels declared: ${['evidence-l0', 'evidence-l1', 'evidence-l2'].filter((l) => declaredLabels.includes(l)).join(', ')} (${labelDeclOk ? 'PASS' : 'FAIL'})`)
  console.log(`[gate] evidence distribution: L0=${levelCount[0]} L1=${levelCount[1]} L2=${levelCount[2]} (missing label: ${badEvidenceLabel}, missing sort values: ${badSortKeys})`)
  console.log(`[gate] total versions: ${totalVersions}`)

  if (!countOk || !dshOk || !allVersionsHaveDsh || !allNpmSources || value.format !== 1) {
    console.error('FAIL: phase 2 gate not satisfied.')
    process.exit(1)
  }
  if (!sortKeyOk || !evidenceDefaultOk || !labelDeclOk || badEvidenceLabel !== 0 || badSortKeys !== 0 || !evidenceFieldOk || !specOk) {
    console.error('FAIL: phase 3 gate not satisfied.')
    process.exit(1)
  }
  console.log('VALID')
}

main().catch((e) => { console.error('FAIL: unexpected error:', e.stack || e.message); process.exit(1) })
