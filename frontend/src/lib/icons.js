/**
 * Single SVG icon family (ui-style.md: one icon set, 1.5–2 px strokes, 16 px box).
 *
 * Icons are never rendered as text glyphs: emoji/box-drawing characters render
 * differently per platform font, cannot inherit stroke weight, and are announced
 * by screen readers. Every decorative icon carries `aria-hidden` in `Icon.svelte`.
 */
export const ICON_PATHS = {
  chevron: '<path d="M4 6l4 4 4-4" />',
  chevronRight: '<path d="M6 4l4 4-4 4" />',
  plus: '<path d="M8 3v10M3 8h10" />',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2" />',
  eyeOff:
    '<path d="M3 3l10 10M6.6 6.7a2 2 0 002.8 2.8M4.4 4.6C2.6 5.8 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1 0 1.9-.2 2.7-.6M7 3.6c.3 0 .7-.1 1-.1 4.1 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2.1" />',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h2" />',
  dots: '<circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14" />',
  pencil: '<path d="M3 13l.8-3.2 7-7a1.4 1.4 0 012 0l1.4 1.4a1.4 1.4 0 010 2l-7 7L2 13z" />',
  columns: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M8 3v10" />',
  send: '<path d="M14 2L7 9" /><path d="M14 2L9.6 14l-2.1-4.9L2.5 7z" />',
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5c2 1.8 2 9.2 0 11-2-1.8-2-9.2 0-11z" />',
  home: '<path d="M3 7.5L8 3l5 4.5"/><path d="M4.5 6.8V13h7V6.8" />',
  folder: '<path d="M2.5 12.5v-8h4l1.5 2h5.5v6z" />',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2.2 1.4" />',
  save: '<path d="M3 3.5h7.5L13 6v6.5H3z"/><path d="M5 3.5V7h5V3.5"/><path d="M5.2 12.5V9.5h5.6v3" />',
  slash: '<circle cx="8" cy="8" r="5.5"/><path d="M4.4 11.6l7.2-7.2" />',
  keyIcon: '<circle cx="5.5" cy="10.5" r="2.8"/><path d="M7.6 8.4L13.8 2.2M11 5l1.8 1.8" />',
  shield: '<path d="M8 2.2l5 1.8v3.6c0 3.1-2 5.6-5 6.4-3-.8-5-3.3-5-6.4V4z" />',
  user: '<circle cx="8" cy="5.3" r="2.4"/><path d="M2.8 13.2c.9-2.3 2.8-3.4 5.2-3.4s4.3 1.1 5.2 3.4" />',
  alert: '<path d="M8 2.6l5.6 10.2H2.4z" /><path d="M8 6.6v3.2" /><path d="M8 11.4v.01" />',
  info: '<circle cx="8" cy="8" r="5.6" /><path d="M8 7.4v4" /><path d="M8 5.1v.01" />',
  check: '<path d="M3.5 8.5l3 3 6-6.5" />',
  close: '<path d="M4 4l8 8M12 4l-8 8" />',
  chevronsLeft: '<path d="M7.5 4L4 8l3.5 4" /><path d="M12 4L8.5 8l3.5 4" />',
  chevronsRight: '<path d="M8.5 4L12 8l-3.5 4" /><path d="M4 4l3.5 4L4 12" />',
  cookie: '<path d="M8 2.5a5.5 5.5 0 105.5 5.5 2 2 0 01-2-2 2 2 0 01-2-2 2 2 0 01-1.5-.5A2 2 0 008 2.5z"/><circle cx="6" cy="9" r=".6"/><circle cx="9" cy="11" r=".6"/>',
  download: '<path d="M8 2.5v7M5 7l3 3 3-3M3 13h10" />',
  filter: '<path d="M2.5 4h11M5 8h6M6.5 12h3" />',
  sparkline: '<path d="M2.5 11l3-3.5 2.5 2 3.5-5" />',
};

/**
 * App logo: the brand "X-molecule" mark — four nodes joined by a crossing,
 * mirroring assets/plugin.svg. Brand blue is baked in (a logo must not follow
 * the host theme accent); the tile behind it comes from .brand__mark.
 */
export const LOGO_PATHS =
  '<path d="M4.9 4.9 11.1 11.1M11.1 4.9 4.9 11.1" fill="none" stroke="#2F6FE8" stroke-width="2" stroke-linecap="round"/>' +
  '<circle cx="4.3" cy="4.3" r="1.55" fill="#2F6FE8"/>' +
  '<circle cx="11.7" cy="4.3" r="1.85" fill="#2F6FE8"/>' +
  '<circle cx="4.3" cy="11.7" r="1.85" fill="#2F6FE8"/>' +
  '<circle cx="11.7" cy="11.7" r="1.55" fill="#2F6FE8"/>';
