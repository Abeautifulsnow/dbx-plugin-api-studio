/**
 * Host bridge access. Every call into the sidecar goes through here so the
 * components never touch `window.dbxPlugin` directly and the RPC shape stays in
 * one auditable place.
 *
 * Errors are surfaced as `{ code, message, category }`: the sidecar already
 * sanitized the cause (no resolved URL query parameters cross the boundary), and
 * `category` is the stable taxonomy the UI maps to a recovery hint.
 */
const bridge = () => window.dbxPlugin;

export class RpcError extends Error {
  constructor(message, { code = -32603, category = "INTERNAL_ERROR" } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.category = category;
  }
}

export function toRpcError(error, fallbackCategory = "INTERNAL_ERROR") {
  if (error instanceof RpcError) return error;
  const category = error?.data?.category || fallbackCategory;
  return new RpcError(error?.message || String(error), { code: error?.code ?? -32603, category });
}

async function invoke(method, params, options) {
  try {
    return await bridge().invoke(method, params, options);
  } catch (error) {
    throw toRpcError(error);
  }
}

/** Load persisted collections, environments, settings and history. */
export async function loadPersistedState() {
  const result = await invoke("api/persistence/load", {});
  return { state: result?.state ?? null, history: result?.history ?? [] };
}

export async function saveState(state) {
  return invoke("api/persistence/save", { state });
}

export async function appendHistory(entry) {
  return invoke("api/persistence/history-append", { entry });
}

export async function clearHistory() {
  return invoke("api/persistence/history-clear", {});
}

/**
 * Execute a request. Resolves to `{ cancelled: true }` when the sidecar reports
 * a neutral cancellation, otherwise the normalized response payload.
 */
export async function sendRequest(spec) {
  const timeoutMs = Math.min(120000, Math.max(1000, (spec?.settings?.timeoutMs ?? 30000) + 5000));
  return invoke("api/request", spec, { timeoutMs });
}

export async function cancelRequest(requestId) {
  return invoke("api/cancel", { requestId });
}

export async function exportCurl(spec) {
  const result = await invoke("api/export-curl", spec, { timeoutMs: 10000 });
  return result?.curl ?? "";
}
