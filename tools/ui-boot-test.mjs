#!/usr/bin/env node
// Boots the SHIPPED `ui/index.html` in a real headless browser and asserts that
// the workbench actually renders.
//
// Why this exists: the previous Svelte port shipped a bundle whose very first
// render threw (`placeholder="…/users/{{userId}}"` compiled to a template
// interpolation), so the workbench sat on its loading screen and no test noticed
// — `ui-redaction-test.mjs` was still asserting against the retired vanilla
// sources. This suite loads the built artifact, drives it with a mock host, and
// fails on any page exception or console error.
//
// The mock host serves a v1 persisted state on purpose: environment variables
// keyed by `name`, rows without ids, `settings.ui` present. That is exactly the
// shape that used to crash the keyed `{#each}` blocks and lose pane sizes.
//
// Zero dependencies (Node 22+ has a global WebSocket). Chrome, Edge or Chromium
// must be installed, or set CHROME_PATH.
//
//   node tools/ui-boot-test.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const bundlePath = join(root, "ui", "index.html");

if (!existsSync(bundlePath)) {
  console.error("ui/index.html is missing — run `node tools/build-ui.mjs` first");
  process.exit(2);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error("no Chrome/Edge/Chromium found; set CHROME_PATH to run this suite");
  process.exit(2);
}

/* ------------------------------------------------------------------ fixtures */

const LEGACY_STATE = {
  version: 1,
  collections: [
    {
      id: "col_legacy",
      type: "collection",
      name: "Legacy Collection",
      items: [
        {
          id: "fld_legacy",
          type: "folder",
          name: "Examples",
          items: [
            {
              id: "req_legacy",
              type: "request",
              name: "Legacy GET",
              request: {
                version: 1,
                name: "Legacy GET",
                method: "GET",
                url: "https://example.test/v1/items?token=LEGACY-TOKEN",
                // v1 rows carry no id; a keyed {#each} over these used to throw.
                query: [],
                headers: [
                  { name: "Accept", value: "application/json" },
                  { name: "X-Api-Key", value: "LEGACY-KEY" },
                ],
                auth: { type: "none" },
                body: { type: "none", text: "" },
                variables: [],
                settings: { timeoutMs: 15000, followRedirects: true, maxRedirects: 5, verifyTls: true },
              },
            },
          ],
        },
      ],
    },
  ],
  environments: [
    {
      id: "env_legacy",
      name: "Production",
      prodLike: true,
      confirmUnsafe: true,
      // v1 environment variables are keyed by `name`.
      variables: [
        { name: "base_url", value: "https://example.test", secret: false },
        { name: "api_key", value: "LEGACY-SECRET", secret: true },
      ],
    },
  ],
  settings: {
    selectedEnvId: "env_legacy",
    previewCapBytes: 1048576,
    ui: { sidebarWidth: 312, historyOpen: true, editorH: 58, responseView: "tree", sidebarCollapsed: false },
  },
};

const LEGACY_HISTORY = [
  {
    id: "h_legacy",
    timestamp: Date.now() - 60000,
    method: "POST",
    url: "https://example.test/v1/submit?access_token=LEGACY-HISTORY-TOKEN",
    name: "Legacy POST",
    status: 500,
    request: {
      name: "Legacy POST",
      method: "POST",
      url: "https://example.test/v1/submit?access_token=LEGACY-HISTORY-TOKEN",
      query: [],
      headers: [{ name: "Content-Type", value: "application/json" }],
      auth: { type: "none" },
      body: { type: "json", text: '{"secret":"LEGACY-BODY"}', redacted: true },
      variables: [],
      settings: {},
    },
  },
];

const HOST_MOCK = `
<script>
  window.__calls = [];
  window.dbxPlugin = {
    ready: Promise.resolve(),
    locale: "en",
    theme: { appearance: "dark" },
    context: {},
    invoke: (method, params) => {
      window.__calls.push({ method, params });
      if (method === "api/persistence/load") {
        return Promise.resolve({ state: ${JSON.stringify(LEGACY_STATE)}, history: ${JSON.stringify(LEGACY_HISTORY)} });
      }
      if (method === "api/request") {
        return Promise.resolve({
          requestId: params.requestId, status: 200, statusText: "OK",
          headers: [{ name: "Content-Type", value: "application/json" }, { name: "Set-Cookie", value: "sid=abc; Path=/; HttpOnly" }],
          contentType: "application/json", body: { text: JSON.stringify({ ok: true, items: [1, 2], nested: { deep: "value" } }), base64: null, truncated: false, sizeBytes: 48 },
          finalUrl: params.url, redirectCount: 0, timing: { totalMs: 42, ttfbMs: 30, downloadMs: 12 },
        });
      }
      if (method === "api/export-curl") return Promise.resolve({ curl: "curl -X GET 'https://example.test'" });
      return Promise.resolve({ ok: true });
    },
  };
</script>
`;

/* ------------------------------------------------------------- test harness */

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log("PASS", name);
  else {
    failures += 1;
    console.log("FAIL", name, detail ?? "");
  }
}

const server = createServer((request, response) => {
  const html = readFileSync(bundlePath, "utf8").replace("<body>", `<body>${HOST_MOCK}`);
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), "api-studio-boot-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // A 1440x900 viewport keeps the desktop layout (the 900px media query would
    // otherwise narrow the sidebar and skew the layout assertions).
    "--window-size=1440,900",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

async function cleanup() {
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  await exited;
  server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome can still hold a handle on Windows; the OS temp dir will reclaim it.
  }
}

async function debuggerUrl() {
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!existsSync(portFile)) continue;
    const [port] = readFileSync(portFile, "utf8").split("\n");
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is not listening yet.
    }
  }
  throw new Error("Chrome did not expose a debugging target");
}

let socket;
let messageId = 0;
const pending = new Map();
const pageErrors = [];
const consoleErrors = [];

function send(method, params = {}) {
  const id = ++messageId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.text ?? "evaluation failed");
  }
  return result?.result?.result?.value;
}

async function waitFor(expression, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  console.log(`FAIL timed out waiting for ${label}`);
  failures += 1;
  return false;
}

try {
  const url = await debuggerUrl();
  socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: pageUrl });

  /* 1. the workbench renders at all */
  const rendered = await waitFor("!!document.querySelector('.app')", "the workbench shell");
  check("workbench renders (no boot-screen crash)", rendered);

  if (rendered) {
    const loadFailure = await evaluate("document.querySelector('.app__notice')?.textContent ?? ''");
    if (loadFailure) console.log("     load notice:", loadFailure.trim());

    // Persistence is debounced; wait for the first save before asserting on what
    // the UI decided to write.
    const saved = await waitFor(
      "window.__calls.some((call) => call.method === 'api/persistence/save')",
      "the first persisted save",
      6000,
    );
    check("workbench persists state", saved);
    const lastSavedState = () =>
      evaluate(
        "JSON.stringify(window.__calls.filter((c) => c.method === 'api/persistence/save').slice(-1)[0]?.params?.state ?? null)",
      );

    /* 2. legacy state survived migration */
    check(
      "collections from v1 state are shown",
      (await evaluate("document.querySelector('.tree')?.textContent ?? ''")).includes("Legacy Collection"),
      await evaluate("document.querySelector('.tree')?.textContent"),
    );
    check(
      "folders from v1 state are shown (no seed overwrite)",
      (await evaluate("document.querySelector('.tree')?.textContent ?? ''")).includes("Examples"),
    );
    check(
      "seeded sample data was not written over stored collections",
      !(await lastSavedState()).includes("My Collection"),
    );
    check(
      "environment variables keyed by `name` are migrated to `key`",
      (await lastSavedState()).includes('"base_url"'),
    );
    check(
      "persisted schema is upgraded to v2",
      (await evaluate(
        "window.__calls.filter((c) => c.method === 'api/persistence/save').slice(-1)[0]?.params?.state?.version",
      )) === 2,
    );
    check(
      "layout preference from settings.ui is preserved",
      (await evaluate("getComputedStyle(document.querySelector('.app')).gridTemplateColumns.split(' ')[0]")) === "312px",
      await evaluate("getComputedStyle(document.querySelector('.app')).gridTemplateColumns"),
    );

    /* 3. legacy rows without ids do not break the keyed each blocks */
    await evaluate("document.querySelectorAll('.tabs__tab')[1]?.click()");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const headerRows = await evaluate("document.querySelectorAll('.kv__row').length");
    check("legacy header rows render after migration", headerRows === 2, `got ${headerRows}`);
    check("row ids were synthesised", (await evaluate("!!document.querySelector('.kv__row input[type=checkbox]')")) === true);

    /* 4. credentials are masked, and secret env values never persist */
    check(
      "credential-named header value is masked in the editor",
      (await evaluate(
        "document.querySelectorAll('.kv__row input[type=password]').length > 0",
      )) === true,
    );
    check("secret environment value is emptied before saving", !(await lastSavedState()).includes("LEGACY-SECRET"));
    check("save payload carries no legacy API key", !(await lastSavedState()).includes("LEGACY-KEY"));
    check("save payload carries no URL query credential", !(await lastSavedState()).includes("LEGACY-TOKEN"));

    /* 6. theme + icons */
    check("theme is applied from the host", (await evaluate("document.body.dataset.theme")) === "dark");
    check(
      "icons are SVG, not text glyphs",
      (await evaluate("document.querySelectorAll('.app svg').length")) > 10,
      await evaluate("document.querySelectorAll('.app svg').length"),
    );
    check(
      "no unicode structure glyphs remain in the shell",
      !/[↗＋▱▰◷⌂⧙⚙➤▣◌▤▥]/.test(await evaluate("document.querySelector('.app')?.textContent ?? ''")),
    );

    /* 7. sending a request renders a response */
    await evaluate("document.querySelector('.btn.send')?.click()");
    const gotResponse = await waitFor("!!document.querySelector('.response__meta')", "a response summary");
    check("response summary appears after Send", gotResponse);
    if (gotResponse) {
      check(
        "status, timing and size are rendered",
        (await evaluate("document.querySelector('.response__meta')?.textContent ?? ''")).includes("OK"),
      );
      await evaluate(
        "[...document.querySelectorAll('.tabs__tab')].find((button) => button.textContent.includes('Cookies'))?.click()",
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      const cookieText = await evaluate("document.querySelector('.cookies__row')?.textContent ?? ''");
      // The name and the value are separate cells: "sid" + "abc" + attributes.
      check(
        "Set-Cookie headers appear in the Cookies tab",
        cookieText.includes("sid") && cookieText.includes("abc") && cookieText.includes("HttpOnly"),
        cookieText || await evaluate(
          "JSON.stringify({ tabs: [...document.querySelectorAll('.response .tabs__tab')].map((b) => b.textContent), pane: document.querySelector('.response__pane')?.textContent?.slice(0, 200) })",
        ),
      );
    }
  }
} catch (error) {
  failures += 1;
  console.log("FAIL harness error:", error.message);
} finally {
  cleanup();
}

check("no uncaught page exceptions", pageErrors.length === 0, pageErrors.join(" | "));
check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

console.log(failures ? `BOOT TEST FAILED (${failures})` : "ALL BOOT CHECKS PASSED");
process.exit(failures ? 1 : 0);
