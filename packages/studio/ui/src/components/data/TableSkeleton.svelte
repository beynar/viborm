<script lang="ts">
import type { Snippet } from "svelte";

let { cell }: { cell: Snippet<[string | undefined, number]> } = $props();

type Track = {
  id: string | undefined;
  column: string;
  position: string;
  start: string;
  end: string;
};
let tracks = $state<Track[]>([]);

// The header already owns the resolved order, virtualization and pinning offsets.
// Borrow its placement while loading instead of implementing a second table layout.
function followHeader(element: HTMLElement) {
  const header = element.closest("table")?.querySelector("thead");
  if (!header) return;
  const read = () => {
    tracks = Array.from(header.querySelectorAll("th"), (cell) => ({
      id: cell.dataset.columnId,
      column: cell.style.gridColumn,
      position: cell.style.position,
      start: cell.style.insetInlineStart,
      end: cell.style.insetInlineEnd,
    }));
  };
  read();
  const observer = new MutationObserver(read);
  observer.observe(header, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "data-column-id"],
  });
  return () => observer.disconnect();
}
</script>

<div class="col-span-full grid grid-cols-subgrid" aria-label="Loading rows" {@attach followHeader}>
  {#each Array.from({ length: 6 }, (_, index) => index) as index (index)}
    <div class="col-span-full grid grid-cols-subgrid border-b border-neutral-muted" aria-hidden="true" data-skeleton-row>
      {#each tracks as track (track.column)}
        <div
          class={['flex min-w-0 items-center overflow-hidden', track.position === 'sticky' && 'sticky z-10 bg-surface']}
          style:grid-column={track.column}
          style:inset-inline-start={track.start}
          style:inset-inline-end={track.end}
          data-skeleton-column={track.id ?? '__selection'}
        >
          {@render cell(track.id, index)}
        </div>
      {/each}
    </div>
  {/each}
</div>
