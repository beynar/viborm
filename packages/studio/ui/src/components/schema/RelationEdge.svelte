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
import { useFocus } from "./focus.svelte";

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
const focus = useFocus();
/** Lit with its chosen model or relation, faded with the others. */
const tone = $derived(focus.line(id));
const ends = $derived(tone === "lit" ? `${data?.markers}-lit` : data?.markers);
</script>

<BaseEdge
  {id}
  path={geometry[0]}
  class={[edge?.kind, tone]}
  markerStart={edge ? `url(#${ends}-${edge.fromEnd})` : undefined}
  markerEnd={edge ? `url(#${ends}-${edge.toEnd})` : undefined}
/>
{#if edge?.junction}
  <EdgeLabel x={geometry[1]} y={geometry[2]}>
    <span class={['junction', tone]} title="Junction table">{edge.junction}</span>
  </EdgeLabel>
{/if}

<style>
  :global(.svelte-flow__edge-path.lit) { stroke: var(--color-link); stroke-width: 2.2; }
  :global(.svelte-flow__edge-path) { transition: opacity 160ms ease, stroke 160ms ease; }
  :global(.svelte-flow__edge-path.faded) { opacity: 0.15; }
  .junction.lit { color: var(--color-link); border-color: color-mix(in oklab, var(--color-link) 45%, transparent); }
  .junction.faded { opacity: 0.25; }
  .junction {
    padding: 1px 6px;
    border: 1px solid color-mix(in oklab, var(--color-neutral) 14%, transparent);
    border-radius: 999px;
    background: var(--color-surface);
    font-family: var(--font-mono);
    font-size: 10px;
    color: color-mix(in oklab, var(--color-neutral) 55%, transparent);
  }
</style>
