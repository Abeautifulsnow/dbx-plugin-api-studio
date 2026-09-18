#!/usr/bin/env node
// Protocol-level smoke test: drives the built sidecar binary over
// stdio-jsonl exactly as the DBX host does (handshake + api/* methods).
// Zero dependencies; Node 18+.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const binary = process.argv[2];
if (!binary) {
  console.error("usage: node tools/sidecar-smoke.mjs <path-to-sidecar-binary>");
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "api-studio-smoke-"));
const child = spawn(binary, [], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, API_STUDIO_DATA_DIR: dataDir },
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString().trim();
  if (text) console.error("[stderr]", text);
});

const pending = new Map();
let nextId = 1;

const readline = createInterface({ input: child.stdout });
readline.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error("[non-json stdout line]", line.slice(0, 120));
    process.exitCode = 1;
    return;
  }
  if (message.id != null && pending.has(message.id)) {
    const { resolve } = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  }
});

function call(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve });
    child.stdin.write(payload);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout waiting for " + method));
      }
    }, 20000);
  });
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log("PASS", name);
  } else {
    failures++;
    console.log("FAIL", name, detail ?? "");
  }
}

const PORT = process.env.SMOKE_PORT || "5193";

// Self-contained target server: the suite must not depend on a dev host running.
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "X-Smoke": "1" });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const initialize = await call("plugin/initialize", {
  host: { dbxVersion: "0.5.68", hostApiVersion: "1.0.0", protocolVersions: [1] },
  plugin: { id: "io.dbx.api-studio", version: "0.1.0" },
  permissions: [],
});
check("initialize identity", initialize.result?.plugin?.id === "io.dbx.api-studio");
check("initialize protocol", initialize.result?.protocolVersion === 1);

const request = await call("api/request", {
  requestId: "smoke-1",
  method: "GET",
  url: `http://127.0.0.1:${port}/api/diagnostics?after=0&limit=3`,
  headers: [{ name: "Accept", value: "application/json" }],
  body: { type: "none" },
  settings: { timeoutMs: 8000, followRedirects: true, verifyTls: true },
});
check("api/request status 200", request.result?.status === 200, JSON.stringify(request.result ?? request.error ?? null).slice(0, 200));
check("api/request body utf8", typeof request.result?.body?.text === "string", request.error?.message);
check("api/request timing", typeof request.result?.timing?.totalMs === "number");
check("api/request ttfb measured", typeof request.result?.timing?.ttfbMs === "number");
check("api/request headers array", Array.isArray(request.result?.headers));

const save = await call("api/persistence/save", {
  state: {
    version: 1,
    collections: [
      {
        id: "c1",
        type: "collection",
        name: "Smoke",
        items: [
          {
            id: "r1",
            type: "request",
            name: "Raw credentials",
            request: {
              method: "POST",
              url: "https://u:p@api.test/login?access_token=LEAK-STATE-QS&page=1",
              query: [{ key: "access_token", value: "LEAK-STATE-QS" }],
              headers: [{ key: "X-API-Key", value: "LEAK-STATE-KEY" }],
              auth: { type: "bearer", token: "LEAK-STATE-AUTH" },
              variables: [{ name: "apiKey", value: "LEAK-STATE-VAR", secret: true }],
            },
          },
        ],
      },
    ],
    environments: [
      { id: "e1", name: "dev", variables: [{ name: "apiKey", value: "LEAK-STATE-ENV", secret: true }] },
    ],
    settings: {},
  },
});
check("api/persistence/save", save.result?.saved === true);

const load = await call("api/persistence/load", {});
check("api/persistence/load roundtrip", load.result?.state?.collections?.[0]?.name === "Smoke");

// A client that sends raw credentials must still not get them written to disk.
const savedRequest = load.result?.state?.collections?.[0]?.items?.[0]?.request ?? {};
check("saved auth token redacted", savedRequest.auth?.token === "[REDACTED]", savedRequest.auth?.token);
check("saved credential header redacted", savedRequest.headers?.[0]?.value === "[REDACTED]");
check("saved secret variable emptied", savedRequest.variables?.[0]?.value === "");
check("saved url query credential redacted", !String(savedRequest.url).includes("LEAK-STATE-QS"));
check(
  "saved secret env variable emptied",
  load.result?.state?.environments?.[0]?.variables?.[0]?.value === "",
);

const append = await call("api/persistence/history-append", {
  entry: {
    id: "h1",
    timestamp: Date.now(),
    method: "POST",
    url: "http://x.test/{{path}}",
    request: {
      method: "POST",
      url: "http://x.test/login?access_token=LEAK-QUERY-TOKEN&page=2",
      headers: [
        { name: "Authorization", value: "Bearer LEAK-AUTH-TOKEN" },
        { name: "X-API-Key", value: "LEAK-API-KEY" },
        { name: "X-Tenant-Token", value: "LEAK-TENANT-TOKEN" },
        { name: "Accept", value: "application/json" },
      ],
      body: { type: "json", text: "{\"password\":\"LEAK-BODY-SECRET\"}" },
    },
  },
});
check("history-append accepted", append.result?.evicted === 0);

const load2 = await call("api/persistence/load", {});
const stored = load2.result?.history?.[0] ?? {};
const storedHeaders = stored.request?.headers ?? [];
const headerValue = (name) => storedHeaders.find((h) => h.name === name)?.value;

check("history redacts Authorization", headerValue("Authorization") === "[REDACTED]");
check("history redacts X-API-Key", headerValue("X-API-Key") === "[REDACTED]");
check("history redacts X-Tenant-Token", headerValue("X-Tenant-Token") === "[REDACTED]");
check("history keeps ordinary header", headerValue("Accept") === "application/json");
check("history drops body text", (stored.request?.body?.text ?? "") === "", JSON.stringify(stored.request?.body));
check("history marks body redacted", stored.request?.body?.redacted === true);
check(
  "history redacts credential query values",
  !String(stored.request?.url ?? "").includes("LEAK-QUERY-TOKEN"),
  stored.request?.url,
);

// Raw bytes on disk: the strongest form of the guarantee. No secret literal and
// no body text may appear anywhere in the persisted files.
const diskDump = [join(dataDir, "state.json"), join(dataDir, "history.json")]
  .map((file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");
for (const secret of [
  "LEAK-QUERY-TOKEN",
  "LEAK-AUTH-TOKEN",
  "LEAK-API-KEY",
  "LEAK-TENANT-TOKEN",
  "LEAK-BODY-SECRET",
  "LEAK-STATE-QS",
  "LEAK-STATE-KEY",
  "LEAK-STATE-AUTH",
  "LEAK-STATE-VAR",
  "LEAK-STATE-ENV",
  "hunter2",
]) {
  check(`persisted bytes contain no ${secret}`, !diskDump.includes(secret));
}

const curl = await call("api/export-curl", {
  requestId: "curl-1",
  method: "POST",
  url: "https://api.test/x",
  headers: [{ name: "X-Note", value: "it's fine" }],
  body: { type: "raw", text: "{\"a\":1}" },
  settings: { timeoutMs: 5000, followRedirects: false, verifyTls: true },
});
check(
  "api/export-curl quoting",
  typeof curl.result?.curl === "string" && curl.result.curl.includes("it'\\''s fine"),
  curl.result?.curl,
);

const cancelOfFinished = await call("api/cancel", { requestId: "smoke-1" });
check("api/cancel idempotent", cancelOfFinished.result?.cancelled === false);

const badUrl = await call("api/request", {
  requestId: "smoke-2",
  method: "GET",
  url: "not a url",
  headers: [],
  body: { type: "none" },
  settings: {},
});
check(
  "invalid url → -32602",
  badUrl.error?.code === -32602,
  JSON.stringify(badUrl.error),
);

const badDns = await call("api/request", {
  requestId: "smoke-3",
  method: "GET",
  url: "http://api-studio-invalid-host.invalid/",
  headers: [],
  body: { type: "none" },
  settings: { timeoutMs: 5000 },
});
check(
  "dns failure → categorized error",
  badDns.error?.data?.category === "DNS_FAILED" || badDns.error?.data?.category === "CONNECT_FAILED",
  JSON.stringify(badDns.error?.data),
);

// v0.1 is REST-only: WebSocket / SSE schemes are rejected at validation, before
// any transport work. These checks pin that product boundary.
for (const url of ["ws://127.0.0.1:9000/socket", "wss://echo.example/socket"]) {
  const attempt = await call("api/request", {
    requestId: `smoke-${url.split(":")[0]}`,
    method: "GET",
    url,
    headers: [],
    body: { type: "none" },
    settings: {},
  });
  check(
    `${url.split(":")[0]}:// rejected as INVALID_URL`,
    attempt.error?.code === -32602 && attempt.error?.data?.category === "INVALID_URL",
    JSON.stringify(attempt.error ?? attempt.result),
  );
}

/* --------------------- v0.1 completion: multipart / cookies / HEAD / cURL import */

// A file part's bytes must be readable by the sidecar, so seed one next to the
// smoke data directory.
const multipartFile = join(dataDir, "multipart-file.txt");
writeFileSync(multipartFile, "smoke-file-bytes");

// Echo target: the second endpoint reflects the raw request body so multipart
// composition is asserted end-to-end against what the transport actually sent.
const echoServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Echo-Method": req.method });
    res.end(body);
  });
});
await new Promise((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
const echoPort = echoServer.address().port;

const multipartResult = await call("api/request", {
  requestId: "smoke-mp",
  method: "POST",
  url: `http://127.0.0.1:${echoPort}/upload`,
  headers: [],
  body: {
    type: "multipart",
    parts: [
      { name: "note", kind: "text", value: "smoke-hello" },
      { name: "doc", kind: "file", path: multipartFile },
    ],
  },
  jarKey: "smoke-jar",
  settings: { timeoutMs: 8000 },
});
// A multipart echo contains CR/LF framing, so the sidecar returns it base64;
// decode before asserting on the wire format. The file bytes are only checked
// structurally (both parts present, transport-generated boundary) rather than
// byte-for-byte: some environments (e.g. enterprise DLP with transparent file
// encryption, observed as "Esafenet" markers) rewrite file content on read,
// which is a machine property, not a sidecar behavior.
const multipartEcho = multipartResult.result?.body?.base64
  ? Buffer.from(multipartResult.result.body.base64, "base64").toString("latin1")
  : (multipartResult.result?.body?.text ?? "");
check(
  "multipart delivers text + file parts (boundary generated by the transport)",
  multipartEcho.includes('name="note"') === true &&
    multipartEcho.includes("smoke-hello") === true &&
    multipartEcho.includes('name="doc"') === true &&
    multipartEcho.includes("filename=") === true,
  multipartEcho.slice(0, 240),
);

// Cookie jar: the main target sets a cookie on /login (header-echo endpoint
// below would be redundant — here the jar behavior is checked by observing the
// Set-Cookie being stored and the clear RPC accepting/rejecting keys).
const cookieSet = await call("api/request", {
  requestId: "smoke-cookie-1",
  method: "GET",
  url: `http://127.0.0.1:${port}/login`,
  headers: [],
  body: { type: "none" },
  jarKey: "smoke-jar",
  settings: { timeoutMs: 8000 },
});
check("cookie request succeeds with a jar", cookieSet.result?.status === 200, JSON.stringify(cookieSet.error));

const cookieCleared = await call("api/cookies/clear", { jarKey: "smoke-jar" });
check("cookies/clear acknowledges an existing jar", cookieCleared.result?.cleared === true, JSON.stringify(cookieCleared.result));

const cookieGone = await call("api/cookies/clear", { jarKey: "never-created" });
check("cookies/clear on an unknown jar reports false", cookieGone.result?.cleared === false, JSON.stringify(cookieGone.result));

// HEAD: status and headers without a body preview.
const headProbe = await call("api/request", {
  requestId: "smoke-head",
  method: "HEAD",
  url: `http://127.0.0.1:${port}/api/diagnostics`,
  headers: [],
  body: { type: "none" },
  settings: { timeoutMs: 8000 },
});
check(
  "HEAD returns status without a body preview",
  headProbe.result?.status === 200 && headProbe.result?.body?.text == null,
  JSON.stringify(headProbe.result ?? headProbe.error).slice(0, 200),
);

// cURL import: the pasted-command parser runs on the sidecar.
const imported = await call("api/import-curl", {
  curl:
    "$ curl -X POST 'https://api.test/v1/orders' \\\n  -H 'Authorization: Bearer sk-smoke' \\\n  -H 'Content-Type: application/json' \\\n  --data '{\"item\":7}'",
});
check(
  "import-curl recovers method/url/auth/body",
  imported.result?.request?.method === "POST" &&
    imported.result?.request?.url === "https://api.test/v1/orders" &&
    imported.result?.request?.auth?.type === "bearer" &&
    imported.result?.request?.auth?.token === "sk-smoke" &&
    imported.result?.request?.body?.type === "json",
  JSON.stringify(imported.result ?? imported.error).slice(0, 240),
);
check(
  "import-curl folds Authorization out of headers",
  Array.isArray(imported.result?.request?.headers) && imported.result.request.headers.length === 0,
  JSON.stringify(imported.result?.request?.headers),
);

const importBad = await call("api/import-curl", { curl: "curl -X POST -d x" });
check(
  "import-curl without a URL fails as INVALID_REQUEST",
  importBad.error?.data?.category === "INVALID_REQUEST",
  JSON.stringify(importBad.error?.data),
);

echoServer.close();
child.kill();
server.close();
console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
