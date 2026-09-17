/**
 * Small pure helpers shared by the workbench UI.
 *
 * Everything here is framework-free on purpose: the same modules are imported
 * by the Svelte components and by the Node test suites under `tools/`, so the
 * tests exercise exactly the code that ships.
 */

/** Cryptographically strong id; `crypto.randomUUID` is unavailable in some
 * sandboxed frames, so fall back to `getRandomValues` rather than Math.random. */
export function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function uid(prefix) {
  const core = crypto.randomUUID ? crypto.randomUUID() : randomId();
  return (prefix ? prefix + "_" : "") + core;
}

export function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function debounce(fn, wait) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    return fn(...args);
  };
  return wrapped;
}

export function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function formatBytes(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

export function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

export function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return "";
  }
}

/** Relative timestamp for the history list; `justNow` is injected so this
 * module stays free of UI language concerns. */
export function timeAgo(timestamp, justNow, now = Date.now()) {
  const delta = now - timestamp;
  if (delta < 60_000) return justNow;
  if (delta < 3_600_000) return Math.floor(delta / 60_000) + " min";
  if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + " h";
  return Math.floor(delta / 86_400_000) + " d";
}

export function btoaUtf8(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

export function safeDecode(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, " "));
  } catch {
    return String(text);
  }
}

/**
 * Copy to the clipboard with a fallback for sandboxed frames, where the async
 * Clipboard API is frequently unavailable without a user gesture.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
