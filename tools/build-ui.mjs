#!/usr/bin/env node
// Builds the workbench UI into a single self-contained `ui/index.html`.
//
// Two steps: Vite bundles `frontend/src` into a classic (IIFE) script, then the
// script and the stylesheet are inlined into the HTML shell. Inlining is what the
// DBX sandbox requires — a packaged `<script type="module" src="./assets/…">` is
// not loadable through the asset bridge (references/host-api.md §6).
//
// Used both as the `[dev].ui_build` command and as `npm run build:ui`. The dev
// host only reloads plugin frames after a build prints the standalone line
// `DBX_UI_BUILD_SUCCESS` (references/debugging.md §2).

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, rmSync, existsSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, ".ui-build");
const outputFile = join(root, "ui", "index.html");
const watchMode = process.argv.includes("--watch");

/** A `</script>` inside the bundle would close the inline tag early. */
function safeForInlineScript(source) {
  return source.split("</script").join("<\\/script").split("<!--").join("<\\!--");
}

function inline() {
  const script = readFileSync(join(buildDir, "app.js"), "utf8");
  const styleFile = readdirSync(buildDir).find((name) => name.endsWith(".css"));
  const style = styleFile ? readFileSync(join(buildDir, styleFile), "utf8") : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>API Studio</title>
    <style>
${style}
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script>
${safeForInlineScript(script)}
    </script>
  </body>
</html>
`;
  writeFileSync(outputFile, html, "utf8");
  rmSync(buildDir, { recursive: true, force: true });
  return html.length;
}

function viteCommand() {
  return process.platform === "win32"
    ? { command: "npx.cmd", args: ["vite", "build"] }
    : { command: "npx", args: ["vite", "build"] };
}

let running = false;
let queued = false;

function build() {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  const { command, args } = viteCommand();
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("close", (code) => {
    running = false;
    if (code === 0) {
      try {
        const bytes = inline();
        console.log(`ui/index.html written (${(bytes / 1024).toFixed(1)} kB)`);
        console.log("DBX_UI_BUILD_SUCCESS");
      } catch (error) {
        console.error(`inlining failed: ${error.message}`);
        if (!watchMode) process.exitCode = 1;
      }
    } else if (!watchMode) {
      process.exitCode = code || 1;
    }
    if (queued) {
      queued = false;
      build();
    }
  });
}

if (!existsSync(join(root, "frontend"))) {
  console.error("frontend/ is missing; nothing to build");
  process.exit(2);
}

build();

if (watchMode) {
  watch(join(root, "frontend"), { recursive: true }, () => build());
}
