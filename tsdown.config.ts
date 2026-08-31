import { defineConfig } from "tsdown";

/**
 * Produce the DSH client-plugin bundle shape consumed by the browser module
 * loader (window.__ModuleLoader__.load): a CJS-flavored factory whose free
 * `require(...)` calls resolve through the loader's own require, with react
 * externalized (provided by the DSH web shell). Output: lib/client.js
 * (+ lib/client.js.map) — the only file `/plugins/dsh-composer-tokens/` serves.
 */
export default defineConfig({
  entry: { client: "src/client/index.ts" },
  format: ["cjs"],
  target: "es2020",
  outDir: "lib",
  outExtensions: () => ({ js: ".js" }),
  sourcemap: true,
  dts: false,
  clean: true,
  deps: {
    // react / react/jsx-runtime are provided by the DSH web shell;
    // @huggingface/tokenizers must be inlined (the browser loader's require
    // cannot resolve arbitrary npm packages).
    neverBundle: ["react", "react/jsx-runtime"],
    alwaysBundle: ["@huggingface/tokenizers"],
  },
  banner: `window.__ModuleLoader__.load({ "id": "dsh-composer-tokens", "factory": (require) => { var module = { exports: {} }; var exports = module.exports; `,
  footer: `return module.exports; }});`,
});