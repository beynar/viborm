<script lang="ts">
import { Button } from "entasis/button";
import { Chip } from "entasis/chip";
import { confirmation } from "entasis/confirmation";
import {
  DataTable,
  type DataTableApi,
  type DataTableCellCommit,
  type DataTableColumn,
  type DataTableEditor,
  type DataTableState,
} from "entasis/data-table";
import { arrowRightIcon } from "entasis/icons/arrowRight";
import { arrowsClockwiseIcon } from "entasis/icons/arrowsClockwise";
import { arrowsOutSimpleIcon } from "entasis/icons/arrowsOutSimple";
import { funnelIcon } from "entasis/icons/funnel";
import { linkSimpleIcon } from "entasis/icons/linkSimple";
import { magnifyingGlassIcon } from "entasis/icons/magnifyingGlass";
import { plusIcon } from "entasis/icons/plus";
import { trashIcon } from "entasis/icons/trash";
import { xIcon } from "entasis/icons/x";
import { Pagination } from "entasis/pagination";
import { Popover } from "entasis/popover";
import { Select } from "entasis/select";
import { TextInput } from "entasis/text-input";
import { toast } from "entasis/toast";
import { untrack } from "svelte";
import {
  createRow,
  deleteRow,
  keyOf,
  type Row,
  readRows,
  type Scope,
  type StudioField,
  type StudioModel,
  type StudioRelation,
  updateRow,
  type Where,
} from "../../lib/api";
import {
  type Condition,
  conditionWhere,
  display,
  editable,
  relatedWhere,
  written,
} from "../../lib/values";
import FilterGroup from "./FilterGroup.svelte";
import RowDrawer from "./RowDrawer.svelte";

// One model's rows, explored as in Pyxel's `TableStudio`: a page at a time, found by words in its text columns,
// filtered by conditions, sorted by its headers, each cell changed by an editor of its type, rows added and removed.
// Everything is read and written through the application's client (`/api`): the table shows only what it answered.
let {
  model,
  models,
  scope,
  navigate,
}: {
  model: StudioModel;
  models: readonly StudioModel[];
  scope?: Scope;
  navigate: (model: string, scope?: Scope) => void;
} = $props();

const HIDDEN_LABEL = { label: { base: "sr-only" } };
const PAGE_SIZES = [25, 50, 100, 250].map((value) => ({
  value: String(value),
  label: String(value),
}));
const NUMERIC = new Set(["int", "number", "bigint", "decimal"]);
const fieldsByName = $derived(
  new Map(model.fields.map((field) => [field.name, field]))
);
const keyed = $derived(model.key !== undefined);

let rows = $state.raw<Row[]>([]);
let total = $state(0);
let loading = $state(true);
let failure = $state<unknown>(null);
let tableState = $state<DataTableState>();
let api = $state<DataTableApi<Row>>();
let editing = $state<{ row?: Row }>();
let root = $state<HTMLElement>();

// Pyxel's `TableStudio` workaround: entasis removes the focused text editor before its Field stops watching
// focusout, which then writes its state mid-teardown (`state_unsafe_mutation`). Blur while handling the gesture,
// before Svelte tears it down (also for unchanged drafts and Escape, which never call commit).
$effect(() => {
  if (!root) return;
  const current = root;
  const document = current.ownerDocument;
  const releaseEditorFocus = (event: KeyboardEvent | MouseEvent) => {
    if (
      event instanceof KeyboardEvent &&
      !["Enter", "Tab", "Escape"].includes(event.key)
    )
      return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLInputElement && current.contains(focused)))
      return;
    const group = focused.closest('[role="gridcell"] > [role="group"]');
    const columnId = group?.parentElement?.dataset.columnId;
    if (
      !group ||
      columns.find((column) => column.id === columnId)?.editor?.type !== "text"
    )
      return;
    if (
      event instanceof MouseEvent &&
      event.target instanceof Node &&
      group.contains(event.target)
    )
      return;
    focused.blur();
  };
  current.addEventListener("keydown", releaseEditorFocus, true);
  document.addEventListener("click", releaseEditorFocus, true);
  return () => {
    current.removeEventListener("keydown", releaseEditorFocus, true);
    document.removeEventListener("click", releaseEditorFocus, true);
  };
});

// The words searched, typed in the header: the table searches them once the member stops typing.
let words = $state("");
let typing: ReturnType<typeof setTimeout> | undefined;
function search(value: string | null) {
  words = value ?? "";
  clearTimeout(typing);
  typing = setTimeout(() => api?.setGlobalFilter(words), 300);
}

/** The filter being written, and the one the rows answer: written is not applied until « Apply ». */
let conditions = $state<Condition[]>([]);
let combinator = $state<"AND" | "OR">("AND");
let applied = $state.raw<Where>();
let appliedCount = $state(0);

const rowId = (row: Row) => JSON.stringify(model.key ? keyOf(model, row) : row);
const selected = $derived(
  Object.keys(tableState?.rowSelection ?? {}).filter(
    (id) => tableState?.rowSelection[id]
  )
);

// Every change of what is asked reads the rows again; a later answer replaces an earlier one, never the reverse.
const query = $derived.by(() => {
  const state = tableState;
  const page = state?.pagination.page ?? 1;
  const pageSize = state?.pagination.pageSize ?? 50;
  const clauses = [scope?.where, applied].filter(
    (clause) => clause !== undefined
  );
  return {
    ...(clauses.length === 1
      ? { where: clauses[0] }
      : clauses.length > 1
        ? { where: { AND: clauses } }
        : {}),
    ...(state?.globalFilter.trim()
      ? { search: state.globalFilter.trim() }
      : {}),
    orderBy: (state?.sorting ?? []).slice(0, 3).map((sort) => ({
      [sort.id]: sort.desc ? ("desc" as const) : ("asc" as const),
    })),
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
});
let answered = "";
let asked = 0;
$effect(() => {
  const current = query;
  const key = JSON.stringify(current);
  if (key === answered) return;
  answered = key;
  untrack(() => {
    load(current);
  });
});

async function load(current = query) {
  const mine = ++asked;
  loading = true;
  try {
    const answer = await readRows(model.name, current);
    if (mine !== asked) return;
    rows = answer.rows;
    total = answer.total;
    failure = null;
  } catch (error) {
    if (mine !== asked) return;
    failure = error;
    toast.danger({
      title: "The rows could not be read",
      description: said(error),
    });
  } finally {
    if (mine === asked) loading = false;
  }
}

const said = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Another filter reads from its first page, as another search or sort does. */
function firstPage() {
  if (tableState && tableState.pagination.page !== 1)
    tableState = {
      ...tableState,
      pagination: { ...tableState.pagination, page: 1 },
    };
}
function apply() {
  try {
    const clauses = conditions.flatMap((condition) => {
      const field = fieldsByName.get(condition.field);
      return field ? [conditionWhere(field, condition)] : [];
    });
    applied =
      clauses.length === 0
        ? undefined
        : clauses.length === 1
          ? clauses[0]
          : { [combinator]: clauses };
    appliedCount = clauses.length;
    firstPage();
  } catch (error) {
    toast.danger({
      title: "This filter cannot be applied",
      description: said(error),
    });
  }
}
function clear() {
  conditions = [];
  applied = undefined;
  appliedCount = 0;
  firstPage();
}

function editor(field: StudioField): DataTableEditor<Row> | undefined {
  if (!keyed || (field.id && field.generated)) return undefined;
  if (
    field.list ||
    field.type === "json" ||
    field.type === "point" ||
    field.type === "vector"
  )
    return { type: "text", placeholder: field.list ? "[…]" : "{…}" };
  if (field.type === "int") return { type: "number", step: 1 };
  if (field.type === "number") return { type: "number" };
  if (field.type === "boolean") return { type: "switch" };
  if (field.type === "enum")
    return {
      type: "select",
      options: [
        ...(field.nullable ? [{ value: "", label: "null" }] : []),
        ...(field.enumValues ?? []).map((value) => ({ value, label: value })),
      ],
    };
  if (field.type === "datetime")
    return { type: "text", placeholder: "2026-01-31T12:00:00Z" };
  return { type: "text", placeholder: field.nullable ? "null" : undefined };
}

/** A column as wide as what it holds reads: a key or a number narrow, an instant or a text wider. */
function widthOf(field: StudioField): number {
  if (field.id && NUMERIC.has(field.type)) return 80;
  if (field.type === "boolean") return 110;
  if (NUMERIC.has(field.type))
    return field.type === "bigint" || field.type === "decimal" ? 160 : 110;
  if (field.type === "datetime") return 230;
  if (field.type === "enum") return 130;
  if (field.list || field.type === "json") return 260;
  return 220;
}

const columns = $derived<DataTableColumn<Row>[]>([
  ...model.fields.map((field) => ({
    id: field.name,
    header: field.name,
    accessor: (row: Row) => editable(field, row[field.name]),
    sortable: !(
      field.list || ["json", "blob", "point", "vector"].includes(field.type)
    ),
    editor: editor(field),
    width: widthOf(field),
    ...(NUMERIC.has(field.type)
      ? { align: "end" as const, class: "tabular-nums" }
      : {}),
  })),
  // The relations, after the columns: each a link to the rows it reaches.
  ...model.relations.map((relation) => ({
    id: relation.name,
    header: relation.name,
    accessor: () => "",
    sortable: false,
    width: 150,
  })),
]);

async function commit({ row, columnId, value }: DataTableCellCommit<Row>) {
  const field = fieldsByName.get(columnId);
  if (!field) throw new Error("This column no longer exists.");
  const next = written(field, value);
  if (Object.is(next, row[columnId])) return;
  try {
    const { row: changed } = await updateRow(model.name, keyOf(model, row)!, {
      [columnId]: next,
    });
    rows = rows.map((candidate) =>
      rowId(candidate) === rowId(row) ? changed : candidate
    );
  } catch (error) {
    toast.danger({
      title: `${columnId} was not saved`,
      description: said(error),
    });
    throw new Error(said(error));
  }
}

async function saveRow(data: Row) {
  const row = editing?.row;
  if (row) await updateRow(model.name, keyOf(model, row)!, data);
  else await createRow(model.name, data);
  toast.success({ title: row ? "The row was saved" : "The row was added" });
  await load();
}

async function removeRow() {
  const row = editing?.row;
  if (!row) return;
  await deleteRow(model.name, keyOf(model, row)!);
  toast.success({ title: "The row was deleted" });
  await load();
}

async function removeSelected(ids: string[]) {
  const { confirmed } = await confirmation({
    title:
      ids.length === 1
        ? "Delete this row?"
        : `Delete these ${ids.length} rows?`,
    description:
      ids.length === 1
        ? "It is deleted through your client. It cannot be undone."
        : "They are deleted through your client, one by one. It cannot be undone.",
    confirm: { text: "Delete", color: "danger" },
    cancel: "Cancel",
  });
  if (!confirmed) return;
  let count = 0;
  try {
    for (const id of ids) {
      await deleteRow(model.name, JSON.parse(id));
      count++;
    }
    toast.success({
      title: count === 1 ? "One row deleted" : `${count} rows deleted`,
    });
  } catch (error) {
    toast.danger({
      title: count
        ? `${count} deleted, then one was refused`
        : "Nothing was deleted",
      description: said(error),
    });
  }
  api?.clearSelection();
  await load();
}

/** Follow one row's relation to the rows it reaches. */
function follow(relation: StudioRelation, row: Row) {
  const target = relation.targets[0];
  const reached = relatedWhere(model, relation, row);
  if (!(target && reached)) return;
  const key = model.key
    ? model.key.fields.map((field) => display(row[field])).join(", ")
    : "";
  navigate(target, {
    where: reached,
    label: `${relation.name} of ${model.name} ${key}`,
  });
}
const heldKey = (relation: StudioRelation, row: Row) =>
  relation.fields.map((field) => row[field]);
</script>

<section bind:this={root} class="flex h-full min-h-0 flex-1 flex-col" aria-label="The rows of {model.name}">
  <header class="flex flex-wrap items-center gap-2 border-b border-neutral/10 px-4 py-2.5">
    <h1 class="m-0 text-[16px] font-semibold">{model.name}</h1>
    <span class="text-[13px] text-neutral/60 tabular-nums">{total} {total === 1 ? 'row' : 'rows'}</span>
    {#if scope}
      <Chip size="small" variant="soft">{scope.label}</Chip>
      <Button size="small" variant="ghost" squared label="Show every {model.name} row" prefix={xIcon} onclick={() => navigate(model.name)} />
    {/if}
    <span class="flex-1"></span>
    {#if selected.length}
      <Button size="small" variant="soft" color="danger" prefix={trashIcon} onclick={() => removeSelected(selected)}>
        {selected.length === 1 ? 'Delete the row' : `Delete ${selected.length} rows`}
      </Button>
    {/if}
    <Popover position="bottom-end" size="large" focusOnOpen="first" theme={{ popover: { size: { large: 'max-w-[44rem] w-[min(44rem,calc(100vw-2rem))] p-4' } } }}>
      {#snippet trigger(popover)}
        <Button size="small" variant={appliedCount ? 'soft' : 'outline'} prefix={funnelIcon} {@attach popover.trigger}>
          {appliedCount ? `Filters · ${appliedCount}` : 'Filter'}
        </Button>
      {/snippet}
      {#snippet children(popover)}
        <div class="grid gap-3">
          <FilterGroup {model} bind:conditions bind:combinator />
          <div class="flex justify-end gap-2">
            {#if appliedCount || conditions.length}<Button size="small" variant="ghost" onclick={() => (clear(), popover.close())}>Clear</Button>{/if}
            <Button size="small" color="primary" onclick={() => (apply(), popover.close())}>Apply</Button>
          </div>
        </div>
      {/snippet}
    </Popover>
    <div class="w-[200px]">
      <TextInput size="small" label="Search the text columns" theme={HIDDEN_LABEL} placeholder="Search" prefix={magnifyingGlassIcon} value={words} onValueChange={search} />
    </div>
    <Button size="small" variant="ghost" squared prefix={arrowsClockwiseIcon} label="Read the rows again" onclick={() => load()} />
    <Button size="small" color="primary" prefix={plusIcon} onclick={() => (editing = {})}>Add row</Button>
  </header>

  <!-- Positioned, the table has a definite height to scroll within. -->
  <div class="relative min-h-0 flex-1">
    <DataTable
      items={rows}
      {columns}
      getRowId={rowId}
      processingMode="manual"
      rowCount={total}
      interactionMode="grid"
      selectionMode={keyed ? 'multiple' : 'none'}
      density="compact"
      stickyHeader
      {loading}
      error={failure}
      pagination={{ pageSize: 50, showControls: false }}
      onCellCommit={commit}
      bind:state={tableState}
      bind:api
      theme={{
        root: { base: 'absolute inset-0 gap-0' },
        viewport: { base: 'min-h-0 flex-1 rounded-none border-0' },
        cellContent: { base: 'min-w-0 w-full truncate' },
      }}
    >
      {#snippet rowActions({ row })}
        <Button size="small" variant="ghost" squared prefix={arrowsOutSimpleIcon} label="Open the row" onclick={() => (editing = { row })} />
      {/snippet}

      {#snippet cell({ row, columnId })}
        {@const field = fieldsByName.get(columnId)}
        {@const relation = field ? undefined : model.relations.find(candidate => candidate.name === columnId)}
        {@const value = row[columnId]}
        {#if relation}
          {@const reachable = relatedWhere(model, relation, row) !== undefined}
          {#if !reachable}
            <span class="text-neutral/40">—</span>
          {:else if relation.cardinality === 'many'}
            <Button size="small" variant="ghost" suffix={arrowRightIcon} label="{relation.name} of this row" onclick={() => follow(relation, row)}>
              <span class="tabular-nums">{row._count?.[relation.name] ?? '?'}</span>&nbsp;{relation.targets[0]}
            </Button>
          {:else if relation.owner && heldKey(relation, row).some(held => held === null)}
            <span class="text-neutral/40 italic">null</span>
          {:else}
            <Button size="small" variant="ghost" prefix={linkSimpleIcon} label="{relation.name} of this row" onclick={() => follow(relation, row)}>
              <span class="truncate">{relation.targets[0]}{relation.owner ? ` ${heldKey(relation, row).map(display).join(', ')}` : ''}</span>
            </Button>
          {/if}
        {:else if !field || value === null || value === undefined}
          <span class="text-neutral/40 italic">null</span>
        {:else if field.type === 'enum' && !field.list}
          <Chip size="small" variant="soft">{String(value)}</Chip>
        {:else if field.type === 'boolean' && !field.list}
          <span>{value ? 'true' : 'false'}</span>
        {:else if field.id}
          <span class="font-mono text-[12px] text-neutral/75">{display(value)}</span>
        {:else if NUMERIC.has(field.type)}
          <span class="tabular-nums">{display(value)}</span>
        {:else if field.type === 'datetime'}
          <span class="font-mono text-[12px] tabular-nums">{display(value)}</span>
        {:else}
          <span class={field.list || field.type === 'json' ? 'font-mono text-[12px]' : ''}>{display(value)}</span>
        {/if}
      {/snippet}

      {#snippet empty()}
        <div class="grid justify-items-center gap-3 p-10 text-center">
          <strong>No {model.name} rows yet</strong>
          <Button size="small" variant="outline" prefix={plusIcon} onclick={() => (editing = {})}>Add the first row</Button>
        </div>
      {/snippet}
      {#snippet noResults()}
        <div class="grid justify-items-center gap-3 p-10 text-center">
          <strong>No row matches</strong>
          <p class="m-0 text-neutral/65">Change the filters or the search.</p>
          <Button size="small" variant="outline" onclick={() => (clear(), clearTimeout(typing), (words = ''), api?.setGlobalFilter(''))}>Show every row</Button>
        </div>
      {/snippet}
      {#snippet errorContent({ error })}
        <div class="grid justify-items-center gap-3 p-10 text-center">
          <strong>The rows could not be read</strong>
          <p class="m-0 whitespace-pre-wrap text-neutral/65">{said(error)}</p>
          <Button size="small" variant="outline" onclick={() => load()}>Try again</Button>
        </div>
      {/snippet}
    </DataTable>
  </div>

  <footer class="flex flex-wrap items-center justify-between gap-3 border-t border-neutral/10 px-4 py-2">
    {#if api}
      {@const pagination = api.state.pagination}
      {@const page = Math.min(pagination.page, Math.max(api.totalPages, 1))}
      <div class="flex items-center gap-4 text-[13px]">
        <span class="text-neutral/70 tabular-nums" role="status">{total ? (page - 1) * pagination.pageSize + 1 : 0}–{Math.min(total, page * pagination.pageSize)} of {total}</span>
        <div class="flex items-center gap-2">
          <span class="text-neutral/70">Rows per page</span>
          <div class="w-20"><Select size="small" label="Rows per page" theme={HIDDEN_LABEL} items={PAGE_SIZES} value={String(pagination.pageSize)} onValueChange={value => api?.setPageSize(Number(value))} /></div>
        </div>
      </div>
      {#if api.totalPages > 1}
        <Pagination totalPages={api.totalPages} value={page} size="small" controlVariant="ghost" siblingCount={1} label="Pages of {model.name}" onValueChange={value => api?.setPage(value)} />
      {/if}
    {/if}
  </footer>
</section>

{#if editing}
  {#key editing}
    <RowDrawer {model} row={editing.row} save={saveRow} remove={editing.row && keyed ? removeRow : undefined} close={() => (editing = undefined)} />
  {/key}
{/if}
