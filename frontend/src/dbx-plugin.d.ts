/**
 * Ambient declarations for the sandboxed workbench.
 *
 * `window.dbxPlugin` is the DBX Host Bridge (Host API 1.x). Only the members the
 * workbench actually uses are declared — the bridge is not a general-purpose
 * network or filesystem API, and everything else must go through the sidecar.
 */
interface Window {
  dbxPlugin: {
    /** Resolves once the host has finished initializing the plugin frame. */
    ready: Promise<void>;
    /** BCP-47-ish tag, e.g. "en", "zh-CN". */
    locale?: string;
    theme?: { appearance?: "light" | "dark" };
    /** Workbench context snapshot; opaque JSON, never credentials. */
    context?: Record<string, unknown>;
    invoke<T>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
    notify?(method: string, params: unknown): void;
    onContext?(handler: (context: unknown) => void): () => void;
  };
}

/** Svelte 5 component modules (single-file components are not TS modules). */
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<Record<string, unknown>>;
  export default component;
}
