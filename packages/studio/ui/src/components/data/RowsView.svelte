<script lang="ts">
import { Button } from "entasis/button";
import { Chip } from "entasis/chip";
import { Combobox } from "entasis/combobox";
import { confirmation } from "entasis/confirmation";
import {
  createDataTableState,
  DataTable,
  type DataTableApi,
  type DataTableCellCommit,
  type DataTableColumn,
  type DataTableEditor,
  type DataTableEditorPayload,
  type DataTableState,
} from "entasis/data-table";
import { arrowsClockwiseIcon } from "entasis/icons/arrowsClockwise";
import { arrowsOutSimpleIcon } from "entasis/icons/arrowsOutSimple";
import { bookmarkSimpleIcon } from "entasis/icons/bookmarkSimple";
import { caretDownIcon } from "entasis/icons/caretDown";
import { downloadSimpleIcon } from "entasis/icons/downloadSimple";
import { funnelIcon } from "entasis/icons/funnel";
import { linkSimpleIcon } from "entasis/icons/linkSimple";
import { magnifyingGlassIcon } from "entasis/icons/magnifyingGlass";
import { plusIcon } from "entasis/icons/plus";
import { trashIcon } from "entasis/icons/trash";
import { xIcon } from "entasis/icons/x";
import { type PageShellApi, setPageShell } from "entasis/page-shell";
import { Pagination } from "entasis/pagination";
import { Popover } from "entasis/popover";
import { Select } from "entasis/select";
import { TextInput } from "entasis/text-input";
import { toast } from "entasis/toast";
import { untrack } from "svelte";
import {
  createRow,
  deleteRow,
  exportRows,
  foreignKeyOf,
  keyOf,
  type Row,
  readRows,
  rowChoices,
  type Scope,
  type StudioField,
  type StudioModel,
  type StudioRelation,
  updateRow,
  type Where,
} from "../../lib/api";
import { fillPage } from "../../lib/fill";
import {
  type Condition,
  conditionWhere,
  display,
  editable,
  isReached,
  reachedText,
  relatedScopes,
  written,
} from "../../lib/values";
import type { SavedView, ViewState, Views } from "../../lib/views.svelte";
import FilterGroup from "./FilterGroup.svelte";
import RelatedRows from "./RelatedRows.svelte";
import RowDrawer from "./RowDrawer.svelte";

// One model's rows, explored as in Pyxel's `TableStudio`: a page at a time, found by words in its text columns,
// filtered by conditions, sorted by its headers, each cell changed by an editor of its type, rows added and removed.
// Everything is read and written through the application's client (`/api`): the table shows only what it answered.
let {
  model,
  models,
  readonly = false,
  scope,
  view,
  views,
  openView,
  navigate,
}: {
  model: StudioModel;
  models: readonly StudioModel[];
  /** The studio does not write: no editor, no add, no delete. */
  readonly?: boolean;
  scope?: Scope;
  /** The saved view the page opens with: its filter, search, order, page size and widths. */
  view?: SavedView;
  views: Views;
  openView: (view: SavedView) => void;
  navigate: (model: string, scope?: Scope) => void;
} = $props();
/** The view as the page opened it: the page starts from it, then the member changes what they like. */
const initial = untrack(() => view);

// The label is read by assistive technology only: its header leaves the layout too, so no empty row spaces the control.
const HIDDEN_LABEL = {
  header: { base: "!absolute sr-only" },
  label: { base: "sr-only" },
};
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
    const type = columns.find((column) => column.id === columnId)?.editor?.type;
    // The foreign-key picker (custom) is released on Escape only: Enter and a
    // click on one of its options are its own to handle.
    const released =
      type === "text" ||
      (type === "custom" &&
        event instanceof KeyboardEvent &&
        event.key === "Escape");
    if (!(group && released)) return;
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
let words = $state(initial?.search ?? "");
let typing: ReturnType<typeof setTimeout> | undefined;
function search(value: string | null) {
  words = value ?? "";
  clearTimeout(typing);
  typing = setTimeout(() => api?.setGlobalFilter(words), 300);
}

/** The filter being written, and the one the rows answer: written is not applied until « Apply ». */
let conditions = $state<Condition[]>(
  initial ? ($state.snapshot(initial.conditions) as Condition[]) : []
);
let combinator = $state<"AND" | "OR">(initial?.combinator ?? "AND");
let applied = $state.raw<Where>();
let appliedCount = $state(0);
/** The conditions the rows answer, as a view saves them (the ones being written may not be applied yet). */
let appliedConditions = $state.raw<readonly Condition[]>([]);
let appliedCombinator = $state<"AND" | "OR">("AND");

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

/** Every row the page's filter, search and order reach, downloaded as a file. */
async function download(format: "csv" | "json") {
  const { skip: _skip, take: _take, ...reach } = query;
  try {
    await exportRows(model.name, reach, format);
  } catch (error) {
    toast.danger({
      title: "The rows could not be exported",
      description: said(error),
    });
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
    appliedConditions = $state.snapshot(conditions);
    appliedCombinator = combinator;
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
  appliedConditions = [];
  firstPage();
}

function editor(field: StudioField): DataTableEditor<Row> | undefined {
  if (readonly || !keyed || (field.id && field.generated)) return undefined;
  if (foreignKeyOf(model, models, field))
    return { type: "custom", render: keyPicker };
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

// A view opens the table as it was saved: its order, page size and widths, its search, then its filter applied.
if (initial) {
  tableState = createDataTableState(
    untrack(() => columns),
    {
      sorting: initial.sorting.map((sort) => ({ ...sort })),
      globalFilter: initial.search,
      columnSizing: { ...initial.columnSizing },
    },
    initial.pageSize
  );
  if (initial.conditions.length) apply();
}

/** The table as a view saves it, now. */
function stateOf(): ViewState {
  return {
    ...(scope ? { scope } : {}),
    conditions: appliedConditions,
    combinator: appliedCombinator,
    search: words.trim(),
    sorting: (tableState?.sorting ?? []).map(({ id, desc }) => ({ id, desc })),
    pageSize: tableState?.pagination.pageSize ?? 50,
    columnSizing: { ...tableState?.columnSizing },
  };
}
/** The open view no longer says what the table shows: its filter, search, order, size or widths changed. */
const unsaved = $derived.by(() => {
  if (!view) return false;
  const { id: _id, name: _name, model: _model, ...saved } = view;
  return (
    JSON.stringify(stateOf()) !==
    JSON.stringify({ ...saved, ...(scope ? { scope } : {}) })
  );
});
let viewName = $state(untrack(() => view?.name ?? ""));
function saveView(asNew: boolean, close: () => void) {
  const name = viewName.trim();
  if (!name) return;
  if (view && !asNew) {
    views.update(view.id, name, stateOf());
    toast.success({ title: `The view “${name}” was saved` });
  } else {
    openView(views.create(name, model.name, stateOf()));
    toast.success({ title: `The view “${name}” was added to the sidebar` });
  }
  close();
}

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

// A row's related rows open under it (Pyxel's `RelatedRows`): the relation shown, by row; a row opened by a relation's
// cell shows that relation.
let opened = $state<Record<string, string>>({});
const expandableRelations = $derived(model.relations);
const expandable = $derived(keyed && expandableRelations.length > 0);
/** Opens a row's related rows on a relation, or closes them when that relation already shows. */
function openRelated(
  id: string,
  relation: string,
  expanded: boolean,
  toggle: () => void
) {
  const shown = opened[id] ?? expandableRelations[0]?.name;
  opened = { ...opened, [id]: relation };
  if (!expanded || shown === relation) toggle();
}

const heldKey = (relation: StudioRelation, row: Row) =>
  relation.fields.map((field) => row[field]);

// The page's header and footer are the page shell's: this page fills them. The shell may render them once more
// as the page leaves, after the route moved on: they read the model the page opened with, which a page keeps
// (App keys a page on its route).
const pageModel = untrack(() => model);
setPageShell({ title, subtitle, headerActions: controls, footer: pages });
</script>

<!-- The page's header: the model, its rows, the relation followed here; then what changes the rows. -->
{#snippet title(_page: PageShellApi)}
  <span class="inline-flex items-center gap-2">
    {pageModel.name}
    {#if view}
      <Chip size="small" variant="soft">{view.name}</Chip>
    {/if}
    {#if scope && !view}
      <Chip size="small" variant="soft">{scope.label}</Chip>
      <Button size="small" variant="ghost" squared label="Show every {pageModel.name} row" prefix={xIcon} onclick={() => navigate(pageModel.name)} />
    {/if}
  </span>
{/snippet}

{#snippet subtitle(_page: PageShellApi)}
  {total} {total === 1 ? 'row' : 'rows'} · {pageModel.table}
{/snippet}

{#snippet controls(_page: PageShellApi)}
  <div class="flex flex-wrap items-center gap-2">
    {#if readonly}
      <Chip size="small" variant="soft">Read-only</Chip>
    {/if}
    {#if selected.length && !readonly}
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
          <FilterGroup model={pageModel} bind:conditions bind:combinator />
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
    <!-- The table as it is, saved as a view in the sidebar; an open view is saved again, renamed or copied. -->
    <Popover position="bottom-end" focusOnOpen="first" theme={{ popover: { base: 'w-72 p-3' } }}>
      {#snippet trigger(popover)}
        <Button size="small" variant={view ? 'soft' : 'ghost'} squared={!unsaved} prefix={bookmarkSimpleIcon} label={view ? `Save the view ${view.name}` : 'Save as a view'} {@attach popover.trigger}>
          {#if unsaved}<span class="text-[12px]">Unsaved</span>{/if}
        </Button>
      {/snippet}
      {#snippet children(popover)}
        <form class="grid gap-2" onsubmit={event => { event.preventDefault(); saveView(false, popover.close) }}>
          <p class="m-0 text-[12px] text-neutral/60">{view ? 'This view keeps the filter, search, order and page size shown now.' : 'Keep this filter, search, order and page size as a view in the sidebar.'}</p>
          <TextInput size="small" label="The view's name" theme={HIDDEN_LABEL} placeholder="The view's name" value={viewName} onValueChange={value => (viewName = value ?? '')} />
          <div class="flex justify-end gap-2">
            {#if view}<Button size="small" variant="ghost" disabled={!viewName.trim()} onclick={() => saveView(true, popover.close)}>Save as new</Button>{/if}
            <Button size="small" color="primary" type="submit" disabled={!viewName.trim()}>{view ? 'Save view' : 'Save'}</Button>
          </div>
        </form>
      {/snippet}
    </Popover>
    <Popover position="bottom-end">
      {#snippet trigger(popover)}
        <Button size="small" variant="ghost" squared prefix={downloadSimpleIcon} label="Export the rows" {@attach popover.trigger} />
      {/snippet}
      {#snippet children(popover)}
        <div class="grid gap-1">
          <p class="m-0 px-2 pb-1 text-[12px] text-neutral/60">Every row the filter and search reach</p>
          <Button size="small" variant="ghost" onclick={() => (download('csv'), popover.close())}>Export as CSV</Button>
          <Button size="small" variant="ghost" onclick={() => (download('json'), popover.close())}>Export as JSON</Button>
        </div>
      {/snippet}
    </Popover>
    {#if !readonly}
      <Button size="small" color="primary" prefix={plusIcon} onclick={() => (editing = {})}>Add row</Button>
    {/if}
  </div>
{/snippet}

<!-- A foreign key changed in its cell: the rows of the model it points to, found by their text or the value it holds. -->
{#snippet keyPicker({ columnId, draft, setDraft, commit: save }: DataTableEditorPayload<Row>)}
  {@const { target, reference } = foreignKeyOf(model, models, fieldsByName.get(columnId)!)!}
  <Combobox
    size="small"
    label={columnId}
    theme={HIDDEN_LABEL}
    items={rowChoices(target, reference)}
    openOnFocus
    placeholder="A {target.name} row"
    loadingText="Searching…"
    noOptionsText="No {target.name} row matches"
    value={draft === null || draft === undefined || draft === '' ? null : String(draft)}
    getValueOption={value => ({ value, label: `${target.name} ${value}` })}
    onValueChange={({ value }) => {
      setDraft(value ?? null)
      // Saving closes the editor: let go of its focus first (see releaseEditorFocus).
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      save()
    }}
  />
{/snippet}

<!-- The page's footer: which rows show, how many a page holds, and the pages. -->
{#snippet pages(_page: PageShellApi)}
  <div class="flex w-full flex-wrap items-center justify-between gap-3">
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
        <Pagination totalPages={api.totalPages} value={page} size="small" controlVariant="ghost" siblingCount={1} label="Pages of {pageModel.name}" onValueChange={value => api?.setPage(value)} />
      {/if}
    {/if}
  </div>
{/snippet}

<!-- Sized to end at the page's footer, the table scrolls within (`fillPage`). -->
<section bind:this={root} class="relative" aria-label="The rows of {model.name}" {@attach fillPage}>
    <DataTable
      items={rows}
      {columns}
      getRowId={rowId}
      processingMode="manual"
      rowCount={total}
      interactionMode="grid"
      selectionMode={keyed && !readonly ? 'multiple' : 'none'}
      density="compact"
      stickyHeader
      {loading}
      error={failure}
      pagination={{ pageSize: 50, showControls: false }}
      onCellCommit={commit}
      canExpand={() => expandable}
      bind:state={tableState}
      bind:api
      theme={{
        root: { base: 'absolute inset-0 gap-0' },
        viewport: { base: 'min-h-0 flex-1 rounded-none border-0' },
        cellContent: { base: 'min-w-0 w-full truncate' },
        // A row's related rows, on a recessed ground: their own padding, so they stay on the table's left as it
        // scrolls sideways (`sticky`), as wide as the table shows (`RelatedRows`).
        detailRow: { base: 'grid min-w-full border-b border-neutral-muted bg-surface-recessed' },
        detailCell: { base: 'min-w-0 overflow-visible p-0', density: { compact: 'p-0', normal: 'p-0', comfortable: 'p-0' } },
      }}
    >
      {#snippet expandedContent({ row, rowId })}
        <RelatedRows {models} {model} {row} {readonly} active={opened[rowId] ?? expandableRelations[0]?.name ?? ''} onActive={name => (opened = { ...opened, [rowId]: name })} {navigate} onChanged={() => load()} />
      {/snippet}

      {#snippet rowActions({ row })}
        <Button size="small" variant="ghost" squared prefix={arrowsOutSimpleIcon} label="Open the row" onclick={() => (editing = { row })} />
      {/snippet}

      {#snippet cell({ row, columnId, rowId, expanded, toggleExpanded })}
        {@const field = fieldsByName.get(columnId)}
        {@const relation = field ? undefined : model.relations.find(candidate => candidate.name === columnId)}
        {@const value = row[columnId]}
        {#if relation}
          {@const reachable = relatedScopes(model, relation, row) !== undefined}
          {#if !reachable}
            <span class="text-neutral/40">—</span>
          {:else if relation.cardinality === 'many'}
            <Button size="small" variant={expanded && opened[rowId] === relation.name ? 'soft' : 'ghost'} suffix={caretDownIcon} label="{relation.name} of this row" onclick={() => openRelated(rowId, relation.name, expanded, toggleExpanded)}>
              <!-- One row is said by its model, several by the relation's own (plural) name; a polymorphic
                   collection, whose one row may be of any variant, by its name before the count. -->
              {@const count = row._count?.[relation.name]}
              {#if relation.variants}
                {relation.name}&nbsp;<span class="tabular-nums">{count ?? '?'}</span>
              {:else}
                <span class="tabular-nums">{count ?? '?'}</span>&nbsp;{count === 1 ? relation.targets[0] : relation.name}
              {/if}
            </Button>
          {:else}
            <!-- A to-one relation: the key of the row it reaches, or an empty mark when there is none. -->
            {@const reached = row[relation.name] as Row | null | undefined}
            <!-- A polymorphic one says the variant it reached before that row's key. -->
            {@const said = isReached(reached) ? reachedText(reached) : undefined}
            {#if reached === null || (relation.owner && heldKey(relation, row).some(held => held === null))}
              <Button size="small" variant={expanded && opened[rowId] === relation.name ? 'soft' : 'ghost'} label="{relation.name} of this row: none" onclick={() => openRelated(rowId, relation.name, expanded, toggleExpanded)}>
                <span class="text-neutral/40 italic">none</span>
              </Button>
            {:else}
              <Button size="small" variant={expanded && opened[rowId] === relation.name ? 'soft' : 'ghost'} prefix={linkSimpleIcon} label="{relation.name} of this row" onclick={() => openRelated(rowId, relation.name, expanded, toggleExpanded)}>
                <span class="truncate">{said ?? `${relation.targets[0]} ${(reached ? Object.values(reached) : heldKey(relation, row)).map(display).join(', ')}`}</span>
              </Button>
            {/if}
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
          {#if !readonly}
            <Button size="small" variant="outline" prefix={plusIcon} onclick={() => (editing = {})}>Add the first row</Button>
          {/if}
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
</section>

{#if editing}
  {#key editing}
    <RowDrawer {model} {models} {readonly} row={editing.row} save={saveRow} remove={editing.row && keyed ? removeRow : undefined} close={() => (editing = undefined)} />
  {/key}
{/if}
