<script>
  import Icon from "./Icon.svelte";

  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

  /**
   * Method + URL + Send/Save row. The method always shows its text; the colour
   * accent is redundant, never the only signal (ui-style.md).
   */
  let {
    request,
    sending = false,
    dirty = false,
    tlsDisabled = false,
    t = (key) => key,
    onUrlInput = () => {},
    onMethodChange = () => {},
    onSend = () => {},
    onCancel = () => {},
    onSave = () => {},
    onMore = () => {},
  } = $props();
</script>

<div class="command-row">
  <select
    class="select method-select method-select--{request.method}"
    value={request.method}
    aria-label="HTTP method"
    onchange={(event) => onMethodChange(event.currentTarget.value)}
  >
    {#each METHODS as method (method)}
      <option value={method}>{method}</option>
    {/each}
  </select>

  {#if tlsDisabled}
    <span class="badge badge--warning" title={t("tlsWarning")}>
      <Icon name="alert" />
      TLS
    </span>
  {/if}

  <input
    class="input mono url-input"
    value={request.url}
    placeholder={"https://api.example.com/v1/users/{{userId}}"}
    aria-label={t("urlLabel")}
    spellcheck="false"
    oninput={(event) => onUrlInput(event.currentTarget.value)}
  />

  <div class="command-row__actions">
    {#if sending}
      <button type="button" class="btn btn--danger send" onclick={onCancel}>
        <Icon name="close" />
        <span>{t("cancel")}</span>
      </button>
    {:else}
      <button type="button" class="btn btn--primary send" onclick={onSend}>
        <Icon name="send" />
        <span>{t("send")}</span>
      </button>
    {/if}
    <button type="button" class="btn" disabled={!dirty} onclick={onSave}>
      <Icon name="save" />
      <span>{t("save")}</span>
    </button>
    <button
      type="button"
      class="icon-btn"
      aria-label={t("moreActions")}
      title={t("moreActions")}
      onclick={onMore}
    >
      <Icon name="dots" />
    </button>
  </div>
</div>
