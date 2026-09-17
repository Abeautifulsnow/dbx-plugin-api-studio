interface Window {
  dbxPlugin: {
    ready: Promise<void>;
    locale?: string;
    theme?: { appearance?: string };
    invoke<T>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
  };
}
