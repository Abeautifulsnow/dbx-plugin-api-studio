#!/usr/bin/env node
// Behaviour tests for the pure workbench libraries: request folding, URL/params
// sync, search, JSON rendering and the error-category contract with the sidecar.
//
// Zero dependencies (Node 18+).
//
//   node tools/ui-lib-test.mjs

import { readFileSync } from "node:fs";
import { DICTIONARIES, NEXT_STEP_KEYS, normalizeLocale, translate } from "../frontend/src/lib/i18n.js";
import { btoaUtf8, clampInt, formatBytes, formatMs, timeAgo } from "../frontend/src/lib/format.js";
import {
  canSetAsVariable,
  containerEntries,
  escapeHtml,
  highlightJson,
  matchingPaths,
  parseJson,
  prettyJson,
  toLines,
  valueAsText,
} from "../frontend/src/lib/jsonview.js";
import { countRequests, filterCollections, matchesQuery } from "../frontend/src/lib/search.js";
import {
  appendQueryParam,
  buildSendSpec,
  isHttpUrl,
  parseUrlQuery,
  rebuildUrlQuery,
  resolveString,
  variableScope,
} from "../frontend/src/lib/variables.js";

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log("PASS", name);
  else {
    failures += 1;
    console.log("FAIL", name, detail ?? "");
  }
}

/* ------------------------------------------------------------------- format */

check("formatBytes B/KB/MB", formatBytes(512) === "512 B" && formatBytes(2048) === "2.0 KB" && formatBytes(3 * 1024 * 1024) === "3.00 MB");
check("formatBytes handles missing values", formatBytes(null) === "—" && formatBytes(undefined) === "—");
check("formatMs promotes to seconds", formatMs(999) === "999 ms" && formatMs(1500) === "1.50 s" && formatMs(null) === "—");
check("clampInt clamps and falls back", clampInt(5, 10, 20, 15) === 10 && clampInt("x", 10, 20, 15) === 15 && clampInt(30, 10, 20, 15) === 20);
check("timeAgo is relative", timeAgo(Date.now(), "just now") === "just now" && timeAgo(Date.now() - 3 * 3600_000, "just now") === "3 h");
check("btoaUtf8 encodes non-latin text", btoaUtf8("密碼") !== "" && atob(btoaUtf8("密碼")) !== "");

/* ---------------------------------------------------------------------- i18n */

const enKeys = Object.keys(DICTIONARIES.en).sort();
const zhKeys = Object.keys(DICTIONARIES.zh).sort();
check(
  "en and zh dictionaries have identical keys",
  enKeys.length === zhKeys.length && enKeys.every((key, index) => key === zhKeys[index]),
  enKeys.filter((key) => !DICTIONARIES.zh[key]).join(", "),
);
check("dictionary is non-trivial", enKeys.length > 150, `${enKeys.length} keys`);
check(
  "no dictionary value is empty",
  enKeys.every((key) => DICTIONARIES.en[key] !== "" && DICTIONARIES.zh[key] !== ""),
  enKeys.filter((key) => !DICTIONARIES.en[key] || !DICTIONARIES.zh[key]).join(", "),
);
check("locale detection", normalizeLocale("zh-CN") === "zh" && normalizeLocale("en-US") === "en" && normalizeLocale(undefined) === "en");
check("interpolation", translate("en", "unresolvedVars", { vars: "a, b" }) === "Unresolved variables: a, b");
check("unknown key falls back to the key", translate("en", "no-such-key") === "no-such-key");

/* Error taxonomy contract with the sidecar (backend/src/model.rs). */
const rustSource = readFileSync(new URL("../backend/src/model.rs", import.meta.url), "utf8");
const categoriesBlock = rustSource.match(/ERROR_CATEGORIES[^=]*=\s*\[([\s\S]*?)\];/);
const rustCategories = categoriesBlock
  ? [...categoriesBlock[1].matchAll(/"([A-Z_]+)"/g)].map((match) => match[1])
  : [];
check("sidecar error categories were found", rustCategories.length > 5, `${rustCategories.length}`);
check(
  "every sidecar error category has a UI recovery hint",
  rustCategories.every((category) => NEXT_STEP_KEYS[category]),
  rustCategories.filter((category) => !NEXT_STEP_KEYS[category]).join(", "),
);
check(
  "the UI hint table has no category the sidecar never sends",
  Object.keys(NEXT_STEP_KEYS).every((category) => rustCategories.includes(category)),
  Object.keys(NEXT_STEP_KEYS).filter((category) => !rustCategories.includes(category)).join(", "),
);

/* -------------------------------------------------------------------- search */

check("empty query matches everything", matchesQuery("", "anything"));
check("multi-term AND across fields", matchesQuery("users get", "Get users", "https://x.test/v1/users", "GET"));
check("a missing term fails", !matchesQuery("users post", "Get users", "https://x.test/v1/users", "GET"));
check("the method is searched", matchesQuery("delete", "Whatever", "https://x.test", "DELETE"));

const tree = [
  {
    id: "c1",
    type: "collection",
    name: "Payments",
    items: [
      { id: "r1", type: "request", name: "Charge", request: { method: "POST", url: "https://pay.test/charge" } },
      { id: "r2", type: "request", name: "Refund", request: { method: "POST", url: "https://pay.test/refund" } },
    ],
  },
  { id: "c2", type: "collection", name: "Other", items: [{ id: "r3", type: "request", name: "Ping", request: { method: "GET", url: "https://x.test/ping" } }] },
];
check("no query returns the original tree", filterCollections(tree, "") === tree);
check("matching keeps only the hit", filterCollections(tree, "charge")[0].items.length === 1);
check("a collection with no hit is dropped", filterCollections(tree, "charge").length === 1);
check("url is searched", filterCollections(tree, "refund")[0].items[0].id === "r2");
check("method is searched", filterCollections(tree, "ping").length === 1);
check("no match yields an empty list", filterCollections(tree, "zzz").length === 0);
check("countRequests counts nested requests", countRequests(tree[0]) === 2);

/* ------------------------------------------------------------------ variables */

const scope = variableScope(
  { variables: [{ id: "1", key: "base_url", value: "https://api.test" }, { id: "2", key: "api_key", value: "S", secret: true }] },
  { variables: [{ id: "3", key: "base_url", value: "https://local.test" }] },
);
check("request variables win over environment", resolveString("{{base_url}}/v1", scope).value === "https://local.test/v1");
check("missing variables are reported", resolveString("{{nope}}", scope).unresolved.join() === "nope");
check("secret values resolve on send", resolveString("{{api_key}}", scope).value === "S");
check("secret values are masked for export", resolveString("{{api_key}}", scope, true).value === "{{api_key}}");
check("non-secret values are not masked", resolveString("{{base_url}}", scope, true).value === "https://local.test");

check("isHttpUrl accepts http and https", isHttpUrl("https://x.test") && isHttpUrl("http://x.test"));
check("isHttpUrl rejects other schemes", !isHttpUrl("ws://x.test") && !isHttpUrl("file:///x") && !isHttpUrl("not a url"));

/* ------------------------------------------------------------ URL/param sync */

const parsed = parseUrlQuery("https://x.test/v1?a=1&b=hello+world&c=%E5%AF%86#frag");
check("query pairs are decoded", parsed.pairs.length === 3 && parsed.pairs[1].value === "hello world");
check("encoded pairs are decoded", parsed.pairs[2].value === "密");
check("base excludes the query", parsed.base === "https://x.test/v1");
check("rebuild preserves the fragment", rebuildUrlQuery("https://x.test/v1#frag", [{ key: "a", value: "1" }]) === "https://x.test/v1?a=1#frag");
check(
  "rebuild REPLACES an existing query instead of appending to it",
  rebuildUrlQuery("https://x.test/v1?old=1", [{ key: "new", value: "2" }]) === "https://x.test/v1?new=2",
);
check("rebuild with no pairs strips the query", rebuildUrlQuery("https://x.test/v1?a=1", []) === "https://x.test/v1");
check("appendQueryParam preserves the fragment", appendQueryParam("https://x.test/v1#f", "k", "v") === "https://x.test/v1?k=v#f");
check("appendQueryParam encodes", appendQueryParam("https://x.test/v1", "a b", "c&d") === "https://x.test/v1?a%20b=c%26d");

/* ---------------------------------------------------------------- send spec */

const baseRequest = {
  method: "POST",
  url: "https://api.test/v1/items",
  headers: [
    { id: "h1", key: "Accept", value: "application/json", enabled: true },
    { id: "h2", key: "", value: "ignored", enabled: true },
    { id: "h3", key: "X-Off", value: "no", enabled: false },
  ],
  query: [{ id: "q1", key: "page", value: "2", enabled: true }],
  auth: { type: "none" },
  body: { type: "json", text: '{"a":1}' },
  variables: [],
  settings: { timeoutMs: 999999, followRedirects: false, maxRedirects: 99, verifyTls: false },
};

const emptyScope = new Map();
const folded = buildSendSpec(baseRequest, "call_1", emptyScope, { previewCapBytes: 1234 });
check("no issues for a valid request", Object.keys(folded.issues).length === 0, JSON.stringify(folded.issues));
check("content-type is added for a JSON body", folded.spec.headers.some((header) => header.name === "Content-Type" && header.value === "application/json"));
check("disabled and blank rows are dropped", !folded.spec.headers.some((header) => header.name === "X-Off" || header.name === ""));
check("an explicit content-type is not duplicated", (() => {
  const withHeader = buildSendSpec(
    { ...baseRequest, headers: [...baseRequest.headers, { id: "h4", key: "content-type", value: "application/vnd.test+json", enabled: true }] },
    "call_2",
    emptyScope,
  );
  return withHeader.spec.headers.filter((header) => header.name.toLowerCase() === "content-type").length === 1;
})());
check("settings are clamped", folded.spec.settings.timeoutMs === 300000 && folded.spec.settings.maxRedirects === 20);
check("booleans are respected", folded.spec.settings.followRedirects === false && folded.spec.settings.verifyTls === false);
check("the preview cap is passed through", folded.spec.settings.maxBodyBytes === 1234);
check("body is sent as raw text", folded.spec.body.type === "raw" && folded.spec.body.text === '{"a":1}');

check(
  "an invalid url is reported",
  buildSendSpec({ ...baseRequest, url: "not-a-url" }, "c", emptyScope).issues.url.invalid === true,
);
check(
  "a ws:// url is rejected like the sidecar does",
  buildSendSpec({ ...baseRequest, url: "ws://x.test/socket" }, "c", emptyScope).issues.url.invalid === true,
);
check(
  "unresolved variables are attributed to the field",
  buildSendSpec({ ...baseRequest, url: "https://x.test/{{missing}}" }, "c", emptyScope).issues.url.unresolved.join() === "missing",
);
check(
  "invalid JSON is reported",
  buildSendSpec({ ...baseRequest, body: { type: "json", text: "{oops" } }, "c", emptyScope).issues.body.json === true,
);
check(
  "an empty bearer token is reported",
  buildSendSpec({ ...baseRequest, auth: { type: "bearer", token: "" } }, "c", emptyScope).issues.auth.empty === true,
);
check(
  "a bearer token becomes an Authorization header",
  buildSendSpec({ ...baseRequest, auth: { type: "bearer", token: "abc" } }, "c", emptyScope).spec.headers.some(
    (header) => header.name === "Authorization" && header.value === "Bearer abc",
  ),
);
check(
  "basic auth encodes non-latin credentials as UTF-8",
  (() => {
    const spec = buildSendSpec({ ...baseRequest, auth: { type: "basic", username: "密", password: "碼" } }, "c", emptyScope).spec;
    const header = spec.headers.find((item) => item.name === "Authorization");
    return header?.value === `Basic ${btoaUtf8("密:碼")}`;
  })(),
);
check(
  "an API key in the query keeps the fragment",
  (() => {
    const spec = buildSendSpec(
      { ...baseRequest, url: "https://x.test/v1#frag", query: [], auth: { type: "apikey", keyName: "k", keyValue: "v", in: "query" } },
      "c",
      emptyScope,
    ).spec;
    return spec.url.endsWith("#frag") && spec.url.includes("k=v");
  })(),
);
check(
  "an API key as a header replaces an existing one",
  (() => {
    const spec = buildSendSpec(
      {
        ...baseRequest,
        headers: [{ id: "h", key: "X-Key", value: "old", enabled: true }],
        auth: { type: "apikey", keyName: "X-Key", keyValue: "new", in: "header" },
      },
      "c",
      emptyScope,
    ).spec;
    const matching = spec.headers.filter((header) => header.name === "X-Key");
    return matching.length === 1 && matching[0].value === "new";
  })(),
);

/* ------------------------------------------------------------------ JSON view */

check("parseJson reports failure", parseJson("{oops").ok === false && parseJson('{"a":1}').ok === true);
check("prettyJson indents", prettyJson('{"a":[1]}', 2) === '{\n  "a": [\n    1\n  ]\n}');
check("prettyJson returns null on invalid input", prettyJson("{oops") === null);
check("lines are split for the gutter", toLines("a\nb").length === 2);
check("containerEntries labels array indices", containerEntries([7])[0].path === "[0]");
check("containerEntries quotes odd keys", containerEntries({ "a b": 1 })[0].path === '["a b"]');
check("containerEntries uses dot paths for identifiers", containerEntries({ ab: 1 })[0].path === ".ab");
check(
  "the highlighter classifies keys, strings, numbers and literals",
  highlightJson('{"a":"b","n":1,"t":true}').includes("tok-key") &&
    highlightJson('{"a":"b"}').includes("tok-string") &&
    highlightJson('{"n":1}').includes("tok-number") &&
    highlightJson('{"t":true}').includes("tok-literal"),
);
check(
  "the highlighter escapes payload markup",
  !highlightJson('{"x":"<script>alert(1)</script>"}').includes("<script>") &&
    highlightJson('{"x":"<b>"}').includes("&lt;b&gt;"),
);
check("escapeHtml escapes quotes", escapeHtml(`"'&<>`) === "&quot;&#39;&amp;&lt;&gt;");
/** Strip the highlighter's markup and undo its escaping. */
const highlightedText = (source) =>
  highlightJson(source)
    .replace(/<[^>]+>/g, "")
    .split("&quot;")
    .join('"')
    .split("&#39;")
    .join("'")
    .split("&lt;")
    .join("<")
    .split("&gt;")
    .join(">")
    .split("&amp;")
    .join("&");

check(
  "the highlighter never loses payload characters",
  highlightedText('{"a":"b","n":[1,true,null]}') === '{"a":"b","n":[1,true,null]}',
  highlightedText('{"a":"b","n":[1,true,null]}'),
);

const json = { a: { b: [1, 2, { c: "needle" }] }, d: "hay" };
const paths = matchingPaths(json, "needle");
check("search finds a nested match", paths.has("$.a.b[2].c"));
check("search keeps the ancestors of a match", paths.has("$.a") && paths.has("$"));
check("search excludes unrelated branches", !paths.has("$.d"));
check("an empty query matches everything", matchingPaths(json, "").has("$.d"));
check("a key match is found", matchingPaths(json, "hay").has("$.d"));

check("small scalars can become variables", canSetAsVariable("v", false) && canSetAsVariable(null, false));
check("truncated responses cannot", canSetAsVariable("v", true) === false);
check("oversized values cannot", canSetAsVariable("x".repeat(70 * 1024), false) === false);
check("objects are stringified for the clipboard", valueAsText({ a: 1 }) === '{"a":1}' && valueAsText("s") === "s");

console.log(failures ? `LIBRARY CHECKS FAILED (${failures})` : "ALL LIBRARY CHECKS PASSED");
process.exit(failures ? 1 : 0);
