<script>
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";

  /**
   * Context/overflow menu. DBX forbids native `alert`/`confirm`/`prompt` inside
   * the sandbox (host-api.md §10), and the host does not supply a menu widget, so
   * this is the plugin-styled replacement used by tree rows, key/value rows and
   * JSON nodes.
   */
  let { x = 0, y = 0, items = [], onSelect = () => {}, onClose = () => {} } = $props();

  let element = $state(null);

  onMount(() => {
    // Keep the menu inside the viewport, then focus the first usable action so
    // the menu is operable by keyboard alone.
    const rect = element?.getBoundingClientRect();
    if (rect) {
      const maxX = window.innerWidth - rect.width - 8;
      const maxY = window.innerHeight - rect.height - 8;
      element.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
      element.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
    }
    const first = element?.querySelector("button:not([disabled])");
    first?.focus();

    const onPointerDown = (event) => {
      if (!element?.contains(event.target)) onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = [...(element?.querySelectorAll("button:not([disabled])") || [])];
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = (index + step + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  });
</script>

<div class="menu" role="menu" bind:this={element} style={`left:${x}px; top:${y}px`}>
  {#each items as item, index (item.id ?? `sep-${index}`)}
    {#if item.separator}
      <div class="menu__sep" role="separator"></div>
    {:else}
      <button
        type="button"
        role="menuitem"
        class="menu__item"
        class:menu__item--danger={item.danger}
        disabled={item.disabled}
        title={item.hint || item.label}
        onclick={() => {
          onSelect(item.id);
          onClose();
        }}
      >
        {#if item.icon}<Icon name={item.icon} />{/if}
        <span>{item.label}</span>
      </button>
    {/if}
  {/each}
</div>
