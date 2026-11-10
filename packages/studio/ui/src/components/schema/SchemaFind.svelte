<script lang="ts">
import { Panel, useSvelteFlow } from "@xyflow/svelte";
import { Combobox } from "entasis/combobox";
import { prefersReducedMotion } from "svelte/motion";
import type { StudioSchema } from "../../lib/api";
import { useFocus } from "./focus.svelte";

// A model found by name, in the diagram's corner: chosen (its lines lit, the rest faded) and brought into view.
// Drawn inside the canvas, where `useSvelteFlow` finds the store it moves.
let { schema }: { schema: StudioSchema } = $props();
const flow = useSvelteFlow();
const focus = useFocus();
const HIDDEN_LABEL = {
  header: { base: "!absolute sr-only" },
  label: { base: "sr-only" },
};
let value = $state<string | null>(null);
const items = $derived(
  schema.models.map((model) => ({
    value: model.name,
    label: model.name,
    ...(model.table === model.name ? {} : { description: model.table }),
  }))
);

function find(name: string | null) {
  value = null;
  if (!name) return;
  // Chosen, even when it already was: finding a model never lets it go.
  focus.model = name;
  focus.relation = undefined;
  flow.fitView({
    nodes: [{ id: name }],
    padding: 0.6,
    maxZoom: 1,
    duration: prefersReducedMotion.current ? 0 : 320,
  });
}
</script>

<Panel position="top-left">
  <div class="w-56 rounded-lg bg-surface">
    <Combobox size="small" label="Find a model" theme={HIDDEN_LABEL} {items} placeholder="Find a model…" noOptionsText="No model of that name" bind:value onValueChange={({ value: name }) => find(name)} />
  </div>
</Panel>
