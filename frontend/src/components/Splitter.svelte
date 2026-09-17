<script>
  /**
   * Draggable pane divider.
   *
   * Keyboard-operable (arrow keys, Shift for a coarse step) and exposed as a
   * focusable `separator` with its current value, because a mouse-only divider
   * makes the layout unreachable for keyboard users (ui-style.md a11y rules).
   */
  let {
    axis = "x",
    value,
    min = 0,
    max = 100,
    unit = "px",
    label = "Resize",
    onChange = () => {},
  } = $props();

  const step = (event) => (event.shiftKey ? 32 : 8);

  function clamp(next) {
    return Math.min(max, Math.max(min, next));
  }

  function startDrag(event) {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const startPosition = axis === "x" ? event.clientX : event.clientY;
    const startValue = value;

    const onMove = (moveEvent) => {
      const current = axis === "x" ? moveEvent.clientX : moveEvent.clientY;
      const delta = axis === "x" ? current - startPosition : startPosition - current;
      onChange(clamp(Math.round(startValue + delta)));
    };
    const onUp = () => {
      target.releasePointerCapture?.(event.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onKeyDown(event) {
    const decrease = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const increase = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (event.key === decrease) onChange(clamp(value - step(event)));
    else if (event.key === increase) onChange(clamp(value + step(event)));
    else if (event.key === "Home") onChange(min);
    else if (event.key === "End") onChange(max);
    else return;
    event.preventDefault();
  }
</script>

<!--
  A focusable `separator` is a valid ARIA 1.2 widget (it becomes adjustable once
  it exposes aria-valuenow), which the a11y linter's static table does not model.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="splitter"
  class:splitter--x={axis === "x"}
  class:splitter--y={axis === "y"}
  role="separator"
  tabindex="0"
  aria-orientation={axis === "x" ? "vertical" : "horizontal"}
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuetext={`${value}${unit}`}
  onpointerdown={startDrag}
  onkeydown={onKeyDown}
>
  <span class="splitter__grip" aria-hidden="true"></span>
</div>
