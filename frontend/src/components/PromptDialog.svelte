<script>
  import { untrack } from "svelte";
  import Modal from "./Modal.svelte";

  /**
   * Name prompt (new collection / folder / request / environment, and rename).
   * Validation runs inline and is announced, instead of failing silently.
   */
  let {
    title,
    label,
    initialValue = "",
    placeholder = "",
    submitLabel = "OK",
    cancelLabel = "Cancel",
    requiredMessage = "A name is required",
    takenMessage = "",
    isTaken = () => false,
    onSubmit = () => {},
    onCancel = () => {},
  } = $props();

  // The prompt is a one-shot editor: the incoming value seeds the field and is
  // then owned locally, so it is deliberately not tracked afterwards.
  let value = $state(untrack(() => initialValue));
  let error = $state("");

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) {
      error = requiredMessage;
      return;
    }
    if (takenMessage && isTaken(trimmed)) {
      error = takenMessage;
      return;
    }
    onSubmit(trimmed);
  }
</script>

<Modal {title} titleId="prompt-title" onClose={onCancel} width="min(440px, calc(100vw - 32px))">
  <div class="form-field">
    <label class="form-field__label" for="prompt-input">{label}</label>
    <input
      id="prompt-input"
      class="input"
      bind:value
      {placeholder}
      data-initial-focus
      aria-invalid={error ? "true" : "false"}
      aria-describedby={error ? "prompt-error" : undefined}
      oninput={() => (error = "")}
      onkeydown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        submit();
      }}
    />
    {#if error}
      <p class="field-error" id="prompt-error" role="alert">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 2.6l5.6 10.2H2.4z" /><path d="M8 6.6v3.2" /><path d="M8 11.4v.01" />
        </svg>
        <span>{error}</span>
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button type="button" class="btn" onclick={onCancel}>{cancelLabel}</button>
    <button type="button" class="btn btn--primary" onclick={submit}>{submitLabel}</button>
  {/snippet}
</Modal>
