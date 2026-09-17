<script lang="ts">
  export let value: unknown;
  export let path = "$";
  export let onCopy: (value: string) => void = () => {};
  let expanded = true;
  const isObject = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object";
  const entries = () => Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>);
  const scalar = (item: unknown) => item === null ? "null" : typeof item === "string" ? JSON.stringify(item) : String(item);
</script>

{#if isObject(value)}
  <div class="json-node" role="treeitem" aria-expanded={expanded} aria-selected="false">
    <button class="json-toggle" aria-label={expanded ? "Collapse" : "Expand"} on:click={() => expanded = !expanded}>{expanded ? "⌄" : "›"}</button>
    <span class="json-brace">{Array.isArray(value) ? "[" : "{"}</span>
    {#if expanded}
      <div class="json-children">
        {#each entries() as [key, item]}
          <div class="json-row">
            <button class="json-key" on:click={() => onCopy(`${path}${Array.isArray(value) ? `[${key}]` : `.${key}`}`)}>{key}</button>
            {#if isObject(item)}
              <svelte:self value={item} path={`${path}${Array.isArray(value) ? `[${key}]` : `.${key}`}`} {onCopy} />
            {:else}
              <button class="json-value" on:click={() => onCopy(String(item))}>{scalar(item)}</button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <span class="json-brace">{Array.isArray(value) ? "]" : "}"}</span>
  </div>
{:else}
  <button class="json-value" on:click={() => onCopy(String(value))}>{scalar(value)}</button>
{/if}
