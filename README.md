# dsh-plugin-market

A DSH (DeepSeek Harness) bundle that provides plugin browsing/search and ships a
**format-1** plugin-market index validated by the official
`@deepseek-ai/dsh-plugin-market-index` checker.

Repository: https://github.com/wakeUpGitHub/dsh-plugin-market
Release: https://github.com/wakeUpGitHub/dsh-plugin-market/releases/tag/v0.1.0

## Hard constraints (do not violate)

1. `package.json` must declare `dsh.bundle.patch` and `files` must include
   `cordis.patch.yml`. A package that only declares `dsh.client` is not
   activated by `dsh plugin add`.
2. The install action must call the host's recoverable install boundary
   (`pnpm.runPluginInstall`). The Desktop host hard-blocks `add` through the
   legacy `runPlugin` path.
3. The index JSON must pass `parseMarketIndex(value, indexUrl)`. Any rule
   violation rejects the whole index with a JSON path.

## Layout

```
dsh-plugin-market/
├── package.json          # declares dsh.bundle.patch + dsh.client.platform:web
├── cordis.patch.yml      # top-level array of patch entries with insert lists
├── tsconfig.json         # server build (src/index.ts, src/install)
├── tsconfig.client.json  # web client build (src/client)
├── src/
│   ├── index.ts          # bundle entry; re-exports the install boundary
│   ├── install/boundary.ts  # the only permitted install implementation
│   └── client/index.tsx  # web client entry (Phase 1 stub, __ModuleLoader__ contract)
├── scripts/
│   ├── verify-bundle.mjs # bundle hard-constraint checks
│   ├── collect.mjs       # npm registry -> .cache/registry-raw.json
│   ├── build-index.mjs   # raw -> site/index.json (format 1)
│   ├── verify-index.mjs  # official parseMarketIndex gate + Phase 2/3 gates
│   └── fix-client-out.mjs
├── site/index.json       # the published format-1 index
├── EVIDENCE.md
└── LICENSE
```

## Develop

```bash
pnpm install
pnpm build
node scripts/verify-bundle.mjs   # must all PASS
pnpm pack                        # dsh-plugin-market-0.1.0.tgz
```

> Sandbox note: `.npmrc` pins `node-linker=hoisted` because this build sandbox
> cannot create the symlinks pnpm's default isolated layout needs
> (`node_modules/.bin/tsc` never materializes and `pnpm build` dies with
> MODULE_NOT_FOUND). `semver` and `@deepseek-ai/dsh-package-manifest` are
> explicit devDependencies so the official checker's runtime imports resolve
> from the hoisted root.

## Index pipeline (format 1)

```bash
node scripts/collect.mjs                               # npm registry -> .cache/registry-raw.json
node scripts/build-index.mjs --output site/index.json  # raw -> site/index.json
node scripts/verify-index.mjs site/index.json          # official gate + Phase 2/3 gates
```

The collector searches the npm registry with `search-packages`'
`fetchPackagesByKeywords(['dsh-plugin'])` (paced ≥200 ms per page, capped
retries, `truncated` recorded), reads each candidate's packument once, and
keeps only packages with a non-deprecated version declaring `dsh.bundle`
whose `bundle.patch` ships in the manifest's `files`. The builder mirrors the
official validator's rules before writing: `engines.dsh` per version follows
the precedence top-level `engines.dsh` → `dsh.engines.dsh` → peer fallback
(intersection of `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer ranges) →
discard, and every kept version's source is counted in the build log. Install
specs are never hand-built: they come from the official
`marketInstallTarget(name, version)`, which `verify-index.mjs` also exercises
per entry as a gate.

**Format generation:** this index is generated for
`@deepseek-ai/dsh-plugin-market-index@0.2.1-rc.2` and same-generation
validators. If a DSH upgrade makes the discovery page white-screen, first
check that the validator version and the index format generation still match.

## Install into a DSH profile

From a local tarball:

```bash
dsh plugin --profile web add ./dsh-plugin-market-0.1.0.tgz
dsh --profile web --dump-config   # confirms the market row is composed
dsh plugin --profile web remove dsh-plugin-market
```

From GitHub (published release v0.1.0):

```bash
dsh plugin --profile web add github:wakeUpGitHub/dsh-plugin-market
```

## Documented compromises

See `EVIDENCE.md`. In short: the task book's `peerDependencies` wildcard
(`"@deepseek-ai/dsh-*": "*"`) is rejected by pnpm's resolver (404 on the
literal name), so the package declares concrete host-provided peers instead
(`@deepseek-ai/cordis`, `@deepseek-ai/dsh-app-boot`); no `@deepseek-ai/dsh-*`
package ever enters `dependencies`.
