#!/usr/bin/env node
import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const watchMode = process.argv.includes("--watch");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let running = false;
let queued = false;

function build() {
  if (running) { queued = true; return; }
  running = true;
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:ui"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  child.on("close", (code) => {
    running = false;
    if (code === 0) {
      console.log("DBX_UI_BUILD_SUCCESS");
    } else if (!watchMode) {
      process.exitCode = code || 1;
    }
    if (queued) { queued = false; build(); }
  });
}

build();
if (watchMode) {
  watch("frontend", { recursive: true }, () => build());
}
