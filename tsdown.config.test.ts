import { defineConfig } from "tsdown";

/**
 * Test-only bundle: the pure logic modules as a plain ESM file
 * (lib-test/index.js) consumable by `node --test` — no React, no
 * ModuleLoader wrapper, no DSH runtime assumptions.
 */
export default defineConfig({
  entry: { index: "src/lib.ts" },
  format: ["esm"],
  target: "es2020",
  outDir: "lib-test",
  sourcemap: false,
  dts: false,
  clean: true,
  deps: {
    neverBundle: ["react", "react/jsx-runtime"],
    alwaysBundle: ["@huggingface/tokenizers"],
  },
});