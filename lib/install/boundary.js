import { randomUUID } from 'node:crypto';
function classify(e) {
    if (e && typeof e === 'object' && 'message' in e) {
        return String(e.message);
    }
    return String(e);
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
export async function installPlugin(pnpm, args, profileDir, packageName, packageVersion, signal) {
    if (args[0] !== 'add') {
        return { ok: false, reason: `unsupported install action: ${String(args[0] ?? '<none>')}` };
    }
    if (!pnpm || typeof pnpm.runPluginInstall !== 'function') {
        return { ok: false, reason: '宿主不支持可恢复安装边界' };
    }
    const receiptId = randomUUID();
    try {
        await pnpm.runPluginInstall(args, profileDir, { packageName, packageVersion, receiptId }, signal);
        return { ok: true };
    }
    catch (e) {
        await pnpm.rollbackPluginInstall(receiptId);
        return { ok: false, reason: classify(e) };
    }
}
