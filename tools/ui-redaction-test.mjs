#!/usr/bin/env node
// Credential-redaction tests for the workbench UI.
//
// These import `frontend/src/lib/*` DIRECTLY — the same modules the bundled
// `ui/index.html` is built from. The previous version of this suite bundled and
// asserted against the retired vanilla UI, so it kept passing after the Svelte
// rewrite dropped URL redaction entirely. Testing the shipped source is the
// point; a test that covers a dead implementation is worse than no test.
//
// Zero dependencies (Node 18+).
//
//   node tools/ui-redaction-test.mjs

import {
  AUTH_CREDENTIAL_FIELDS,
  REDACTED,
  isPlainVariableReference,
  isSensitiveHeaderName,
  isSensitiveQueryName,
  redactCredentialValue,
  redactRequestForHistory,
  redactUrlForHistory,
  sanitizeRequestForPersistence,
  sanitizeTree,
  stripUrlUserinfo,
} from "../frontend/src/lib/redaction.js";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log("PASS", name);
  else {
    failures += 1;
    console.log("FAIL", name, detail ?? "");
  }
}

/* ----------------------------------------------------- sensitive name rules */

for (const name of [
  "Authorization",
  "proxy-authorization",
  "Cookie",
  "Set-Cookie",
  "X-Api-Key",
  "x-auth-token",
  "X-Tenant-Token",
  "x-service-password",
  "Private-Token",
  "x-goog-api-key",
  "X-Amz-Security-Token",
]) {
  check(`sensitive header: ${name}`, isSensitiveHeaderName(name));
}
for (const name of ["Accept", "Content-Type", "User-Agent", "X-Request-Id", ""]) {
  check(`not sensitive: ${name || "(empty)"}`, !isSensitiveHeaderName(name));
}
check("sensitive query: access_token", isSensitiveQueryName("access_token"));
check("sensitive query: X-Amz-Signature", isSensitiveQueryName("X-Amz-Signature"));
check("not sensitive query: page", !isSensitiveQueryName("page"));

/* ------------------------------------------------------- value redaction */

check("empty stays empty", redactCredentialValue("") === "");
check("reference survives", redactCredentialValue("{{api_key}}") === "{{api_key}}");
check("padded reference survives", redactCredentialValue("  {{ api_key }}  ") === "  {{ api_key }}  ");
check("literal is redacted", redactCredentialValue("sk-live-123") === REDACTED);
check("embedded reference is redacted", redactCredentialValue("Bearer {{api_key}}") === REDACTED);
check("reference with invalid chars is redacted", redactCredentialValue("{{a b}}") === REDACTED);
check("plain reference detection", isPlainVariableReference("{{a.b-c_1}}"));
check(
  "credential fields cover every auth type",
  AUTH_CREDENTIAL_FIELDS.bearer.includes("token") &&
    AUTH_CREDENTIAL_FIELDS.basic.includes("password") &&
    AUTH_CREDENTIAL_FIELDS.apikey.includes("keyValue"),
);

/* ------------------------------------------------------------- URL redaction */

check(
  "userinfo is dropped",
  stripUrlUserinfo("https://user:pass@host.test/x") === "https://host.test/x",
);
check(
  "userinfo without a path is dropped",
  stripUrlUserinfo("https://user:pass@host.test") === "https://host.test",
);
check("no userinfo is left alone", stripUrlUserinfo("https://host.test/x") === "https://host.test/x");

const queryRedacted = redactUrlForHistory("https://api.test/v1?access_token=SEKRET&page=2");
check("query credential is redacted", queryRedacted.includes(`access_token=${REDACTED}`), queryRedacted);
check("query credential value is gone", !queryRedacted.includes("SEKRET"), queryRedacted);
check("ordinary query values survive", queryRedacted.includes("page=2"), queryRedacted);
check(
  "encoded query credential is redacted",
  !redactUrlForHistory("https://api.test/v1?access%5Ftoken=SEKRET").includes("SEKRET"),
);
check(
  "fragment survives redaction",
  redactUrlForHistory("https://api.test/v1?token=S#frag").endsWith("#frag"),
);
check(
  "userinfo without a query is redacted",
  !redactUrlForHistory("https://user:pass@api.test/v1").includes("user:pass@"),
);
check(
  "userinfo with a query is redacted",
  !redactUrlForHistory("https://user:pass@api.test/v1?a=1").includes("user:pass@"),
);
check(
  "unparseable url is returned unchanged",
  redactUrlForHistory("not a url") === "not a url",
);

/* ------------------------------------------- persistable request + history */

const request = {
  name: "Checkout",
  method: "POST",
  url: "https://user:pass@api.test/v1/orders?access_token=SEKRET&page=1",
  headers: [
    { id: "h1", key: "Authorization", value: "Bearer SEKRET", enabled: true },
    { id: "h2", key: "X-Api-Key", value: "{{api_key}}", enabled: true },
    { id: "h3", key: "Accept", value: "application/json", enabled: true },
  ],
  query: [
    { id: "q1", key: "token", value: "SEKRET", enabled: true },
    { id: "q2", key: "page", value: "1", enabled: true },
  ],
  auth: { type: "bearer", token: "SEKRET", reveal: true },
  body: { type: "json", text: '{"card":"4111111111111111"}' },
  variables: [{ id: "v1", key: "api_key", value: "SEKRET", secret: true }],
  settings: { timeoutMs: 30000 },
};

const persistable = sanitizeRequestForPersistence(request);
const persistableText = JSON.stringify(persistable);
check("auth literal is redacted", persistable.auth.token === REDACTED, persistable.auth.token);
check("auth reveal flag is dropped", !("reveal" in persistable.auth));
check("credential header literal is redacted", persistable.headers[0].value === REDACTED);
check("credential header reference survives", persistable.headers[1].value === "{{api_key}}");
check("ordinary header survives", persistable.headers[2].value === "application/json");
check("credential query literal is redacted", persistable.query[0].value === REDACTED);
check("ordinary query survives", persistable.query[1].value === "1");
check("secret variable value is emptied", persistable.variables[0].value === "");
check("url credential is redacted", persistable.url.includes(`access_token=${REDACTED}`), persistable.url);
check("url userinfo is dropped", !persistable.url.includes("user:pass@"));
check("no literal credential survives serialisation", !persistableText.includes("SEKRET"));
check("authored body is preserved for a stored request", persistable.body.text.includes("4111"));

const historySnapshot = redactRequestForHistory(request);
const historyText = JSON.stringify(historySnapshot);
check("history drops body text", historySnapshot.body.text === "");
check("history marks the body redacted", historySnapshot.body.redacted === true);
check("history keeps the body size", historySnapshot.body.sizeBytes === request.body.text.length);
check("history keeps the body type", historySnapshot.body.type === "json");
check("history empties every variable value", historySnapshot.variables.every((v) => v.value === ""));
check("history carries no credential", !historyText.includes("SEKRET"));
check("history carries no card number", !historyText.includes("4111"));

/* ------------------------------------------------------------ tree scrubbing */

const tree = {
  id: "col",
  type: "collection",
  name: "C",
  items: [
    {
      id: "f",
      type: "folder",
      name: "F",
      items: [{ id: "r", type: "request", name: "R", request }],
    },
  ],
};
const scrubbed = JSON.stringify(sanitizeTree(tree));
check("nested requests are scrubbed", !scrubbed.includes("SEKRET"));
check("nested structure is preserved", scrubbed.includes('"name":"F"') && scrubbed.includes('"name":"R"'));

/* ----------------------------------------------- structural wiring invariants */

const appSource = await (await import("node:fs/promises")).readFile(
  new URL("../frontend/src/App.svelte", import.meta.url),
  "utf8",
);

check(
  "exactly one history-append call site",
  (appSource.match(/api\.appendHistory\(/g) || []).length === 1,
);
check(
  "the history snapshot is built from the frozen send snapshot through redactRequestForHistory",
  appSource.includes("const requestSnapshot = deepClone(current.request)") &&
    appSource.includes("recordHistory({ requestKey, request: requestSnapshot") &&
    appSource.includes("redactRequestForHistory(request)"),
);
check(
  "history never reads the live editor state at completion time",
  !appSource.includes("redactRequestForHistory(current.request)"),
);
check(
  "persistence sends persistableState()",
  /api\.saveState\(snapshot\)/.test(appSource) && appSource.includes("persistableState({"),
);
check(
  "no raw request is sent to the save path",
  !/api\.saveState\((?!snapshot)/.test(appSource),
);

console.log(failures ? `REDACTION CHECKS FAILED (${failures})` : "ALL REDACTION CHECKS PASSED");
process.exit(failures ? 1 : 0);
