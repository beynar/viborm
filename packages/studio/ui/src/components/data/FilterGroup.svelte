<script lang="ts">
import { Button } from "entasis/button";
import { DateInput } from "entasis/date-input";
import { bracketsRoundIcon } from "entasis/icons/bracketsRound";
import { plusIcon } from "entasis/icons/plus";
import { xIcon } from "entasis/icons/x";
import { NumberInput } from "entasis/number-input";
import { Select } from "entasis/select";
import { TextInput } from "entasis/text-input";
import { TimeInput } from "entasis/time-input";
import type { StudioModel } from "../../lib/api";
import {
  COMBINATORS,
  type Combinator,
  type Condition,
  columnOf,
  dateToDay,
  dayToDate,
  type FilterColumn,
  type FilterEntry,
  filterColumns,
  foldsCase,
  instantOf,
  instantParts,
  isGroup,
  OPERATOR_LABELS,
  type Operator,
  operatorsOf,
  QUANTIFIER_LABELS,
  type Quantifier,
  secondsToTime,
  timeToSeconds,
} from "../../lib/values";
import CaseToggle from "./CaseToggle.svelte";
import FilterGroup from "./FilterGroup.svelte";

// The conditions being written, each a column (the model's, or a related model's through one relation), a
// comparison and a value picked as its type is (a calendar, a time, a number, a choice), and groups of them, joined
// as each group says: all of them, any, or none (`a AND (b OR NOT (c))`). A group is this same component, a level
// down. They reach the client only when applied: a half-written value is never sent.
let {
  model,
  models,
  conditions = $bindable(),
  combinator = $bindable(),
  depth = 0,
  onRemove,
}: {
  model: StudioModel;
  models: readonly StudioModel[];
  conditions: FilterEntry[];
  combinator: Combinator;
  /** How deep the group sits: groups nest two levels down at most. */
  depth?: number;
  /** Removes this group from the one it sits in. */
  onRemove?: () => void;
} = $props();
const MAX_DEPTH = 2;
const joinLabel = $derived(
  COMBINATORS.find((entry) => entry.value === combinator)?.label
);

// The label is read by assistive technology only: its header leaves the layout too, so no empty row spaces the control.
const HIDDEN_LABEL = {
  header: { base: "!absolute sr-only" },
  label: { base: "sr-only" },
};
const columns = $derived(filterColumns(model, models));
const columnItems = $derived.by(() => {
  const groups = new Map<string | undefined, FilterColumn[]>();
  for (const column of columns) {
    const group = relationLabel(column);
    const items = groups.get(group);
    if (items) items.push(column);
    else groups.set(group, [column]);
  }
  return Array.from(groups, ([group, items]) => ({
    label: group ?? model.name,
    items: items.map((column) => ({
      value: column.key,
      label: column.field.name,
    })),
  }));
});
function relationLabel(column: FilterColumn | undefined) {
  const via = column?.via;
  if (!via) return undefined;
  return `${via.relation.name}${via.variant ? ` (${via.variant})` : ""}`;
}
const QUANTIFIERS = (Object.keys(QUANTIFIER_LABELS) as Quantifier[]).map(
  (value) => ({ value, label: QUANTIFIER_LABELS[value] })
);

/** What a condition starts with on a column: its first comparison, a value of its type, and its relation. */
function fresh(
  column: FilterColumn
): Pick<Condition, "operator" | "value" | "via"> {
  const { via } = column;
  return {
    operator: operatorsOf(column.field)[0]!,
    value: column.field.type === "boolean" ? "true" : "",
    ...(via
      ? {
          via: {
            relation: via.relation.name,
            ...(via.variant ? { variant: via.variant } : {}),
            ...(via.relation.cardinality === "many"
              ? { quantifier: "some" as const }
              : {}),
          },
        }
      : {}),
  };
}

/** Past every id the group holds: a saved view brings its conditions with theirs. */
const nextId = () => Math.max(0, ...conditions.map((entry) => entry.id)) + 1;

function add() {
  const column = columns[0];
  if (column)
    conditions = [
      ...conditions,
      { id: nextId(), field: column.key, ...fresh(column) },
    ];
}

/** A group of its own, joined all its conditions at first, holding one to start from. */
function addGroup() {
  const column = columns[0];
  if (!column) return;
  conditions = [
    ...conditions,
    {
      id: nextId(),
      group: true,
      combinator: "AND",
      conditions: [{ id: 1, field: column.key, ...fresh(column) }],
    },
  ];
}

const remove = (id: number) =>
  (conditions = conditions.filter((entry) => entry.id !== id));

function update(id: number, change: Partial<Condition>) {
  conditions = conditions.map((condition) => {
    if (isGroup(condition) || condition.id !== id) return condition;
    if (change.field && change.field !== condition.field) {
      // Another column: its relation, a value of its type, and its own first comparison, unless the member chose
      // one the new column has too.
      const column = columns.find(
        (candidate) => candidate.key === change.field
      );
      if (!column) return condition;
      const before = columnOf(columns, condition)?.field;
      const chosen = before && condition.operator !== operatorsOf(before)[0];
      const { via: _via, ...rest } = condition;
      const next = { ...rest, field: column.key, ...fresh(column) };
      return chosen && operatorsOf(column.field).includes(condition.operator)
        ? { ...next, operator: condition.operator }
        : next;
    }
    return { ...condition, ...change };
  });
}

/** The value as the condition holds it: a day, an instant, a time, a number, all as text. */
const setValue = (id: number, value: string) => update(id, { value });
</script>

<!-- A container query lays each condition out for the room it has: one line in the rows' filter, the value on a
     line of its own in the query's narrower sidebar. -->
<div class="@container grid gap-2">
  <!-- How the group's conditions join; a group says it always, the top only once it is more than one condition. -->
  {#if conditions.length > 1 || combinator !== 'AND' || depth > 0}
    <div class="flex items-center gap-2 text-[13px] text-neutral/70">
      <div class="w-24"><Select size="small" label="Which conditions must hold" theme={HIDDEN_LABEL} items={COMBINATORS} value={combinator} onValueChange={value => (combinator = COMBINATORS.find(entry => entry.value === value)?.value ?? 'AND')} /></div>
      {#if onRemove}
        <div class="ml-auto"><Button size="small" variant="ghost" squared label="Remove the group" prefix={xIcon} onclick={onRemove} /></div>
      {/if}
    </div>
  {/if}
  {#if conditions.length === 0}
    <p class="m-0 text-[13px] text-neutral/70">{depth === 0 ? 'No condition: every row shows.' : 'No condition in this group yet.'}</p>
  {/if}
  {#each conditions as entry, index (entry.id)}
    {#if index > 0}
      <span class="-my-1 w-fit rounded-sm bg-neutral-muted/40 px-1 text-[9px] leading-3 font-semibold tracking-wide text-neutral/70">{joinLabel}</span>
    {/if}
    {#if isGroup(entry)}
      <div class="min-w-0 rounded-md border border-neutral-muted bg-neutral-muted/20 p-2">
        <FilterGroup {model} {models} bind:conditions={entry.conditions} bind:combinator={entry.combinator} depth={depth + 1} onRemove={() => remove(entry.id)} />
      </div>
    {:else}
    {@const condition = entry}
    {@const column = columnOf(columns, condition)}
    {@const field = column?.field}
    {@const operators = field ? operatorsOf(field) : []}
    {@const listed = condition.operator === 'in'}
    <div class="flex flex-wrap items-center gap-2">
      {#if column?.via?.relation.cardinality === 'many'}
        <!-- Through a to-many relation: whether any, every or no related row matches. -->
        <div class="w-[5.5rem] shrink-0"><Select size="small" label="Which related rows" theme={HIDDEN_LABEL} items={QUANTIFIERS} value={condition.via?.quantifier ?? 'some'} onValueChange={value => value && condition.via && update(condition.id, { via: { ...condition.via, quantifier: value as Quantifier } })} /></div>
      {/if}
      {#snippet relationPrefix()}
        <span class="max-w-28 truncate text-neutral/55">{relationLabel(column)} /</span>
      {/snippet}
      <div class="min-w-[8rem] flex-1 @xl:w-48 @xl:flex-none"><Select size="small" label="Column" theme={HIDDEN_LABEL} alignItemWithTrigger={false} prefix={column?.via ? relationPrefix : undefined} triggerAttrs={{ title: condition.field }} items={columnItems} value={condition.field} onValueChange={value => value && update(condition.id, { field: value })} /></div>
      <div class="w-28 shrink-0"><Select size="small" label="Comparison" theme={HIDDEN_LABEL} items={operators.map(operator => ({ value: operator, label: OPERATOR_LABELS[operator] }))} value={condition.operator} onValueChange={value => value && update(condition.id, { operator: value as Operator })} /></div>
      <!-- Last on the line when the value shares it; on the first line when the value takes its own. -->
      <div class="shrink-0 @xl:order-last"><Button size="small" variant="ghost" squared label="Remove the condition" prefix={xIcon} onclick={() => remove(condition.id)} /></div>
      <div class={['flex min-w-0 basis-full items-center gap-2 @xl:basis-0 @xl:flex-1', (condition.operator === 'isNull' || condition.operator === 'isNotNull' || !field) && 'hidden @xl:flex']}>
      <div class="min-w-0 flex-1">
        {#if condition.operator === 'isNull' || condition.operator === 'isNotNull' || !field}
          <span></span>
        {:else if field.type === 'boolean'}
          <Select size="small" label="Value" theme={HIDDEN_LABEL} items={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} value={condition.value} onValueChange={value => setValue(condition.id, value ?? 'true')} />
        {:else if field.type === 'enum' && !listed}
          <Select size="small" label="Value" theme={HIDDEN_LABEL} items={(field.enumValues ?? []).map(value => ({ value, label: value }))} value={condition.value} onValueChange={value => setValue(condition.id, value ?? '')} />
        {:else if field.type === 'date' && !listed && !field.list}
          <DateInput size="small" label="Value" theme={HIDDEN_LABEL} format="yyyy/mm/dd" closeOnSelect value={dayToDate(condition.value)} onValueChange={day => setValue(condition.id, day ? dateToDay(day) : '')} />
        {:else if field.type === 'datetime' && !listed && !field.list}
          {@const parts = instantParts(condition.value)}
          <div class="flex items-center gap-1">
            <div class="min-w-0 flex-1"><DateInput size="small" label="Value, day" theme={HIDDEN_LABEL} format="yyyy/mm/dd" closeOnSelect value={parts?.day ?? null} onValueChange={day => setValue(condition.id, day ? instantOf(day, parts?.seconds ?? 0) : '')} /></div>
            <div class="w-28 shrink-0"><TimeInput size="small" label="Value, time" theme={HIDDEN_LABEL} format="HH:MM:SS" as="secondSinceMidnight" value={parts?.seconds ?? null} onValueChange={seconds => setValue(condition.id, instantOf(parts?.day ?? new Date(), seconds ?? 0))} /></div>
          </div>
        {:else if field.type === 'time' && !listed && !field.list}
          <TimeInput size="small" label="Value" theme={HIDDEN_LABEL} format="HH:MM:SS" as="secondSinceMidnight" value={timeToSeconds(condition.value)} onValueChange={seconds => setValue(condition.id, seconds === null ? '' : secondsToTime(seconds))} />
        {:else if (field.type === 'int' || field.type === 'number') && !listed && !field.list}
          <NumberInput size="small" label="Value" theme={HIDDEN_LABEL} showControls={false} placeholder="value" value={condition.value === '' ? null : Number(condition.value)} onValueChange={value => setValue(condition.id, value === null || value === undefined ? '' : String(value))} />
        {:else}
          <TextInput size="small" label="Value" theme={HIDDEN_LABEL} placeholder={listed ? 'a, b, c' : 'value'} value={condition.value} onValueChange={value => setValue(condition.id, value ?? '')} />
        {/if}
        </div>
        {#if field && foldsCase(field, condition.operator)}
          <CaseToggle value={condition.ignoreCase === true} onValueChange={value => update(condition.id, { ignoreCase: value })} />
        {/if}
      </div>
    </div>
    {/if}
  {/each}
  <div class="flex gap-2">
    <Button size="small" variant="outline" prefix={plusIcon} disabled={columns.length === 0} onclick={add}>Condition</Button>
    {#if depth < MAX_DEPTH}
      <Button size="small" variant="ghost" prefix={bracketsRoundIcon} disabled={columns.length === 0} onclick={addGroup}>Group</Button>
    {/if}
  </div>
</div>
