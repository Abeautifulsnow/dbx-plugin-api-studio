#!/usr/bin/env node
// Loads the workbench through a REAL `dbx-plugin dev` host and checks that it
// renders inside the host's sandboxed plugin frame.
//
// `ui-boot-test.mjs` drives the bundle with a mock bridge, which proves the app
// itself works but not that DBX can load it. The dev host enforces the sandbox,
// CSP and asset boundaries, so this is the check that answers "does the packaged
// single-file UI actually load in the host?" — the question that a relative
// `<script type="module" src="./assets/…">` bundle would fail.
//
// Start the host first:
//   dbx-plugin dev --path . --port 5195
//   node tools/ui-dev-host-check.mjs --port 5195
//
// Zero dependencies (Node 22+). Set CHROME_PATH if Chrome is not in a default
// location. The host must already be running; this script only reads it.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const portArgument = process.argv.indexOf("--port");
const port = portArgument >= 0 ? process.argv[portArgument + 1] : "5195";
const hostUrl = `http://127.0.0.1:${port}/`;

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
  console.error("no Chrome/Edge/Chromium found; set CHROME_PATH");
  process.exit(2);
}

try {
  const probe = await fetch(hostUrl, { method: "GET" });
  if (!probe.ok) throw new Error(`status ${probe.status}`);
} catch (error) {
  console.error(`no dev host at ${hostUrl} (${error.message}) — start it with: dbx-plugin dev --path . --port ${port}`);
  process.exit(2);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log("PASS", name);
  else {
    failures += 1;
    console.log("FAIL", name, detail ?? "");
  }
}

const profile = mkdtempSync(join(tmpdir(), "api-studio-devh-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1440,900",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

async function debuggerUrl() {
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!existsSync(portFile)) continue;
    const [debugPort] = readFileSync(portFile, "utf8").split("\n");
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
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
const contextIds = [];
const frameErrors = [];
/** Sessions for out-of-process frames (the plugin frame is a sandboxed OOPIF). */
const attachedSessions = [];

function send(method, params = {}, sessionId) {
  const id = ++messageId;
  socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

/**
 * Evaluate in the shell page and in every attached OOPIF session, returning the
 * first non-null value. The plugin frame is sandboxed without
 * `allow-same-origin`, so it has an opaque origin and lives in its own process —
 * it is only reachable through an attached target session.
 */
async function evaluateInAnyFrame(expression) {
  const targets = [undefined, ...attachedSessions];
  for (const sessionId of targets) {
    const result = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: false },
      sessionId,
    );
    const value = result?.result?.result?.value;
    if (value !== undefined && value !== null && value !== false) return value;
  }
  return null;
}

/** Diagnostic dump used when the frame does not render. */
async function describeFrames() {
  for (const sessionId of [undefined, ...attachedSessions]) {
    const info = await send(
      "Runtime.evaluate",
      {
        expression:
          "JSON.stringify({ href: location.href, title: document.title, text: (document.body?.textContent ?? '').trim().replace(/\\s+/g, ' ').slice(0, 140) })",
        returnByValue: true,
      },
      sessionId,
    );
    console.log(`     frame${sessionId ? " (oopif)" : " (shell)"}:`, info?.result?.result?.value);
  }
}

try {
  socket = new WebSocket(await debuggerUrl());
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.executionContextCreated") {
      contextIds.push(message.params.context.id);
    }
    if (message.method === "Target.attachedToTarget") {
      attachedSessions.push(message.params.sessionId);
    }
    if (message.method === "Runtime.exceptionThrown") {
      frameErrors.push(
        message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text,
      );
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      frameErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });

  await send("Runtime.enable");
  await send("Page.enable");
  // Auto-attach is what makes the sandboxed plugin frame observable.
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send("Page.navigate", { url: hostUrl });

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const opened = await evaluateInAnyFrame(
    "[...document.querySelectorAll('button,a,[role=button],li')].find((element) => element.textContent.includes('工作台') && element.textContent.length < 40)?.click() ?? null",
  );
  void opened;

  const deadline = Date.now() + 20000;
  let rendered = null;
  while (Date.now() < deadline) {
    rendered = await evaluateInAnyFrame(
      "document.querySelector('.brand__title')?.textContent === 'API Studio' || null",
    );
    if (rendered) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  check("the host serves the workbench in a sandboxed frame", attachedSessions.length >= 1, `${attachedSessions.length} attached`);
  check("the workbench renders inside the host's sandboxed frame", !!rendered);
  if (!rendered) await describeFrames();
  if (rendered) {
    check(
      "the sidebar tree rendered",
      (await evaluateInAnyFrame("document.querySelector('.tree') ? 'yes' : null")) === "yes",
    );
    check(
      "the command row rendered",
      (await evaluateInAnyFrame("document.querySelector('.url-input') ? 'yes' : null")) === "yes",
    );
    check(
      "the response pane rendered",
      (await evaluateInAnyFrame("document.querySelector('.response__pane') ? 'yes' : null")) === "yes",
    );
    check(
      "the host theme reached the workbench",
      ["light", "dark"].includes(await evaluateInAnyFrame("document.body.dataset.theme || null")),
      await evaluateInAnyFrame("document.body.dataset.theme || null"),
    );
  }

  const frameCount = contextIds.length + attachedSessions.length;
  check("no console errors in any frame", frameErrors.length === 0, frameErrors.slice(0, 3).join(" | "));
  console.log(`     frames observed: ${frameCount}`);
} catch (error) {
  failures += 1;
  console.log("FAIL harness error:", error.message);
} finally {
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  await exited;
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold handles on Windows.
  }
}

console.log(failures ? `DEV HOST CHECK FAILED (${failures})` : "ALL DEV HOST CHECKS PASSED");
process.exit(failures ? 1 : 0);
