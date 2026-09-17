<script>
  import { untrack } from "svelte";
  import { newRow } from "../lib/model.js";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";

  /**
   * Environment manager. Secret variables are the supported way to keep a
   * credential usable without storing it: resolving happens at send time and
   * `persistableState` empties every secret value on save.
   */
  let {
    environments = [],
    selectedId = "",
    t = (key) => key,
    onClose = () => {},
    onChange = () => {},
    onAdd = () => {},
    onDelete = () => {},
  } = $props();

  // `selectedId` only picks the environment to show when the dialog opens; the
  // list selection is local from then on.
  let activeId = $state(untrack(() => selectedId));
  let newName = $state("");
  let revealed = $state(new Set());

  const active = $derived(environments.find((environment) => environment.id === activeId) || null);

  function addEnvironment() {
    const name = newName.trim();
    if (!name) return;
    const created = onAdd(name);
    newName = "";
    if (created?.id) activeId = created.id;
  }

  function toggleReveal(id) {
    const next = new Set(revealed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    revealed = next;
  }
</script>

<Modal
  title={t("envManagerTitle")}
  titleId="env-title"
  onClose={onClose}
  width="min(760px, calc(100vw - 32px))"
>
  <div class="env-layout">
    <nav class="env-list" aria-label={t("envManagerTitle")}>
      {#each environments as environment (environment.id)}
        <button
          type="button"
          class="env-list__item"
          class:env-list__item--active={environment.id === activeId}
          aria-pressed={environment.id === activeId}
          onclick={() => (activeId = environment.id)}
        >
          {#if environment.prodLike}<Icon name="alert" />{/if}
          <span>{environment.name}</span>
        </button>
      {/each}
      {#if !environments.length}
        <p class="empty-state empty-state--compact">{t("noEnvironments")}</p>
      {/if}
      <div class="env-list__create">
        <input
          class="input"
          bind:value={newName}
          placeholder={t("environmentName")}
          aria-label={t("environmentName")}
          onkeydown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            addEnvironment();
          }}
        />
        <button
          type="button"
          class="icon-btn"
          title={t("newEnv")}
          aria-label={t("newEnv")}
          onclick={addEnvironment}
        >
          <Icon name="plus" />
        </button>
      </div>
    </nav>

    {#if active}
      <div class="env-detail">
        <div class="form-field">
          <label class="form-field__label" for="env-name">{t("envName")}</label>
          <input id="env-name" class="input" bind:value={active.name} oninput={onChange} />
        </div>

        <label class="checkbox">
          <input type="checkbox" bind:checked={active.prodLike} onchange={onChange} />
          <span>{t("prodLike")}</span>
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={active.confirmUnsafe} onchange={onChange} />
          <span>{t("confirmUnsafe")}</span>
        </label>

        <div class="env-detail__vars-head">
          <strong>{t("addVariable")}</strong>
          <button
            type="button"
            class="link-btn"
            onclick={() => {
              active.variables = [...active.variables, { ...newRow(), secret: false }];
              onChange();
            }}
          >
            <Icon name="plus" />
            <span>{t("addVariable")}</span>
          </button>
        </div>

        <div class="env-vars">
          {#each active.variables as variable (variable.id)}
            <div class="env-var">
              <input
                class="input mono"
                bind:value={variable.key}
                aria-label={t("key")}
                placeholder="base_url"
                spellcheck="false"
                oninput={onChange}
              />
              <span class="secret-field">
                <input
                  class="input mono"
                  type={variable.secret && !revealed.has(variable.id) ? "password" : "text"}
                  bind:value={variable.value}
                  aria-label={t("value")}
                  placeholder={t("value")}
                  spellcheck="false"
                  oninput={onChange}
                />
                <button
                  type="button"
                  class="icon-btn"
                  title={revealed.has(variable.id) ? t("hideValue") : t("revealValue")}
                  aria-label={revealed.has(variable.id) ? t("hideValue") : t("revealValue")}
                  onclick={() => toggleReveal(variable.id)}
                >
                  <Icon name={revealed.has(variable.id) ? "eyeOff" : "eye"} />
                </button>
              </span>
              <label class="checkbox" title={t("secretNote")}>
                <input type="checkbox" bind:checked={variable.secret} onchange={onChange} />
                <span>{t("secret")}</span>
              </label>
              <button
                type="button"
                class="icon-btn"
                title={t("deleteRow")}
                aria-label={t("deleteRow")}
                onclick={() => {
                  active.variables = active.variables.filter((item) => item.id !== variable.id);
                  onChange();
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          {/each}
        </div>

        <p class="notice notice--info">
          <Icon name="info" />
          <span>{t("secretNote")}</span>
        </p>

        <button type="button" class="btn btn--danger" onclick={() => onDelete(active)}>
          <Icon name="trash" />
          <span>{t("deleteEnv")}</span>
        </button>
      </div>
    {:else}
      <p class="empty-state">{t("noEnvSelected")}</p>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn" data-initial-focus onclick={onClose}>OK</button>
  {/snippet}
</Modal>
