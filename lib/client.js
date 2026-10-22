// DSH web client entry for dsh-plugin-market.
//
// Phase 1 forbids committing any business UI under src/client/ before the
// install-boundary gate passes. This is a compile-only stub so the
// `dsh.client.platform: "web"` export resolves; the real market UI is added in
// a later phase.
export default function clientEntry() {
    // no-op placeholder for the Phase 1 boundary gate
}
