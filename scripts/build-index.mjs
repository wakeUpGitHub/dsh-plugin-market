#!/usr/bin/env node
// Phase 2 builder (spec 2.3-2.5): .cache/registry-raw.json -> site/index.json.
//
// Every entry is constructed to the same rules parseMarketIndex enforces, so
// the artifact cannot be rejected at verify time. Highlights:
//   - engines.dsh per-version precedence: top-level engines.dsh ->
//     dsh.engines.dsh -> peer fallback (intersection of @deepseek-ai/dsh /
//     @deepseek-ai/dsh-* peerDependencies ranges) -> discard the version.
//     The source of every kept version is counted and reported.
//   - install specs are derived ONLY through marketInstallTarget (spec 2.4);
//     a missing export is a hard stop, never a hand-built string.
//   - zh (and any non-en locale) appears only when the source data carries it.
//   - format is the integer 1 (spec 2.5).
// Phase 3 fields (evidenceLevel / evidence-lX labels / sortKeys) are retained
// from the previously accepted phase and remain pipeline-derived.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'
const require = createRequire(import.meta.url)
const semver = require('semver')

const ROOT = new URL('..', import.meta.url)
const RAW = new URL('.cache/registry-raw.json', ROOT)
// Acceptance form: `node scripts/build-index.mjs --output site/index.json`.
function resolveOutput() {
  const args = process.argv.slice(2)
  const i = args.indexOf('--output')
  if (i >= 0 && args[i + 1]) return resolve(process.cwd(), args[i + 1])
  return fileURLToPath(new URL('index.json', new URL('site/', ROOT)))
}
const OUT = resolveOutput()
const MAX_INLINE_ICON_BYTES = 32 * 1024

// Spec 2.4: the official helper must exist; never fall back to string concat.
if (typeof marketInstallTarget !== 'function') {
  console.error('FATAL: @deepseek-ai/dsh-plugin-market-index does not export marketInstallTarget — refusing to hand-build install specs (spec 2.4 stop condition).')
  process.exit(1)
}

// The exact SemVer grammar parseMarketIndex uses for `version`.
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][\\w-]*)`
const SEMVER = new RegExp(`^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`, 'u')
const MAX_PUBLISH_TIMESTAMP = 1e11
const DATA_ICON = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/

function humanize(name) {
  const base = name.startsWith('@') ? name.split('/')[1] : name
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
function validRange(range) {
  if (typeof range !== 'string') return null
  const r = range.trim()
  if (!r || r.startsWith('workspace:')) return null
  try { if (semver.validRange(r) === null) return null } catch { return null }
  return r
}

// engines.dsh precedence (spec 2.3). Returns { dsh, source } — dsh null means
// the version is discarded. No mixing of sources, no union.
function enginesFor(record) {
  const top = validRange(record.topLevelDsh)
  if (top) return { dsh: top, source: 'top-level' }
  const nested = validRange(record.dshEnginesDsh)
  if (nested) return { dsh: nested, source: 'dsh.engines' }
  const distinct = [...new Set((record.peerRanges || []).map(validRange).filter(Boolean))]
  if (distinct.length === 1) return { dsh: distinct[0], source: 'peer-fallback' }
  if (distinct.length > 1) {
    // Only accept one range when it is a subset of every other (the common
    // lockstep case, e.g. an exact version inside a caret range). Refuse to
    // synthesize an intersection the ecosystem does not declare.
    for (const candidate of distinct) {
      if (distinct.every((other) => other === candidate || semver.subset(candidate, other))) {
        return { dsh: candidate, source: 'peer-fallback' }
      }
    }
    return { dsh: null, source: 'peer-ambiguous' }
  }
  return { dsh: null, source: 'none' }
}

// Localized text: a string becomes { en }; an object is copied as-is when it
// carries en. Non-en locales survive only when the source declares them.
function localizedOrNull(value) {
  if (typeof value === 'string' && value.trim()) return { en: value.trim() }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const [lang, text] of Object.entries(value)) {
      if (typeof text === 'string' && text.trim()) out[lang] = text.trim()
    }
    if (out.en) return out
  }
  return null
}
function titleOf(rec, humanized) {
  for (const candidate of [rec.title?.dshTitle, rec.title?.displayName]) {
    const loc = localizedOrNull(candidate)
    if (loc) return loc
  }
  return { en: humanized }
}

// Icons: absolute https URLs and valid inline data: URLs only. A relative
// asset path has no meaningful base in an index context — resolving it against
// the index host would ship a dead URL, so it is omitted (counted, not faked).
function iconOf(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { kind: 'missing' }
  const text = raw.trim()
  if (text.startsWith('data:')) {
    const m = DATA_ICON.exec(text)
    if (!m) return { kind: 'invalid-data' }
    const payload = m[1]
    const decoded = payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)
    if (decoded > MAX_INLINE_ICON_BYTES) return { kind: 'too-large' }
    return { kind: 'data', value: text }
  }
  try {
    const url = new URL(text)
    if (url.protocol === 'https:') return { kind: 'absolute', value: url.href }
    if (url.protocol === 'http:') return { kind: 'http-omitted' }
  } catch { /* relative or malformed */ }
  return { kind: 'relative-omitted' }
}

function normalizeRepoUrl(raw) {
  if (typeof raw !== 'string') return undefined
  let s = raw.trim()
  if (s.startsWith('git+')) s = s.slice(4)
  let url
  try { url = new URL(s) } catch { return undefined }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password) return undefined
  if (url.href.includes('?') || url.href.includes('#')) return undefined
  return url.href
}

// Keyword-based category heuristic (spec 2.3, optional field): first rule wins,
// "other" is the accepted fallback. Signals come from the package's keywords
// and name tokens only — no human judgment.
const CATEGORY_RULES = [
  ['i18n', ['i18n', 'locale', 'language', 'translation', 'l10n', 'chinese', 'english', ' bilingual']],
  ['theme', ['theme', 'skin', 'wallpaper', 'appearance', 'css', 'pet', 'mascot', 'badge', 'cursor', 'font']],
  ['cost', ['cost', 'billing', 'usage', 'token', 'quota', 'meter', 'price', 'subscription', 'limits', 'credits', 'balance', 'stats', 'statistics']],
  ['model', ['model', 'models', 'llm', 'provider', 'proxy', 'gateway', 'channel', 'api-key', 'router', 'reasoning', 'thinking', 'openai', 'claude', 'gemini', 'qwen', 'kimi']],
  ['session', ['session', 'memory', 'context', 'history', 'chat', 'conversation', 'title', 'summary', 'compact', 'compression', 'resume', 'checkpoint']],
  ['tools', ['tool', 'tools', 'mcp', 'integration', 'browser', 'search', 'filesystem', 'shell', 'terminal', 'office', 'excel', 'docs', 'web', 'fetch']],
  ['ui', ['ui', 'ux', 'widget', 'layout', 'sidebar', 'render', 'markdown', 'visualize', 'chart', 'component', 'face', 'panel', 'dialog']],
  ['dev', ['dev', 'git', 'test', 'build', 'debug', 'workflow', 'ci', 'vcs', 'code', 'refactor', 'review', 'lint', 'typescript']],
  ['agent', ['agent', 'team', 'subagent', 'skill', 'command', 'slash', 'prompt', 'persona', 'goal', 'plan', 'todo', 'approval', 'permission', 'mode', 'preset']],
  ['system', ['storage', 'settings', 'config', 'credential', 'account', 'automation', 'job', 'schedule', 'hook', 'monitor', 'notification', 'update', 'manager', 'inventory']],
]
function categoryOf(keywords, name) {
  const kws = keywords.map((k) => k.toLowerCase())
  const nameTokens = name.replace(/^@[^/]+\//, '').split(/[-_./]+/).filter(Boolean).map((t) => t.toLowerCase())
  for (const [id, words] of CATEGORY_RULES) {
    if (words.some((w) => kws.some((k) => k === w.trim() || k.includes(w.trim())))) return id
  }
  for (const [id, words] of CATEGORY_RULES) {
    if (words.some((w) => nameTokens.some((t) => t === w.trim() || t.includes(w.trim())))) return id
  }
  return 'other'
}

async function main() {
  const raw = JSON.parse(await readFile(RAW, 'utf8'))
  const plugins = []
  const versionSourceCounts = { 'top-level': 0, 'dsh.engines': 0, 'peer-fallback': 0 }
  const entryOnlyViaPeerFallback = { count: 0 }
  const iconCounts = {}
  const categoryCounts = {}
  let skippedNoEngine = 0, skippedPeerAmbiguous = 0, skippedBadVersion = 0, skippedBadSpec = 0

  for (const pkg of raw) {
    if (!pkg.versions || pkg.versions.length === 0) continue
    const kept = []
    for (const record of pkg.versions) {
      const { dsh, source } = enginesFor(record)
      if (!dsh) {
        if (source === 'peer-ambiguous') skippedPeerAmbiguous += 1; else skippedNoEngine += 1
        continue
      }
      if (!SEMVER.test(record.version)) { skippedBadVersion += 1; continue }
      const ts = Number.isInteger(record.publishTimestamp) ? record.publishTimestamp : Math.floor(record.publishTimestamp || 0)
      if (!(ts >= 0 && ts < MAX_PUBLISH_TIMESTAMP)) { skippedBadVersion += 1; continue }
      const versionEntry = {
        version: record.version,
        publishTimestamp: ts,
        source: { type: 'npm' },
        engines: { dsh },
      }
      // Spec 2.4: the install spec comes from the official helper, never concat.
      const target = marketInstallTarget(pkg.name, versionEntry)
      if (!target || typeof target.spec !== 'string' || target.spec.length === 0) {
        skippedBadSpec += 1
        continue
      }
      if (target.registry) versionEntry.source.registry = target.registry
      kept.push({ entry: versionEntry, source })
    }
    if (kept.length === 0) continue
    kept.sort((a, b) => semver.rcompare(a.entry.version, b.entry.version))
    const versions = kept.map((k) => k.entry)
    for (const k of kept) versionSourceCounts[k.source] += 1
    if (kept.every((k) => k.source === 'peer-fallback')) entryOnlyViaPeerFallback.count += 1

    const humanized = humanize(pkg.name)
    const title = titleOf(pkg, humanized)
    const description = localizedOrNull(pkg.description)
    const icon = iconOf(pkg.icon)
    iconCounts[icon.kind] = (iconCounts[icon.kind] || 0) + 1
    const repo = normalizeRepoUrl(pkg.repository)
    const hasHome = typeof pkg.homepage === 'string' && /^https?:\/\//.test(pkg.homepage)
    const category = categoryOf(pkg.keywords || [], pkg.name)
    categoryCounts[category] = (categoryCounts[category] || 0) + 1
    const keywords = [...new Set((pkg.keywords || []).filter((k) => typeof k === 'string' && k.length > 0))]

    // Phase 3 evidence level: derived from registry signals only (L0-L2).
    const hasRepo = !!repo
    const hasDesc = !!description
    let level = 0
    if (hasRepo && hasHome && hasDesc && versions.length >= 2) level = 2
    else if ((hasRepo || hasHome) && hasDesc) level = 1
    const updatedTs = versions.reduce((m, v) => Math.max(m, v.publishTimestamp), 0)

    plugins.push({
      name: pkg.name,
      // Literal evidence level (pipeline-produced). parseMarketIndex drops
      // members the format does not define; the evidence-lX label below is
      // the carrier that survives validation.
      evidenceLevel: `L${level}`,
      title,
      ...(description ? { description } : {}),
      ...(icon.value ? { icon: icon.value } : {}),
      ...(pkg.author ? { author: pkg.author } : {}),
      ...(hasHome ? { homepage: pkg.homepage } : {}),
      ...(repo ? { repository: { url: repo } } : {}),
      metadata: {
        category,
        keywords,
        labels: [`evidence-l${level}`],
        sortKeys: { evidence: level + 1, updated: updatedTs, stars: 0 },
      },
      versions,
    })
  }

  const index = {
    format: 1,
    title: { en: 'DSH Plugin Market', 'zh-cn': 'DSH 插件市场' },
    description: {
      en: 'A curated market of DSH (DeepSeek Harness) plugin bundles sourced from the npm registry.',
      'zh-cn': '从 npm registry 采集整理的 DSH（DeepSeek Harness）插件市场索引。',
    },
    metadata: {
      categories: {
        theme: { title: { en: 'Themes & appearance', 'zh-cn': '主题与外观' } },
        cost: { title: { en: 'Cost & usage', 'zh-cn': '费用与用量' } },
        model: { title: { en: 'Models & channels', 'zh-cn': '模型与渠道' } },
        session: { title: { en: 'Sessions & memory', 'zh-cn': '会话与记忆' } },
        tools: { title: { en: 'Tools & integrations', 'zh-cn': '工具与集成' } },
        ui: { title: { en: 'UI & interaction', 'zh-cn': '界面与交互' } },
        dev: { title: { en: 'Development', 'zh-cn': '开发工程' } },
        i18n: { title: { en: 'Localization', 'zh-cn': '本地化' } },
        agent: { title: { en: 'Agents & skills', 'zh-cn': '智能体与技能' } },
        system: { title: { en: 'System & settings', 'zh-cn': '系统与设置' } },
        other: { title: { en: 'Other', 'zh-cn': '其他' } },
      },
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
  }

  await mkdir(new URL('site/', ROOT), { recursive: true })
  await writeFile(OUT, JSON.stringify(index, null, 2))

  const totalVersions = plugins.reduce((sum, p) => sum + p.versions.length, 0)
  const otherShare = plugins.length ? (categoryCounts.other || 0) / plugins.length : 0
  console.log(`[build] plugins: ${plugins.length} (>=50 gate: ${plugins.length >= 50 ? 'PASS' : 'FAIL'})`)
  console.log(`[build] total versions: ${totalVersions} (no per-plugin cap: every qualifying version)`)
  console.log(`[build] engines.dsh sources (versions): top-level=${versionSourceCounts['top-level']} dsh.engines=${versionSourceCounts['dsh.engines']} peer-fallback=${versionSourceCounts['peer-fallback']}`)
  console.log(`[build] entries existing only via peer fallback: ${entryOnlyViaPeerFallback.count} of ${plugins.length}`)
  console.log(`[build] discarded versions — no engine: ${skippedNoEngine}, peer-ambiguous: ${skippedPeerAmbiguous}, bad version/timestamp: ${skippedBadVersion}, no install spec: ${skippedBadSpec}`)
  console.log(`[build] icons: ${JSON.stringify(iconCounts)}`)
  console.log(`[build] categories: ${JSON.stringify(categoryCounts)} (other share: ${(otherShare * 100).toFixed(1)}%)`)
  console.log(`[build] -> ${OUT}`)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
