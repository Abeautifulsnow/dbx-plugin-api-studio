<script>
  import Icon from "./Icon.svelte";

  /**
   * Auth editor: a rail of types (SVG icon + one-line description) and the fields
   * for the selected one. Credential fields are masked with an explicit reveal
   * control, and the reveal flag lives in component state only so it can never be
   * persisted.
   */
  let { auth = { type: "none" }, t = (key) => key, onChange = () => {}, onOpenEnvironments = () => {} } = $props();

  const TYPES = [
    { id: "none", label: "authNone", description: "authNoneDesc", icon: "slash" },
    { id: "bearer", label: "authBearer", description: "authBearerDesc", icon: "keyIcon" },
    { id: "basic", label: "authBasic", description: "authBasicDesc", icon: "shield" },
    { id: "apikey", label: "authApiKey", description: "authApiKeyDesc", icon: "user" },
  ];

  let revealed = $state(false);

  function selectType(id) {
    // Report the replacement instead of reassigning the prop: a local
    // `auth = { type: id }` never reaches the parent's request object, so the
    // sidecar would still see the old auth. A fresh object also guarantees a
    // stale token from the previous type does not survive in memory.
    revealed = false;
    onChange(id === "apikey" ? { type: id, in: "header" } : { type: id });
  }
</script>

<div class="auth">
  <nav class="auth__rail" aria-label={t("authType")}>
    {#each TYPES as type (type.id)}
      <button
        type="button"
        class="auth__option"
        class:auth__option--active={auth.type === type.id}
        aria-pressed={auth.type === type.id}
        onclick={() => selectType(type.id)}
      >
        <span class="auth__option-head">
          <Icon name={type.icon} />
          <span>{t(type.label)}</span>
        </span>
        <small class="auth__option-desc">{t(type.description)}</small>
      </button>
    {/each}
  </nav>

  <div class="auth__form">
    {#if auth.type === "none"}
      <p class="auth__desc">{t("authNoneDesc")}</p>
    {:else if auth.type === "bearer"}
      <div class="field">
        <label class="field__label" for="auth-token">{t("tokenLabel")}</label>
        <span class="secret-field">
          <input
            id="auth-token"
            class="input mono"
            type={revealed ? "text" : "password"}
            bind:value={auth.token}
            spellcheck="false"
            oninput={() => onChange(auth)}
          />
          <button
            type="button"
            class="icon-btn"
            title={revealed ? t("hideValue") : t("revealValue")}
            aria-label={revealed ? t("hideValue") : t("revealValue")}
            onclick={() => (revealed = !revealed)}
          >
            <Icon name={revealed ? "eyeOff" : "eye"} />
          </button>
        </span>
      </div>
    {:else if auth.type === "basic"}
      <div class="field">
        <label class="field__label" for="auth-user">{t("usernameLabel")}</label>
        <input id="auth-user" class="input" bind:value={auth.username} spellcheck="false" oninput={() => onChange(auth)} />
      </div>
      <div class="field">
        <label class="field__label" for="auth-password">{t("passwordLabel")}</label>
        <span class="secret-field">
          <input
            id="auth-password"
            class="input mono"
            type={revealed ? "text" : "password"}
            bind:value={auth.password}
            spellcheck="false"
            oninput={() => onChange(auth)}
          />
          <button
            type="button"
            class="icon-btn"
            title={revealed ? t("hideValue") : t("revealValue")}
            aria-label={revealed ? t("hideValue") : t("revealValue")}
            onclick={() => (revealed = !revealed)}
          >
            <Icon name={revealed ? "eyeOff" : "eye"} />
          </button>
        </span>
      </div>
    {:else if auth.type === "apikey"}
      <div class="field">
        <label class="field__label" for="auth-key-name">{t("apiKeyNameLabel")}</label>
        <input
          id="auth-key-name"
          class="input mono"
          bind:value={auth.keyName}
          spellcheck="false"
          oninput={() => onChange(auth)}
        />
      </div>
      <div class="field">
        <label class="field__label" for="auth-key-value">{t("apiKeyValueLabel")}</label>
        <span class="secret-field">
          <input
            id="auth-key-value"
            class="input mono"
            type={revealed ? "text" : "password"}
            bind:value={auth.keyValue}
            spellcheck="false"
            oninput={() => onChange(auth)}
          />
          <button
            type="button"
            class="icon-btn"
            title={revealed ? t("hideValue") : t("revealValue")}
            aria-label={revealed ? t("hideValue") : t("revealValue")}
            onclick={() => (revealed = !revealed)}
          >
            <Icon name={revealed ? "eyeOff" : "eye"} />
          </button>
        </span>
      </div>
      <div class="field">
        <label class="field__label" for="auth-in">{t("authIn")}</label>
        <select id="auth-in" class="select" bind:value={auth.in} onchange={() => onChange(auth)}>
          <option value="header">{t("authHeader")}</option>
          <option value="query">{t("authQuery")}</option>
        </select>
      </div>
    {/if}

    <p class="notice notice--info">
      <Icon name="info" />
      <span>{t("authSessionNote")}</span>
    </p>
    <button type="button" class="link-btn" onclick={onOpenEnvironments}>
      {t("goToEnvSettings")}
    </button>
  </div>
</div>
