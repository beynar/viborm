<script lang="ts">
import "@xyflow/svelte/dist/base.css";
import {
  type ColorMode,
  type Edge,
  type Node,
  SvelteFlow,
} from "@xyflow/svelte";
import { Button } from "entasis/button";
import { arrowCounterClockwiseIcon } from "entasis/icons/arrowCounterClockwise";
import { type PageShellApi, setPageShell } from "entasis/page-shell";
import { untrack } from "svelte";
import type { StudioDescription, StudioSchema } from "../../lib/api";
import {
  CARD_WIDTH,
  END_LABELS,
  handleOf,
  type Link,
  linksOf,
  schemaLayout,
} from "../../lib/diagram";
import { fillPage } from "../../lib/fill";
import RelationEdge from "./RelationEdge.svelte";
import SchemaLegend from "./SchemaLegend.svelte";
import SchemaMarkers from "./SchemaMarkers.svelte";
import SchemaZoom from "./SchemaZoom.svelte";
import TableNode, { type TableData } from "./TableNode.svelte";

// The schema as a diagram (Svelte Flow), after Pyxel's: a card per model, its columns with their key, their links and
// their types, then its relations; a stepped line per relation, from the columns that hold a key to the key they
// point to, its ends in crow's foot notation. The models pointed to stand on the left. A card moves by hand.
let { schema }: { schema: StudioDescription } = $props();

const uid = $props.id();
const markers = `schema-${uid}`;
const NODE_TYPES = { table: TableNode };
const EDGE_TYPES = { relation: RelationEdge };
/** The whole diagram in view, read at a zoom of one half at least: a large one scrolls rather than shrinks to a mark. */
const FIT = { padding: 0.15, minZoom: 0.5, maxZoom: 1 };
/** No colour mode of Svelte Flow's: its classes would bring its own palette, not entasis's. */
const NO_MODE = "" as ColorMode;

const links = $derived(linksOf(schema));

// The page's header: its title, what the schema holds, and the legend.
setPageShell({ title: "Schema", subtitle, headerActions });

/**
 * Where the member moved each card, kept in the browser per project (the
 * config's path makes the key, which no reload changes: a model added later
 * joins the saved layout), so the diagram opens as it was left.
 */
const LAYOUT_KEY = `viborm-studio:layout:${untrack(() => schema.project)}`;
function savedLayout(): Record<string, { x: number; y: number }> {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
  } catch {
    return {};
  }
}
let saving: ReturnType<typeof setTimeout> | undefined;
function saveLayout(current: readonly Node<TableData>[]) {
  clearTimeout(saving);
  saving = setTimeout(() => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify(
        Object.fromEntries(current.map((node) => [node.id, node.position]))
      )
    );
  }, 300);
}
/** The diagram as the schema lays it out: every card back to its column. */
function resetLayout() {
  localStorage.removeItem(LAYOUT_KEY);
  const at = schemaLayout(schema);
  nodes = nodes.map((node) => ({
    ...node,
    position: at.get(node.id) ?? node.position,
  }));
}

function laidOut(current: StudioSchema): Node<TableData>[] {
  const at = schemaLayout(current);
  const all = linksOf(current);
  const kept = new Map([
    ...Object.entries(savedLayout()),
    ...(nodes ?? []).map((node) => [node.id, node.position] as const),
  ]);
  return current.models.map((model) => ({
    id: model.name,
    type: "table",
    position: kept.get(model.name) ?? at.get(model.name) ?? { x: 0, y: 0 },
    width: CARD_WIDTH,
    deletable: false,
    selectable: false,
    data: {
      model,
      sources: new Set(
        all
          .filter((link) => link.from === model.name)
          .map((link) => link.fromAnchor)
      ),
      targets: new Set(
        all
          .filter((link) => link.to === model.name)
          .map((link) => link.toAnchor)
      ),
      pointing: new Map(
        current.edges
          .filter(
            (edge) =>
              edge.from.model === model.name && edge.kind !== "many-to-many"
          )
          .flatMap((edge) =>
            edge.from.columns.map((column) => [column, edge.to.model] as const)
          )
      ),
    },
  }));
}

let nodes = $state.raw<Node<TableData>[]>([]);
// The schema read again: each card keeps where it was moved, a new one takes its place.
$effect.pre(() => {
  const current = schema;
  nodes = untrack(() => laidOut(current));
});

// A card moved (or the schema reloaded): where every card stands is kept.
$effect(() => saveLayout(nodes));

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

{#snippet subtitle(_page: PageShellApi)}
  {schema.models.length} {schema.models.length === 1 ? 'model' : 'models'} · {schema.edges.length} {schema.edges.length === 1 ? 'relation' : 'relations'} · {schema.dialect}
{/snippet}

{#snippet headerActions(_page: PageShellApi)}
  <Button size="small" variant="ghost" prefix={arrowCounterClockwiseIcon} onclick={resetLayout}>Reset layout</Button>
  <SchemaLegend />
{/snippet}

<div class="schema" {@attach fillPage}>
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
</div>

<style>
  .schema {
    position: relative;
    background: var(--color-surface-recessed, color-mix(in oklab, var(--color-neutral) 4%, var(--color-surface)));
    --xy-background-color: transparent;
    --xy-edge-stroke: color-mix(in oklab, var(--color-neutral) 55%, transparent);
    --xy-edge-stroke-width: 1.6;
  }
  .schema :global(.svelte-flow) { position: absolute; inset: 0; height: auto; }
  /* One for one: dashed, so it reads apart from one for many before its ends do. Many for many: dotted. */
  .schema :global(.svelte-flow__edge-path.one-to-one) { stroke-dasharray: 6 4; }
  .schema :global(.svelte-flow__edge-path.many-to-many) { stroke-dasharray: 2 4; }
  .schema :global(.svelte-flow__edge-path.variant) { stroke-dasharray: 10 3 2 3; }
</style>
