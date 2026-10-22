#!/usr/bin/env node
// Phase 2 collector (spec 2.2).
//
// Candidate discovery goes through search-packages' fetchPackagesByKeywords
// (['dsh-plugin']) with maxResults: Number.POSITIVE_INFINITY — page to the end.
// If this environment refuses infinite paging (429 after capped retries), the
// cap falls back to 2500 (10 requests) and the truncated flag is recorded.
// Page requests are paced >=200ms apart with at most 2 retries and doubling
// backoff; a 429 is never retried immediately. No GitHub topic enumeration,
// no git sources, no star/keyword/download heuristics — the only mechanical
// inclusion signal is a dsh.bundle declaration.
//
// Per candidate the packument is read once and filtered:
//   - at least one non-deprecated version            (versions[v].deprecated)
//   - that version declares dsh.bundle, and bundle.patch is covered by the
//     manifest's files array (when files is declared)
//   - name passes validate-npm-package-name
//   - not the market itself (dsh-plugin-market)
//
// Raw ingredients for build-index are cached to .cache/registry-raw.json.
import { writeFile, mkdir } from 'node:fs/promises'
import { fetchPackagesByKeywords, hasAllKeywords } from 'search-packages'
import validate from 'validate-npm-package-name'

const REGISTRY = 'https://registry.npmjs.org'
const KEYWORD = 'dsh-plugin'
const SELF_PACKAGE = 'dsh-plugin-market'
const PAGE_INTERVAL_MS = 200
const MAX_RETRIES = 2
const FALLBACK_MAX_RESULTS = 2500
const PACKUMENT_CONCURRENCY = 8
const CACHE = new URL('../.cache/registry-raw.json', import.meta.url)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = (name) => name.replace('/', '%2f')

// --- search path: paced fetch with capped, doubling-backoff retries ----------
let lastSearchRequestAt = 0
async function pacedSearchFetch(url, init) {
  for (let attempt = 0; ; attempt += 1) {
    const since = Date.now() - lastSearchRequestAt
    if (since < PAGE_INTERVAL_MS) await sleep(PAGE_INTERVAL_MS - since)
    lastSearchRequestAt = Date.now()
    let response
    try {
      response = await fetch(url, init)
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error
      await sleep(PAGE_INTERVAL_MS * 2 ** attempt) // 200ms, 400ms
      continue
    }
    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) throw new Error(`npm search 429 after ${attempt + 1} attempts`)
      await sleep(PAGE_INTERVAL_MS * 2 ** (attempt + 1)) // 400ms, 800ms — never immediate
      continue
    }
    return response
  }
}

async function searchCandidates() {
  try {
    const { packages, truncated } = await fetchPackagesByKeywords([KEYWORD], {
      maxResults: Number.POSITIVE_INFINITY,
      fetch: pacedSearchFetch,
    })
    return { packages, truncated, mode: 'maxResults=Infinity' }
  } catch (error) {
    console.log(`[collect] infinite paging refused (${error.message}); retrying with maxResults=${FALLBACK_MAX_RESULTS}`)
    const { packages, truncated } = await fetchPackagesByKeywords([KEYWORD], {
      maxResults: FALLBACK_MAX_RESULTS,
      fetch: pacedSearchFetch,
    })
    return { packages, truncated, mode: `maxResults=${FALLBACK_MAX_RESULTS}` }
  }
}

// --- packument path: concurrency-limited with 429 backoff ---------------------
async function fetchPackument(name) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${REGISTRY}/${enc(name)}`)
      if (response.status === 429) throw new Error('429')
      if (!response.ok) return null
      return await response.json()
    } catch (error) {
      if (attempt >= MAX_RETRIES) return null
      await sleep(400 * 2 ** attempt)
    }
  }
}

// bundle.patch covered by files? An absent/empty files array means npm packs
// everything, so the patch ships by default.
function patchCoveredByFiles(patchRel, files) {
  if (!Array.isArray(files) || files.length === 0) return true
  const patch = String(patchRel).replace(/^\.\//, '')
  return files.some((entry) => {
    const e = String(entry).replace(/^\.\//, '')
    return e === patch || e === '.' || (e.endsWith('/') && patch.startsWith(e))
  })
}

// peerDependencies ranges that speak about the DSH runtime: exactly
// @deepseek-ai/dsh, or the @deepseek-ai/dsh-* family.
function dshPeerRanges(peerDependencies) {
  if (!peerDependencies || typeof peerDependencies !== 'object') return []
  const out = []
  for (const [name, range] of Object.entries(peerDependencies)) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      if (typeof range === 'string' && range.length > 0) out.push(range)
    }
  }
  return out
}

function authorString(author) {
  if (typeof author === 'string' && author.trim()) return author.trim()
  if (author && typeof author === 'object' && typeof author.name === 'string' && author.name.trim()) {
    return author.name.trim()
  }
  return undefined
}

async function main() {
  // 1) candidate discovery
  const { packages, truncated, mode } = await searchCandidates()
  console.log(`[collect] search mode: ${mode}`)
  console.log(`[collect] search returned: ${packages.length} | truncated: ${truncated}`)
  const withKeyword = packages.filter((p) => hasAllKeywords(p.keywords, [KEYWORD]))
  console.log(`[collect] carrying the "${KEYWORD}" keyword (client-side hasAllKeywords): ${withKeyword.length}`)

  // 2) per-candidate packument + filters
  const stats = {
    packuments: 0, packumentFailed: 0,
    droppedSelf: 0, droppedBadName: 0,
    droppedNoLiveVersion: 0, droppedNoBundle: 0, droppedPatchNotInFiles: 0,
    kept: 0,
  }
  const dataset = []
  let cursor = 0
  async function worker() {
    while (cursor < withKeyword.length) {
      const pkg = withKeyword[cursor]
      cursor += 1
      const packument = await fetchPackument(pkg.name)
      if (!packument) { stats.packumentFailed += 1; continue }
      stats.packuments += 1
      if (pkg.name === SELF_PACKAGE) { stats.droppedSelf += 1; continue }
      // validate-npm-package-name v8 returns { validForNewPackages, validForOldPackages }.
      // New-package rules match the official checker's package-name grammar, so a
      // name that fails them would be rejected at verify time anyway.
      if (!validate(pkg.name).validForNewPackages) { stats.droppedBadName += 1; continue }

      const versions = packument.versions || {}
      const time = packument.time || {}
      const records = []
      let liveVersions = 0
      for (const [version, manifest] of Object.entries(versions)) {
        if (manifest && manifest.deprecated) continue
        liveVersions += 1
        const dsh = manifest && manifest.dsh
        if (!dsh || typeof dsh !== 'object' || !dsh.bundle) continue
        if (dsh.bundle.patch && !patchCoveredByFiles(dsh.bundle.patch, manifest.files)) continue
        records.push({
          version,
          publishTimestamp: typeof time[version] === 'string' ? Math.floor(Date.parse(time[version]) / 1000) : 0,
          topLevelDsh: typeof manifest.engines?.dsh === 'string' ? manifest.engines.dsh : null,
          dshEnginesDsh: typeof dsh.engines?.dsh === 'string' ? dsh.engines.dsh : null,
          peerRanges: dshPeerRanges(manifest.peerDependencies),
        })
      }
      if (liveVersions === 0) { stats.droppedNoLiveVersion += 1; continue }
      if (records.length === 0) {
        const anyBundle = Object.values(versions).some((m) => m && m.dsh && m.dsh.bundle)
        if (anyBundle) stats.droppedPatchNotInFiles += 1; else stats.droppedNoBundle += 1
        continue
      }
      const latest = packument['dist-tags'] && packument['dist-tags'].latest
      const latestManifest = (latest && versions[latest]) || {}
      dataset.push({
        name: pkg.name,
        description: typeof latestManifest.description === 'string'
          ? latestManifest.description
          : (typeof pkg.description === 'string' ? pkg.description : ''),
        keywords: Array.isArray(latestManifest.keywords)
          ? latestManifest.keywords.filter((k) => typeof k === 'string')
          : [],
        author: authorString(latestManifest.author),
        homepage: typeof latestManifest.homepage === 'string' ? latestManifest.homepage : undefined,
        icon: typeof latestManifest.icon === 'string'
          ? latestManifest.icon
          : (typeof latestManifest.dsh?.icon === 'string' ? latestManifest.dsh.icon : undefined),
        repository: typeof latestManifest.repository === 'string'
          ? latestManifest.repository
          : (typeof latestManifest.repository?.url === 'string' ? latestManifest.repository.url : undefined),
        title: { dshTitle: latestManifest.dsh?.title, displayName: latestManifest.displayName },
        versions: records,
      })
      stats.kept += 1
    }
  }
  await Promise.all(Array.from({ length: PACKUMENT_CONCURRENCY }, worker))

  // 3) cache the raw dataset (CACHE is <root>/.cache/registry-raw.json; the
  // directory itself is new URL('.', CACHE) — '..' would resolve to the root).
  const cacheDir = new URL('.', CACHE)
  try {
    await writeFile(CACHE, JSON.stringify(dataset, null, 2))
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      await mkdir(cacheDir, { recursive: true })
      await writeFile(CACHE, JSON.stringify(dataset, null, 2))
    } else {
      throw error
    }
  }

  const totalVersions = dataset.reduce((sum, d) => sum + d.versions.length, 0)
  console.log(`[collect] packuments read: ${stats.packuments} (failed: ${stats.packumentFailed})`)
  console.log(`[collect] dropped — self: ${stats.droppedSelf}, bad name: ${stats.droppedBadName}, no live version: ${stats.droppedNoLiveVersion}, no dsh.bundle: ${stats.droppedNoBundle}, patch not in files: ${stats.droppedPatchNotInFiles}`)
  console.log(`[collect] bundle packages kept: ${stats.kept}`)
  console.log(`[collect] bundle versions recorded: ${totalVersions}`)
  console.log(`[collect] cached -> ${CACHE.pathname}`)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
