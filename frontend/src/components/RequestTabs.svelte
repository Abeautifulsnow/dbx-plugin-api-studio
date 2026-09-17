<script>
  import { newRow } from "../lib/model.js";
  import Icon from "./Icon.svelte";
  import AuthEditor from "./AuthEditor.svelte";
  import BodyEditor from "./BodyEditor.svelte";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";

  /**
   * Request tabs and their panes. Tab badges count the rows that will actually be
   * sent, so a badge never advertises hidden state (ui-style.md).
   */
  let {
    request,
    activeTab = "params",
    issues = {},
    previewCapBytes = 2 * 1024 * 1024,
    t = (key) => key,
    onChange = () => {},
    onActiveTab = () => {},
    onOpenEnvironments = () => {},
    onPreviewCapChange = () => {},
  } = $props();

  const TABS = [
    { id: "params", label: "tabParams" },
    { id: "headers", label: "tabHeaders" },
    { id: "auth", label: "tabAuth" },
    { id: "body", label: "tabBody" },
    { id: "settings", label: "tabSettings" },
  ];

  const enabledCount = (rows) => rows.filter((row) => row.enabled && String(row.key || "").trim()).length;

  function addRow(rows, assign) {
    assign([...rows, newRow()]);
    onChange();
  }

  function removeRow(rows, row, assign) {
    assign(rows.filter((item) => item.id !== row.id));
    onChange();
  }

  function duplicateRow(rows, row, assign) {
    const index = rows.findIndex((item) => item.id === row.id);
    assign([...rows.slice(0, index + 1), { ...row, id: newRow().id }, ...rows.slice(index + 1)]);
    onChange();
  }

  /** Field-local validation: icon + text + colour, announced to screen readers. */
  const issueText = (issue) =>
    issue?.unresolved?.length
      ? t("unresolvedVars", { vars: issue.unresolved.join(", ") })
      : t("invalidUrl");
</script>

{#snippet fieldError(message)}
  <p class="field-error" role="alert">
    <Icon name="alert" />
    <span>{message}</span>
  </p>
{/snippet}

<nav class="tabs" aria-label={t("request")}>
  {#each TABS as item (item.id)}
    <button
      type="button"
      class="tabs__tab"
      class:tabs__tab--active={activeTab === item.id}
      aria-pressed={activeTab === item.id}
      onclick={() => onActiveTab(item.id)}
    >
      <span>{t(item.label)}</span>
      {#if item.id === "params" && enabledCount(request.query)}
        <span class="tabs__count">{enabledCount(request.query)}</span>
      {:else if item.id === "headers" && enabledCount(request.headers)}
        <span class="tabs__count">{enabledCount(request.headers)}</span>
      {/if}
    </button>
  {/each}
</nav>

<div class="editor">
  {#if activeTab === "params"}
    {#if issues.url?.invalid || issues.url?.unresolved}
      {@render fieldError(issueText(issues.url))}
    {/if}
    <KeyValueEditor
      rows={request.query}
      keyLabel={t("key")}
      valueLabel={t("value")}
      descriptionLabel={t("description")}
      addLabel={t("addParam")}
      {t}
      onChange={onChange}
      onAdd={() => addRow(request.query, (next) => (request.query = next))}
      onRemove={(row) => removeRow(request.query, row, (next) => (request.query = next))}
      onDuplicate={(row) => duplicateRow(request.query, row, (next) => (request.query = next))}
    />
  {:else if activeTab === "headers"}
    {#if issues.headers?.unresolved?.length}
      {@render fieldError(t("unresolvedVars", { vars: issues.headers.unresolved.join(", ") }))}
    {/if}
    <KeyValueEditor
      rows={request.headers}
      keyLabel={t("key")}
      valueLabel={t("value")}
      descriptionLabel={t("description")}
      addLabel={t("addHeader")}
      maskable
      {t}
      onChange={onChange}
      onAdd={() => addRow(request.headers, (next) => (request.headers = next))}
      onRemove={(row) => removeRow(request.headers, row, (next) => (request.headers = next))}
      onDuplicate={(row) => duplicateRow(request.headers, row, (next) => (request.headers = next))}
    />
  {:else if activeTab === "auth"}
    {#if issues.auth?.unresolved?.length}
      {@render fieldError(t("unresolvedVars", { vars: issues.auth.unresolved.join(", ") }))}
    {/if}
    <AuthEditor auth={request.auth} {t} onChange={onChange} onOpenEnvironments={onOpenEnvironments} />
  {:else if activeTab === "body"}
    {#if issues.body?.json}
      {@render fieldError(t("jsonInvalid"))}
    {:else if issues.body?.unresolved?.length}
      {@render fieldError(t("unresolvedVars", { vars: issues.body.unresolved.join(", ") }))}
    {/if}
    <BodyEditor body={request.body} {t} onChange={onChange} />
  {:else}
    <SettingsPanel
      settings={request.settings}
      {previewCapBytes}
      {t}
      onChange={onChange}
      onPreviewCapChange={onPreviewCapChange}
    />
  {/if}
</div>
