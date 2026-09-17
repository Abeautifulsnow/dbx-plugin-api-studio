import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  root: "frontend",
  plugins: [svelte()],
  base: "./",
  build: {
    // Keep the legacy UI alongside the new bundle until every feature has
    // crossed the framework boundary. The manifest is switched only after
    // parity verification.
    outDir: "../ui/svelte",
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
