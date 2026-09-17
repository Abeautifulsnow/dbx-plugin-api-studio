<script>
  import Icon from "./Icon.svelte";
  import Tree from "./Tree.svelte";

  /**
   * Recursive collection tree. Requests show the method as text (never colour
   * alone), containers show their child count, and every row exposes the same
   * context menu so rename/duplicate/delete work at any depth.
   */
  let {
    nodes = [],
    depth = 0,
    activeId = "",
    forceExpanded = false,
    expanded = new Set(),
    onToggle = () => {},
    onOpen = () => {},
    onMenu = () => {},
  } = $props();

  const isOpen = (node) => forceExpanded || expanded.has(node.id);

  const childCount = (node) => (node.items || []).length;
</script>

{#each nodes as node (node.id)}
  <div class="tree__group">
    {#if node.type === "request"}
      <div
        class="tree-row tree-row--request"
        class:tree-row--active={node.id === activeId}
        style={`--tree-depth:${depth}`}
      >
        <button type="button" class="tree-row__main" onclick={() => onOpen(node)}>
          <span class="method-tag method-tag--{node.request?.method || "GET"}">
            {node.request?.method || "GET"}
          </span>
          <span class="tree-row__name" title={node.request?.url || node.name}>{node.name}</span>
        </button>
        <button
          type="button"
          class="icon-btn tree-row__menu"
          aria-label="More actions"
          title="More actions"
          onclick={(event) => onMenu(event, node)}
        >
          <Icon name="dots" />
        </button>
      </div>
    {:else}
      <div
        class="tree-row"
        class:tree-row--collection={node.type === "collection"}
        class:tree-row--folder={node.type === "folder"}
        style={`--tree-depth:${depth}`}
      >
        <button
          type="button"
          class="tree-row__main"
          aria-expanded={isOpen(node)}
          onclick={() => onToggle(node.id)}
        >
          <span class="tree-row__caret" class:tree-row__caret--open={isOpen(node)}>
            <Icon name="chevronRight" />
          </span>
          <Icon name={node.type === "collection" ? "columns" : "folder"} />
          <span class="tree-row__name" title={node.name}>{node.name}</span>
          {#if childCount(node)}<span class="tree-row__count">{childCount(node)}</span>{/if}
        </button>
        <button
          type="button"
          class="icon-btn tree-row__menu"
          aria-label="More actions"
          title="More actions"
          onclick={(event) => onMenu(event, node)}
        >
          <Icon name="dots" />
        </button>
      </div>
      {#if isOpen(node) && childCount(node)}
        <Tree
          nodes={node.items}
          depth={depth + 1}
          {activeId}
          {forceExpanded}
          {expanded}
          {onToggle}
          {onOpen}
          {onMenu}
        />
      {/if}
    {/if}
  </div>
{/each}
