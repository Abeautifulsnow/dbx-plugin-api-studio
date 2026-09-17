<script>
  import { isSensitiveHeaderName, isSensitiveQueryName } from "../lib/redaction.js";
  import Icon from "./Icon.svelte";
  import Menu from "./Menu.svelte";

  /**
   * Key/value editor used by Params, Headers and the urlencoded body.
   *
   * Rows follow ui-style.md: enabled toggle, key, value, description, row menu.
   * A value whose key looks like a credential is masked, and `revealed` stays in
   * component state so a reveal flag can never reach saved state.
   */
  let {
    rows = [],
    keyLabel = "Key",
    valueLabel = "Value",
    descriptionLabel = "Description",
    addLabel = "Add row",
    emptyLabel = "",
    maskable = false,
    t = (key) => key,
    onAdd = () => {},
    onRemove = () => {},
    onDuplicate = () => {},
    onChange = () => {},
  } = $props();

  let revealed = $state(new Set());
  let menu = $state(null);

  const isMasked = (row) =>
    maskable && (isSensitiveHeaderName(row.key) || isSensitiveQueryName(row.key));

  function toggleReveal(id) {
    const next = new Set(revealed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    revealed = next;
  }

  function menuItems(row) {
    return [
      { id: "duplicate", label: t("duplicateRow"), icon: "copy" },
      { id: "delete", label: t("deleteRow"), icon: "trash", danger: true },
    ];
  }
</script>

<div class="kv" role="group">
  <div class="kv__head" aria-hidden="true">
    <span class="kv__cell kv__cell--toggle"></span>
    <span class="kv__cell">{keyLabel}</span>
    <span class="kv__cell">{valueLabel}</span>
    <span class="kv__cell kv__cell--description">{descriptionLabel}</span>
    <span class="kv__cell kv__cell--menu"></span>
  </div>

  {#each rows as row (row.id)}
    <div class="kv__row" class:kv__row--disabled={!row.enabled}>
      <span class="kv__cell kv__cell--toggle">
        <input
          type="checkbox"
          checked={row.enabled}
          aria-label={`${row.key || keyLabel}: ${row.enabled ? t("enabled") : ""}`}
          onchange={(event) => {
            row.enabled = event.currentTarget.checked;
            onChange();
          }}
        />
      </span>

      <input
        class="input mono kv__cell"
        bind:value={row.key}
        aria-label={keyLabel}
        placeholder={keyLabel}
        spellcheck="false"
        oninput={onChange}
      />

      <span class="kv__value">
        <input
          class="input mono"
          type={isMasked(row) && !revealed.has(row.id) ? "password" : "text"}
          bind:value={row.value}
          aria-label={valueLabel}
          placeholder={valueLabel}
          spellcheck="false"
          oninput={onChange}
        />
        {#if isMasked(row)}
          <button
            type="button"
            class="icon-btn kv__reveal"
            title={revealed.has(row.id) ? t("hideValue") : t("revealValue")}
            aria-label={revealed.has(row.id) ? t("hideValue") : t("revealValue")}
            onclick={() => toggleReveal(row.id)}
          >
            <Icon name={revealed.has(row.id) ? "eyeOff" : "eye"} />
          </button>
        {/if}
      </span>

      <input
        class="input kv__cell kv__cell--description"
        bind:value={row.description}
        aria-label={descriptionLabel}
        placeholder={descriptionLabel}
        spellcheck="false"
        oninput={onChange}
      />

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

  {#if !rows.length && emptyLabel}
    <p class="kv__empty">{emptyLabel}</p>
  {/if}

  <button type="button" class="kv__add" onclick={onAdd}>
    <Icon name="plus" />
    <span>{addLabel}</span>
  </button>
</div>

{#if menu}
  <Menu
    x={menu.x}
    y={menu.y}
    items={menuItems(menu.row)}
    onClose={() => (menu = null)}
    onSelect={(id) => (id === "delete" ? onRemove(menu.row) : onDuplicate(menu.row))}
  />
{/if}
