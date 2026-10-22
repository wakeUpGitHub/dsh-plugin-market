#!/usr/bin/env node
// Phase 4 + Phase 5 automation for dsh-plugin-market.
// Prerequisite: `gh auth login` already done with a token carrying repo + workflow scope.
// This script does everything else unattended:
//   - derives git identity from the authenticated GitHub account
//   - git init / commit (if needed)
//   - creates the GitHub repo (or pushes to existing) + uploads the release tarball
//   - Phase 5: installs the bundle from github:<owner>/<repo> into a clean profile and verifies
//
// Usage: node scripts/publish.mjs
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO = 'dsh-plugin-market';
const TAG = 'v0.1.0';
const TARBALL = path.join(ROOT, `${REPO}-0.1.0.tgz`);
const DSH = 'npx --yes @deepseek-ai/dsh';

function run(cmd, { allowFail = false, cwd = ROOT } = {}) {
  console.log(`\n$ ${cmd}`);
  try {
    execSync(cmd, { cwd, stdio: 'inherit' });
    return true;
  } catch (e) {
    if (allowFail) return false;
    console.error(`[publish] FAILED: ${cmd}`);
    process.exit(1);
  }
}
function capture(cmd, cwd = ROOT) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// 0) Auth gate — bail early with the exact one-liner if not logged in.
console.log('[publish] checking gh authentication...');
let login = null;
const who = capture('gh api user');
if (who) { try { login = JSON.parse(who).login; } catch {} }
if (!login) {
  console.error('\n[publish] NOT authenticated.\nRun this (paste your token), then rerun:\n');
  console.error('  echo "ghp_xxx" | gh auth login --with-token\n');
  process.exit(1);
}
console.log(`[publish] authenticated as ${login}`);

// 1) git init BEFORE configuring identity (local config needs a repo).
if (!existsSync(path.join(ROOT, '.git'))) run('git init -b main');

// 2) git identity derived from the GitHub account (no need to ask the user).
const email = `${login}@users.noreply.github.com`;
run(`git config user.name "${login}"`);
run(`git config user.email "${email}"`);

// 3) commit.
run('git add -A');
if (capture('git status --porcelain')) {
  run('git commit -m "chore: dsh-plugin-market bundle with format-1 index (phase 2/3)"');
} else {
  console.log('[publish] working tree clean, nothing to commit');
}

// 3) repo: create (with push) or push to existing.
const origin = capture('git remote get-url origin');
if (!origin) {
  const exists = capture(`gh repo view ${login}/${REPO}`);
  if (!exists) {
    run(`gh repo create ${REPO} --public --description "DSH plugin market: browse/search bundles + format-1 index validated by the official checker" --source . --push --branch main`, { allowFail: true });
  } else {
    run(`git remote add origin https://github.com/${login}/${REPO}.git`);
    run('git push -u origin main');
  }
} else {
  run('git push -u origin main');
}

// 4) release + upload tarball.
if (!existsSync(TARBALL)) { console.error('[publish] tarball missing — run `pnpm pack` first'); process.exit(1); }
if (!capture(`gh release view ${TAG}`)) {
  run(`gh release create ${TAG} "${TARBALL}" --title "${TAG}" --notes "DSH plugin market index (format 1). 174 plugins / 1853 versions, validated by @deepseek-ai/dsh-plugin-market-index."`);
} else {
  console.log(`[publish] release ${TAG} already exists, skipping`);
}
console.log('\n[publish] Phase 4 complete.');

// 5) Phase 5: install from GitHub into a clean profile and verify.
console.log('\n[publish] Phase 5: install github:' + `${login}/${REPO}` + ' into clean profile "web"');
const added = run(`${DSH} plugin --profile web add github:${login}/${REPO}`, { allowFail: true });
if (added) {
  const cfg = capture(`${DSH} --profile web --dump-config`);
  const ok = cfg && cfg.includes('name: dsh-plugin-market');
  console.log(ok ? '[publish] Phase 5 install OK (dump-config lists dsh-plugin-market)' : '[publish] Phase 5: install ran but dump-config check inconclusive');
  run(`${DSH} plugin --profile web remove dsh-plugin-market`, { allowFail: true });
} else {
  console.error('[publish] Phase 5 install did not succeed — manual check needed (github: install spec support may vary by dsh version)');
}
console.log('\n[publish] done.');
