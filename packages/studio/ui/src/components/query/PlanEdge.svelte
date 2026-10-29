<script lang="ts">
import {
  BaseEdge,
  type Edge,
  EdgeLabel,
  type EdgeProps,
  getSmoothStepPath,
} from "@xyflow/svelte";
import { compact } from "../../lib/plan-graph";

// The rows an operation hands the one above it: a line from its card up to its parent's, the thicker the more rows,
// the count on it. A line from an operation the query never reached is dashed.
type FlowData = { rows: number | undefined; never: boolean };
const {
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<FlowData>> = $props();

const geometry = $derived(
  getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
  })
);
const width = $derived(
  1.25 + Math.min(7, Math.log10((data?.rows ?? 0) + 1) * 1.4)
);
</script>

<BaseEdge {id} path={geometry[0]} class={['plan-flow', data?.never && 'never']} style="stroke-width: {width}px" />
{#if data?.rows !== undefined && !data.never}
  <EdgeLabel x={geometry[1]} y={geometry[2]} class="rounded bg-surface px-1 font-mono text-[10px] text-neutral/70 tabular-nums">{compact(data.rows)} rows</EdgeLabel>
{/if}
