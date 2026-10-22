// scripts/fix-client-out.mjs
// The client compiles to lib/client/index.js (preserving the src/ tree
// layout). DSH's `exports["./client"]` expects ./lib/client.js, so move the
// emitted entry into place and drop the now-empty directory.

import { existsSync, renameSync, rmSync } from 'node:fs'

const from = 'lib/client/index.js'
const to = 'lib/client.js'

if (!existsSync(from)) {
  console.error(`Expected compiled client at ${from}; run the build first.`)
  process.exit(1)
}

renameSync(from, to)
try {
  rmSync('lib/client', { recursive: true, force: true })
} catch {
  // ignore: directory may already be gone or contain other artifacts
}
console.log('client entry -> lib/client.js')
