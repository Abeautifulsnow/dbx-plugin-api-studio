#!/usr/bin/env node
// dbx-plugin-sdk is not published to crates.io — it ships inside the
// @dbx-app/plugin-cli npm package. This writes a root `.cargo/config.toml`
// patching the crate to the CLI's bundled copy, so `cargo` resolves the SDK
// no matter which working directory inside the repo it runs from. CI runs
// this after installing the CLI; locally you can pass the SDK directory
// explicitly (e.g. when the CLI is installed globally):
//   node tools/setup-sdk-patch.mjs <path-to-dbx-plugin-sdk>
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let sdkDir = process.argv[2];
if (!sdkDir) {
  const pkgDir = execSync("npm ls @dbx-app/plugin-cli --parseable", {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/)
    .pop();
  sdkDir = join(pkgDir, "sdk-root", "plugins", "sdk", "rust", "dbx-plugin-sdk");
}

if (!existsSync(join(sdkDir, "Cargo.toml"))) {
  console.error(
    `dbx-plugin-sdk not found at ${sdkDir}\n` +
      "Install the DBX plugin CLI (npm install @dbx-app/plugin-cli) or pass the SDK path explicitly.",
  );
  process.exit(1);
}

mkdirSync(join(root, ".cargo"), { recursive: true });
const tomlPath = JSON.stringify(sdkDir.replaceAll("\\", "/"));
writeFileSync(
  join(root, ".cargo", "config.toml"),
  `[patch.crates-io]\ndbx-plugin-sdk = { path = ${tomlPath} }\n`,
);
console.log(`wrote .cargo/config.toml -> ${sdkDir}`);
