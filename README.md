# dsh-plugin-market

A DSH (DeepSeek Harness) bundle that provides plugin browsing/search and ships a
**format-1** plugin-market index validated by the official
`@deepseek-ai/dsh-plugin-market-index` checker.

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
├── cordis.patch.yml      # insert: { id, name } by package name
├── tsconfig.json         # server build (src/index.ts, src/install)
├── tsconfig.client.json  # web client build (src/client)
├── src/
│   ├── index.ts          # bundle entry; re-exports the install boundary
│   ├── install/boundary.ts  # the only permitted install implementation
│   └── client/index.tsx  # web client entry
├── scripts/
│   ├── verify-bundle.mjs # bundle hard-constraint checks
│   └── fix-client-out.mjs
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

Install into a clean DSH web profile:

```bash
dsh plugin --profile web add ./dsh-plugin-market-0.1.0.tgz
dsh --profile web --dump-config   # confirms the market row is composed
dsh plugin --profile web remove dsh-plugin-market
```
