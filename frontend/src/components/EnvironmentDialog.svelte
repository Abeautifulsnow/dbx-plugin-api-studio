<script lang="ts">
  type Row = { id: string; key: string; value: string; enabled: boolean; secret?: boolean };
  type Environment = { id: string; name: string; prodLike: boolean; confirmUnsafe: boolean; variables: Row[] };
  export let environments: Environment[] = [];
  export let selectedId = "";
  export let onClose: () => void = () => {};
  export let onChange: () => void = () => {};
  export let onAdd: (name: string) => void = () => {};
  let name = "";
  let activeId = selectedId;
  $: active = environments.find((item) => item.id === activeId);
  const addVariable = () => { if (!active) return; active.variables = [...active.variables, { id: crypto.randomUUID(), key: "", value: "", enabled: true }]; environments = [...environments]; onChange(); };
</script>

<div class="backdrop" role="presentation" on:click={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal env-modal" role="dialog" aria-modal="true" aria-labelledby="env-title">
    <header class="modal-header"><h2 id="env-title">Environments / 环境</h2><button class="icon-btn" on:click={onClose} aria-label="Close">×</button></header>
    <div class="env-layout">
      <nav class="env-list" aria-label="Environments">
        {#each environments as environment}
          <button class:active={environment.id === activeId} on:click={() => { activeId = environment.id; selectedId = activeId; onChange(); }}>{environment.prodLike ? "⚠ " : ""}{environment.name}</button>
        {/each}
        <div class="env-create"><input class="input" bind:value={name} placeholder="New environment / 新环境" /><button class="btn primary" on:click={() => { if (name.trim()) { onAdd(name.trim()); name = ""; } }}>＋</button></div>
      </nav>
      {#if active}
        <div class="env-detail">
          <label>Name / 名称<input class="input" bind:value={active.name} on:input={onChange} /></label>
          <label class="check"><input type="checkbox" bind:checked={active.prodLike} on:change={onChange} /> Production-like / 类生产环境</label>
          <label class="check"><input type="checkbox" bind:checked={active.confirmUnsafe} on:change={onChange} /> Confirm unsafe methods / 危险方法发送前确认</label>
          <div class="env-vars-title"><strong>Variables / 变量</strong><button class="add-row" on:click={addVariable}>＋ Add</button></div>
          {#each active.variables as variable (variable.id)}
            <div class="env-variable"><input class="input mono" bind:value={variable.key} on:input={onChange} placeholder="base_url" /><input class="input mono" bind:value={variable.value} on:input={onChange} type={variable.secret ? "password" : "text"} placeholder="value" /><label class="check"><input type="checkbox" bind:checked={variable.secret} on:change={onChange} /> Secret</label><button class="icon-btn" on:click={() => { active.variables = active.variables.filter((item) => item.id !== variable.id); environments = [...environments]; onChange(); }} aria-label="Delete variable">×</button></div>
          {/each}
        </div>
      {:else}<div class="empty">Create an environment / 创建环境</div>{/if}
    </div>
    <footer class="modal-actions"><button class="btn" on:click={onClose}>Done / 完成</button></footer>
  </div>
</div>
