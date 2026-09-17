/**
 * JSON rendering helpers: a syntax highlighter for the text view, a search
 * matcher for the tree view, and the guards that decide what may be promoted to
 * an environment variable.
 *
 * Response bodies are attacker-controlled, so `highlightJson` escapes the input
 * before inserting any markup: the highlighter never emits a tag derived from
 * payload bytes.
 */

/** Maximum string length previewed in a tree row before it is elided. */
export const PREVIEW_STRING_LENGTH = 160;

/** Values larger than this are not offered as "set as environment variable". */
export const MAX_SET_VARIABLE_BYTES = 64 * 1024;

export function escapeHtml(text) {
  return String(text ?? "")
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

export function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function prettyJson(text, indent = 2) {
  const parsed = parseJson(text);
  if (!parsed.ok) return null;
  return JSON.stringify(parsed.value, null, indent);
}

export function minifyJson(text) {
  const parsed = parseJson(text);
  if (!parsed.ok) return null;
  return JSON.stringify(parsed.value);
}

export function describe(value) {
  if (value === null) return { kind: "null", label: "null" };
  if (Array.isArray(value)) return { kind: "array", label: "[" + value.length + "]" };
  if (typeof value === "object") {
    return { kind: "object", label: "{" + Object.keys(value).length + "}" };
  }
  if (typeof value === "string") {
    const preview =
      value.length > PREVIEW_STRING_LENGTH ? value.slice(0, PREVIEW_STRING_LENGTH) + "…" : value;
    return { kind: "string", label: JSON.stringify(preview) };
  }
  return { kind: typeof value, label: String(value) };
}

export function valueClass(kind) {
  if (kind === "string") return "jv-string";
  if (kind === "number") return "jv-number";
  if (kind === "null" || kind === "boolean") return "jv-literal";
  return "jv-punct";
}

/** Key/value pairs of a container, with the JSONPath segment for each. */
export function containerEntries(value) {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({ key: String(index), path: "[" + index + "]", value: item }));
  }
  return Object.keys(value || {}).map((key) => ({
    key,
    path: /^[A-Za-z_$][\w$]*$/.test(key) ? "." + key : "[" + JSON.stringify(key) + "]",
    value: value[key],
  }));
}

export function jsonPathOf(path) {
  return "$" + path;
}

/** A tree node matches when its key or its rendered value contains the query. */
export function nodeMatches(key, value, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (String(key ?? "").toLowerCase().includes(needle)) return true;
  if (value === null || typeof value !== "object") {
    return String(value).toLowerCase().includes(needle);
  }
  return false;
}

export function canSetAsVariable(value, truncated) {
  if (truncated) return false;
  if (value == null) return true;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).length <= MAX_SET_VARIABLE_BYTES;
    } catch {
      return false;
    }
  }
  return String(value).length <= MAX_SET_VARIABLE_BYTES;
}

export function valueAsText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Tokenize JSON into escaped HTML with token classes. Whitespace is preserved by
 * the wrapping `<pre>`, so indentation survives untouched.
 */
export function highlightJson(text) {
  const source = String(text ?? "");
  const classes = {
    key: "tok-key",
    string: "tok-string",
    number: "tok-number",
    literal: "tok-literal",
    punct: "tok-punct",
  };
  let html = "";
  let index = 0;
  let lastEmittedWasKey = false;

  while (index < source.length) {
    const character = source[index];

    if (character === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      const token = source.slice(index, end);
      let after = end;
      while (after < source.length && /\s/.test(source[after])) after += 1;
      const isKey = source[after] === ":";
      html += `<span class="${isKey ? classes.key : classes.string}">${escapeHtml(token)}</span>`;
      lastEmittedWasKey = isKey;
      index = end;
      continue;
    }

    if (/[-\d]/.test(character)) {
      let end = index;
      while (end < source.length && /[-+.eE\d]/.test(source[end])) end += 1;
      if (end > index) {
        html += `<span class="${classes.number}">${escapeHtml(source.slice(index, end))}</span>`;
        index = end;
        continue;
      }
    }

    if (source.startsWith("true", index) || source.startsWith("false", index) || source.startsWith("null", index)) {
      const word = source.startsWith("false", index) ? "false" : source.startsWith("true", index) ? "true" : "null";
      html += `<span class="${classes.literal}">${word}</span>`;
      index += word.length;
      continue;
    }

    if ("{}[],:".includes(character)) {
      html += `<span class="${classes.punct}">${escapeHtml(character)}</span>`;
      index += 1;
      continue;
    }

    html += escapeHtml(character);
    index += 1;
    lastEmittedWasKey = lastEmittedWasKey && character === ":";
  }

  return html;
}

/** Line-by-line split used by the gutter; the numbers are rendered by the view. */
export function toLines(text) {
  return String(text ?? "").split("\n");
}

/**
 * JSONPath set for a tree search: every matching node plus the ancestors needed
 * to reach it. Returning paths (rather than filtering the value tree) keeps the
 * renderer a plain recursive component and keeps the rule unit-testable.
 */
export function matchingPaths(root, query) {
  const needle = String(query || "").toLowerCase();
  const visible = new Set();

  const walk = (value, path) => {
    const container = value !== null && typeof value === "object";
    let hit = false;

    if (!container) {
      hit = !needle || String(value).toLowerCase().includes(needle);
    } else {
      for (const entry of containerEntries(value)) {
        const childPath = path + entry.path;
        const childHit = walk(entry.value, childPath);
        const keyHit = !!needle && entry.key.toLowerCase().includes(needle);
        if (keyHit) visible.add(childPath);
        if (childHit || keyHit) hit = true;
      }
    }

    if (hit) visible.add(path);
    return hit;
  };

  walk(root, "$");
  return visible;
}
