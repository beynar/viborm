<script lang="ts">
import {
  type FitViewOptions,
  Panel,
  useNodesInitialized,
  useStore,
  useSvelteFlow,
} from "@xyflow/svelte";
import { prefersReducedMotion } from "svelte/motion";
import Icon from "../Icon.svelte";

// The diagram's zoom, in its corner. Drawn inside the canvas: `useSvelteFlow` takes its commands from the store it
// finds when it is called. And the whole diagram in view each time the canvas takes a new size: on load, once its
// cards are measured, and when the window resizes. `fitView` alone fitted the canvas it found as the page mounted,
// before the frame had laid it out.
const { fit }: { fit: FitViewOptions } = $props();
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
  <div class="zoom">
    <button class="icon" title="Zoom in" aria-label="Zoom in" onclick={() => flow.zoomIn({ duration: duration() })}><Icon name="zoomIn" /></button>
    <button class="icon" title="Zoom out" aria-label="Zoom out" onclick={() => flow.zoomOut({ duration: duration() })}><Icon name="zoomOut" /></button>
    <button class="icon" title="Fit" aria-label="Fit the whole schema" onclick={() => flow.fitView({ ...fit, duration: duration() })}><Icon name="fit" /></button>
  </div>
</Panel>

<style>
  .zoom { display: flex; flex-direction: column; gap: 4px; padding: 4px; border: 1px solid var(--border); border-radius: 12px; background: var(--color-surface); }
</style>
