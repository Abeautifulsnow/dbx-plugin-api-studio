<script>
  import Modal from "./Modal.svelte";

  /**
   * Paste a cURL command, hand it to the sidecar parser (`api/import-curl`),
   * and apply the recovered request. Parse errors surface inline; partial
   * imports (unknown flags) arrive as warnings on the result.
   */
  let {
    t = (key) => key,
    onImport = () => {},
    onCancel = () => {},
  } = $props();

  let command = $state("");
  let error = $state("");
  let busy = $state(false);

  async function submit() {
    if (!command.trim() || busy) return;
    busy = true;
    error = "";
    try {
      await onImport(command.trim());
    } catch (failure) {
      error = failure?.message ?? String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  title={t("importCurl")}
  titleId="import-title"
  onClose={onCancel}
  width="min(680px, calc(100vw - 32px))"
>
  <div class="form-field">
    <label class="form-field__label" for="curl-input">{t("curlCommand")}</label>
    <textarea
      id="curl-input"
      class="code-input mono"
      bind:value={command}
      rows="7"
      spellcheck="false"
      data-initial-focus
      placeholder={"curl 'https://api.example.com/users' \\\n  -H 'Authorization: Bearer …' \\\n  --data '{\"name\":\"Alice\"}'"}
      aria-invalid={error ? "true" : "false"}
    ></textarea>
    {#if error}
      <p class="field-error" role="alert">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 2.6l5.6 10.2H2.4z" /><path d="M8 6.6v3.2" /><path d="M8 11.4v.01" />
        </svg>
        <span>{error}</span>
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button type="button" class="btn" data-initial-focus onclick={onCancel}>{t("cancel")}</button>
    <button type="button" class="btn btn--primary" disabled={busy || !command.trim()} onclick={submit}>
      {t("import")}
    </button>
  {/snippet}
</Modal>
