<script lang="ts">
import {
  BaseEdge,
  type Edge,
  EdgeLabel,
  type EdgeProps,
  getSmoothStepPath,
  Position,
} from "@xyflow/svelte";
import { CARD_WIDTH, type Link } from "../../lib/diagram";

// A relation: a stepped line from the columns that hold a key to the key they point to (a many-to-many joins the
// two relations), each end drawn in crow's foot notation (`SchemaMarkers`).
type RelationData = { link: Link; markers: string };
const {
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<Edge<RelationData>> = $props();

/**
 * A line that spans more than the gap between two columns turns in the gap beside the card it points to, not
 * halfway: halfway would be the middle of the column between them, behind its cards.
 */
const centerX = $derived(
  Math.abs(targetX - sourceX) > CARD_WIDTH * 1.5
    ? targetX + (targetPosition === Position.Right ? 36 : -36)
    : undefined
);
const geometry = $derived(
  getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
    offset: 24,
    ...(centerX === undefined ? {} : { centerX }),
  })
);
const edge = $derived(data?.link.edge);
</script>

<BaseEdge
  {id}
  path={geometry[0]}
  class={edge?.kind}
  markerStart={edge ? `url(#${data!.markers}-${edge.fromEnd})` : undefined}
  markerEnd={edge ? `url(#${data!.markers}-${edge.toEnd})` : undefined}
/>
{#if edge?.junction}
  <EdgeLabel x={geometry[1]} y={geometry[2]}>
    <span class="junction" title="Junction table">{edge.junction}</span>
  </EdgeLabel>
{/if}

<style>
  .junction {
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--color-surface);
    font: 10px var(--mono);
    color: var(--muted);
  }
</style>
