<script lang="ts" module>
// A handful of line icons, drawn on a 16 px grid.
const PATHS = {
  key: "M10.5 2.5a3 3 0 1 1-2.6 4.5L2.5 12.4V14h2v-1.5H6V11h1.5l1.4-1.4A3 3 0 0 1 10.5 2.5Zm.5 2.2h.01",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1",
  unique:
    "M8 2.5c-3 0-4.5 2-4.5 4.5 0 1.5.3 3 1 4.5M8 5c-1.4 0-2.2 1-2.2 2.2 0 2 .6 3.8 1.6 5.3M8 7.2c0 2.3.7 4.4 2 6.3M10.4 6.2c.3 2 .1 4 .6 5.8M12.4 9.5c0-1 0-2-.3-3",
  table: "M2.5 3.5h11v9h-11zM2.5 6.5h11M6 6.5v6",
  diagram:
    "M2.5 2.5h4v3h-4zM9.5 10.5h4v3h-4zM9.5 2.5h4v3h-4zM4.5 5.5v5.5h5M11.5 5.5v5",
  plus: "M8 3v10M3 8h10",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5",
  refresh: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5",
  filter: "M2.5 3.5h11L9.5 8.5v4l-3 1v-5z",
  search: "M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM10.3 10.3l3.2 3.2",
  x: "M4 4l8 8M12 4l-8 8",
  left: "M10 3.5L5.5 8l4.5 4.5",
  right: "M6 3.5l4.5 4.5L6 12.5",
  up: "M8 12.5v-9M4.5 7L8 3.5 11.5 7",
  down: "M8 3.5v9M4.5 9L8 12.5 11.5 9",
  arrow: "M3 8h10M9 4l4 4-4 4",
  zoomIn:
    "M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM10.3 10.3l3.2 3.2M5 7h4M7 5v4",
  zoomOut:
    "M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM10.3 10.3l3.2 3.2M5 7h4",
  fit: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  database:
    "M8 2.5c3 0 5 .9 5 2s-2 2-5 2-5-.9-5-2 2-2 5-2ZM3 4.5v7c0 1.1 2 2 5 2s5-.9 5-2v-7M3 8c0 1.1 2 2 5 2s5-.9 5-2",
} as const;
export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let { name, size = 16, label }: { name: IconName; size?: number; label?: string } = $props()
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.4"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
><path d={PATHS[name]} /></svg>
