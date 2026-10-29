<script lang="ts">
import { Button } from "entasis/button";
import { Chip } from "entasis/chip";
import { DataTable, type DataTableColumn } from "entasis/data-table";
import { caretDownIcon } from "entasis/icons/caretDown";
import { functionIcon } from "entasis/icons/function";
import { linkSimpleIcon } from "entasis/icons/linkSimple";
import type { Attachment } from "svelte/attachments";
import type { StudioField, StudioModel, StudioRelation } from "../../lib/api";
import { TYPE_COLORS, TYPE_ICONS } from "../../lib/icons";
import { computedColumn } from "../../lib/query-builder";
import { TABLE_FOCUS } from "../../lib/table-theme";
import {
  dayText,
  display,
  grouped,
  instantText,
  isReached,
  timeText,
} from "../../lib/values";
import ResultTable from "./ResultTable.svelte";

// What a read answered, as a table of the model's own: each column shown as its type is (an enum a chip, an instant
// in the browser's zone, a number to the right), sorted in place, a relation read with the rows a button that opens
// its rows under the row — a table of the same kind, as deep as the read went — and a group's computed values
// (`_sum: { rating }`) a column each, said as they read ("sum · rating").
let {
  model,
  models,
  result,
  nested = false,
}: {
  /** The model the rows are of; unknown for the rows of a relation that reaches several. */
  model: StudioModel | undefined;
  models: readonly StudioModel[];
  result: unknown;
  /** Under another row: no header kept in view, a frame of its own. */
  nested?: boolean;
} = $props();

type Row = Record<string, unknown>;
type Kind = "field" | "relation" | "computed" | "value";
interface Column {
  id: string;
  label: string;
  kind: Kind;
  field?: StudioField;
  relation?: StudioRelation;
  /** A computed value read as a number; else as its `field` (the extreme of an instant is an instant). */
  numeric?: boolean;
}

const NUMERIC = new Set(["int", "number", "decimal", "bigint"]);
const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The rows: one answer is one row, a value a row of its own, a computed object a column per value. */
const rows = $derived.by<Row[]>(() => {
  const list = Array.isArray(result)
    ? result
    : result === null || result === undefined
      ? []
      : [result];
  return list.map((entry) => {
    if (!isRecord(entry)) return { value: entry };
    const row: Row = {};
    for (const [key, value] of Object.entries(entry)) {
      const relation = model?.relations.some(
        (candidate) => candidate.name === key
      );
      if (key.startsWith("_") && !relation && isRecord(value)) {
        for (const [inner, held] of Object.entries(value))
          row[`${key}.${inner}`] = held;
      } else row[key] = value;
    }
    return row;
  });
});

const described = $derived.by<Column[]>(() => {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return keys.map((id) => {
    const field = model?.fields.find((candidate) => candidate.name === id);
    if (field) return { id, label: id, kind: "field", field };
    const relation = model?.relations.find(
      (candidate) => candidate.name === id
    );
    if (relation) return { id, label: id, kind: "relation", relation };
    const computed = computedColumn(model, id);
    if (computed) return { id, kind: "computed", ...computed };
    return { id, label: id, kind: "value" };
  });
});
const byId = $derived(new Map(described.map((column) => [column.id, column])));

/** Wide enough for its header (its icon, its name, its sort mark) and for what its type holds. */
const widthOf = (column: Column) =>
  Math.max(typeWidth(column), Math.round(column.label.length * 8.5) + 64);
function typeWidth(column: Column): number {
  if (column.kind === "relation") return 150;
  if (column.kind === "computed" && column.numeric) return 130;
  const type = column.field?.type;
  if (column.field?.id) return 110;
  if (type && NUMERIC.has(type)) return 130;
  if (type === "boolean") return 90;
  if (type === "datetime") return 170;
  if (type === "date" || type === "time" || type === "enum") return 120;
  if (type === "json" || column.field?.list) return 220;
  return 200;
}

const isNumber = (column: Column) =>
  column.numeric === true ||
  (column.kind === "field" &&
    column.field !== undefined &&
    NUMERIC.has(column.field.type) &&
    !column.field.list);

const columns = $derived<DataTableColumn<Row>[]>(
  described.map((column) => ({
    id: column.id,
    header: column.label,
    accessor: (row: Row) => row[column.id],
    sortable: column.kind !== "relation" && column.field?.type !== "json",
    resizable: true,
    width: widthOf(column),
    ...(isNumber(column)
      ? { align: "end" as const, class: "tabular-nums" }
      : {}),
  }))
);

/** Rows of one model a relation holds: all of them, or one variant's of a polymorphic relation. */
interface Group {
  /** The variant, for a polymorphic relation. */
  variant?: string;
  model: StudioModel | undefined;
  rows: Row[];
}

const modelNamed = (name: string | undefined) =>
  models.find((candidate) => candidate.name === name);

/**
 * What a relation holds on a row: its rows (one, several, none), by the model they are of. A polymorphic
 * relation's entries are `{ type, data }`: the variant names its model (`article` may be a `post`), and its rows
 * are the data, read as that model's (their own relations included).
 */
function related(row: Row, relation: StudioRelation) {
  const value = row[relation.name];
  const many = Array.isArray(value);
  const entries = many
    ? value
    : value === null || value === undefined
      ? []
      : [value];
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const variant =
      relation.variants && isReached(entry)
        ? relation.variants.find((candidate) => candidate.name === entry.type)
        : undefined;
    const key = variant?.name ?? "";
    const group = groups.get(key) ?? {
      ...(variant ? { variant: variant.name } : {}),
      model: modelNamed(
        variant?.target ??
          (relation.targets.length === 1 ? relation.targets[0] : undefined)
      ),
      rows: [],
    };
    const data = variant && isReached(entry) ? entry.data : entry;
    group.rows.push(isRecord(data) ? data : { value: data });
    groups.set(key, group);
  }
  return { many, count: entries.length, groups: [...groups.values()] };
}

const relationColumns = $derived(
  described.filter((column) => column.kind === "relation")
);
/** The first relation that holds rows on a row: the one its expander opens. */
const firstHeld = (row: Row) =>
  relationColumns.find((column) => related(row, column.relation!).count > 0)
    ?.id;
const holds = (row: Row) => firstHeld(row) !== undefined;

/** The relation shown under each row opened, by its place; else the first that holds rows. */
let opened = $state<Record<string, string>>({});
const shownOf = (row: Row, rowId: string) => opened[rowId] ?? firstHeld(row);
function open(
  row: Row,
  rowId: string,
  relation: string,
  expanded: boolean,
  toggle: () => void
) {
  const shown = shownOf(row, rowId);
  opened = { ...opened, [rowId]: relation };
  if (!expanded || shown === relation) toggle();
}

/** A row reached by a to-one relation, said by its variant or its model, and its key's value. */
function reachedLabel(group: Group): string {
  const data = group.rows[0] ?? {};
  const name = group.variant ?? group.model?.name ?? "row";
  const key = group.model?.key?.fields.map((field) => data[field]) ?? [];
  return key.length && key.every((part) => part !== undefined)
    ? `${name} ${key.map(display).join(", ")}`
    : name;
}

/** As wide as the table around shows, whatever its scroll: the rows under a row scroll on their own, inside. */
const fitView: Attachment<HTMLElement> = (element) => {
  const viewport = element.parentElement?.closest<HTMLElement>(
    "[data-scroll-area-viewport]"
  );
  if (!viewport) return;
  const measure = () => {
    element.style.width = `${viewport.clientWidth}px`;
  };
  measure();
  const resized = new ResizeObserver(measure);
  resized.observe(viewport);
  return () => resized.disconnect();
};

const FRAMED = $derived(
  nested
    ? { root: { base: "gap-0" }, viewport: { base: "rounded-md" } }
    : { root: { base: "gap-0" } }
);
</script>

{#snippet value(column: Column | undefined, held: unknown)}
  {@const field = column?.field}
  {#if held === null || held === undefined}
    <span class="text-neutral/40 italic">null</span>
  {:else if column?.kind === 'computed' && column.numeric}
    <span class="font-medium tabular-nums">{grouped(held)}</span>
  {:else if !field || field.list || field.type === 'json'}
    <span class={typeof held === 'object' ? 'font-mono text-[12px]' : ''}>{display(held)}</span>
  {:else if field.type === 'enum'}
    <Chip size="small" variant="soft">{String(held)}</Chip>
  {:else if field.type === 'boolean'}
    <span class={held ? 'text-success' : 'text-neutral/55'}>{held ? '✓ true' : '✗ false'}</span>
  {:else if field.id}
    <span class="font-mono text-[12px] text-neutral/75">{display(held)}</span>
  {:else if NUMERIC.has(field.type)}
    <span class={['tabular-nums', column?.kind === 'computed' && 'font-medium']}>{grouped(held)}</span>
  {:else if field.type === 'datetime'}
    <span class="font-mono text-[12px] tabular-nums" title="{String(held)} (UTC)">{instantText(held)}</span>
  {:else if field.type === 'date'}
    <span class="font-mono text-[12px] tabular-nums">{dayText(held)}</span>
  {:else if field.type === 'time'}
    <span class="font-mono text-[12px] tabular-nums">{timeText(held)}</span>
  {:else}
    <span>{display(held)}</span>
  {/if}
{/snippet}

<div class={nested ? 'p-3 pl-10' : 'min-h-0'}>
  <DataTable
    items={rows}
    {columns}
    getRowId={(_row, index) => String(index)}
    density="compact"
    stickyHeader={!nested}
    pagination={false}
    canExpand={holds}
    theme={{
      ...FRAMED,
      ...TABLE_FOCUS,
      cellContent: { base: 'min-w-0 w-full truncate' },
      detailRow: { base: 'grid min-w-full border-b border-neutral-muted bg-surface-recessed' },
      detailCell: { base: 'min-w-0 overflow-visible p-0', density: { compact: 'p-0', normal: 'p-0', comfortable: 'p-0' } },
    }}
  >
    <!-- Each column's type, or a function for a value computed, before its name. -->
    {#snippet header({ column, renderDefault })}
      {@const described = byId.get(column.id)}
      <span class="inline-flex min-w-0 items-center gap-1.5">
        {#if described?.field}
          <span class={["inline-flex shrink-0", TYPE_COLORS[described.field.type]]}>{@render TYPE_ICONS[described.field.type]({ size: 12 })}</span>
        {:else if described?.kind === 'computed'}
          <span class="inline-flex shrink-0 text-primary/70">{@render functionIcon({ size: 12 })}</span>
        {:else if described?.kind === 'relation'}
          <span class="inline-flex shrink-0 text-neutral/45">{@render linkSimpleIcon({ size: 12 })}</span>
        {/if}
        {@render renderDefault()}
      </span>
    {/snippet}

    {#snippet cell({ row, columnId, rowId, expanded, toggleExpanded })}
      {@const column = byId.get(columnId)}
      {#if column?.relation}
        {@const holding = related(row, column.relation)}
        {@const active = expanded && shownOf(row, rowId) === columnId}
        {#if holding.many}
          <Button size="small" variant={active ? 'soft' : 'ghost'} suffix={caretDownIcon} disabled={holding.count === 0} label="{columnId} of this row" onclick={() => open(row, rowId, columnId, expanded, toggleExpanded)}>
            <span class="tabular-nums">{holding.count}</span>&nbsp;{holding.count === 1 ? (holding.groups[0]?.variant ?? holding.groups[0]?.model?.name ?? 'row') : columnId}
          </Button>
        {:else if holding.count === 0}
          <span class="text-neutral/40 italic">none</span>
        {:else}
          <Button size="small" variant={active ? 'soft' : 'ghost'} prefix={linkSimpleIcon} label="{columnId} of this row" onclick={() => open(row, rowId, columnId, expanded, toggleExpanded)}>
            <span class="truncate">{reachedLabel(holding.groups[0]!)}</span>
          </Button>
        {/if}
      {:else}
        {@render value(column, row[columnId])}
      {/if}
    {/snippet}

    <!-- A relation's rows under their row: a button per relation the row holds, then their table. -->
    {#snippet expandedContent({ row, rowId })}
      {@const shown = relationColumns.find(column => column.id === shownOf(row, rowId))}
      <div class="sticky left-0 grid gap-2" {@attach fitView}>
        {#if relationColumns.length > 1}
          <div class="flex flex-wrap gap-1 px-3 pt-3 pl-10">
            {#each relationColumns as column (column.id)}
              {@const holding = related(row, column.relation!)}
              <Button size="small" variant={shown?.id === column.id ? 'soft' : 'ghost'} disabled={holding.count === 0} onclick={() => (opened = { ...opened, [rowId]: column.id })}>
                {column.id}&nbsp;<span class="tabular-nums text-neutral/55">{holding.count}</span>
              </Button>
            {/each}
          </div>
        {/if}
        {#if shown}
          <!-- A polymorphic relation's rows, a table per variant, each read as its own model's. -->
          {#each related(row, shown.relation!).groups as group (group.variant ?? '')}
            {#if group.variant}
              <span class="px-3 pt-1 pl-10 text-[12px] text-neutral/60"><span class="font-medium text-neutral">{group.variant}</span>{group.model && group.model.name !== group.variant ? ` (${group.model.name})` : ''} · {group.rows.length}</span>
            {/if}
            <ResultTable model={group.model} {models} result={group.rows} nested />
          {/each}
        {/if}
      </div>
    {/snippet}

    {#snippet empty()}
      <p class="m-0 p-6 text-center text-[13px] text-neutral/60">No row.</p>
    {/snippet}
  </DataTable>
</div>
