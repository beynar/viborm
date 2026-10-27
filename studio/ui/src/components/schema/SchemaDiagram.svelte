<script lang="ts">
import "@xyflow/svelte/dist/base.css";
import {
  type ColorMode,
  type Edge,
  type Node,
  SvelteFlow,
} from "@xyflow/svelte";
import { untrack } from "svelte";
import type { StudioSchema } from "../../lib/api";
import {
  CARD_WIDTH,
  END_LABELS,
  handleOf,
  type Link,
  linksOf,
  schemaLayout,
} from "../../lib/diagram";
import RelationEdge from "./RelationEdge.svelte";
import SchemaMarkers from "./SchemaMarkers.svelte";
import SchemaZoom from "./SchemaZoom.svelte";
import TableNode, { type TableData } from "./TableNode.svelte";

// The schema as a diagram (Svelte Flow): a card per model, its columns with their key, their links and their types,
// then its relations; a stepped line per relation, from the columns that hold a key to the key they point to, its
// ends in crow's foot notation. The models pointed to stand on the left. A card moves by hand.
const {
  schema,
  open,
}: { schema: StudioSchema; open: (model: string) => void } = $props();

const uid = $props.id();
const markers = `schema-${uid}`;
const NODE_TYPES = { table: TableNode };
const EDGE_TYPES = { relation: RelationEdge };
/** The whole diagram in view, read at a zoom of one half at least: a large one scrolls rather than shrinks to a mark. */
const FIT = { padding: 0.15, minZoom: 0.5, maxZoom: 1 };
/** No colour mode of Svelte Flow's: its classes would bring its own palette, not the studio's. */
const NO_MODE = "" as ColorMode;

const links = $derived(linksOf(schema));

function laidOut(schema: StudioSchema): Node<TableData>[] {
  const at = schemaLayout(schema);
  const kept = new Map(
    untrack(() => nodes ?? []).map((node) => [node.id, node.position])
  );
  return schema.models.map((model) => ({
    id: model.name,
    type: "table",
    position: kept.get(model.name) ?? at.get(model.name) ?? { x: 0, y: 0 },
    width: CARD_WIDTH,
    deletable: false,
    selectable: false,
    data: {
      model,
      sources: new Set(
        links
          .filter((link) => link.from === model.name)
          .map((link) => link.fromAnchor)
      ),
      targets: new Set(
        links
          .filter((link) => link.to === model.name)
          .map((link) => link.toAnchor)
      ),
      pointing: new Map(
        schema.edges
          .filter(
            (edge) =>
              edge.from.model === model.name && edge.kind !== "many-to-many"
          )
          .flatMap((edge) =>
            edge.from.columns.map((column) => [column, edge.to.model] as const)
          )
      ),
      open,
    },
  }));
}

let nodes = $state.raw<Node<TableData>[]>([]);
nodes = untrack(() => laidOut(schema));
// The schema changed: each card keeps where it was moved, a new one takes its place.
$effect(() => {
  const next = schema;
  nodes = untrack(() => laidOut(next));
});

/** Each line leaves and meets its cards on the sides that face each other; a model pointing to itself loops on its right. */
const edges = $derived.by<Edge<{ link: Link; markers: string }>[]>(() => {
  const x = new Map(nodes.map((node) => [node.id, node.position.x]));
  return links.map((link) => {
    const rightward = (x.get(link.from) ?? 0) <= (x.get(link.to) ?? 0);
    return {
      id: link.id,
      type: "relation",
      source: link.from,
      target: link.to,
      sourceHandle: handleOf(link.fromAnchor, rightward ? "right" : "left"),
      targetHandle: handleOf(
        link.toAnchor,
        rightward && link.from !== link.to ? "left" : "right"
      ),
      selectable: false,
      deletable: false,
      data: { link, markers },
      ariaLabel: `${link.from}.${link.edge.from.relation} to ${link.to}: ${END_LABELS[link.edge.fromEnd]} ${link.from} for ${END_LABELS[link.edge.toEnd]} ${link.to}`,
    };
  });
});
</script>

<div class="schema">
  <SchemaMarkers id={markers} />
  <SvelteFlow
    bind:nodes
    {edges}
    nodeTypes={NODE_TYPES}
    edgeTypes={EDGE_TYPES}
    colorMode={NO_MODE}
    fitView
    fitViewOptions={FIT}
    minZoom={0.2}
    maxZoom={1.5}
    nodesConnectable={false}
    elementsSelectable={false}
    proOptions={{ hideAttribution: true }}
  >
    <SchemaZoom fit={FIT} />
  </SvelteFlow>
  <div class="legend" aria-label="Legend">
    <span><svg viewBox="0 0 40 12" aria-hidden="true"><path d="M0 6H40" /></svg>one to many</span>
    <span><svg viewBox="0 0 40 12" aria-hidden="true"><path class="dashed" d="M0 6H40" /></svg>one to one</span>
    <span><svg viewBox="0 0 40 12" aria-hidden="true"><path class="dotted" d="M0 6H40" /></svg>many to many</span>
  </div>
</div>

<style>
  .schema {
    position: relative;
    flex: 1;
    min-height: 0;
    height: 100%;
    background-color: var(--color-canvas);
    background-image: radial-gradient(color-mix(in oklab, var(--color-neutral) 12%, transparent) 1px, transparent 1px);
    background-size: 20px 20px;
    --xy-background-color: transparent;
    --xy-edge-stroke: color-mix(in oklab, var(--color-neutral) 55%, transparent);
    --xy-edge-stroke-width: 1.6;
  }
  .schema :global(.svelte-flow) { position: absolute; inset: 0; height: auto; }
  /* One for one: dashed, so it reads apart from one for many before its ends do. Many for many: dotted. */
  .schema :global(.svelte-flow__edge-path.one-to-one) { stroke-dasharray: 6 4; }
  .schema :global(.svelte-flow__edge-path.many-to-many) { stroke-dasharray: 2 4; }
  .schema :global(.svelte-flow__edge-path.variant) { stroke-dasharray: 10 3 2 3; }
  .legend {
    position: absolute;
    left: 12px;
    bottom: 12px;
    display: flex;
    gap: 14px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--color-surface);
    font-size: 11px;
    color: var(--muted);
  }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend svg { width: 32px; height: 12px; }
  .legend path { stroke: color-mix(in oklab, var(--color-neutral) 55%, transparent); stroke-width: 1.6; fill: none; }
  .legend .dashed { stroke-dasharray: 6 4; }
  .legend .dotted { stroke-dasharray: 2 4; }
</style>
