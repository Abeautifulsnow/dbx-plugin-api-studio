#!/usr/bin/env node
// Persisted-state schema tests: the v1 → v2 migration and the invariants the
// workbench relies on (stable row ids, preserved layout settings, no secret
// values in a save payload).
//
// The v1 fixture below is byte-for-byte the shape an existing install has in
// `<data dir>/state.json` — environment variables keyed by `name`, key/value
// rows without ids, `settings.ui` and `previewCapBytes` at the top of settings.
// A migration that drops or mangles it looks like data loss to the user.
//
// Zero dependencies (Node 18+).
//
//   node tools/ui-state-test.mjs

import {
  DEFAULT_PREVIEW_CAP_BYTES,
  STATE_VERSION,
  duplicateItem,
  findCollectionOf,
  findItem,
  historyEntry,
  mergeQueryRows,
  migrateHistory,
  migrateState,
  newCollection,
  newRow,
  normalizeResponse,
  persistableState,
  removeItem,
  responseCookies,
} from "../frontend/src/lib/model.js";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log("PASS", name);
  else {
    failures += 1;
    console.log("FAIL", name, detail ?? "");
  }
}

/* ------------------------------------------------------------- v1 fixture */

const LEGACY_STATE = {
  version: 1,
  collections: [
    {
      id: "col_legacy",
      type: "collection",
      name: "My Collection",
      items: [
        {
          id: "fld_legacy",
          type: "folder",
          name: "Examples",
          items: [
            {
              id: "req_legacy",
              type: "request",
              name: "Sample GET",
              request: {
                version: 1,
                name: "",
                method: "get",
                url: "https://httpbin.org/get",
                query: [],
                headers: [{ description: "", enabled: true, id: "kv_1", key: "Accept", value: "application/json" }],
                auth: { type: "none" },
                body: { text: "", type: "none" },
                variables: [],
                settings: { followRedirects: true, maxRedirects: 10, timeoutMs: 30000, verifyTls: true },
              },
            },
          ],
        },
        { id: "req_top", type: "request", name: "Top level", request: { method: "POST", url: "https://x.test" } },
      ],
    },
  ],
  environments: [
    {
      id: "env_legacy",
      name: "Production",
      prodLike: true,
      confirmUnsafe: true,
      // v1 key names the variable `name`; v2 uses `key`.
      variables: [
        { name: "base_url", value: "https://api.test", secret: false },
        { name: "api_key", value: "LIVE-SECRET", secret: true },
      ],
    },
  ],
  settings: {
    selectedEnvId: "env_legacy",
    previewCapBytes: 1048576,
    ui: { sidebarWidth: 312, historyOpen: false, editorH: 58, responseView: "tree", sidebarCollapsed: true },
  },
};

const migrated = migrateState(LEGACY_STATE);

check("schema is upgraded to v2", migrated.version === STATE_VERSION && STATE_VERSION === 2);
check("collections survive", migrated.collections.length === 1);
check(
  "nested folders survive",
  migrated.collections[0].items[0].type === "folder" &&
    migrated.collections[0].items[0].items[0].name === "Sample GET",
);
check("methods are upper-cased", migrated.collections[0].items[0].items[0].request.method === "GET");
check(
  "existing row ids are kept",
  migrated.collections[0].items[0].items[0].request.headers[0].id === "kv_1",
);
check(
  "request rows gain the fields the editor needs",
  typeof migrated.collections[0].items[0].items[0].request.headers[0].description === "string" &&
    migrated.collections[0].items[0].items[0].request.headers[0].enabled === true,
);
check(
  "a request without headers gets an empty list, not undefined",
  Array.isArray(migrated.collections[0].items[1].request.headers),
);
check(
  "a partial legacy request is filled with defaults",
  migrated.collections[0].items[1].request.settings.timeoutMs === 30000,
);

check(
  "environment variables are re-keyed from `name` to `key`",
  migrated.environments[0].variables[0].key === "base_url" &&
    !("name" in migrated.environments[0].variables[0]),
);
check(
  "variables without ids get one",
  migrated.environments[0].variables.every(
    (variable) => typeof variable.id === "string" && variable.id.length > 3,
  ),
);
check("the secret flag survives", migrated.environments[0].variables[1].secret === true);
check("the selected environment survives", migrated.settings.selectedEnvId === "env_legacy");
check("the preview limit survives", migrated.settings.previewCapBytes === 1048576);
check("layout preferences survive", migrated.settings.ui.sidebarWidth === 312);
check("collapsed state survives", migrated.settings.ui.sidebarCollapsed === true);
check("history visibility survives", migrated.settings.ui.historyOpen === false);
check("the response view survives", migrated.settings.ui.responseView === "tree");

const ids = migrated.environments[0].variables.map((variable) => variable.id);
check("synthesised ids are unique (keyed each stays safe)", new Set(ids).size === ids.length);

/* --------------------------------------------------------- degenerate input */

for (const [label, input] of [
  ["null", null],
  ["undefined", undefined],
  ["empty object", {}],
  ["array", []],
  ["string", "nonsense"],
  ["wrong types", { collections: "no", environments: 5, settings: 7 }],
]) {
  const result = migrateState(input);
  check(
    `migrateState(${label}) returns usable defaults`,
    result.version === STATE_VERSION &&
      Array.isArray(result.collections) &&
      Array.isArray(result.environments) &&
      result.settings.ui.sidebarWidth > 0 &&
      result.settings.previewCapBytes === DEFAULT_PREVIEW_CAP_BYTES,
  );
}

/* ------------------------------------------------------------------ history */

// The fixture is in DISK order (oldest first — the sidecar appends and evicts
// from the front); migrateHistory must return newest-first.
const history = migrateHistory([
  {
    id: "h1",
    timestamp: 1,
    method: "POST",
    url: "https://x.test",
    // v1 stored history headers as { name, value }.
    request: { name: "n", method: "POST", url: "https://x.test", headers: [{ name: "X-A", value: "1" }] },
  },
  { method: "GET", url: "https://y.test" },
]);
check("history is newest-first after migration", history[0].method === "GET" && history[1].id === "h1");
check("history entries keep their id", history[1].id === "h1");
check("history headers are normalised to `key`", history[1].request.headers[0].key === "X-A");
check("history headers get ids", typeof history[1].request.headers[0].id === "string");
check("an entry without an id gets one", typeof history[0].id === "string" && history[0].id !== "");
check("migrateHistory tolerates junk", migrateHistory(null).length === 0 && migrateHistory("x").length === 0);
check(
  "history entry ids are unique",
  new Set(history.map((entry) => entry.id)).size === history.length,
);

const entry = historyEntry({
  request: { name: "r", method: "GET", url: "https://x.test" },
  response: { status: 200, statusText: "OK", contentType: "application/json", timing: { totalMs: 12 }, body: { sizeBytes: 9 } },
  error: null,
});
check(
  "a history entry carries what the list renders",
  entry.status === 200 && entry.durationMs === 12 && entry.sizeBytes === 9 && entry.responseMeta.contentType === "application/json",
);

/* ------------------------------------------------------- persisted payload */

const persisted = persistableState(migrated);
const persistedText = JSON.stringify(persisted);
check("secret environment values are emptied", !persistedText.includes("LIVE-SECRET"));
check("ordinary environment values survive", persistedText.includes("https://api.test"));
check("the payload is versioned", persisted.version === STATE_VERSION);

/* -------------------------------------------- [REDACTED] placeholder cleanup */

// A saved credential comes back from disk as the [REDACTED] placeholder. It
// must never masquerade as a sendable value: on load it becomes an empty field.
const redacted = migrateState({
  collections: [
    {
      id: "c",
      type: "collection",
      name: "C",
      items: [
        {
          id: "r",
          type: "request",
          name: "R",
          request: {
            method: "GET",
            url: "https://x.test/x?token=%5BREDACTED%5D",
            headers: [
              { key: "Authorization", value: "[REDACTED]", enabled: true },
              { key: "Accept", value: "[REDACTED]", enabled: true },
            ],
            query: [{ key: "token", value: "[REDACTED]", enabled: true }],
            auth: { type: "bearer", token: "[REDACTED]" },
          },
        },
      ],
    },
  ],
  environments: [],
  settings: {},
});
const migratedRequest = redacted.collections[0].items[0].request;
check("redacted auth token loads as empty", migratedRequest.auth.token === "");
check(
  "redacted credential header loads as empty",
  migratedRequest.headers.find((row) => row.key === "Authorization").value === "",
);
check(
  "redacted credential query value loads as empty",
  migratedRequest.query.find((row) => row.key === "token").value === "",
);
check(
  "the placeholder pair is dropped from the URL",
  !migratedRequest.url.includes("REDACTED") && migratedRequest.url.startsWith("https://x.test/x"),
  migratedRequest.url,
);
check(
  "an identical value on a non-credential header is left alone",
  migratedRequest.headers.find((row) => row.key === "Accept").value === "[REDACTED]",
);

/* ------------------------------------------------------------ query reconcile */

const queryRows = mergeQueryRows(
  [
    { id: "r1", key: "tag", value: "old", enabled: true },
    { id: "d1", key: "debug", value: "true", enabled: false },
  ],
  [
    { key: "tag", value: "a" },
    { key: "tag", value: "b" },
    { key: "page", value: "2" },
  ],
);
check("duplicate keys produce one row per occurrence", queryRows.length === 4);
check(
  "duplicate-key row ids are unique (keyed editor must not throw)",
  new Set(queryRows.map((row) => row.id)).size === queryRows.length,
);
check("the first occurrence reuses the existing row", queryRows[0].id === "r1" && queryRows[0].value === "a");
check("the second occurrence clones a fresh row", queryRows[0].id !== queryRows[1].id && queryRows[1].value === "b");
check("a new key gets a fresh row", queryRows[2].key === "page" && queryRows[2].value === "2");
check("disabled rows survive the sync", queryRows[3].id === "d1" && queryRows[3].enabled === false);

const reconciled = mergeQueryRows(
  [{ id: "gone", key: "gone", value: "1", enabled: true }],
  [{ key: "a", value: "1" }],
);
check("enabled rows whose key left the URL are dropped", reconciled.length === 1 && reconciled[0].key === "a");
check("no pairs yields only the disabled rows", mergeQueryRows([{ id: "d", key: "k", value: "", enabled: false }], []).length === 1);
check("mergeQueryRows tolerates junk", mergeQueryRows(null, [{ key: "a", value: "1" }]).length === 1);

/* ------------------------------------------------------------ tree helpers */

const collections = [newCollection("C")];
collections[0].items = [
  { id: "f1", type: "folder", name: "F1", items: [{ id: "r1", type: "request", name: "R1", request: { method: "GET", url: "https://x.test", headers: [newRow("A", "1")] } }] },
  { id: "r2", type: "request", name: "R2", request: { method: "GET", url: "https://y.test" } },
];
check("findItem reaches into folders", findItem(collections, "r1")?.item.name === "R1");
check("findCollectionOf resolves a nested request", findCollectionOf(collections, "r1")?.id === collections[0].id);
check("findCollectionOf resolves the collection itself", findCollectionOf(collections, collections[0].id)?.id === collections[0].id);

const copy = duplicateItem(collections, "r1", (name) => `${name} (copy)`);
check("duplicate inserts after the original", collections[0].items[0].items.length === 2);
check("duplicate gets a fresh id", copy.id !== "r1" && copy.request !== undefined);
check("duplicate gets fresh row ids", copy.request.headers[0].id !== "r1");
check("duplicate is labelled", copy.name === "R1 (copy)");

check("removeItem removes a nested node", removeItem(collections, "r1") && !findItem(collections, "r1"));
check("removeItem reports a miss", removeItem(collections, "does-not-exist") === false);

/* --------------------------------------------------- response normalisation */

const normalized = normalizeResponse({
  requestId: "call_1",
  status: 200,
  statusText: "OK",
  headers: [{ name: "Content-Type", value: "application/json" }, { name: "Set-Cookie", value: "sid=abc; Path=/; HttpOnly" }],
  contentType: "application/json",
  body: { text: "{}", base64: null, truncated: false, sizeBytes: 2 },
  finalUrl: "https://x.test/final",
  redirectCount: 1,
  timing: { totalMs: 42, ttfbMs: 30, downloadMs: 12 },
});
check("status is normalised", normalized.status === 200 && normalized.statusText === "OK");
check("headers get ids", normalized.headers.every((header) => typeof header.id === "string"));
check("timing is normalised", normalized.timing.ttfbMs === 30 && normalized.timing.downloadMs === 12);
check("redirects are normalised", normalized.redirectCount === 1);
check("a missing payload yields null", normalizeResponse(null) === null);

const cookies = responseCookies(normalized);
check("cookies are parsed", cookies.length === 1 && cookies[0].name === "sid" && cookies[0].value === "abc");
check("cookie attributes are parsed", cookies[0].attributes.join(";") === "Path=/;HttpOnly");
check("no cookies yields an empty list", responseCookies({ headers: [] }).length === 0);

console.log(failures ? `STATE CHECKS FAILED (${failures})` : "ALL STATE CHECKS PASSED");
process.exit(failures ? 1 : 0);
