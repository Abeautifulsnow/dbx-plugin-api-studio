<script>
  import { ICON_PATHS } from "../lib/icons.js";

  /**
   * One icon family for the whole workbench (ui-style.md). The path map is a
   * module-level constant — no value from request or response data ever reaches
   * `{@html}` here.
   */
  let { name, size = 16, className = "" } = $props();
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {@html ICON_PATHS[name] ?? ""}
</svg>
