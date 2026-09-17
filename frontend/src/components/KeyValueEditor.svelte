<script lang="ts">
  type Row = { id: string; key: string; value: string; enabled: boolean; secret?: boolean };
  export let rows: Row[] = [];
  export let keyLabel = "Name";
  export let valueLabel = "Value";
  export let addLabel = "Add row";
  export let secretKeys = false;
  export let onChange: () => void = () => {};
  export let onAdd: () => void = () => {};
  export let onRemove: (row: Row) => void = () => {};
</script>

<div class="kv-head"><span></span><span>{keyLabel}</span><span>{valueLabel}</span><span></span></div>
{#each rows as row (row.id)}
  <div class="kv-row">
    <input type="checkbox" bind:checked={row.enabled} on:change={onChange} aria-label="Enabled" />
    <input class="input mono" bind:value={row.key} on:input={onChange} aria-label={keyLabel} />
    <input class="input mono" bind:value={row.value} on:input={onChange} type={secretKeys && /token|secret|key|password|auth|cookie/i.test(row.key) ? "password" : "text"} aria-label={valueLabel} />
    <button class="icon-btn" type="button" on:click={() => onRemove(row)} aria-label="Delete row">×</button>
  </div>
{/each}
<button class="add-row" type="button" on:click={onAdd}>＋ {addLabel}</button>
