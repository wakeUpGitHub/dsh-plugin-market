// DSH web client entry for dsh-plugin-market.
//
// Phase 1 gates business UI on the install-boundary proof, so this stub only
// fulfils the `dsh.client.platform: "web"` loading contract: it registers a
// no-op browser half with the page module loader, the same way the shipped
// client bundles do (window.__ModuleLoader__.load({ id, factory })). The real
// Discover UI lands in a later phase.

interface ModuleLoader {
  load(def: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
}

const loader = (globalThis as unknown as { __ModuleLoader__?: ModuleLoader }).__ModuleLoader__

loader?.load({
  id: 'dsh-plugin-market',
  factory: () => {
    const module = { exports: {} as Record<string, unknown> }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    // Phase 1: the browser half mounts nothing yet.
    exports.apply = function apply(): void {}
    return module.exports
  },
})

export default function clientEntry(): void {
  // no-op placeholder for the Phase 1 boundary gate
}
