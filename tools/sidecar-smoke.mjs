#!/usr/bin/env node
// Protocol-level smoke test: drives the built sidecar binary over
// stdio-jsonl exactly as the DBX host does (handshake + api/* methods).
// Zero dependencies; Node 18+.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync } from "node:fs";
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

child.kill();
server.close();
console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
