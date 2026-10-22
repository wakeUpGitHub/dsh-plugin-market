"use strict";
// DSH web client entry for dsh-plugin-market.
//
// Phase 1 gates business UI on the install-boundary proof, so this stub only
// fulfils the `dsh.client.platform: "web"` loading contract.
//
// CONTRACT (verified against @deepseek-ai/dsh-client-modules): the page loads
// every plugin's client half as a CLASSIC script (document.createElement
// ("script")), and executing the bundle must REGISTER its factory — and
// nothing else — via `window.__ModuleLoader__.load({ id, factory })`.
// ESM syntax is fatal here: a classic script carrying `import`/`export`
// throws a SyntaxError, the script's load event still fires, and the loader
// then reports `bundle <url> loaded without registering "<id>"`. Every module
// side effect (including CSS injection) must live INSIDE the factory closure,
// because the body runs at materialization, not at script execution.
//
// This file therefore contains no import and no export statement on purpose.
const moduleLoader = window.__ModuleLoader__;
moduleLoader.load({
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
