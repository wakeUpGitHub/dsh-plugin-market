import { randomUUID } from 'node:crypto'

/**
 * The host-owned recoverable install boundary. DSH passes this object to the
 * plugin's `installPlugin` during `dsh plugin add`. It is NOT the npm `pnpm`
 * binary: it is the host's install API that supports a receipt-scoped,
 * rollback-able install. The Desktop host hard-blocks `add` through the legacy
 * `runPlugin` path, so every install must route through `runPluginInstall`.
 */
export interface RecoverableInstallHost {
  runPluginInstall(
    args: readonly string[],
    profileDir: string,
    opts: { packageName: string; packageVersion: string; receiptId: string },
    signal?: AbortSignal
  ): Promise<unknown>
  rollbackPluginInstall(receiptId: string): Promise<void>
}

export type InstallResult = { ok: true } | { ok: false; reason: string }

function classify(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message)
  }
  return String(e)
}

/**
 * The only permitted implementation of the install action.
 *
 * Hard rules (task book):
 *  - args[0] must be "add".
 *  - Must call pnpm.runPluginInstall; must NEVER call runPlugin.
 *  - If the host does not expose runPluginInstall, return
 *    { ok: false, reason: "宿主不支持可恢复安装边界" } and do not downgrade.
 */
export async function installPlugin(
  pnpm: RecoverableInstallHost,
  args: readonly string[],
  profileDir: string,
  packageName: string,
  packageVersion: string,
  signal?: AbortSignal
): Promise<InstallResult> {
  if (args[0] !== 'add') {
    return { ok: false, reason: `unsupported install action: ${String(args[0] ?? '<none>')}` }
  }

  if (!pnpm || typeof pnpm.runPluginInstall !== 'function') {
    return { ok: false, reason: '宿主不支持可恢复安装边界' }
  }

  const receiptId = randomUUID()
  try {
    await pnpm.runPluginInstall(args, profileDir, { packageName, packageVersion, receiptId }, signal)
    return { ok: true }
  } catch (e) {
    await pnpm.rollbackPluginInstall(receiptId)
    return { ok: false, reason: classify(e) }
  }
}
