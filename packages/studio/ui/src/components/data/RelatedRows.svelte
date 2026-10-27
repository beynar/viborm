<script lang="ts">
import { Button } from "entasis/button";
import { arrowRightIcon } from "entasis/icons/arrowRight";
import { ScrollArea } from "entasis/scroll-area";
import { Skeleton } from "entasis/skeleton";
import { Table, type TableRow } from "entasis/table";
import {
  type Row,
  readRows,
  type Scope,
  type StudioModel,
  type StudioRelation,
} from "../../lib/api";
import { display, relatedWhere } from "../../lib/values";

// A row's related rows, under it, as Pyxel's `RelatedRows` opens them: one button per relation and what it holds
// beside its name, then the first rows of the relation chosen, read through the client with the filter that
// follows it (`relatedWhere`), and a link to see them all in their own table. A relation changed reads them again;
// a later answer replaces an earlier one, never the reverse.
let {
  models,
  model,
  row,
  active,
  onActive,
  navigate,
}: {
  models: readonly StudioModel[];
  model: StudioModel;
  row: Row;
  /** The relation shown, by its name. */
  active: string;
  onActive: (relation: string) => void;
  navigate: (model: string, scope?: Scope) => void;
} = $props();

/** The rows of a relation shown under a row; the rest open in their own table. */
const LINKED_PAGE = 20;
/** The related rows' frame: a card as high as 18 rem, then scrolling. */
const LINKED_AREA = {
  root: {
    base: "bg-surface border-neutral-muted max-h-72 min-w-0 rounded-[12px] border",
  },
};

const relations = $derived(
  model.relations.filter(
    (relation) => relatedWhere(model, relation, row) !== undefined
  )
);
const relation = $derived(
  relations.find((candidate) => candidate.name === active) ?? relations[0]
);
const target = $derived(
  relation && models.find((candidate) => candidate.name === relation.targets[0])
);
const keyText = $derived(
  model.key
    ? model.key.fields.map((field) => display(row[field])).join(", ")
    : ""
);
const scope = $derived<Scope | undefined>(
  relation
    ? {
        where: relatedWhere(model, relation, row)!,
        label: `${relation.name} of ${model.name} ${keyText}`,
      }
    : undefined
);

/** What a relation holds, beside its name: how many rows, or the key it points to. */
function held(candidate: StudioRelation): string {
  if (candidate.cardinality === "many")
    return String(
      (row._count as Record<string, number> | undefined)?.[candidate.name] ?? ""
    );
  if (candidate.owner) {
    const values = candidate.fields.map((field) => row[field]);
    return values.some((value) => value === null)
      ? "null"
      : values.map(display).join(", ");
  }
  return "";
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
  answer = null;
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
  if (target && scope) load(target, scope.where);
});

const header = $derived(
  target
    ? Object.fromEntries(target.fields.map((field) => [field.name, field.name]))
    : {}
);
const items = $derived<TableRow[]>(
  target && answer && answer !== "failed"
    ? answer.rows.map((linked) => ({
        cells: Object.fromEntries(
          target.fields.map((field) => [
            field.name,
            {
              content: display(linked[field.name]),
              class: linked[field.name] == null ? "empty" : undefined,
            },
          ])
        ),
      }))
    : []
);
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

  {#if !relation || !target || !scope}
    <p class="note">This row has no relation to follow.</p>
  {:else if answer === 'failed'}
    <p class="note">The related rows could not be read.</p>
  {:else if !answer}
    <Skeleton theme={{ root: { base: 'h-16 w-full' } }} />
  {:else if !answer.rows.length}
    <p class="note">
      {relation.cardinality === 'one' ? `This row points to no ${target.name} row.` : `No ${target.name} row belongs to this one.`}
    </p>
  {:else}
    <ScrollArea label="The {target.name} rows" type="auto" theme={LINKED_AREA}>
      <Table {header} {items} density="compact" theme={{ root: { base: 'w-max min-w-full overflow-visible' }, cell: { base: 'whitespace-nowrap' }, head: { base: 'whitespace-nowrap' } }} />
    </ScrollArea>
    <div class="foot">
      <span>{answer.total > answer.rows.length ? `${answer.rows.length} of ${answer.total} ${target.name} rows` : `${answer.total} ${target.name} ${answer.total === 1 ? 'row' : 'rows'}`}</span>
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
  .foot { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: color-mix(in oklab, var(--color-neutral) 65%, transparent); }
  .linked :global(td.empty) { opacity: 0.45; font-style: italic; }
</style>
