<script lang="ts">
import {
  type FitViewOptions,
  Panel,
  useNodesInitialized,
  useStore,
  useSvelteFlow,
} from "@xyflow/svelte";
import { Button } from "entasis/button";
import { cornersOutIcon } from "entasis/icons/cornersOut";
import { magnifyingGlassMinusIcon } from "entasis/icons/magnifyingGlassMinus";
import { magnifyingGlassPlusIcon } from "entasis/icons/magnifyingGlassPlus";
import { prefersReducedMotion } from "svelte/motion";

// The diagram's zoom, in its corner. Drawn inside the canvas: `useSvelteFlow` takes its commands from the store it
// finds when it is called. And the whole diagram in view each time the canvas takes a new size: on load, once its
// cards are measured, and when the window resizes.
let { fit }: { fit: FitViewOptions } = $props();
const flow = useSvelteFlow();
const store = useStore();
const measured = useNodesInitialized();
const duration = () => (prefersReducedMotion.current ? 0 : 240);

let fitted = "";
$effect(() => {
  const size = `${store.width}x${store.height}`;
  if (
    !measured.current ||
    store.width < 1 ||
    store.height < 1 ||
    size === fitted
  )
    return;
  fitted = size;
  flow.fitView(fit);
});
</script>

<Panel position="bottom-right">
  <div class="flex flex-col gap-1 rounded-xl border border-neutral/10 bg-surface p-1">
    <Button variant="outline" size="small" squared label="Zoom in" prefix={magnifyingGlassPlusIcon} onclick={() => flow.zoomIn({ duration: duration() })} />
    <Button variant="outline" size="small" squared label="Zoom out" prefix={magnifyingGlassMinusIcon} onclick={() => flow.zoomOut({ duration: duration() })} />
    <Button variant="outline" size="small" squared label="Fit the schema" prefix={cornersOutIcon} onclick={() => flow.fitView({ ...fit, duration: duration() })} />
  </div>
</Panel>
