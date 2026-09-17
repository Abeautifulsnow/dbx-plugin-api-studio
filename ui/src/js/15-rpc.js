/* ==== Sidecar RPC wrappers (Host Bridge) ==== */

const Api = (() => {
  function invoke(method, params, options) {
    return window.dbxPlugin.invoke(method, params, options);
  }

  return {
    async request(spec, timeoutMs) {
      return invoke("api/request", spec, { timeoutMs });
    },
    cancel(requestId) {
      return invoke("api/cancel", { requestId });
    },
    exportCurl(spec, timeoutMs) {
      return invoke("api/export-curl", spec, { timeoutMs });
    },
    async loadAll() {
      const result = await invoke("api/persistence/load", {});
      return {
        state: result && result.state ? result.state : null,
        history: result && Array.isArray(result.history) ? result.history : [],
      };
    },
    saveState(state) {
      return invoke("api/persistence/save", { state });
    },
    historyAppend(entry) {
      return invoke("api/persistence/history-append", { entry });
    },
    historyClear() {
      return invoke("api/persistence/history-clear", {});
    },
  };
})();
