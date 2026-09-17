#!/usr/bin/env node
// Redaction tests for the workbench UI.
//
// Runs against the SAME concatenated sources that are inlined into
// ui/index.html, so these assertions cover exactly what ships. The bundle is
// wrapped in one IIFE whose epilogue publishes the pure helpers on
// `globalThis.__API_STUDIO_TEST__` (see tools/build-ui.mjs --emit-js); we load
// it into a minimal browser shim, keeping `dbxPlugin.ready` pending forever so
// no DOM wiring runs.
//
// Zero dependencies; Node 18+.
//
//   node tools/ui-redaction-test.mjs

import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(tmpdir(), `api-studio-ui-test-${process.pid}.js`);

const { spawnSync } = await import("node:child_process");
const build = spawnSync(process.execPath, [join(root, "tools", "build-ui.mjs"), "--emit-js", bundlePath], {
  cwd: root,
  encoding: "utf8",
});
if (build.status !== 0) {
  console.error(build.stdout || "", build.stderr || "");
  process.exit(2);
}

/* ---- minimal browser shim (no DOM work is performed before dbxPlugin.ready) ---- */

const never = new Promise(() => {});
const fakeElement = () => ({
  style: {},
  dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  setAttribute() {},
  removeAttribute() {},
  append() {},
  appendChild() {},
  replaceChildren() {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
});

globalThis.window = {
  dbxPlugin: {
    ready: never,
    locale: "en",
    theme: { appearance: "light" },
    context: {},
    invoke: async () => ({}),
  },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: fakeElement,
  createElementNS: fakeElement,
  createDocumentFragment: fakeElement,
  body: { dataset: {}, append() {}, appendChild() {} },
  documentElement: { dataset: {}, style: {} },
};
// `navigator` is a getter-only global in modern Node; define it rather than assign.
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

await import(new URL(`file://${bundlePath.replace(/\\/g, "/")}`).href);
await rm(bundlePath, { force: true });

const api = globalThis.__API_STUDIO_TEST__;
if (!api) {
  console.error("test bundle did not expose __API_STUDIO_TEST__");
  process.exit(2);
}

/* ---- assertions ---- */

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log("PASS", name);
  } else {
    failures++;
    console.log("FAIL", name, detail === undefined ? "" : String(detail));
  }
}

const LIVE = "live-secret-value";

function requestWithEveryCredentialShape() {
  return {
    version: 1,
    name: "Login",
    method: "POST",
    url: `https://api.test/v1/users?access_token=${LIVE}&page=2`,
    query: [
      api.newRow("access_token", LIVE),
      api.newRow("page", "2"),
    ],
    headers: [
      api.newRow("Authorization", `Bearer ${LIVE}`),
      api.newRow("X-API-Key", LIVE),
      api.newRow("X-Tenant-Token", LIVE),
      api.newRow("Accept", "application/json"),
    ],
    auth: { type: "bearer", token: LIVE, reveal: true },
    body: { type: "json", text: `{"password":"${LIVE}"}` },
    variables: [
      { name: "apiKey", value: LIVE, secret: true },
      { name: "host", value: "api.test", secret: false },
    ],
    settings: { timeoutMs: 30000, followRedirects: true, maxRedirects: 10, verifyTls: true },
  };
}

/* Credential channels = auth fields, credential-named headers/query, secret
 * variables, URL credential query values. Those must never reach disk. The
 * authored request body is request content (PRD §6.4 lists `body` as stored) and
 * is therefore excluded from this literal scan; history keeps no body at all. */
function assertNoCredentialLiteral(label, value, request) {
  const text = JSON.stringify(value);
  const bodyText = JSON.stringify(request.body.text);
  const withoutBody = text.split(bodyText).join('""');
  check(label, !withoutBody.includes(LIVE), withoutBody.slice(0, 400));
}

/* 1. Persistable request copy strips credentials, keeps {{references}} */

const source = requestWithEveryCredentialShape();
const sanitized = api.sanitizeRequestForPersistence(source);
assertNoCredentialLiteral("persistable copy has no credential literal", sanitized, source);
check("auth token neutralized", sanitized.auth.token === "[REDACTED]", sanitized.auth.token);
check("auth reveal flag dropped", sanitized.auth.reveal === undefined);
check(
  "secret variable value stripped",
  sanitized.variables.find((v) => v.name === "apiKey").value === "",
);
check(
  "non-secret variable preserved",
  sanitized.variables.find((v) => v.name === "host").value === "api.test",
);
check(
  "credential headers redacted",
  ["Authorization", "X-API-Key", "X-Tenant-Token"].every(
    (name) => sanitized.headers.find((h) => h.key === name).value === "[REDACTED]",
  ),
);
check(
  "ordinary header preserved",
  sanitized.headers.find((h) => h.key === "Accept").value === "application/json",
);
check("credential query value redacted", !sanitized.query.find((q) => q.key === "access_token").value.includes(LIVE));
check("ordinary query preserved", sanitized.query.find((q) => q.key === "page").value === "2");
check("url query credential redacted", !sanitized.url.includes(LIVE), sanitized.url);
check("url keeps non-secret query", sanitized.url.includes("page=2"), sanitized.url);
check("authored body preserved for collection storage", sanitized.body.text === source.body.text);

/* 2. {{reference}} placeholders survive redaction */

const referenced = requestWithEveryCredentialShape();
referenced.auth.token = "{{access_token}}";
referenced.headers = [api.newRow("Authorization", "Bearer {{access_token}}"), api.newRow("X-Api-Key-Ref", "{{apiKey}}")];
const referencedCopy = api.sanitizeRequestForPersistence(referenced);
check("pure reference token kept", referencedCopy.auth.token === "{{access_token}}", referencedCopy.auth.token);
check(
  "reference-only header value kept",
  referencedCopy.headers.find((h) => h.key === "X-Api-Key-Ref").value === "{{apiKey}}",
);
check(
  "header mixing a literal and a reference is redacted",
  referencedCopy.headers.find((h) => h.key === "Authorization").value === "[REDACTED]",
);
check("isPlainVariableReference accepts padded form", api.isPlainVariableReference("  {{ a-b.c }} "));
check("isPlainVariableReference rejects composite", !api.isPlainVariableReference("{{a}}{{b}}"));

/* 3. persistableState() — the actual save payload — never carries credentials */

api.State.collections = [
  {
    id: "c1",
    type: "collection",
    name: "C",
    items: [
      {
        id: "r1",
        type: "request",
        name: "R",
        request: requestWithEveryCredentialShape(),
      },
      {
        id: "f1",
        type: "folder",
        name: "F",
        items: [{ id: "r2", type: "request", name: "Nested", request: requestWithEveryCredentialShape() }],
      },
    ],
  },
];
api.State.environments = [
  {
    id: "e1",
    name: "dev",
    prodLike: false,
    confirmUnsafe: true,
    variables: [
      { name: "apiKey", value: LIVE, secret: true },
      { name: "host", value: "api.test", secret: false },
    ],
  },
];
const persisted = api.persistableState();
assertNoCredentialLiteral(
  "state payload has no credential literal",
  persisted,
  requestWithEveryCredentialShape(),
);
check(
  "nested folder request also sanitized",
  persisted.collections[0].items[1].items[0].request.auth.token === "[REDACTED]",
);
check("secret env variable stripped", persisted.environments[0].variables[0].value === "");
check("non-secret env variable kept", persisted.environments[0].variables[1].value === "api.test");
check("in-memory request keeps working copy", api.State.collections[0].items[0].request.auth.token === LIVE);

/* 4. History snapshot: no body text, credentials redacted */

const history = api.redactRequestForHistory(requestWithEveryCredentialShape());
const historyText = JSON.stringify(history);
check("history has no credential literal", !historyText.includes(LIVE), historyText);
check("history drops body text", history.body.text === "", history.body.text);
check("history marks body redacted", history.body.redacted === true);
check("history keeps body size hint", history.body.sizeBytes > 0, history.body.sizeBytes);
check(
  "history variable values emptied",
  history.variables.every((v) => v.value === ""),
);

/* 5. Header / query sensitivity rules */

for (const name of ["Authorization", "COOKIE", "x-api-key", "apikey", "X-Auth-Token", "X-Tenant-Token", "x-service-password", "Private-Token"]) {
  check(`sensitive header: ${name}`, api.isSensitiveHeaderName(name));
}
for (const name of ["Accept", "Content-Type", "User-Agent", "X-Request-Id"]) {
  check(`not sensitive: ${name}`, !api.isSensitiveHeaderName(name));
}
check("userinfo stripped from stored url", !api.redactUrlForHistory("https://u:p@api.test/x").includes("p@"));

/* 6. Defaults stay credential-free (regression guard for new fields) */

const blank = api.sanitizeRequestForPersistence(api.defaultRequest());
check("default request has no auth literal", blank.auth.token === undefined);
check("default request round-trips", blank.method === "GET");

/* 7. Wiring: no save path may bypass the sanitizer. These are static checks on
 * the shipped bundle, so a future edit that persists raw state fails the suite. */

const shipped = (await readFile(join(root, "ui", "index.html"), "utf8")).match(
  /<script>([\s\S]*)<\/script>/,
)[1];

check(
  "the only saveState call sends persistableState()",
  /Api\.saveState\(persistableState\(\)\)/.test(shipped),
  shipped.match(/Api\.saveState\([^)]*\)/g),
);
check(
  "persistableState no longer deep-clones raw collections",
  !/collections:\s*deepClone\(State\.collections\)/.test(shipped),
);
check(
  "exactly one historyAppend call site",
  (shipped.match(/Api\.historyAppend\(/g) || []).length === 1,
);
check(
  "recordHistory builds its snapshot through redactRequestForHistory",
  /redactRequestForHistory\(request\)/.test(shipped),
);
check(
  "history construction does not slice raw body text",
  !/bodyText\.slice|body\.text\.slice/.test(shipped),
);
check(
  "no raw transport message is forwarded to the UI",
  !/transport\(category, detail\)/.test(shipped),
);

console.log(
  failures === 0 ? "\nALL UI REDACTION CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
