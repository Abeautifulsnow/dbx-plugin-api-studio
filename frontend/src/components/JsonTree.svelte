<script>
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import JsonTree from "./JsonTree.svelte";
  import { containerEntries, describe, valueClass, jsonPathOf } from "../lib/jsonview.js";

  /**
   * One JSON node. Children render only when the node is expanded, so a wide
   * payload never stalls the workbench, and the search result set (`visible`,
   * computed once by the parent) decides which paths are shown at all.
   *
   * Disclosure is expressed with `aria-expanded` on the toggle button rather
   * than `role="tree"`/`treeitem`: a full tree widget would also owe the user
   * roving focus and arrow-key navigation, which this view does not implement.
   */
  let {
    value,
    nodeKey = null,
    path = "$",
    depth = 0,
    visible = null,
    truncated = false,
    t = (key) => key,
    onNodeAction = () => {},
  } = $props();

  // Depth only seeds the initial expansion state; it is not a live input.
  let expanded = $state(untrack(() => depth < 1));

  const info = $derived(describe(value));
  const isContainer = $derived(info.kind === "object" || info.kind === "array");
  const entries = $derived(isContainer ? containerEntries(value) : []);
  const shown = (childPath) => !visible || visible.has(childPath);
  const hasVisibleChildren = $derived(entries.some((entry) => shown(path + entry.path)));
  const empty = $derived(info.label === "{0}" || info.label === "[0]");

  const node = $derived({ key: nodeKey, path: jsonPathOf(path), value, truncated });

  /** The context menu hangs off the row's own buttons, so no bare div listens. */
  function openMenu(event) {
    event.preventDefault();
    onNodeAction(event, node);
  }
</script>

{#if shown(path)}
  <div class="jv" class:jv--container={isContainer}>
    <div class="jv__row">
      {#if isContainer}
        <button
          type="button"
          class="jv__toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse" : "Expand"}
          title={expanded ? "Collapse" : "Expand"}
          onclick={() => (expanded = !expanded)}
          oncontextmenu={openMenu}
        >
          <Icon
            name="chevronRight"
            className={expanded ? "jv__caret jv__caret--open" : "jv__caret"}
          />
        </button>
      {:else}
        <span class="jv__toggle"></span>
      {/if}

      {#if nodeKey !== null}
        <button
          type="button"
          class="jv__key"
          title={t("copyKey")}
          oncontextmenu={openMenu}
          onclick={() => onNodeAction(null, { ...node, copyOnly: "key" })}
        >
          {JSON.stringify(nodeKey)}
        </button>
        <span class="jv__punct">:</span>
      {/if}

      {#if isContainer}
        <span class="jv__punct">{info.kind === "array" ? "[" : "{"}</span>
        <span class="jv__summary">{info.label}</span>
        {#if !expanded && !empty}
          <span class="jv__punct">{info.kind === "array" ? "]" : "}"}</span>
        {/if}
      {:else}
        <button
          type="button"
          class={valueClass(info.kind)}
          title={t("copyValue")}
          oncontextmenu={openMenu}
          onclick={() => onNodeAction(null, { ...node, copyOnly: "value" })}
        >
          {info.label}
        </button>
      {/if}
    </div>

    {#if isContainer && expanded && hasVisibleChildren}
      <div class="jv__children">
        {#each entries as entry (entry.path)}
          <JsonTree
            value={entry.value}
            nodeKey={entry.key}
            path={path + entry.path}
            depth={depth + 1}
            {visible}
            {truncated}
            {t}
            {onNodeAction}
          />
        {/each}
      </div>
    {/if}
  </div>
{/if}
