<script lang="ts">
import { Button } from "entasis/button";
import { plusIcon } from "entasis/icons/plus";
import { xIcon } from "entasis/icons/x";
import { Select } from "entasis/select";
import { TextInput } from "entasis/text-input";
import type { StudioModel } from "../../lib/api";
import {
  type Condition,
  OPERATOR_LABELS,
  type Operator,
  operatorsOf,
} from "../../lib/values";

// The conditions being written, each a column, a comparison and a value, joined by AND or OR (Pyxel's `FilterGroup`,
// one level). They reach the client only when applied: a half-written value is never sent.
let {
  model,
  conditions = $bindable(),
  combinator = $bindable(),
}: {
  model: StudioModel;
  conditions: Condition[];
  combinator: "AND" | "OR";
} = $props();

const HIDDEN_LABEL = { label: { base: "sr-only" } };
const filterable = $derived(
  model.fields.filter((field) => operatorsOf(field).length > 0)
);
const fieldItems = $derived(
  filterable.map((field) => ({ value: field.name, label: field.name }))
);
const fieldOf = (name: string) =>
  model.fields.find((field) => field.name === name);
let next = 0;

function add() {
  const field = filterable[0];
  if (field)
    conditions = [
      ...conditions,
      {
        id: ++next,
        field: field.name,
        operator: operatorsOf(field)[0]!,
        value: field.type === "boolean" ? "true" : "",
      },
    ];
}
function update(id: number, change: Partial<Condition>) {
  conditions = conditions.map((condition) => {
    if (condition.id !== id) return condition;
    const updated = { ...condition, ...change };
    const field = fieldOf(updated.field);
    // Another column keeps the comparison when it has it, else takes its first.
    if (field && !operatorsOf(field).includes(updated.operator))
      updated.operator = operatorsOf(field)[0]!;
    if (change.field && field?.type === "boolean") updated.value = "true";
    return updated;
  });
}
</script>

<div class="grid gap-2">
  {#if conditions.length === 0}
    <p class="m-0 text-[13px] text-neutral/70">No condition: every row shows.</p>
  {/if}
  {#each conditions as condition, index (condition.id)}
    {@const field = fieldOf(condition.field)}
    {@const operators = field ? operatorsOf(field) : []}
    <div class="flex items-center gap-2">
      <div class="w-14 shrink-0 text-right text-[13px] text-neutral/60">
        {#if index === 0}
          where
        {:else if index === 1}
          <Select size="small" label="Join" theme={HIDDEN_LABEL} items={[{ value: 'AND', label: 'and' }, { value: 'OR', label: 'or' }]} value={combinator} onValueChange={value => (combinator = value === 'OR' ? 'OR' : 'AND')} />
        {:else}
          {combinator.toLowerCase()}
        {/if}
      </div>
      <div class="w-40"><Select size="small" label="Column" theme={HIDDEN_LABEL} items={fieldItems} value={condition.field} onValueChange={value => value && update(condition.id, { field: value })} /></div>
      <div class="w-32"><Select size="small" label="Comparison" theme={HIDDEN_LABEL} items={operators.map(operator => ({ value: operator, label: OPERATOR_LABELS[operator] }))} value={condition.operator} onValueChange={value => value && update(condition.id, { operator: value as Operator })} /></div>
      <div class="min-w-0 flex-1">
        {#if condition.operator === 'isNull' || condition.operator === 'isNotNull'}
          <span></span>
        {:else if field?.type === 'boolean'}
          <Select size="small" label="Value" theme={HIDDEN_LABEL} items={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} value={condition.value} onValueChange={value => update(condition.id, { value: value ?? 'true' })} />
        {:else if field?.type === 'enum' && condition.operator !== 'in'}
          <Select size="small" label="Value" theme={HIDDEN_LABEL} items={(field.enumValues ?? []).map(value => ({ value, label: value }))} value={condition.value} onValueChange={value => update(condition.id, { value: value ?? '' })} />
        {:else}
          <TextInput
            size="small"
            label="Value"
            theme={HIDDEN_LABEL}
            placeholder={condition.operator === 'in' ? 'a, b, c' : field?.type === 'datetime' ? '2026-01-31T12:00:00Z' : 'value'}
            value={condition.value}
            onValueChange={value => update(condition.id, { value: value ?? '' })}
          />
        {/if}
      </div>
      <Button size="small" variant="ghost" squared label="Remove the condition" prefix={xIcon} onclick={() => (conditions = conditions.filter(entry => entry.id !== condition.id))} />
    </div>
  {/each}
  <div><Button size="small" variant="outline" prefix={plusIcon} disabled={filterable.length === 0} onclick={add}>Condition</Button></div>
</div>
