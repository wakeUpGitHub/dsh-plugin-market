// DSH bundle entry for dsh-plugin-market.
//
// Phase 1 only needs the install boundary (server side) to hold; the runtime
// contributions (market tool, index reader, client wiring) are added in later
// phases. The `apply` hook is intentionally minimal here.
export const name = 'dsh-plugin-market';
// Cordis lifecycle hook. Real registrations land here in later phases.
export function apply(_ctx) {
    // no-op for the Phase 1 boundary gate
}
// Re-export the recoverable install boundary. The DSH host calls this during
// `dsh plugin add`; it must go through the host's runPluginInstall, never the
// raw runPlugin path.
export { installPlugin } from './install/boundary.js';
