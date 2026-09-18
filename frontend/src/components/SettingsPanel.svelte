<script>
  import { clampInt } from "../lib/format.js";
  import { formatBytes } from "../lib/format.js";
  import Icon from "./Icon.svelte";

  /**
   * Per-request execution settings. Values are clamped on blur and again in
   * `buildSendSpec`, and disabling TLS verification raises a visible warning
   * rather than passing silently.
   */
  let {
    settings,
    previewCapBytes = 2 * 1024 * 1024,
    t = (key) => key,
    onChange = () => {},
    onPreviewCapChange = () => {},
  } = $props();

  let timeoutError = $state("");
  let redirectError = $state("");

  function commitTimeout() {
    const clamped = clampInt(settings.timeoutMs, 1000, 300000, 30000);
    timeoutError = clamped !== Number(settings.timeoutMs) ? `${1000}–${300000} ms` : "";
    settings.timeoutMs = clamped;
    onChange();
  }

  function commitRedirects() {
    const clamped = clampInt(settings.maxRedirects, 0, 20, 10);
    redirectError = clamped !== Number(settings.maxRedirects) ? "0–20" : "";
    settings.maxRedirects = clamped;
    onChange();
  }

  // All options sit inside the sidecar's 6 MiB ceiling, so the UI never offers
  // a value that would be silently clamped. Binary previews stop lower (4 MiB
  // raw) because base64 expands them 4/3 inside the 8 MiB RPC message.
  const CAP_OPTIONS = [
    512 * 1024,
    1024 * 1024,
    2 * 1024 * 1024,
    4 * 1024 * 1024,
    6 * 1024 * 1024,
  ];

  // `settings.proxy` is normalized on load; guard for safety anyway.
  const proxyMode = $derived(settings.proxy?.mode || "system");
</script>

<div class="settings-panel">
  <div class="field">
    <label class="field__label" for="setting-timeout">{t("timeout")}</label>
    <input
      id="setting-timeout"
      class="input"
      type="number"
      min="1000"
      max="300000"
      step="1000"
      bind:value={settings.timeoutMs}
      aria-invalid={timeoutError ? "true" : "false"}
      onblur={commitTimeout}
      onchange={onChange}
    />
    {#if timeoutError}
      <p class="field-error" role="alert">
        <Icon name="alert" />
        <span>{timeoutError}</span>
      </p>
    {/if}
  </div>

  <div class="field field--check">
    <label class="checkbox">
      <input type="checkbox" bind:checked={settings.followRedirects} onchange={onChange} />
      <span>{t("followRedirects")}</span>
    </label>
  </div>

  <div class="field">
    <label class="field__label" for="setting-redirects">{t("maxRedirects")}</label>
    <input
      id="setting-redirects"
      class="input"
      type="number"
      min="0"
      max="20"
      bind:value={settings.maxRedirects}
      disabled={settings.followRedirects === false}
      aria-invalid={redirectError ? "true" : "false"}
      onblur={commitRedirects}
      onchange={onChange}
    />
    {#if redirectError}
      <p class="field-error" role="alert">
        <Icon name="alert" />
        <span>{redirectError}</span>
      </p>
    {/if}
  </div>

  <div class="field field--check">
    <label class="checkbox">
      <input type="checkbox" bind:checked={settings.verifyTls} onchange={onChange} />
      <span>{t("verifyTls")}</span>
    </label>
  </div>

  <div class="field">
    <label class="field__label" for="setting-preview">{t("previewCap")}</label>
    <select
      id="setting-preview"
      class="select"
      value={String(previewCapBytes)}
      onchange={(event) => onPreviewCapChange(Number(event.currentTarget.value))}
    >
      {#each CAP_OPTIONS as option (option)}
        <option value={String(option)}>{formatBytes(option)}</option>
      {/each}
    </select>
  </div>

  {#if settings.verifyTls === false}
    <p class="notice notice--warning" role="alert">
      <Icon name="alert" />
      <span>{t("tlsWarning")}</span>
    </p>
  {/if}

  <h3 class="settings-panel__section">{t("proxy")}</h3>
  <div class="field">
    <label class="field__label" for="proxy-mode">{t("proxyMode")}</label>
    <select
      id="proxy-mode"
      class="select"
      value={proxyMode}
      onchange={(event) => {
        settings.proxy.mode = event.currentTarget.value;
        onChange();
      }}
    >
      <option value="system">{t("proxySystem")}</option>
      <option value="none">{t("proxyNone")}</option>
      <option value="custom">{t("proxyCustom")}</option>
    </select>
  </div>

  {#if proxyMode === "custom"}
    <div class="field">
      <label class="field__label" for="proxy-url">{t("proxyUrl")}</label>
      <input
        id="proxy-url"
        class="input mono"
        bind:value={settings.proxy.url}
        placeholder="http://127.0.0.1:8080 或 socks5://…"
        spellcheck="false"
        oninput={onChange}
      />
    </div>
    <div class="field">
      <label class="field__label" for="proxy-user">{t("usernameLabel")}</label>
      <input id="proxy-user" class="input" bind:value={settings.proxy.username} autocomplete="off" oninput={onChange} />
    </div>
    <div class="field">
      <label class="field__label" for="proxy-pass">{t("passwordLabel")}</label>
      <input
        id="proxy-pass"
        class="input mono"
        type="password"
        bind:value={settings.proxy.password}
        autocomplete="off"
        oninput={onChange}
      />
    </div>
    <p class="notice notice--info">
      <Icon name="info" />
      <span>{t("proxyNote")}</span>
    </p>
  {/if}
</div>
