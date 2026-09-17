#!/usr/bin/env node
// Zero-dependency UI bundler: inlines ui/src sources into ui/index.html.
// The sandboxed workbench requires self-contained HTML (no relative module
// URLs, no CDN), so the built artifact is the single committed entry file.
//
// Usage:
//   node tools/build-ui.mjs           # one-shot build
//   node tools/build-ui.mjs --watch   # rebuild on change (prints
//                                     # DBX_UI_BUILD_SUCCESS after each
//                                     # successful full build, per dev-host
//                                     # auto-reload contract)
//   node tools/build-ui.mjs --emit-js <path>
//                                     # also write the concatenated sources as
//                                     # a loadable script with a test epilogue,
//                                     # so tests exercise the shipped sources.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "ui", "src");
const outFile = join(root, "ui", "index.html");

// JS files are concatenated in order inside one shared IIFE scope.
const JS_FILES = [
  "js/00-utils.js",
  "js/05-i18n.js",
  "js/10-state.js",
  "js/15-rpc.js",
  "js/20-variables.js",
  "js/25-jsonview.js",
  "js/30-kv.js",
  "js/35-dialogs.js",
  "js/40-sidebar.js",
  "js/45-editor.js",
  "js/50-response.js",
  "js/60-shortcuts.js",
  "js/90-main.js",
];

async function build() {
  const shell = await readFile(join(srcDir, "shell.html"), "utf8");
  const css = await readFile(join(srcDir, "styles.css"), "utf8");
  const chunks = [];
  for (const file of JS_FILES) {
    chunks.push(`/* ==== ${file} ==== */`);
    chunks.push(await readFile(join(srcDir, file), "utf8"));
  }
  const js = chunks.join("\n\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>API Studio</title>
<style>
${css}
</style>
</head>
<body>
${shell}
<script>
"use strict";
(function () {
${js}
})();
</script>
</body>
</html>
`;
  await writeFile(outFile, html, "utf8");
  return html.length;
}

let watching = false;
async function run() {
  try {
    const bytes = await build();
    console.log(`[build-ui] wrote ui/index.html (${bytes} bytes)`);
    const emitIndex = process.argv.indexOf("--emit-js");
    if (emitIndex >= 0) {
      const target = process.argv[emitIndex + 1];
      if (!target) throw new Error("--emit-js requires a path");
      await emitTestBundle(target);
      console.log(`[build-ui] wrote ${target}`);
    }
    if (watching) {
      // Dev-host auto-reload contract: one standalone line after every
      // fully successful build. Never printed on failures.
      console.log("DBX_UI_BUILD_SUCCESS");
    }
  } catch (error) {
    console.error(`[build-ui] failed: ${error.message}`);
    if (!watching) process.exitCode = 1;
  }
}

/** Emit the same concatenated sources as a loadable script exposing the pure
 * redaction helpers, so tests cover exactly what ships in index.html. */
async function emitTestBundle(target) {
  const chunks = [];
  for (const file of JS_FILES) {
    chunks.push(await readFile(join(srcDir, file), "utf8"));
  }
  const epilogue = `
globalThis.__API_STUDIO_TEST__ = {
  State,
  persistableState,
  sanitizeRequestForPersistence,
  redactRequestForHistory,
  isSensitiveHeaderName,
  isSensitiveQueryName,
  isPlainVariableReference,
  redactUrlForHistory,
  redactCredentialValue,
  defaultRequest,
  newRow,
  newRequestItem,
  newCollection,
};
`;
  await writeFile(
    target,
    `"use strict";\n(function () {\n${chunks.join("\n\n")}\n${epilogue}})();\n`,
    "utf8",
  );
}

if (process.argv.includes("--watch")) {
  watching = true;
  const { watch } = await import("node:fs");
  let timer;
  watch(srcDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(run, 80);
  });
  console.log("[build-ui] watching ui/src …");
}
await run();
