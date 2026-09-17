<script>
  import { newRow } from "../lib/model.js";
  import { parseJson } from "../lib/jsonview.js";
  import { CONTENT_TYPES } from "../lib/variables.js";
  import Icon from "./Icon.svelte";
  import KeyValueEditor from "./KeyValueEditor.svelte";

  /**
   * Body editor. `urlencoded` gets a real key/value table — the previous UI
   * degraded it to a textarea and stopped sending a Content-Type — and its rows
   * are serialized into `body.text` so one spec builder serves every body type.
   */
  let { body, t = (key) => key, onChange = () => {} } = $props();

  const TYPES = [
    { id: "none", label: "bodyNone" },
    { id: "json", label: "bodyJson" },
    { id: "text", label: "bodyText" },
    { id: "urlencoded", label: "bodyForm" },
  ];

  let gutter = $state(null);
  let area = $state(null);

  const jsonState = $derived(
    body.type === "json" && String(body.text || "").trim() ? parseJson(body.text) : null,
  );
  const lineCount = $derived(Math.max(1, String(body.text || "").split("\n").length));

  function applyJson(pretty) {
    const parsed = parseJson(body.text);
    if (!parsed.ok) return;
    body.text = JSON.stringify(parsed.value, null, pretty ? 2 : 0);
    onChange();
  }

  function syncFormRows() {
    body.rows = body.rows || [];
    body.text = body.rows
      .filter((row) => row.enabled && row.key)
      .map((row) => `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`)
      .join("&");
    onChange();
  }

  function onScroll() {
    if (gutter && area) gutter.scrollTop = area.scrollTop;
  }
</script>

<div class="body-toolbar">
  <div class="field field--inline">
    <label class="field__label" for="body-type">{t("bodyType")}</label>
    <select
      id="body-type"
      class="select"
      value={body.type}
      onchange={(event) => {
        body.type = event.currentTarget.value;
        if (body.type === "urlencoded" && !body.rows) body.rows = [];
        onChange();
      }}
    >
      {#each TYPES as type (type.id)}
        <option value={type.id}>{t(type.label)}</option>
      {/each}
    </select>
  </div>

  {#if body.type !== "none"}
    <span class="badge badge--muted mono">{CONTENT_TYPES[body.type] || CONTENT_TYPES.text}</span>
  {/if}

  {#if body.type === "json"}
    <div class="body-toolbar__actions">
      <span class="json-status" class:json-status--invalid={jsonState && !jsonState.ok}>
        {#if jsonState}
          <Icon name={jsonState.ok ? "check" : "alert"} />
          <span>{jsonState.ok ? t("jsonValid") : t("jsonInvalid")}</span>
        {:else}
          <span>{t("validateJson")}</span>
        {/if}
      </span>
      <button type="button" class="btn" onclick={() => applyJson(true)}>{t("format")}</button>
      <button type="button" class="btn" onclick={() => applyJson(false)}>{t("minify")}</button>
    </div>
  {/if}
</div>

{#if body.type === "urlencoded"}
  <KeyValueEditor
    rows={body.rows || []}
    keyLabel={t("key")}
    valueLabel={t("value")}
    descriptionLabel={t("description")}
    addLabel={t("addParam")}
    {t}
    onChange={syncFormRows}
    onAdd={() => {
      body.rows = [...(body.rows || []), newRow()];
      syncFormRows();
    }}
    onRemove={(row) => {
      body.rows = (body.rows || []).filter((item) => item.id !== row.id);
      syncFormRows();
    }}
    onDuplicate={(row) => {
      const index = (body.rows || []).findIndex((item) => item.id === row.id);
      body.rows = [
        ...(body.rows || []).slice(0, index + 1),
        { ...row, id: newRow().id },
        ...(body.rows || []).slice(index + 1),
      ];
      syncFormRows();
    }}
  />
{:else if body.type !== "none"}
  <div class="code-area">
    <div class="code-gutter" bind:this={gutter} aria-hidden="true">
      {#each Array.from({ length: lineCount }, (_, index) => index + 1) as line (line)}
        <span class="code-gutter__line">{line}</span>
      {/each}
    </div>
    <textarea
      class="code-input mono"
      bind:this={area}
      bind:value={body.text}
      spellcheck="false"
      aria-label={t("tabBody")}
      oninput={onChange}
      onscroll={onScroll}
      onkeydown={(event) => {
        // Tab indents instead of moving focus out of the editor.
        if (event.key !== "Tab") return;
        event.preventDefault();
        const start = area.selectionStart;
        body.text = body.text.slice(0, start) + "  " + body.text.slice(area.selectionEnd);
        onChange();
        queueMicrotask(() => {
          area.selectionStart = area.selectionEnd = start + 2;
        });
      }}
    ></textarea>
  </div>
{/if}
