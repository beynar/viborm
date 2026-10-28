<script lang="ts">
import { Button } from "entasis/button";
import { confirmation } from "entasis/confirmation";
import { floppyDiskIcon } from "entasis/icons/floppyDisk";
import { xIcon } from "entasis/icons/x";
import { Popover } from "entasis/popover";
import { toast } from "entasis/toast";
import { StudioError, saveChanges } from "../../lib/api";
import type { Changes, StagedChange } from "../../lib/changes.svelte";

// The stacked changes, floating over the page while there are some: how many, each one listed (and dropped one by
// one), all of them dropped, or all of them saved in one transaction of the client. A save the client refuses
// writes nothing and names the change it stopped at.
let { changes }: { changes: Changes } = $props();

let busy = $state(false);
/** The client's words for the change the last save stopped at. */
let refusal = $state<string>();

/** A change as the list says it. */
function said(change: StagedChange): string {
  if (change.action === "create") return `Add a ${change.model} row`;
  if (change.action === "delete") return `Delete ${change.label}`;
  if (change.nested) return change.label;
  return `${change.label} · ${Object.keys(change.data ?? {}).join(", ")}`;
}

async function save() {
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
  busy = true;
  try {
    const { saved } = await saveChanges(changes.toSend());
    changes.clear();
    changes.saved += 1;
    refusal = undefined;
    toast.success({
      title: saved === 1 ? "One change saved" : `${saved} changes saved`,
    });
  } catch (error) {
    const at = error instanceof StudioError ? error.at : undefined;
    const stopped = at === undefined ? undefined : changes.list[at];
    changes.failed = stopped?.id;
    refusal = error instanceof Error ? error.message : String(error);
    toast.danger({
      title: stopped
        ? `Nothing was saved: “${said(stopped)}” was refused`
        : "Nothing was saved",
      description: refusal,
    });
  } finally {
    busy = false;
  }
}

async function discard() {
  const count = changes.list.length;
  const { confirmed } = await confirmation({
    title: count === 1 ? "Drop this change?" : `Drop these ${count} changes?`,
    description:
      "Nothing was written: the rows stay as the database holds them.",
    confirm: { text: "Drop", color: "danger" },
    cancel: "Keep them",
  });
  if (confirmed) changes.clear();
}
</script>

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
              {#if changes.failed === change.id && refusal}
                <li class="px-2 pb-1 text-[12px] whitespace-pre-wrap text-danger">{refusal}</li>
              {/if}
            {/each}
          </ol>
        {/snippet}
      </Popover>
      <Button size="small" variant="ghost" disabled={busy} onclick={discard}>Discard</Button>
      <Button size="small" color="primary" prefix={floppyDiskIcon} loading={busy} onclick={save}>Save changes</Button>
    </div>
  </div>
{/if}
