#!/usr/bin/env node
// Guards the invariant the previous UI broke: every class used in markup has a
// rule in the stylesheets, and vice versa.
//
// Two implementations drifted apart once already — the Svelte rewrite renamed
// the markup (`kv__row`, `url-input`, `icon-btn`) while the stylesheet still
// targeted the old names (`kv`, `url`, `icon`), so the key/value grid, the URL
// field and the icon buttons silently rendered unstyled. This script fails the
// build if that happens again.
//
//   node tools/ui-class-check.mjs [--json]

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "frontend", "src");
const styleDir = join(sourceDir, "styles");
const jsonOutput = process.argv.includes("--json");

/** Class families assembled at runtime, e.g. `method-tag--{method}`. */
const DYNAMIC_FAMILIES = {
  "method-tag--": ["GET", "POST", "PUT", "PATCH", "DELETE"],
  "method-select--": ["GET", "POST", "PUT", "PATCH", "DELETE"],
  // `Sidebar.statusKind()` emits ok/err/cancelled; `ResponsePane` adds warn/none.
  "status-dot--": ["ok", "warn", "err", "none", "cancelled"],
};

const VALID_CLASS = /^[a-z][\w-]*$/;

function walk(directory, extension) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, extension));
    else if (path.endsWith(extension)) found.push(path);
  }
  return found;
}

function markupClasses() {
  const classes = new Set();
  const dynamic = new Set();

  for (const file of walk(sourceDir, ".svelte")) {
    const source = readFileSync(file, "utf8");
    const label = relative(root, file);

    for (const match of source.matchAll(/\bclass="([^"]*)"/g)) {
      for (const token of match[1].split(/\s+/)) {
        if (!token || token.includes("{")) {
          // `class="a {dynamic}"` — record the family prefix when we can see one.
          const prefix = token.split("{")[0];
          if (prefix) dynamic.add(prefix);
          continue;
        }
        if (VALID_CLASS.test(token)) classes.add(token);
      }
    }
    for (const match of source.matchAll(/\bclass:([a-zA-Z][\w-]*)/g)) {
      classes.add(match[1]);
    }
    for (const match of source.matchAll(/className=\{?["']([^"'}]*)/g)) {
      for (const token of match[1].split(/\s+/)) {
        if (VALID_CLASS.test(token)) classes.add(token);
      }
    }
    for (const match of source.matchAll(/["'`]([a-z][\w-]*__[\w-]*)/g)) {
      classes.add(match[1]);
    }
    void label;
  }
  return { classes, dynamic };
}

function styleClasses() {
  const classes = new Set();
  const names = new Set();
  for (const file of walk(styleDir, ".css")) {
    names.add(relative(root, file));
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of source.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)) {
      classes.add(match[1]);
    }
  }
  return { classes, names };
}

const markup = markupClasses();
const styles = styleClasses();

const missing = [...markup.classes].filter((name) => !styles.classes.has(name)).sort();
const dynamicMissing = [];
for (const [prefix, variants] of Object.entries(DYNAMIC_FAMILIES)) {
  if (!markup.dynamic.has(prefix) && ![...markup.classes].some((name) => name.startsWith(prefix))) {
    continue;
  }
  for (const variant of variants) {
    if (!styles.classes.has(prefix + variant)) dynamicMissing.push(prefix + variant);
  }
}

const unused = [...styles.classes]
  .filter((name) => {
    if (markup.classes.has(name)) return false;
    return !Object.keys(DYNAMIC_FAMILIES).some((prefix) =>
      DYNAMIC_FAMILIES[prefix].some((variant) => prefix + variant === name),
    );
  })
  .sort();

if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        markupClasses: [...markup.classes].sort(),
        styleFiles: [...styles.names].sort(),
        missing,
        dynamicMissing,
        unused,
      },
      null,
      2,
    ),
  );
  process.exit(missing.length || dynamicMissing.length ? 1 : 0);
}

let failures = 0;
const report = (label, items, detail) => {
  const ok = items.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (${items.length})`}`);
  if (!ok) {
    failures += 1;
    for (const item of items) console.log(`  ${detail} ${item}`);
  }
};

console.log(`stylesheets: ${[...styles.names].sort().join(", ")}`);
console.log(`markup classes: ${markup.classes.size}`);
report("every markup class has a rule", missing, "no rule for");
report("every runtime class variant has a rule", dynamicMissing, "no rule for");
console.log(`NOTE ${unused.length} stylesheet class(es) are not referenced by markup`);
if (unused.length) console.log(`  ${unused.join(" ")}`);

console.log(failures ? "CLASS CHECK FAILED" : "ALL CLASS CHECKS PASSED");
process.exit(failures ? 1 : 0);
