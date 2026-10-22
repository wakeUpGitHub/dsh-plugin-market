// DSH web client entry for dsh-plugin-market.
//
// Phase 1 gates business UI on the install-boundary proof, so this stub only
// fulfils the `dsh.client.platform: "web"` loading contract: it registers a
// no-op browser half with the page module loader, the same way the shipped
// client bundles do (window.__ModuleLoader__.load({ id, factory })). The real
// Discover UI lands in a later phase.
const loader = globalThis.__ModuleLoader__;
loader?.load({
    id: 'dsh-plugin-market',
    factory: () => {
        const module = { exports: {} };
        const exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        // Phase 1: the browser half mounts nothing yet.
        exports.apply = function apply() { };
        return module.exports;
    },
});
export default function clientEntry() {
    // no-op placeholder for the Phase 1 boundary gate
}
