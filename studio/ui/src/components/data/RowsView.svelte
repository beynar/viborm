<script lang="ts">
import { untrack } from "svelte";
import {
  createRow,
  deleteRow,
  keyOf,
  type Row,
  readRows,
  type Scope,
  type StudioModel,
  type StudioRelation,
  type StudioSchema,
  updateRow,
  type Where,
} from "../../lib/api";
import {
  type Condition,
  conditionWhere,
  display,
  relatedWhere,
  typeLabel,
} from "../../lib/values";
import Icon from "../Icon.svelte";
import FilterPanel from "./FilterPanel.svelte";
import RowPanel from "./RowPanel.svelte";

// One model's rows, a page at a time, read through the client: found by words in its text columns, filtered by
// conditions, sorted by its headers, each relation a link to the rows it reaches. A row opens in a panel to be
// changed or deleted; a new one is written there too.
const {
  schema,
  model,
  scope,
  navigate,
}: {
  schema: StudioSchema;
  model: StudioModel;
  /** The rows a followed relation reached, when the page was opened from one. */
  scope?: Scope;
  navigate: (model: string, scope?: Scope) => void;
} = $props();

const PAGE_SIZES = [25, 50, 100, 250];
let rows = $state.raw<Row[]>([]);
let total = $state(0);
let loading = $state(false);
let failure = $state<string>();
let skip = $state(0);
let take = $state(50);
let order = $state<{ field: string; direction: "asc" | "desc" }>();
let words = $state("");
let search = $state("");
let showFilters = $state(false);
let conditions = $state<Condition[]>([]);
let combinator = $state<"AND" | "OR">("AND");
/** The conditions last applied: those the page reads. */
let applied = $state<Where>();
let editing = $state<{ row?: Row }>();

let typing: ReturnType<typeof setTimeout> | undefined;
function typed(value: string) {
  words = value;
  clearTimeout(typing);
  typing = setTimeout(() => {
    search = words;
    skip = 0;
  }, 250);
}

function applyFilters() {
  failure = undefined;
  try {
    const clauses = conditions.flatMap((condition) => {
      const field = model.fields.find(
        (entry) => entry.name === condition.field
      );
      return field ? [conditionWhere(field, condition)] : [];
    });
    applied =
      clauses.length === 0
        ? undefined
        : clauses.length === 1
          ? clauses[0]
          : { [combinator]: clauses };
    skip = 0;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
}

const where = $derived.by<Where | undefined>(() => {
  const clauses = [scope?.where, applied].filter(
    (clause) => clause !== undefined
  );
  return clauses.length === 0
    ? undefined
    : clauses.length === 1
      ? clauses[0]
      : { AND: clauses };
});

/** The page the controls ask for. */
const query = $derived({
  model: model.name,
  ...(where ? { where } : {}),
  ...(search.trim() ? { search } : {}),
  ...(order ? { orderBy: [{ [order.field]: order.direction }] } : {}),
  skip,
  take,
});

let asked = 0;
async function load({ model: name, ...page }: typeof query) {
  const ask = ++asked;
  loading = true;
  try {
    const answer = await readRows(name, page);
    if (ask !== asked) return;
    rows = answer.rows;
    total = answer.total;
    failure = undefined;
  } catch (error) {
    if (ask !== asked) return;
    rows = [];
    total = 0;
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (ask === asked) loading = false;
  }
}

$effect(() => {
  const asking = query;
  untrack(() => load(asking));
});
const reload = () => load(query);

function sortBy(field: string) {
  order =
    order?.field !== field
      ? { field, direction: "asc" }
      : order.direction === "asc"
        ? { field, direction: "desc" }
        : undefined;
  skip = 0;
}

const keyText = (row: Row) =>
  model.key
    ? model.key.fields.map((field) => display(row[field])).join(", ")
    : "";

/** Follow one row's relation to the rows it reaches. */
function follow(relation: StudioRelation, row: Row) {
  const target = relation.targets[0];
  const reached = relatedWhere(model, relation, row);
  if (!(target && reached)) return;
  navigate(target, {
    where: reached,
    label: `${relation.name} of ${model.name} ${keyText(row)}`,
  });
}

const ownedValues = (relation: StudioRelation, row: Row) =>
  relation.fields.map((field) => row[field]);

async function save(data: Row) {
  const row = editing?.row;
  if (row) await updateRow(model.name, keyOf(model, row)!, data);
  else await createRow(model.name, data);
  editing = undefined;
  await reload();
}

async function remove() {
  const row = editing?.row;
  if (!row) return;
  await deleteRow(model.name, keyOf(model, row)!);
  editing = undefined;
  await reload();
}

const last = $derived(Math.min(skip + take, total));
</script>

<section class="view">
  <header class="bar">
    <h1>{model.name}</h1>
    <span class="count">{total} {total === 1 ? 'row' : 'rows'}</span>
    {#if scope}
      <span class="scope">
        {scope.label}
        <button class="icon ghost" aria-label="Show all {model.name} rows" onclick={() => navigate(model.name)}><Icon name="x" size={14} /></button>
      </span>
    {/if}
    <span class="spacer"></span>
    <label class="search">
      <Icon name="search" />
      <span class="sr-only">Search text columns</span>
      <input placeholder="Search" value={words} oninput={event => typed(event.currentTarget.value)} />
    </label>
    <button class:active={showFilters || applied} onclick={() => (showFilters = !showFilters)} aria-expanded={showFilters}>
      <Icon name="filter" />Filter{#if applied}<span class="badge">{conditions.length}</span>{/if}
    </button>
    <button class="icon" aria-label="Refresh" title="Refresh" onclick={reload}><Icon name="refresh" /></button>
    <button class="primary" onclick={() => (editing = {})}><Icon name="plus" />Add row</button>
  </header>
  {#if showFilters}
    <FilterPanel {model} bind:conditions bind:combinator apply={applyFilters} />
  {/if}
  {#if failure}<p class="failure" role="alert">{failure}</p>{/if}
  <div class="grid" class:loading>
    <table>
      <thead>
        <tr>
          {#each model.fields as field (field.name)}
            <th scope="col" aria-sort={order?.field === field.name ? (order.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
              <button class="ghost head" onclick={() => sortBy(field.name)} title="Sort by {field.name}">
                {#if field.id}<Icon name="key" size={12} />{/if}
                <span>{field.name}</span>
                <span class="type">{typeLabel(field)}</span>
                {#if order?.field === field.name}<Icon name={order.direction === 'asc' ? 'up' : 'down'} size={12} />{/if}
              </button>
            </th>
          {/each}
          {#each model.relations as relation (relation.name)}
            <th scope="col" class="relation"><span class="head">{relation.name}<span class="type">{relation.targets.join(' | ')}{relation.cardinality === 'many' ? '[]' : ''}</span></span></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each rows as row, index (model.key ? keyText(row) : index)}
          <tr>
            {#each model.fields as field (field.name)}
              {@const value = row[field.name]}
              <td class:null={value === null} class:number={['int', 'number', 'bigint', 'decimal'].includes(field.type)}>
                <button class="cell" title="Edit this row" onclick={() => (editing = { row })}>{display(value)}</button>
              </td>
            {/each}
            {#each model.relations as relation (relation.name)}
              {@const reachable = relatedWhere(model, relation, row) !== undefined}
              <td class="relation">
                {#if !reachable}
                  <span class="muted">—</span>
                {:else if relation.cardinality === 'many'}
                  <button class="link" onclick={() => follow(relation, row)}>{row._count?.[relation.name] ?? '?'} {relation.targets[0]}<Icon name="right" size={12} /></button>
                {:else if relation.owner && ownedValues(relation, row).some(value => value === null)}
                  <span class="muted">null</span>
                {:else}
                  <button class="link" onclick={() => follow(relation, row)}>
                    {relation.targets[0]}{relation.owner ? ` ${ownedValues(relation, row).map(display).join(', ')}` : ''}<Icon name="right" size={12} />
                  </button>
                {/if}
              </td>
            {/each}
          </tr>
        {:else}
          <tr><td class="empty" colspan={model.fields.length + model.relations.length}>{loading ? 'Loading…' : 'No rows'}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <footer class="pages">
    <span>{total === 0 ? 0 : skip + 1}–{last} of {total}</span>
    <label>Rows per page
      <select bind:value={take} onchange={() => (skip = 0)}>
        {#each PAGE_SIZES as size (size)}<option value={size}>{size}</option>{/each}
      </select>
    </label>
    <button class="icon" aria-label="Previous page" disabled={skip === 0} onclick={() => (skip = Math.max(0, skip - take))}><Icon name="left" /></button>
    <button class="icon" aria-label="Next page" disabled={skip + take >= total} onclick={() => (skip += take)}><Icon name="right" /></button>
  </footer>
  {#if editing}
    {#key editing}
      <RowPanel
        {model}
        row={editing.row}
        {save}
        remove={editing.row && model.key ? remove : undefined}
        close={() => (editing = undefined)}
      />
    {/key}
  {/if}
</section>

<style>
  .view { position: relative; display: flex; flex-direction: column; height: 100%; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--color-surface); }
  h1 { margin: 0; font-size: 16px; }
  .count { color: var(--muted); }
  .scope { display: inline-flex; align-items: center; gap: 2px; padding: 0 2px 0 10px; border-radius: 999px; background: color-mix(in oklab, var(--color-link) 12%, transparent); color: var(--color-link); font-size: 12px; }
  .scope button { height: 24px; width: 24px; }
  .spacer { flex: 1; }
  .search { position: relative; display: inline-flex; align-items: center; color: var(--muted); }
  .search :global(svg) { position: absolute; left: 8px; }
  .search input { padding-left: 28px; width: 200px; color: var(--color-neutral); }
  .active { border-color: var(--color-link); color: var(--color-link); }
  .badge { padding: 0 6px; border-radius: 999px; background: var(--color-link); color: #fff; font-size: 11px; }
  .failure { margin: 8px 16px 0; padding: 8px 10px; border-radius: 8px; background: color-mix(in oklab, var(--color-danger) 12%, transparent); color: var(--color-danger); white-space: pre-wrap; }
  .grid { flex: 1; overflow: auto; background: var(--color-surface); }
  .grid.loading { opacity: 0.6; }
  table { border-collapse: separate; border-spacing: 0; min-width: 100%; font-size: 12.5px; }
  th { position: sticky; top: 0; z-index: 1; background: var(--color-surface); border-bottom: 1px solid var(--border); text-align: left; font-weight: 600; padding: 0; }
  .head { display: flex; align-items: center; gap: 6px; width: 100%; height: 34px; padding: 0 12px; border-radius: 0; font-weight: 600; }
  th.relation .head { font-style: italic; color: var(--muted); }
  .type { font: 10.5px var(--mono); font-weight: 400; color: var(--muted); }
  td { border-bottom: 1px solid color-mix(in oklab, var(--color-neutral) 7%, transparent); border-right: 1px solid color-mix(in oklab, var(--color-neutral) 5%, transparent); padding: 0; max-width: 320px; }
  tr:hover td { background: var(--faint); }
  .cell { display: block; width: 100%; height: 32px; padding: 0 12px; border: 0; border-radius: 0; background: transparent; text-align: inherit; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); font-size: 12px; line-height: 32px; }
  td.null .cell { color: var(--muted); font-style: italic; }
  td.number { text-align: right; }
  td.relation { padding: 0 8px; white-space: nowrap; }
  .link { height: 24px; padding: 0 6px; border: 0; background: transparent; color: var(--color-link); font-size: 12px; gap: 2px; }
  .link:hover { text-decoration: underline; }
  .muted { color: var(--muted); padding: 0 6px; }
  .empty { padding: 32px; text-align: center; color: var(--muted); }
  .pages { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--border); background: var(--color-surface); color: var(--muted); }
  .pages label { display: inline-flex; align-items: center; gap: 6px; }
</style>
