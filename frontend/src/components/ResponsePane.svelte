<script>
  import { formatBytes, formatMs, formatTime, copyText } from "../lib/format.js";
  import {
    highlightJson,
    matchingPaths,
    parseJson,
    prettyJson,
    toLines,
    canSetAsVariable,
    valueAsText,
  } from "../lib/jsonview.js";
  import { responseCookies } from "../lib/model.js";
  import { NEXT_STEP_KEYS } from "../lib/i18n.js";
  import Icon from "./Icon.svelte";
  import JsonTree from "./JsonTree.svelte";
  import Menu from "./Menu.svelte";

  /**
   * Response inspector: Body / Headers / Cookies / Timing plus the diagnostics
   * block for failures.
   *
   * The previous response stays on screen while a new request is in flight — dimmed
   * and labelled — so stale data is never mistaken for the current result.
   */
  let {
    response = null,
    sending = false,
    error = null,
    cancelled = false,
    receivedAt = null,
    truncatedLimit = 2 * 1024 * 1024,
    t = (key) => key,
    onRetry = () => {},
    onCopyText = () => {},
    onPromoteToEnv = null,
    onClearCookies = null,
  } = $props();

  const TABS = [
    { id: "body", label: "responseBody" },
    { id: "headers", label: "responseHeaders" },
    { id: "cookies", label: "cookies" },
    { id: "timing", label: "responseTiming" },
  ];

  let tab = $state("body");
  let view = $state("text");
  let search = $state("");
  let nodeMenu = $state(null);

  const bodyText = $derived(response ? (response.body.text ?? response.body.base64 ?? "") : "");
  const binary = $derived(!!response && response.body.text == null && !!response.body.base64);
  // Binary bodies are enforced at a smaller limit than text; the sidecar
  // reports which one actually applied.
  const previewLimit = $derived(response?.previewLimitBytes ?? truncatedLimit);
  // `sizeBytes` is the preview that was delivered. When the server reported a
  // total and it differs from the preview, show both so a truncated response is
  // never mistaken for the whole body.
  const sizeLabel = $derived.by(() => {
    if (!response) return "—";
    const preview = formatBytes(response.body.sizeBytes);
    const total = response.contentLength;
    if (response.body.truncated && total != null && total !== response.body.sizeBytes) {
      return `${preview} / ${formatBytes(total)}`;
    }
    return preview;
  });
  const parsed = $derived(
    response && response.body.text && !binary ? parseJson(response.body.text) : { ok: false },
  );
  const cookies = $derived(responseCookies(response));
  const cookieCount = $derived(cookies.length);
  const visiblePaths = $derived(
    parsed.ok && view === "tree" ? matchingPaths(parsed.value, search) : null,
  );
  const prettyHtml = $derived(
    response && !binary && response.body.text ? highlightJson(prettyJson(response.body.text) ?? response.body.text) : "",
  );
  const failed = $derived(!!error);

  const statusKind = $derived.by(() => {
    if (!response) return "none";
    if (response.status >= 500) return "err";
    if (response.status >= 400) return "warn";
    return "ok";
  });

  function nodeActions(node) {
    const items = [
      { id: "value", label: t("copyValue"), icon: "copy" },
      { id: "path", label: t("copyPath"), icon: "copy" },
    ];
    if (onPromoteToEnv) {
      items.push({ separator: true, id: "sep" });
      items.push({
        id: "env",
        label: t("setEnvVar"),
        icon: "globe",
        disabled: !canSetAsVariable(node.value, node.truncated),
        hint: canSetAsVariable(node.value, node.truncated) ? "" : t("setEnvVarDisabled"),
      });
    }
    return items;
  }

  function onNodeAction(event, node) {
    if (node.copyOnly === "key") {
      onCopyText(JSON.stringify(node.key));
      return;
    }
    if (node.copyOnly === "value") {
      onCopyText(valueAsText(node.value));
      return;
    }
    if (!event) return;
    nodeMenu = { x: event.clientX, y: event.clientY, node };
  }

  function runNodeAction(id, node) {
    if (id === "value") onCopyText(valueAsText(node.value));
    else if (id === "path") onCopyText(node.path);
    else if (id === "env" && onPromoteToEnv) onPromoteToEnv(node);
  }
</script>

<section class="response">
  <header class="response__header">
    <nav class="tabs" aria-label={t("responseOf")}>
      {#each TABS as item (item.id)}
        <button
          type="button"
          class="tabs__tab"
          class:tabs__tab--active={tab === item.id}
          aria-pressed={tab === item.id}
          onclick={() => (tab = item.id)}
        >
          <span>{t(item.label)}</span>
          {#if item.id === "cookies" && cookieCount}
            <span class="tabs__count">{cookieCount}</span>
          {/if}
        </button>
      {/each}
    </nav>

    {#if response}
      <div class="response__meta" class:response__meta--stale={sending}>
        <span class="status-dot status-dot--{statusKind}" aria-hidden="true"></span>
        <span class="response__status">{response.status} {response.statusText}</span>
        <span class="response__dim">{formatMs(response.timing.totalMs)}</span>
        <span class="response__dim">{sizeLabel}</span>
        {#if receivedAt}<span class="response__dim">{formatTime(receivedAt)}</span>{/if}
      </div>
    {/if}
  </header>

  {#if sending}
    <p class="response__sending" role="status">
      <Icon name="clock" />
      <span>{t("sending")}</span>
    </p>
  {/if}

  <div class="response__pane" class:response__pane--stale={sending}>
    {#if failed}
      <div class="error-card" role="alert">
        <h3 class="error-card__title">
          <Icon name="alert" />
          <span>{t("errSummary")}</span>
          <code class="error-card__category">{error.category}</code>
        </h3>
        <p class="error-card__cause mono">{error.message}</p>
        {#if NEXT_STEP_KEYS[error.category]}
          <p class="error-card__next">
            <strong>{t("errNext")}</strong>
            <span>{t(NEXT_STEP_KEYS[error.category])}</span>
          </p>
        {/if}
        <button type="button" class="btn" onclick={onRetry}>
          <Icon name="send" />
          <span>{t("retry")}</span>
        </button>
      </div>
    {:else if cancelled}
      <p class="empty-state">{t("requestCancelled")}</p>
    {:else if !response}
      <p class="empty-state">{t("noResponse")}</p>
    {:else if tab === "body"}
      {#if binary}
        <p class="notice notice--info">
          <Icon name="info" />
          <span>{t("binaryBody", { size: formatBytes(response.body.sizeBytes), type: response.contentType || "application/octet-stream" })}</span>
        </p>
      {:else}
        {#if response.body.truncated}
          <p class="notice notice--warning" role="status">
            <Icon name="alert" />
            <span>{t("truncatedNote", { cap: formatBytes(previewLimit), shown: formatBytes(response.body.sizeBytes) })}</span>
          </p>
        {/if}
        <div class="response-toolbar">
          <div class="segmented" role="group" aria-label={t("responseBody")}>
            <button
              type="button"
              class="segmented__item"
              class:segmented__item--active={view === "text"}
              onclick={() => (view = "text")}
            >
              {t("viewText")}
            </button>
            <button
              type="button"
              class="segmented__item"
              class:segmented__item--active={view === "tree"}
              disabled={!parsed.ok}
              onclick={() => (view = "tree")}
            >
              {t("viewTree")}
            </button>
          </div>
          {#if view === "tree" && parsed.ok}
            <div class="search-field search-field--inline">
              <Icon name="search" className="search-field__icon" />
              <input
                class="input search-field__input"
                value={search}
                placeholder={t("searchJson")}
                aria-label={t("searchJson")}
                oninput={(event) => (search = event.currentTarget.value)}
              />
            </div>
          {/if}
          <button type="button" class="btn" onclick={() => onCopyText(bodyText)}>
            <Icon name="copy" />
            <span>{t("copy")}</span>
          </button>
        </div>

        {#if view === "tree" && parsed.ok}
          {#if search && visiblePaths && visiblePaths.size <= 1}
            <p class="empty-state">{t("noJsonMatches")}</p>
          {:else}
            <div class="jv-scroll">
              <JsonTree value={parsed.value} visible={visiblePaths} truncated={response.body.truncated} {t} {onNodeAction} />
            </div>
          {/if}
        {:else}
          <div class="pretty-json">
            <div class="pretty-json__gutter" aria-hidden="true">
              {#each toLines(bodyText) as _line, index (index)}
                <span class="pretty-json__num">{index + 1}</span>
              {/each}
            </div>
            <pre class="pretty-json__code mono">{@html prettyHtml}</pre>
          </div>
        {/if}
      {/if}
    {:else if tab === "headers"}
      {#if response.headers.length}
        <div class="headers-table">
          {#each response.headers as header (header.id)}
            <button
              type="button"
              class="headers-table__row"
              title={t("copyValue")}
              onclick={() => onCopyText(`${header.name}: ${header.value}`)}
            >
              <span class="headers-table__name mono">{header.name}</span>
              <span class="headers-table__value mono">{header.value}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="empty-state">{t("noResponse")}</p>
      {/if}
    {:else if tab === "cookies"}
      {#if onClearCookies}
        <div class="response-toolbar">
          <button type="button" class="btn" onclick={onClearCookies}>
            <Icon name="trash" />
            <span>{t("clearCookies")}</span>
          </button>
        </div>
      {/if}
      {#if cookieCount}
        <div class="headers-table">
          {#each cookies as cookie (cookie.id)}
            <div class="cookies__row">
              <span class="headers-table__name mono">{cookie.name}</span>
              <span class="headers-table__value mono">{cookie.value}</span>
              {#if cookie.attributes.length}
                <span class="cookies__attrs mono">{cookie.attributes.join("; ")}</span>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <p class="empty-state">{t("noCookies")}</p>
      {/if}
    {:else}
      <div class="timing">
        <table class="timing__table">
          <caption class="visually-hidden">{t("timingPanelTitle")}</caption>
          <tbody>
            <tr class="timing__row">
              <th scope="row">{t("phaseTotal")}</th>
              <td class="mono">{formatMs(response.timing.totalMs)}</td>
              <td class="timing__bar-cell">
                <span class="timing__bar"><span class="timing__bar-fill" style="width:100%"></span></span>
              </td>
            </tr>
            <tr class="timing__row">
              <th scope="row">{t("phaseTtfb")}</th>
              <td class="mono">{formatMs(response.timing.ttfbMs)}</td>
              <td class="timing__bar-cell">
                {#if response.timing.ttfbMs != null && response.timing.totalMs}
                  <span class="timing__bar">
                    <span
                      class="timing__bar-fill"
                      style={`width:${Math.min(100, Math.round((response.timing.ttfbMs / response.timing.totalMs) * 100))}%`}
                    ></span>
                  </span>
                {/if}
              </td>
            </tr>
            <tr class="timing__row">
              <th scope="row">{t("phaseDownload")}</th>
              <td class="mono">{formatMs(response.timing.downloadMs)}</td>
              <td class="timing__bar-cell">
                {#if response.timing.downloadMs != null && response.timing.totalMs}
                  <span class="timing__bar">
                    <span
                      class="timing__bar-fill"
                      style={`width:${Math.min(100, Math.round((response.timing.downloadMs / response.timing.totalMs) * 100))}%`}
                    ></span>
                  </span>
                {/if}
              </td>
            </tr>
            {#each [["phaseDns"], ["phaseConnect"], ["phaseTls"], ["phaseRequest"]] as [key] (key)}
              <tr class="timing__row timing__row--unavailable">
                <th scope="row">{t(key)}</th>
                <td class="timing__na">{t("timingNotAvailable")}</td>
                <td class="timing__bar-cell"></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="timing__note">{t("timingNote")}</p>
        <dl class="info-grid">
          <dt>{t("infoStatus")}</dt>
          <dd class="mono">{response.status} {response.statusText}</dd>
          <dt>{t("infoSize")}</dt>
          <dd class="mono">{sizeLabel}</dd>
          {#if response.contentType}
            <dt>{t("infoType")}</dt>
            <dd class="mono">{response.contentType}</dd>
          {/if}
          {#if response.redirectCount}
            <dt>{t("infoRedirects")}</dt>
            <dd class="mono">{t("redirectCountLabel", { count: response.redirectCount })}</dd>
          {/if}
          {#if response.finalUrl}
            <dt>{t("infoFinalUrl")}</dt>
            <dd class="mono">{response.finalUrl}</dd>
          {/if}
        </dl>
      </div>
    {/if}
  </div>
</section>

{#if nodeMenu}
  <Menu
    x={nodeMenu.x}
    y={nodeMenu.y}
    items={nodeActions(nodeMenu.node)}
    onClose={() => (nodeMenu = null)}
    onSelect={(id) => runNodeAction(id, nodeMenu.node)}
  />
{/if}
