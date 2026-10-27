<script lang="ts">
import type { StudioModel } from "../../lib/api";
import { type Condition, OPERATOR_LABELS, operatorsOf } from "../../lib/values";
import Icon from "../Icon.svelte";

// The conditions a page is filtered by, each a column, a comparison and a value, joined by AND or OR. They apply
// when the member says so: a half-written value never reaches the client.
let {
  model,
  conditions = $bindable(),
  combinator = $bindable(),
  apply,
}: {
  model: StudioModel;
  conditions: Condition[];
  combinator: "AND" | "OR";
  apply: () => void;
} = $props();

const filterable = $derived(
  model.fields.filter((field) => operatorsOf(field).length > 0)
);
let next = 0;
const fieldOf = (name: string) =>
  model.fields.find((field) => field.name === name);

function add() {
  const field = filterable[0];
  if (!field) return;
  conditions = [
    ...conditions,
    {
      id: ++next,
      field: field.name,
      operator: operatorsOf(field)[0]!,
      value: "",
    },
  ];
}
function remove(id: number) {
  conditions = conditions.filter((condition) => condition.id !== id);
  apply();
}
function changeField(condition: Condition, name: string) {
  const field = fieldOf(name);
  condition.field = name;
  if (field && !operatorsOf(field).includes(condition.operator))
    condition.operator = operatorsOf(field)[0]!;
  conditions = [...conditions];
}
</script>

<form class="filters" onsubmit={event => { event.preventDefault(); apply() }}>
  {#each conditions as condition, index (condition.id)}
    {@const field = fieldOf(condition.field)}
    <div class="condition">
      {#if index === 0}
        <span class="join">where</span>
      {:else if index === 1}
        <select class="join" aria-label="Join conditions with" bind:value={combinator}>
          <option value="AND">and</option>
          <option value="OR">or</option>
        </select>
      {:else}
        <span class="join">{combinator.toLowerCase()}</span>
      {/if}
      <select aria-label="Column" value={condition.field} onchange={event => changeField(condition, event.currentTarget.value)}>
        {#each filterable as option (option.name)}<option value={option.name}>{option.name}</option>{/each}
      </select>
      <select aria-label="Comparison" bind:value={condition.operator}>
        {#each field ? operatorsOf(field) : [] as operator (operator)}<option value={operator}>{OPERATOR_LABELS[operator]}</option>{/each}
      </select>
      {#if condition.operator !== 'isNull' && condition.operator !== 'isNotNull'}
        {#if field?.type === 'boolean'}
          <select aria-label="Value" bind:value={condition.value}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        {:else if field?.type === 'enum' && condition.operator !== 'in'}
          <select aria-label="Value" bind:value={condition.value}>
            {#each field.enumValues ?? [] as value (value)}<option {value}>{value}</option>{/each}
          </select>
        {:else}
          <input
            aria-label="Value"
            placeholder={condition.operator === 'in' ? 'a, b, c' : field?.type === 'datetime' ? '2026-01-31T12:00:00Z' : 'value'}
            bind:value={condition.value}
          />
        {/if}
      {/if}
      <button type="button" class="icon ghost" aria-label="Remove condition" onclick={() => remove(condition.id)}><Icon name="x" /></button>
    </div>
  {/each}
  <div class="actions">
    <button type="button" onclick={add} disabled={filterable.length === 0}><Icon name="plus" />Condition</button>
    {#if conditions.length > 0}
      <button type="submit" class="primary">Apply</button>
      <button type="button" class="ghost" onclick={() => { conditions = []; apply() }}>Clear</button>
    {/if}
  </div>
</form>

<style>
  .filters { display: grid; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--color-surface); }
  .condition { display: flex; gap: 6px; align-items: center; }
  .join { width: 64px; flex: none; color: var(--muted); text-align: right; padding-right: 4px; }
  span.join { padding-right: 12px; }
  .condition input { width: 240px; }
  .actions { display: flex; gap: 6px; padding-left: 70px; }
</style>
