import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * The workbench is packaged as ONE self-contained `ui/index.html`.
 *
 * The DBX sandbox only loads UI assets that are inline or fetched through the
 * asset bridge (references/host-api.md §6), so Vite builds a single classic
 * script here and `tools/build-ui.mjs` inlines it together with the stylesheet.
 * Library mode is used precisely because it does not emit an HTML entry with a
 * relative `<script type="module" src>` pointing at a hashed file.
 */
export default defineConfig({
  root: "frontend",
  plugins: [svelte()],
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "ApiStudioWorkbench",
      fileName: () => "app.js",
    },
    cssCodeSplit: false,
    outDir: "../.ui-build",
    emptyOutDir: true,
    target: "es2020",
  },
});
