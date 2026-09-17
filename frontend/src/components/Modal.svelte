<script>
  import { onMount } from "svelte";

  /**
   * Modal shell: backdrop, Escape to dismiss, focus moved into the dialog and
   * restored on close, plus a Tab wrap so focus cannot escape into the sandboxed
   * page behind it. Every dialog in the workbench is built on this.
   */
  let {
    title = "",
    titleId = "modal-title",
    dismissable = true,
    width = "",
    onClose = () => {},
    children,
    footer,
  } = $props();

  let dialog = $state(null);
  let previousFocus = null;

  const focusable = () =>
    [...(dialog?.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])") || [])].filter(
      (node) => !node.disabled,
    );

  onMount(() => {
    previousFocus = document.activeElement;
    const initial = dialog?.querySelector("[data-initial-focus]") || focusable()[0];
    initial?.focus();
    if (initial instanceof HTMLInputElement) initial.select?.();

    const onKeyDown = (event) => {
      if (event.key === "Escape" && dismissable) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  });
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={(event) => {
    if (dismissable && event.target === event.currentTarget) onClose();
  }}
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    style={width ? `width:${width}` : ""}
    bind:this={dialog}
  >
    <header class="modal__head">
      <h2 id={titleId}>{title}</h2>
      {#if dismissable}
        <button type="button" class="icon-btn" aria-label="Close" title="Close" onclick={onClose}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      {/if}
    </header>
    <div class="modal__body">
      {@render children?.()}
    </div>
    {#if footer}
      <footer class="modal__foot">{@render footer()}</footer>
    {/if}
  </div>
</div>
