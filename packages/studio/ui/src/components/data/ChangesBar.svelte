<script lang="ts">
import { Button } from "entasis/button";
import { floppyDiskIcon } from "entasis/icons/floppyDisk";
import { xIcon } from "entasis/icons/x";
import { Popover } from "entasis/popover";
import { type Changes, said } from "../../lib/changes.svelte";

// The stacked changes, floating over the page while there are some: how many, each one listed (and dropped one by
// one), all of them dropped, or all of them saved in one transaction of the client (⌘S). ⌘Z drops the last one
// when no field has the keyboard. A save the client refuses writes nothing and names the change it stopped at.
let { changes }: { changes: Changes } = $props();

function keys(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "s" && !event.shiftKey) {
    event.preventDefault();
    changes.save();
  } else if (key === "z" && !event.shiftKey) {
    // A field keeps its own undo.
    const typing =
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, [contenteditable=true]");
    if (typing || changes.list.length === 0) return;
    event.preventDefault();
    changes.undo();
  }
}
</script>

<svelte:window onkeydown={keys} />

{#if changes.list.length}
  <div class="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-4">
    <div class="pointer-events-auto flex items-center gap-2 rounded-xl border border-neutral-muted bg-surface-raised py-1.5 pr-1.5 pl-4 shadow-lg" role="status">
      <span class="text-[13px] font-medium">{changes.list.length === 1 ? 'One change' : `${changes.list.length} changes`} not saved</span>
      <Popover position="top" theme={{ popover: { base: 'w-[26rem] p-2' } }}>
        {#snippet trigger(popover)}
          <Button size="small" variant="ghost" {@attach popover.trigger}>Review</Button>
        {/snippet}
        {#snippet children()}
          <ol class="m-0 grid max-h-80 list-none gap-0.5 overflow-auto p-0">
            {#each changes.list as change (change.id)}
              <li class={['flex items-center gap-2 rounded-md px-2 py-1 text-[13px]', changes.failed === change.id && 'bg-danger-muted']}>
                <span class="min-w-0 flex-1 truncate" title={said(change)}>{said(change)}</span>
                <Button size="small" variant="ghost" squared prefix={xIcon} label="Drop “{said(change)}”" onclick={() => changes.remove(change.id)} />
              </li>
              {#if changes.failed === change.id && changes.refusal}
                <li class="px-2 pb-1 text-[12px] whitespace-pre-wrap text-danger">{changes.refusal}</li>
              {/if}
            {/each}
          </ol>
        {/snippet}
      </Popover>
      <Button size="small" variant="ghost" disabled={changes.busy} onclick={() => changes.discard()}>Discard</Button>
      <Button size="small" color="primary" prefix={floppyDiskIcon} loading={changes.busy} onclick={() => changes.save()}>Save changes <span class="ml-1 opacity-60">⌘S</span></Button>
    </div>
  </div>
{/if}
