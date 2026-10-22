// scripts/verify-bundle.mjs
// Verifies the bundle skeleton meets DSH's hard constraints before publishing.
// Exit code 0 = all checks PASS; non-zero = at least one FAIL.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

let allPass = true

function check(name, cond, detail) {
  const status = cond ? 'PASS' : 'FAIL'
  if (!cond) allPass = false
  const tail = detail ? ` — ${detail}` : ''
  console.log(`[${status}] ${name}${tail}`)
}

// 1. dsh.bundle.patch points to an existing file.
const patchRel = pkg?.dsh?.bundle?.patch
const patchPath = patchRel ? resolve(root, patchRel) : null
check(
  'dsh.bundle.patch points to an existing file',
  !!patchPath && existsSync(patchPath),
  patchRel ?? '(dsh.bundle.patch missing)'
)

// 2. files array includes cordis.patch.yml.
const files = pkg.files ?? []
check('files includes cordis.patch.yml', files.includes('cordis.patch.yml'), JSON.stringify(files))

// 3. dsh.client declared AND ./client present in exports.
const clientDeclared = !!(pkg?.dsh?.client)
const clientInExports = !!(pkg.exports && Object.keys(pkg.exports).includes('./client'))
check('dsh.client declared', clientDeclared)
check('./client present in exports', clientInExports, clientDeclared ? '' : '(dsh.client missing)')

// 4. dependencies must NOT include any @deepseek-ai/dsh-* package.
const deps = pkg.dependencies ?? {}
const badDep = Object.keys(deps).find((k) => k.startsWith('@deepseek-ai/dsh'))
check(
  'dependencies excludes @deepseek-ai/dsh-*',
  !badDep,
  badDep ? `found "${badDep}" in dependencies` : 'ok'
)

// 5. The client bundle must be a classic script. The page loads each plugin's
//    client half via <script src> (document.createElement), so ESM syntax in
//    lib/client.js throws a SyntaxError while the load event still fires — the
//    loader then reports "loaded without registering ... via
//    __ModuleLoader__.load". Regression guard for that failure mode.
const clientExport = pkg.exports?.['./client']
const clientPath = clientExport ? resolve(root, clientExport) : null
if (!clientPath || !existsSync(clientPath)) {
  check('client bundle exists at exports["./client"]', false, clientExport ?? '(missing)')
} else {
  const raw = readFileSync(clientPath, 'utf8')
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/.*$/gm, '$1')
  const esm = /^\s*import[\s({'"]|^\s*export[\s{*]|(^|[^\w.])export\s+default|(^|[^\w.])export\s*\{/m.test(code)
  check(
    'client bundle is a classic script (no ESM syntax)',
    !esm,
    esm ? 'found import/export statements — classic <script> loading would fail' : clientExport
  )
}

console.log(allPass ? '\nAll bundle checks PASSED.' : '\nBundle checks FAILED.')
process.exit(allPass ? 0 : 1)
