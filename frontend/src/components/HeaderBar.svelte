<script>
  import Icon from "./Icon.svelte";

  /**
   * Breadcrumb + environment row. The path mirrors the real tree location
   * (`home › collection › folder › request`) and carries the dirty marker, the
   * production badge and the rename affordance.
   */
  let {
    requestName = "",
    dirty = false,
    path = [],
    environments = [],
    selectedEnv = null,
    sidebarCollapsed = false,
    t = (key) => key,
    onSelectEnv = () => {},
    onManageEnvironments = () => {},
    onRename = () => {},
    onToggleSidebar = () => {},
  } = $props();
</script>

<header class="header">
  <div class="breadcrumb">
    {#if sidebarCollapsed}
      <button
        type="button"
        class="icon-btn"
        title={t("showSidebar")}
        aria-label={t("showSidebar")}
        onclick={onToggleSidebar}
      >
        <Icon name="chevronsRight" />
      </button>
    {/if}
    <Icon name="home" className="breadcrumb__icon" />
    {#each path as segment (segment.id)}
      <span class="breadcrumb__segment" title={segment.name}>{segment.name}</span>
      <span class="breadcrumb__sep" aria-hidden="true">/</span>
    {/each}
    <strong class="breadcrumb__current" title={requestName}>{requestName}</strong>
    {#if dirty}
      <span class="dirty-mark" title={t("unsavedMessage")} aria-label={t("unsavedMessage")}>*</span>
    {/if}
    <button
      type="button"
      class="icon-btn"
      title={t("rename")}
      aria-label={t("rename")}
      onclick={onRename}
    >
      <Icon name="pencil" />
    </button>
  </div>

  <div class="header__tools">
    {#if selectedEnv?.prodLike}
      <span class="badge badge--prod" title={t("prodLike")}>
        <Icon name="alert" />
        {t("prodBadge")}
      </span>
    {/if}
    <select
      class="select"
      value={selectedEnv?.id ?? ""}
      aria-label={t("environment")}
      onchange={(event) => onSelectEnv(event.currentTarget.value)}
    >
      <option value="">{t("noEnvironment")}</option>
      {#each environments as environment (environment.id)}
        <option value={environment.id}>
          {environment.prodLike ? "⚠ " : ""}{environment.name}
        </option>
      {/each}
    </select>
    <button
      type="button"
      class="btn"
      title={t("manageEnvironments")}
      onclick={onManageEnvironments}
    >
      <Icon name="globe" />
      <span>{t("environment")}</span>
    </button>
  </div>
</header>
