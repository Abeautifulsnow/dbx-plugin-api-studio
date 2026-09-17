<script>
  import Modal from "./Modal.svelte";

  /**
   * Destructive confirmation. Default focus is the Cancel button: ui-style.md
   * requires that an accidental Enter never confirms a deletion.
   */
  let {
    title,
    message,
    confirmLabel,
    cancelLabel,
    danger = false,
    onConfirm = () => {},
    onCancel = () => {},
  } = $props();
</script>

<Modal {title} titleId="confirm-title" onClose={onCancel} width="min(420px, calc(100vw - 32px))">
  <p class="modal__text">{message}</p>
  {#snippet footer()}
    <button type="button" class="btn" data-initial-focus onclick={onCancel}>{cancelLabel}</button>
    <button
      type="button"
      class="btn"
      class:btn--danger={danger}
      class:btn--primary={!danger}
      onclick={onConfirm}
    >
      {confirmLabel}
    </button>
  {/snippet}
</Modal>
