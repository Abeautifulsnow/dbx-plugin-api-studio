<script>
  import Icon from "./Icon.svelte";
  import Menu from "./Menu.svelte";

  /**
   * Multipart/form-data editor: each part is Text (inline value) or File (a
   * local path the sidecar reads at send time — the sandbox cannot open local
   * files, and file bytes must not cross the RPC bridge).
   */
  let {
    rows = [],
    nameLabel = "Name",
    typeLabel = "Type",
    valueLabel = "Value",
    pathLabel = "File path",
    textOption = "Text",
    fileOption = "File",
    t = (key) => key,
    onChange = () => {},
    onAddText = () => {},
    onAddFile = () => {},
    onRemove = () => {},
  } = $props();

  let menu = $state(null);

  function menuItems(row) {
    return [{ id: "delete", label: t("deleteRow"), icon: "trash", danger: true }];
  }
</script>

<div class="kv" role="group">
  <div class="kv__head" aria-hidden="true">
    <span class="kv__cell kv__cell--toggle"></span>
    <span class="kv__cell">{nameLabel}</span>
    <span class="kv__cell">{typeLabel}</span>
    <span class="kv__cell">{valueLabel}</span>
    <span class="kv__cell kv__cell--menu"></span>
  </div>

  {#each rows as row (row.id)}
    <div class="kv__row" class:kv__row--disabled={!row.enabled}>
      <span class="kv__cell kv__cell--toggle">
        <input
          type="checkbox"
          checked={row.enabled}
          aria-label={`${row.name || nameLabel}: ${row.enabled ? t("enabled") : ""}`}
          onchange={(event) => {
            row.enabled = event.currentTarget.checked;
            onChange();
          }}
        />
      </span>

      <input
        class="input mono kv__cell"
        bind:value={row.name}
        aria-label={nameLabel}
        placeholder={nameLabel}
        spellcheck="false"
        oninput={onChange}
      />

      <select
        class="select kv__cell"
        value={row.kind}
        aria-label={typeLabel}
        onchange={(event) => {
          row.kind = event.currentTarget.value;
          if (row.kind === "file" && !row.path && row.value) {
            row.path = row.value;
            row.value = "";
          }
          onChange();
        }}
      >
        <option value="text">{textOption}</option>
        <option value="file">{fileOption}</option>
      </select>

      {#if row.kind === "file"}
        <input
          class="input mono kv__cell"
          bind:value={row.path}
          aria-label={pathLabel}
          placeholder={pathLabel}
          spellcheck="false"
          oninput={onChange}
        />
      {:else}
        <input
          class="input mono kv__cell"
          bind:value={row.value}
          aria-label={valueLabel}
          placeholder={valueLabel}
          spellcheck="false"
          oninput={onChange}
        />
      {/if}

      <span class="kv__cell kv__cell--menu">
        <button
          type="button"
          class="icon-btn"
          aria-label={t("rowMenu")}
          title={t("rowMenu")}
          onclick={(event) => (menu = { x: event.clientX, y: event.clientY, row })}
        >
          <Icon name="dots" />
        </button>
      </span>
    </div>
  {/each}

  {#if !rows.length}
    <p class="kv__empty"></p>
  {/if}

  <div class="mp-add">
    <button type="button" class="kv__add" onclick={onAddText}>
      <Icon name="plus" />
      <span>{textOption}</span>
    </button>
    <button type="button" class="kv__add" onclick={onAddFile}>
      <Icon name="folder" />
      <span>{fileOption}</span>
    </button>
  </div>
</div>

{#if menu}
  <Menu
    x={menu.x}
    y={menu.y}
    items={menuItems(menu.row)}
    onClose={() => (menu = null)}
    onSelect={(id) => id === "delete" && onRemove(menu.row)}
  />
{/if}
