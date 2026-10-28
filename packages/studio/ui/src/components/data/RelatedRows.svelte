<script lang="ts">
import { Button } from "entasis/button";
import { Chip } from "entasis/chip";
import { Combobox } from "entasis/combobox";
import { arrowRightIcon } from "entasis/icons/arrowRight";
import { linkBreakIcon } from "entasis/icons/linkBreak";
import { xIcon } from "entasis/icons/x";
import { ScrollArea } from "entasis/scroll-area";
import { Skeleton } from "entasis/skeleton";
import {
  keyOf,
  type Row,
  readRows,
  rowChoices,
  type Scope,
  type StudioModel,
  type StudioRelation,
} from "../../lib/api";
import type { Changes } from "../../lib/changes.svelte";
import {
  cellText,
  display,
  isReached,
  reachedText,
  relatedScopes,
} from "../../lib/values";

// A row's related rows, under it, as Pyxel's `RelatedRows` opens them: one button per relation and what it holds
// beside its name, then the first rows of the relation chosen, read through the client with the filter that
// follows it (`relatedScopes`; one per variant for a polymorphic collection), and a link to see them all in their own table. A relation the row does not hold the
// key of is linked here too: a row connected, or one disconnected, through the client's nested writes, stacked with
// the other changes until they are saved. A later answer replaces an earlier one, never the reverse.
let {
  models,
  model,
  row,
  readonly = false,
  active,
  onActive,
  navigate,
  changes,
}: {
  models: readonly StudioModel[];
  model: StudioModel;
  row: Row;
  readonly?: boolean;
  /** The relation shown, by its name. */
  active: string;
  onActive: (relation: string) => void;
  navigate: (model: string, scope?: Scope) => void;
  /** Where a link or an unlink is stacked until it is saved. */
  changes: Changes;
} = $props();

/** The rows of a relation shown under a row; the rest open in their own table. */
const LINKED_PAGE = 20;
/** The related rows' frame: a card as high as 18 rem, then scrolling. */
const LINKED_AREA = {
  root: {
    base: "bg-surface border-neutral-muted max-h-72 min-w-0 rounded-[12px] border",
  },
};
// The label is read by assistive technology only: its header leaves the layout too, so no empty row spaces the control.
const HIDDEN_LABEL = {
  header: { base: "!absolute sr-only" },
  label: { base: "sr-only" },
};

const relations = $derived(
  model.relations.filter(
    (relation) => relatedScopes(model, relation, row) !== undefined
  )
);
const relation = $derived(
  relations.find((candidate) => candidate.name === active) ?? relations[0]
);
/** Where the relation reaches: one model, or one per variant of a polymorphic collection, shown one at a time. */
const scopes = $derived(
  relation ? (relatedScopes(model, relation, row) ?? []) : []
);
let pickedVariant = $state<string>();
const reaching = $derived(
  scopes.find((candidate) => candidate.variant === pickedVariant) ?? scopes[0]
);
const target = $derived(
  reaching && models.find((candidate) => candidate.name === reaching.target)
);
const keyText = $derived(
  model.key
    ? model.key.fields.map((field) => display(row[field])).join(", ")
    : ""
);
const scope = $derived<Scope | undefined>(
  relation && reaching
    ? {
        where: reaching.where,
        label: `${relation.name}${scopes.length > 1 ? ` (${reaching.variant})` : ""} of ${model.name} ${keyText}`,
      }
    : undefined
);
/**
 * Whether this row links its related rows itself, through the relation: a to-many relation, or a to-one whose key
 * the other row holds. A key this row holds is changed in its own column.
 */
const links = $derived(
  !readonly &&
    !!relation &&
    !relation.owner &&
    // A polymorphic membership is written with its variant: not offered here yet.
    relation.storage !== "variant" &&
    target?.key?.fields.length === 1
);
/**
 * Whether a linked row can be let go: a junction row always, a foreign key only
 * when one of its columns on the other row takes null (the client clears those;
 * a key none of whose columns does has no disconnect, and that row is moved by
 * linking it elsewhere).
 */
const unlinks = $derived.by(() => {
  if (!(links && relation && target)) return false;
  if (relation.storage === "junction") return true;
  const held = target.relations.find(
    (candidate) => candidate.name === relation.inverse
  );
  return (
    !!held &&
    held.fields.some(
      (name) => target.fields.find((field) => field.name === name)?.nullable
    )
  );
});

/** What a relation holds, beside its name: how many rows, or the key it reaches. */
function held(candidate: StudioRelation): string {
  if (candidate.cardinality === "many")
    return String(row._count?.[candidate.name] ?? "");
  const reached = row[candidate.name] as Row | null | undefined;
  if (reached === null) return "none";
  if (isReached(reached)) return reachedText(reached);
  return reached ? Object.values(reached).map(display).join(", ") : "";
}

// As wide as the table shows, whatever its scroll: the related rows scroll on their own, inside.
let root = $state<HTMLElement>();
let width = $state<number | null>(null);
$effect(() => {
  const viewport = root?.parentElement?.closest<HTMLElement>(
    "[data-scroll-area-viewport]"
  );
  if (!viewport) return;
  const measure = () => (width = viewport.clientWidth);
  measure();
  const resized = new ResizeObserver(measure);
  resized.observe(viewport);
  return () => resized.disconnect();
});

let answer = $state.raw<{ rows: Row[]; total: number } | "failed" | null>(null);
let asked = 0;
async function load(target: StudioModel, where: Scope["where"]) {
  const mine = ++asked;
  try {
    const found = await readRows(target.name, {
      where,
      skip: 0,
      take: LINKED_PAGE,
    });
    if (mine === asked) answer = found;
  } catch {
    if (mine === asked) answer = "failed";
  }
}
$effect(() => {
  if (target && scope) {
    answer = null;
    load(target, scope.where);
  }
});

/** Link or unlink one row of the relation: a nested write on this row, stacked until the changes are saved. */
function change(write: Record<string, unknown>, done: string) {
  if (!(relation && model.key)) return;
  // The panel redraws: a field still focused would write its state as it goes (entasis's `state_unsafe_mutation`,
  // as `RowsView`'s editors), so focus leaves it first.
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
  changes.nested(
    model.name,
    keyOf(model, row)!,
    { [relation.name]: write },
    done
  );
}
/** The links and unlinks stacked for this row's relation shown, which the rows above do not show yet. */
const staged = $derived(
  relation
    ? changes.list.filter(
        (entry) =>
          entry.nested &&
          entry.model === model.name &&
          JSON.stringify(entry.key) === JSON.stringify(keyOf(model, row)) &&
          entry.data !== undefined &&
          relation.name in entry.data
      )
    : []
);
const keyWhere = (value: string) => {
  const field = target!.fields.find(
    (candidate) => candidate.name === target!.key!.fields[0]
  )!;
  return {
    [field.name]:
      field.type === "int" || field.type === "number" ? Number(value) : value,
  };
};
const connect = (value: string) =>
  change(
    { connect: keyWhere(value) },
    `${target!.name} ${value} linked to ${model.name} ${keyText}`
  );
const disconnect = (linked: Row) =>
  change(
    relation!.cardinality === "many"
      ? { disconnect: keyOf(target!, linked) }
      : { disconnect: true },
    `${target!.name} ${Object.values(keyOf(target!, linked)!).map(display).join(", ")} unlinked`
  );
let picked = $state<string | null>(null);
</script>

<div class="linked" bind:this={root} style:width={width ? `${width}px` : undefined} aria-label="The rows related to this {model.name}">
  <div class="relations">
    {#each relations as candidate (candidate.name)}
      {@const holds = held(candidate)}
      <Button size="small" variant={candidate.name === relation?.name ? 'soft' : 'ghost'} onclick={() => onActive(candidate.name)}>
        {candidate.name}
        {#if holds}<span class="held">{holds}</span>{/if}
      </Button>
    {/each}
  </div>
  {#if scopes.length > 1}
    <!-- A polymorphic collection: its rows one variant at a time. -->
    <div class="relations" aria-label="Variants of {relation?.name}">
      {#each scopes as candidate (candidate.variant)}
        <Button size="small" variant={candidate === reaching ? 'soft' : 'ghost'} onclick={() => (pickedVariant = candidate.variant)}>{candidate.variant}</Button>
      {/each}
    </div>
  {/if}

  {#if relation && scopes.length === 0}
    <p class="note">This row reaches no {relation.targets.join(' or ')} row.</p>
  {:else if !relation || !target || !scope}
    <p class="note">This row has no relation to follow.</p>
  {:else if answer === 'failed'}
    <p class="note">The related rows could not be read.</p>
  {:else if !answer}
    <Skeleton theme={{ root: { base: 'h-16 w-full' } }} />
  {:else}
    {#if !answer.rows.length}
      <p class="note">
        {relation.cardinality === 'one' ? `This row reaches no ${target.name} row.` : `No ${target.name} row belongs to this one.`}
      </p>
    {:else}
      <ScrollArea label="The {target.name} rows" type="auto" theme={LINKED_AREA}>
        <table class="related">
          <thead>
            <tr>
              {#each target.fields as field (field.name)}<th>{field.name}</th>{/each}
              {#if unlinks}<th class="action"><span class="sr-only">Unlink</span></th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each answer.rows as linked, index (index)}
              <tr>
                {#each target.fields as field (field.name)}
                  <td class:empty={linked[field.name] == null}>{cellText(field, linked[field.name])}</td>
                {/each}
                {#if unlinks}
                  <td class="action">
                    <Button size="small" variant="ghost" squared prefix={linkBreakIcon} label="Unlink this {target.name}" onclick={() => disconnect(linked)} />
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </ScrollArea>
    {/if}
    {#if staged.length}
      <!-- Stacked, not yet written: the rows above show the database as it is. -->
      <div class="flex flex-wrap items-center gap-1">
        <span class="text-[12px] text-neutral/60">Not saved yet:</span>
        {#each staged as entry (entry.id)}
          <Chip size="small" variant="soft" color="warning">
            {entry.label}
            <Button size="small" variant="ghost" squared prefix={xIcon} label="Drop “{entry.label}”" onclick={() => changes.remove(entry.id)} />
          </Chip>
        {/each}
      </div>
    {/if}
    <div class="foot">
      {#if links && (relation.cardinality === 'many' || !answer.rows.length)}
        <div class="w-64">
          <Combobox
            size="small"
            label="Link a {target.name}"
            theme={HIDDEN_LABEL}
            items={rowChoices(target)}
            openOnFocus
            placeholder="Link a {target.name}…"
            loadingText="Searching…"
            noOptionsText="No {target.name} row matches"
            bind:value={picked}
            onValueChange={({ value }) => {
              if (value) connect(value)
              picked = null
            }}
          />
        </div>
      {/if}
      <span class="count">{answer.total > answer.rows.length ? `${answer.rows.length} of ${answer.total} ${target.name} rows` : `${answer.total} ${target.name} ${answer.total === 1 ? 'row' : 'rows'}`}</span>
      <Button size="small" variant="ghost" suffix={arrowRightIcon} onclick={() => navigate(target.name, scope)}>Open them in {target.name}</Button>
    </div>
  {/if}
</div>

<style>
  /* Under a row as wide as the table scrolls, the related rows stay in view: as wide as the table shows, on its left. */
  .linked { position: sticky; left: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-sm); padding: var(--space-md) var(--space-lg); }
  .relations { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
  .held { color: color-mix(in oklab, var(--color-neutral) 60%, transparent); font-weight: 400; }
  .note { margin: 0; font-size: 13px; color: color-mix(in oklab, var(--color-neutral) 65%, transparent); }
  .foot { display: flex; align-items: center; gap: var(--space-md); font-size: 12px; color: color-mix(in oklab, var(--color-neutral) 65%, transparent); }
  .count { margin-left: auto; }
  /* entasis's compact table, with a column of actions: its Table takes no row-bound snippet. */
  .related { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 13px; }
  .related th { padding: 6px 12px; text-align: left; font-weight: 500; white-space: nowrap; border-bottom: 1px solid color-mix(in oklab, var(--color-neutral) 12%, transparent); }
  .related td { padding: 4px 12px; white-space: nowrap; border-bottom: 1px solid color-mix(in oklab, var(--color-neutral) 7%, transparent); }
  .related tr:last-child td { border-bottom: 0; }
  .related .action { width: 1%; padding: 2px 6px; }
  .related td.empty { opacity: 0.45; font-style: italic; }
</style>
