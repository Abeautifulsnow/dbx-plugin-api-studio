<script>
  /**
   * Transient confirmations (copy succeeded, variable set, save failed). The
   * region itself is a polite live region so screen readers announce toasts
   * without the caller having to remember to.
   */
  let { toasts = [] } = $props();
</script>

<div class="toast-region" role="status" aria-live="polite">
  {#each toasts as toast (toast.id)}
    <div class="toast">{toast.message}</div>
  {/each}
</div>
