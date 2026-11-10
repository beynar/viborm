<script lang="ts">
import { Button } from "entasis/button";
import {
  Combobox,
  type ComboboxItemsRequest,
  type ComboboxOption,
} from "entasis/combobox";
import { caretDownIcon } from "entasis/icons/caretDown";
import { checkIcon } from "entasis/icons/check";
import { xIcon } from "entasis/icons/x";
import { rowChoices, type StudioModel } from "../../lib/api";

let {
  label,
  target,
  reference,
  nullable,
  value,
  onSelect,
}: {
  label: string;
  target: StudioModel;
  reference: string;
  nullable: boolean;
  value: string | null;
  onSelect: (value: string | null) => void;
} = $props();

let search = $state("");
let resolvedSearch = $state<string>();
const choices = $derived(rowChoices(target, reference));

async function options(
  words: string | undefined,
  { signal }: ComboboxItemsRequest
) {
  const result = await choices(words);
  if (!signal.aborted) resolvedSearch = words ?? "";
  // The cell displays the stored key; the menu describes the row it points to.
  return result.map((option) => ({
    ...option,
    label: option.value,
    description: option.label,
    data: { search: words ?? "" },
  }));
}

function guardSearch(event: KeyboardEvent) {
  // The combobox retains old results while its debounced search runs.
  if (event.key === "Enter" && search !== resolvedSearch) {
    event.preventDefault();
    event.stopPropagation();
  }
}
</script>

{#snippet optionRow(option: ComboboxOption)}
  <div class="flex min-w-0 flex-1 items-center gap-3">
    <div class="grid min-w-0 flex-1 text-left">
      <span class="truncate">{option.description}</span>
      <span class="truncate font-mono text-xs text-neutral/55">{target.name}.{reference}: {option.value}</span>
    </div>
    {#if option.value === value}
      <span class="shrink-0">{@render checkIcon({ size: 14 })}<span class="sr-only">Current value</span></span>
    {/if}
  </div>
{/snippet}

{#snippet actions()}
  {#if nullable && value !== null}
    <Button size="small" variant="ghost" squared prefix={xIcon} label="Set {label} to null" onclick={() => onSelect(null)} />
  {:else}
    <span class="pointer-events-none text-neutral/55" aria-hidden="true">{@render caretDownIcon({ size: 12 })}</span>
  {/if}
{/snippet}

<div class="min-w-0 w-full" onkeydowncapture={guardSearch}>
  <Combobox
    size="small"
    {label}
    theme={{
      header: { base: '!absolute sr-only' },
      label: { base: 'sr-only' },
      inputContainer: { base: 'rounded-none border-0 bg-transparent px-1.5 shadow-none focus-within:ring-0' },
      input: { base: 'font-mono tabular-nums' },
    }}
    prefix={false}
    suffix={actions}
    items={options}
    item={optionRow}
    openOnFocus
    placeholder="Search…"
    loadingText="Searching…"
    noOptionsText="No {target.name} row matches"
    {value}
    bind:searchValue={search}
    getValueOption={key => ({ value: key, label: key })}
    onValueChange={({ value: next, option }) => {
      if (option?.data?.search === search && next !== null) onSelect(next)
    }}
  />
</div>
