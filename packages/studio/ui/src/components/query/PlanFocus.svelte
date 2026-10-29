<script lang="ts">
import {
  Panel,
  useNodesInitialized,
  useStore,
  useSvelteFlow,
} from "@xyflow/svelte";
import { Button } from "entasis/button";
import { cornersOutIcon } from "entasis/icons/cornersOut";
import { magnifyingGlassMinusIcon } from "entasis/icons/magnifyingGlassMinus";
import { magnifyingGlassPlusIcon } from "entasis/icons/magnifyingGlassPlus";
import { untrack } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { PLAN_CARD_WIDTH } from "../../lib/plan-graph";

// Fit the measured plan on mount and resize; the reader can zoom in to inspect operations.
let { root }: { root: string } = $props();
const flow = useSvelteFlow();
const store = useStore();
const measured = useNodesInitialized();
const duration = () => (prefersReducedMotion.current ? 0 : 240);

function start(animate = true) {
  const node = flow.getNode(root);
  if (!node) return;
  flow.setViewport(
    {
      x: (store.width - PLAN_CARD_WIDTH) / 2 - node.position.x,
      y: 24 - node.position.y,
      zoom: 1,
    },
    { duration: animate ? duration() : 0 }
  );
}

let placed = "";
$effect(() => {
  const size = `${root}:${store.width}x${store.height}`;
  if (
    !measured.current ||
    store.width < 1 ||
    store.height < 1 ||
    size === placed
  )
    return;
  placed = size;
  untrack(() => flow.fitView({ padding: 0.12, minZoom: 0.01, maxZoom: 1 }));
});
</script>

<Panel position="bottom-left">
  <div class="rounded-md border border-neutral-muted bg-surface/95 px-2 py-1 text-[11px] text-neutral/65">Scroll or drag to pan</div>
</Panel>
<Panel position="bottom-right">
  <div class="flex items-center gap-1 rounded-lg border border-neutral-muted bg-surface p-1 shadow-sm">
    <Button variant="ghost" size="small" onclick={() => start()}>Start · 100%</Button>
    <Button variant="ghost" size="small" squared label="Zoom in" prefix={magnifyingGlassPlusIcon} onclick={() => flow.zoomIn({ duration: duration() })} />
    <Button variant="ghost" size="small" squared label="Zoom out" prefix={magnifyingGlassMinusIcon} onclick={() => flow.zoomOut({ duration: duration() })} />
    <Button variant="ghost" size="small" squared label="Overview of the whole plan" prefix={cornersOutIcon} onclick={() => flow.fitView({ padding: 0.12, minZoom: 0.01, maxZoom: 1, duration: duration() })} />
  </div>
</Panel>
