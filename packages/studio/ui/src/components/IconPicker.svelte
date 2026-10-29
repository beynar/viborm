<script lang="ts">
import { magnifyingGlassIcon } from "entasis/icons/magnifyingGlass";
import { TextInput } from "entasis/text-input";
import { ICON_RULES, MODEL_ICONS, type ModelIcon } from "../../../src/icons";
import { MODEL_ICON } from "../lib/model-icons";

// The icons a saved view or query may be shown with, found by their name or by the words that call for them
// (`money`, `invoice`, `team`): a grid to choose one from, the one chosen marked.
let {
  value,
  onValueChange,
}: {
  value: ModelIcon | undefined;
  onValueChange: (icon: ModelIcon) => void;
} = $props();

const HIDDEN_LABEL = {
  header: { base: "!absolute sr-only" },
  label: { base: "sr-only" },
};
/** Each icon's name and the words that call for it, to search. */
const WORDS = new Map<ModelIcon, string>(
  MODEL_ICONS.map((icon) => [
    icon,
    `${icon.toLowerCase()} ${ICON_RULES.find(([named]) => named === icon)?.[1].replaceAll("|", " ") ?? ""}`,
  ])
);

const SPACES = /\s+/;
let search = $state("");
const shown = $derived.by(() => {
  const words = search.trim().toLowerCase().split(SPACES).filter(Boolean);
  return words.length
    ? MODEL_ICONS.filter((icon) =>
        words.every((word) => WORDS.get(icon)?.includes(word))
      )
    : MODEL_ICONS;
});
</script>

<div class="grid gap-2">
  <TextInput size="small" label="Find an icon" theme={HIDDEN_LABEL} placeholder="Find an icon: money, team, invoice…" prefix={magnifyingGlassIcon} value={search} onValueChange={next => (search = next ?? '')} />
  <div class="grid max-h-56 grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-1 overflow-auto p-0.5" role="listbox" aria-label="Icons">
    {#each shown as icon (icon)}
      <button type="button" role="option" aria-selected={value === icon} title={icon} class={['grid size-8 place-items-center rounded-md text-neutral/75 hover:bg-neutral-muted hover:text-neutral focus-visible:outline-2 focus-visible:outline-primary', value === icon && 'bg-primary/15 text-primary ring-1 ring-primary/50']} onclick={() => onValueChange(icon)}>
        {@render MODEL_ICON[icon]({ size: 16 })}
      </button>
    {:else}
      <p class="col-span-full m-0 p-2 text-[12px] text-neutral/60">No icon for “{search}”.</p>
    {/each}
  </div>
</div>
