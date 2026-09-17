<script>
  import { LOGO_PATHS } from "../lib/icons.js";
  import { timeAgo } from "../lib/format.js";
  import { countRequests } from "../lib/search.js";
  import Icon from "./Icon.svelte";
  import Tree from "./Tree.svelte";

  /**
   * Navigation rail: brand, creation actions, search, the collection tree and
   * the history list. Collections and History are independent collapsible
   * sections so history never competes with the tree for vertical space.
   */
  let {
    collections = [],
    visibleCollections = [],
    history = [],
    activeRequestId = "",
    activeHistoryId = "",
    search = "",
    historyOpen = true,
    collapsed = false,
    expanded = new Set(),
    t = (key) => key,
    onSearch = () => {},
    onToggleNode = () => {},
    onToggleHistory = () => {},
    onToggleSidebar = () => {},
    onOpenRequest = () => {},
    onOpenHistory = () => {},
    onNodeMenu = () => {},
    onNewRequest = () => {},
    onNewCollection = () => {},
    onClearHistory = () => {},
  } = $props();

  const hasCollections = $derived(collections.length > 0);
  const searching = $derived(!!search.trim());

  function statusKind(entry) {
    if (entry.error || (entry.status != null && entry.status >= 400)) return "err";
    if (entry.status == null) return "cancelled";
    return "ok";
  }
</script>

<aside class="sidebar" class:sidebar--collapsed={collapsed}>
  <div class="brand">
    <span class="brand__mark" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
        {@html LOGO_PATHS}
      </svg>
    </span>
    <span class="brand__text">
      <strong class="brand__title">API Studio</strong>
      <small class="brand__subtitle">{t("appSubtitle")}</small>
    </span>
    <button
      type="button"
      class="icon-btn"
      title={t("collapseSidebar")}
      aria-label={t("collapseSidebar")}
      onclick={onToggleSidebar}
    >
      <Icon name="chevronsLeft" />
    </button>
  </div>

  <div class="sidebar-actions">
    <button type="button" class="btn btn--primary" onclick={onNewRequest}>
      <Icon name="plus" />
      <span>{t("newRequest")}</span>
    </button>
    <button type="button" class="btn" onclick={onNewCollection}>
      <Icon name="plus" />
      <span>{t("newCollection")}</span>
    </button>
  </div>

  <div class="search-field">
    <Icon name="search" className="search-field__icon" />
    <input
      class="input search-field__input"
      value={search}
      placeholder={t("searchPlaceholder")}
      aria-label={t("searchPlaceholder")}
      oninput={(event) => onSearch(event.currentTarget.value)}
    />
  </div>

  <section class="sidebar-section sidebar-section--grow">
    <header class="sidebar-section__head">
      <span class="sidebar-section__title">
        <Icon name="columns" />
        <span>{t("collections")}</span>
      </span>
      <span class="sidebar-section__count">{collections.length}</span>
    </header>

    <div class="tree">
      {#if !hasCollections}
        <p class="empty-state">{t("emptyCollections")}</p>
      {:else if searching && !visibleCollections.length}
        <p class="empty-state">{t("noSearchResults")}</p>
      {:else}
        <Tree
          nodes={visibleCollections}
          activeId={activeRequestId}
          forceExpanded={searching}
          {expanded}
          onToggle={onToggleNode}
          onOpen={onOpenRequest}
          onMenu={onNodeMenu}
        />
      {/if}
    </div>
  </section>

  <section class="sidebar-section sidebar-section--history">
    <header class="sidebar-section__head">
      <button
        type="button"
        class="sidebar-section__toggle"
        aria-expanded={historyOpen}
        onclick={onToggleHistory}
      >
        <span class="sidebar-section__caret" class:sidebar-section__caret--open={historyOpen}>
          <Icon name="chevronRight" />
        </span>
        <Icon name="clock" />
        <span>{t("history")}</span>
        <span class="sidebar-section__count">{history.length}</span>
      </button>
      {#if history.length && historyOpen}
        <button type="button" class="link-btn" onclick={onClearHistory}>{t("clearHistory")}</button>
      {/if}
    </header>

    {#if historyOpen}
      <div class="history">
        {#if !history.length}
          <p class="empty-state">{t("emptyHistory")}</p>
        {:else}
          {#each history.slice(0, 100) as entry (entry.id)}
            <div
              class="history-row"
              class:history-row--active={entry.id === activeHistoryId}
            >
              <button type="button" class="history-row__main" onclick={() => onOpenHistory(entry)}>
                <span class="method-tag method-tag--{entry.method}">{entry.method}</span>
                <span class="history-row__body">
                  <span class="history-row__url" title={entry.url}>{entry.url || entry.name}</span>
                  <span class="history-row__meta">
                    <span class="status-dot status-dot--{statusKind(entry)}" aria-hidden="true"></span>
                    <span>{entry.status ?? t("historyEmptyStatus")}</span>
                    <span class="history-row__time">{timeAgo(entry.timestamp, t("justNow"))}</span>
                  </span>
                </span>
              </button>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </section>
</aside>
