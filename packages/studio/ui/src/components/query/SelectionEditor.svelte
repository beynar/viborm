<script lang="ts">
import { Button } from "entasis/button";
import { caretRightIcon } from "entasis/icons/caretRight";
import { xIcon } from "entasis/icons/x";
import { Select } from "entasis/select";
import { cubicOut } from "svelte/easing";
import { prefersReducedMotion } from "svelte/motion";
import { slide } from "svelte/transition";
import type { StudioModel } from "../../lib/api";
import {
  changeSelection,
  type QuerySelection,
  relationName,
  relationSelection,
  type SelectionStep,
  variantSelection,
} from "../../lib/query-builder";

let {
  model,
  models,
  selection,
  onChange,
}: {
  model: StudioModel;
  models: readonly StudioModel[];
  selection: QuerySelection;
  onChange: (selection: QuerySelection) => void;
} = $props();

// Only the user's finite selection is traversed, never the schema's potentially cyclic graph.
// Drilling down keeps the controls full-width at every depth.
let path = $state<SelectionStep[]>([]);
const frames = $derived.by(() => {
  const out = [{ model, selection, label: model.name }];
  for (const step of path) {
    const parent = out.at(-1)!;
    const entry = parent.selection.include.find(
      (item) => relationName(item) === step.relation
    );
    const relation = parent.model.relations.find(
      (item) => item.name === step.relation
    );
    if (!(entry && relation)) break;
    const target =
      step.variant === undefined
        ? relation.targets[0]
        : relation.variants?.find((item) => item.name === step.variant)?.target;
    const nextModel = models.find((item) => item.name === target);
    if (!nextModel) break;
    const branch = relationSelection(entry);
    out.push({
      model: nextModel,
      selection:
        step.variant === undefined
          ? branch
          : variantSelection(branch, step.variant),
      label:
        step.variant === undefined
          ? step.relation
          : `${step.relation} · ${step.variant}`,
    });
  }
  return out;
});
const current = $derived(frames.at(-1)!);
const branchKey = $derived(JSON.stringify(path.slice(0, frames.length - 1)));
const motion = $derived({
  duration: prefersReducedMotion.current ? 0 : 180,
  easing: cubicOut,
});
$effect(() => {
  // Resetting the builder or removing an ancestor also returns its editor to the surviving branch.
  if (path.length >= frames.length) path = path.slice(0, frames.length - 1);
});
const selected = $derived(current.selection.include.map(relationName));

function update(next: QuerySelection) {
  onChange(changeSelection(selection, path.slice(0, frames.length - 1), next));
}
function chooseRelations(names: string[]) {
  update({
    ...current.selection,
    include: names.map(
      (name) =>
        current.selection.include.find(
          (entry) => relationName(entry) === name
        ) ?? name
    ),
  });
}
function summary(selection: QuerySelection) {
  const columns = selection.columns.length;
  const relations = selection.include.length;
  return `${columns ? `${columns} column${columns === 1 ? "" : "s"}` : "Every column"}${relations ? ` · ${relations} relation${relations === 1 ? "" : "s"}` : ""}`;
}
function open(relation: string, variant?: string) {
  path = [...path, { relation, ...(variant === undefined ? {} : { variant }) }];
}
</script>

<div class="grid min-w-0" aria-label="Returned fields">
  {#if path.length}
    <div class="min-w-0 pb-3" transition:slide={{ ...motion, axis: 'y' }}>
    <nav class="flex min-w-0 flex-wrap items-center gap-1" aria-label="Selection path">
      {#each frames as frame, index (JSON.stringify(path.slice(0, index)))}
        <span class="flex min-w-0 max-w-full items-center gap-1" transition:slide={{ ...motion, axis: 'x' }}>
        {#if index > 0}<span class="text-neutral/40" aria-hidden="true">{@render caretRightIcon({ size: 11 })}</span>{/if}
        <button type="button" class={['max-w-full truncate rounded px-1 py-0.5 text-[12px] hover:bg-neutral-muted/50', index === frames.length - 1 ? 'text-neutral' : 'text-neutral/60']} aria-current={index === frames.length - 1 ? 'location' : undefined} title={frame.label} onclick={() => (path = path.slice(0, index))}>{frame.label}</button>
        </span>
      {/each}
    </nav>
    </div>
  {/if}

  <div class="min-w-0 pb-3">
  <Select size="small" multiple label="Columns" placeholder="Every column" items={current.model.fields.map((field) => ({ value: field.name, label: field.name }))} value={current.selection.columns} onValueChange={value => update({ ...current.selection, columns: value ?? [] })} />
  </div>
  {#if current.model.relations.length}
    <div class="min-w-0 pb-3" transition:slide={{ ...motion, axis: 'y' }}>
    <Select size="small" multiple label="With related rows" placeholder="No relation" items={current.model.relations.map((relation) => ({ value: relation.name, label: relation.name }))} value={selected} onValueChange={value => chooseRelations(value ?? [])} />
    </div>
  {/if}

  {#each current.selection.include as entry (JSON.stringify([branchKey, relationName(entry)]))}
    {@const name = relationName(entry)}
    {@const relation = current.model.relations.find((item) => item.name === name)}
    {@const branch = relationSelection(entry)}
    <div class="min-w-0 pb-3" transition:slide={{ ...motion, axis: 'y' }}>
    <div class="min-w-0 rounded-md border border-neutral-muted">
      <div class="flex min-w-0 items-center gap-1 p-1">
        {#if relation && !relation.variants?.length}
          <button type="button" class="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-neutral-muted/40" aria-label="Configure {name}" onclick={() => open(name)}>
            <span class="grid min-w-0 flex-1 gap-0.5">
              <span class="truncate text-[13px] font-medium">{name}</span>
              <span class="truncate text-[11px] text-neutral/55">{summary(branch)}</span>
            </span>
            <span class="shrink-0 text-neutral/50">{@render caretRightIcon({ size: 13 })}</span>
          </button>
        {:else}
          <span class="min-w-0 flex-1 truncate px-2 text-[13px] font-medium">{name}</span>
        {/if}
        <Button size="small" variant="ghost" squared prefix={xIcon} label="Remove {name}" onclick={() => chooseRelations(selected.filter((value) => value !== name))} />
      </div>
      {#if relation?.variants?.length}
        <div class="grid gap-1 border-t border-neutral-muted p-1">
          {#each relation.variants as variant (variant.name)}
            {@const fields = variantSelection(branch, variant.name)}
            <button type="button" class="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-neutral-muted/40" aria-label="Configure {name} · {variant.name}" onclick={() => open(name, variant.name)}>
              <span class="min-w-0 flex-1 truncate text-[12px]">{variant.name}</span>
              <span class="truncate text-[11px] text-neutral/55">{summary(fields)}</span>
              <span class="shrink-0 text-neutral/50">{@render caretRightIcon({ size: 13 })}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    </div>
  {/each}
</div>
