// A plan as a graph: each operation a card, its inputs below it, the rows they hand it drawn on the line between
// them, the thicker the more rows. A tidy tree: each card centred over the cards it reads from.
import type { Edge, Node } from "@xyflow/svelte";
import type { PlanNode } from "./api";

export const PLAN_CARD_WIDTH = 272;
const CARD_HEIGHT = 168;
const GAP_X = 28;
const GAP_Y = 72;

export type PlanCardData = {
  node: PlanNode;
  /** Its own time over the statement's, 0 to 1; undefined when the plan did not run. */
  share: number | undefined;
  /** The statement's time, to say a node's share of it. */
  total: number | undefined;
  /** An ancestor limit can stop this output early without crossing a blocking input boundary. */
  underLimit: boolean;
};

/** Rows a node handed its parent: per loop times loops when it ran, else what the planner expected. */
export function rowsOut(node: PlanNode): number | undefined {
  if (node.actual) return node.actual.rows * node.actual.loops;
  return node.estimate?.rows;
}

/** The statement's time: the database's own, else its top operation's. */
export function totalTime(
  root: PlanNode,
  executionTime: number | undefined
): number | undefined {
  if (executionTime !== undefined) return executionTime;
  const time = root.actual?.time ?? 0;
  const children = root.children.reduce(
    (sum, child) => sum + (child.actual?.time ?? 0),
    0
  );
  const measured = Math.max(time, children);
  return measured > 0 ? measured : undefined;
}

export function planGraph(
  root: PlanNode,
  executionTime: number | undefined
): { nodes: Node<PlanCardData>[]; edges: Edge[] } {
  const total = totalTime(root, executionTime);
  const width = new Map<string, number>();
  const measure = (node: PlanNode): number => {
    const children = node.children.reduce(
      (sum, child) => sum + measure(child),
      0
    );
    const own = Math.max(PLAN_CARD_WIDTH + GAP_X, children);
    width.set(node.id, own);
    return own;
  };
  measure(root);
  const nodes: Node<PlanCardData>[] = [];
  const edges: Edge[] = [];
  const place = (
    node: PlanNode,
    left: number,
    depth: number,
    underLimit: boolean
  ) => {
    const own = width.get(node.id) ?? PLAN_CARD_WIDTH;
    nodes.push({
      id: node.id,
      type: "plan",
      position: {
        x: left + (own - PLAN_CARD_WIDTH) / 2,
        y: depth * (CARD_HEIGHT + GAP_Y),
      },
      data: {
        node,
        share:
          total && node.actual
            ? Math.min(1, node.actual.self / total)
            : undefined,
        total,
        underLimit,
      },
      draggable: false,
    });
    let at =
      left +
      (own -
        node.children.reduce(
          (sum, child) => sum + (width.get(child.id) ?? 0),
          0
        )) /
        2;
    for (const child of node.children) {
      const rows = rowsOut(child);
      edges.push({
        id: `${child.id}->${node.id}`,
        source: child.id,
        target: node.id,
        type: "plan",
        data: { rows, never: child.neverExecuted === true },
      });
      const blocking =
        node.kind === "sort" ||
        node.kind === "aggregate" ||
        node.kind === "materialize";
      place(
        child,
        at,
        depth + 1,
        node.kind === "limit" || (underLimit && !blocking)
      );
      at += width.get(child.id) ?? 0;
    }
  };
  place(root, 0, 0, false);
  return { nodes, edges };
}

/** A count to read at a glance: 1,234 · 25k · 1.2M. */
export function compact(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return value.toLocaleString("en-US");
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A duration to read at a glance: 0.04 ms · 8.8 ms · 120 ms · 1.4 s. */
export function ms(value: number): string {
  if (value >= 1000)
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} s`;
  if (value >= 100) return `${Math.round(value)} ms`;
  if (value >= 10) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(value < 0.1 ? 3 : 2)} ms`;
}
