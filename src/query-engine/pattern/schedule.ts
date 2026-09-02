/**
 * D — the scheduler (pattern-engine-ideal-state.md §6, §13.3 unit D).
 *
 * One pass over a pattern produces: the statement nodes (one per row and mode,
 * cells grouped by key — §7.1's grouping decided here so the packer has nothing
 * to decide), the variable binders (single assignment, D4), the dataflow graph
 * with its one anti-dependency (§6.2), the cascade pseudo-statement, the
 * payload-order tie-break, the fragment cuts (§6.3), the match levels, and the
 * legality verdict (§6.4).
 *
 * No verb, storage word, or substrate word decides anything here. The only
 * substrate facts consumed are the two in {@link Substrate}, and both only
 * decide where a fragment ends and whether a decision match locks.
 */
import { NestedWriteError } from "@errors";
import type { Model } from "@schema/model";
import { getColumnName, getModelKeyCatalog } from "@schema/model";
import {
  classifyTargetConstraintOverlap,
  normalizeTargetConstraint,
  type PredicateFieldSet,
  predicateFieldSetsIntersect,
  type TargetConstraint,
  type TargetConstraintOverlap,
} from "../TargetConstraint";
import type { FragmentBoundary, Premise } from "./fragment";
import type {
  ArmId,
  Cell,
  Pattern,
  Predicate,
  Reference,
  Row,
  RowId,
  Variable,
  VariableId,
} from "./pattern";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The two substrate facts the scheduler consumes (§9.3, §6.3). */
export interface Substrate {
  /** How the asserting statement can bind a database-generated key in place. */
  readonly bindsGeneratedKey: "returning" | "insertId" | "reselect" | "none";
  readonly supportsTransactions: boolean;
}

/**
 * A refusal construction deferred (§5 rule 3): raised after legality, before
 * packing, so "OwnWrite before construction refusals" holds by placement.
 */
export type DeferredRefusal = () => never;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeKind =
  | "match"
  | "assert"
  | "retract"
  | "cascade"
  | "unreferenced"
  | "terminal";

/**
 * One statement of the schedule. `index` is the payload-order position and the
 * deterministic tie-break; `cells` are the cells this statement carries
 * (already grouped by key, §7.1); `binds` are the variables it establishes
 * (single assignment); `consumes` the variables it reads; `needsRows` the rows
 * whose key must exist before it runs (a reference is written after its
 * referent exists).
 */
export interface Node {
  readonly index: number;
  readonly kind: NodeKind;
  readonly row: RowId;
  readonly cells: readonly Cell[];
  readonly binds: readonly VariableId[];
  readonly consumes: readonly VariableId[];
  readonly needsRows: readonly RowId[];
  readonly arm?: ArmId;
  /** False for a node inside an arm the merge did not take. */
  readonly taken: boolean;
  /**
   * A match the row's own assert/retract cannot proceed without (the located
   * root): `exactlyOneRow` at execution. Decision matches carry a premise instead.
   */
  readonly required: boolean;
  readonly premise?: Premise;
  /** The reference this holder statement writes, when it writes exactly one. */
  readonly reference?: Reference;
  /** Cells rewritten to the OLD key so `ON UPDATE CASCADE` carries them (§6.2). */
  readonly cascadeCarried: readonly Cell[];
  /** Dependency level (longest predecessor chain) over the whole dataflow graph. */
  readonly level: number;
}

export interface ScheduledFragment {
  /** Match nodes grouped by dependency level among the fragment's matches. */
  readonly matches: readonly (readonly Node[])[];
  /** Every other node in dataflow order (cascade / unreferenced / terminal included). */
  readonly writes: readonly Node[];
  readonly boundary: FragmentBoundary;
}

export interface Scheduled {
  readonly pattern: Pattern;
  readonly substrate: Substrate;
  readonly nodes: readonly Node[];
  /** The whole dataflow order, payload-order tie-break. */
  readonly order: readonly Node[];
  readonly fragments: readonly ScheduledFragment[];
  /** Variable → the node that binds it. Absent for literals and generators. */
  readonly binders: ReadonlyMap<VariableId, Node>;
  /** Row → the node whose success establishes the row's key. */
  readonly establishes: ReadonlyMap<RowId, Node>;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function schedule(
  pattern: Pattern,
  substrate: Substrate,
  deferred: readonly DeferredRefusal[] = []
): Scheduled {
  const facts = new PatternFacts(pattern);
  const nodes = buildNodes(pattern, facts);
  const graph = buildGraph(pattern, facts, nodes);
  const order = topological(nodes, graph);
  const leveled = withLevels(order, graph);
  const fragments = cutFragments(leveled, graph, pattern, substrate);
  for (const fragment of fragments) {
    assertLegal(facts, fragment, leveled);
  }
  for (const refuse of deferred) refuse();
  const byIndex = new Map(leveled.map((node) => [node.index, node]));
  return {
    pattern,
    substrate,
    nodes: [...byIndex.values()].sort((a, b) => a.index - b.index),
    order: leveled,
    fragments,
    binders: remap(graph.binders, byIndex),
    establishes: remap(graph.establishes, byIndex),
  };
}

function remap<K>(
  source: ReadonlyMap<K, Node>,
  byIndex: ReadonlyMap<number, Node>
): Map<K, Node> {
  const out = new Map<K, Node>();
  for (const [key, node] of source) out.set(key, byIndex.get(node.index)!);
  return out;
}

// ---------------------------------------------------------------------------
// Pattern facts (indexes over K1, computed once)
// ---------------------------------------------------------------------------

class PatternFacts {
  readonly rows = new Map<RowId, Row>();
  readonly variables = new Map<VariableId, Variable>();
  readonly cellsByRow = new Map<RowId, Cell[]>();
  readonly referencesByHolder = new Map<RowId, Reference[]>();
  readonly matchedOn = new Map<RowId, Variable[]>();
  readonly returnedOn = new Map<RowId, Variable[]>();
  readonly armTaken = new Map<ArmId, boolean>();
  readonly decisionRows = new Set<RowId>();
  /** Every k′: established by the transitioning row's own statement. */
  readonly newKeyVariables = new Set<VariableId>();

  readonly pattern: Pattern;

  constructor(pattern: Pattern) {
    this.pattern = pattern;
    for (const row of pattern.rows) {
      this.rows.set(row.id, row);
      this.cellsByRow.set(row.id, []);
      this.referencesByHolder.set(row.id, []);
      this.matchedOn.set(row.id, []);
      this.returnedOn.set(row.id, []);
      for (const variable of row.newKey ?? []) {
        this.newKeyVariables.add(variable.id);
      }
    }
    for (const cell of pattern.cells) this.cellsByRow.get(cell.row)?.push(cell);
    for (const reference of pattern.references) {
      this.referencesByHolder.get(reference.holder)?.push(reference);
    }
    for (const variable of pattern.variables) {
      this.variables.set(variable.id, variable);
      const { binding } = variable;
      if (binding.kind === "matched") {
        this.matchedOn.get(binding.row)?.push(variable);
      } else if (binding.kind === "returned") {
        this.returnedOn.get(binding.row)?.push(variable);
      }
    }
    for (const arm of pattern.arms) {
      this.armTaken.set(arm.id, this.armIsTaken(arm.id));
      this.decisionRows.add(arm.decision);
    }
  }

  private armIsTaken(id: ArmId): boolean {
    // An arm is "taken" when the merge decided for it; K1 records the decision
    // per arm, so both arms of one merge are present and exactly one is taken.
    const arm = this.pattern.arms.find((candidate) => candidate.id === id);
    if (!arm) return true;
    const decision = this.rows.get(arm.decision);
    if (!decision) return true;
    // The arm's own `taken` tag names the outcome it belongs to; the pattern
    // states the actual outcome through the decision row's match result at
    // pack time. At schedule time both arms are ordered and only the taken one
    // is packed; the scheduler marks by the tag the constructor chose.
    return arm.taken === "found"
      ? decision.mode !== "assert" || !decision.fresh
      : decision.mode === "assert" && decision.fresh;
  }

  row(id: RowId): Row {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`query-engine pattern: unknown row ${id} in schedule`);
    }
    return row;
  }

  cells(id: RowId): readonly Cell[] {
    return this.cellsByRow.get(id) ?? [];
  }

  /** The references whose holder is `row` and whose columns this cell set writes. */
  referencesWritten(row: RowId, cells: readonly Cell[]): Reference[] {
    const columns = new Set(cells.map((cell) => cell.column));
    return (this.referencesByHolder.get(row) ?? []).filter((reference) =>
      reference.columns.some((column) => columns.has(column.holderColumn))
    );
  }

  /** Every reference touching `row` at either end. */
  referencesOf(row: RowId): Reference[] {
    return this.pattern.references.filter(
      (reference) => reference.holder === row || reference.referenced === row
    );
  }

  hasOwnMatch(row: RowId): boolean {
    return (this.matchedOn.get(row)?.length ?? 0) > 0;
  }

  taken(row: Row): boolean {
    return row.arm === undefined ? true : (this.armTaken.get(row.arm) ?? true);
  }

  /** `Row.verb` is message text only (K1); the fallback derives one from the mode. */
  verb(row: Row, kind: NodeKind): string {
    if (row.verb) return row.verb;
    if (kind === "match")
      return row.arm === undefined ? "connect" : "connectOrCreate";
    if (kind === "retract") return "delete";
    return row.fresh ? "create" : "update";
  }

  relationOf(row: RowId): string {
    const reference = this.referencesOf(row).find(
      (candidate) => candidate.holder !== candidate.referenced
    );
    return reference?.relation.field ?? this.pattern.operation;
  }
}

// ---------------------------------------------------------------------------
// Nodes (one statement per row and mode, cells grouped by key — §7.1)
// ---------------------------------------------------------------------------

/**
 * The variables a statement DEPENDS on: those the database binds (matched,
 * returned) and those a statement establishes as a row's new key (k′ is a
 * literal in the payload, but the row carries it only after the transition).
 */
function dependentVariableIds(
  facts: PatternFacts,
  values: readonly (Variable | undefined)[]
): VariableId[] {
  const ids: VariableId[] = [];
  for (const value of values) {
    if (!value) continue;
    const bound =
      value.binding.kind === "matched" ||
      value.binding.kind === "returned" ||
      facts.newKeyVariables.has(value.id);
    if (bound) ids.push(value.id);
  }
  return ids;
}

function predicateVariables(predicate: Predicate | undefined): Variable[] {
  if (!predicate) return [];
  switch (predicate.kind) {
    case "scalar":
      return Array.isArray(predicate.operand)
        ? [...predicate.operand]
        : [predicate.operand as Variable];
    case "and":
    case "or":
      return predicate.items.flatMap(predicateVariables);
    case "not":
      return predicateVariables(predicate.item);
    case "structural":
      return [...predicate.operands];
    case "relation":
      return predicateVariables(predicate.inner);
    default:
      return [];
  }
}

function buildNodes(pattern: Pattern, facts: PatternFacts): Node[] {
  const nodes: Node[] = [];
  const push = (node: Omit<Node, "index" | "level">) => {
    nodes.push({ ...node, index: nodes.length, level: 0 });
  };

  for (const row of pattern.rows) {
    const cells = facts.cells(row.id);
    const taken = facts.taken(row);
    const matchCells = cells.filter((cell) => cell.mode === "match");
    const writeCells = cells.filter((cell) => cell.mode !== "match");

    // 1. The row's own match: it binds every `matched` variable on the row.
    if (facts.hasOwnMatch(row.id) || row.mode === "match") {
      const decision =
        row.mode === "match" ||
        row.matchIsDecision === true ||
        facts.decisionRows.has(row.id) ||
        row.arm !== undefined;
      const missing = pattern.arms.some(
        (arm) => arm.decision === row.id && arm.taken === "missing"
      );
      const premise: Premise = missing
        ? { kind: "notExists", row: row.id, raceable: false }
        : { kind: "exists", row: row.id, raceable: false };
      push({
        kind: "match",
        row: row.id,
        cells: matchCells,
        binds: (facts.matchedOn.get(row.id) ?? []).map((v) => v.id),
        consumes: [
          ...dependentVariableIds(facts, predicateVariables(row.predicate)),
          ...dependentVariableIds(
            facts,
            matchCells.map((cell) => cell.value)
          ),
          // A correlated match reads the OTHER endpoint's key.
          ...dependentVariableIds(
            facts,
            facts
              .referencesWritten(row.id, matchCells)
              .flatMap((reference) => facts.row(reference.referenced).key)
          ),
        ],
        needsRows: [],
        ...(row.arm === undefined ? {} : { arm: row.arm }),
        taken,
        required: !decision,
        premise,
        cascadeCarried: [],
      });
    }

    // 2. The row's write: all its assert/retract cells at one key.
    if (row.mode === "retract") {
      push({
        kind: "retract",
        row: row.id,
        cells: writeCells,
        binds: [],
        consumes: dependentVariableIds(facts, row.key),
        needsRows: [],
        ...(row.arm === undefined ? {} : { arm: row.arm }),
        taken,
        required: false,
        cascadeCarried: [],
      });
      continue;
    }
    if (writeCells.length === 0 && !(row.mode === "assert" && row.fresh)) {
      continue;
    }
    const references = facts.referencesWritten(row.id, writeCells);
    const binds = [
      ...(facts.returnedOn.get(row.id) ?? []).map((v) => v.id),
      ...(row.newKey ?? []).map((v) => v.id),
    ];
    push({
      kind: "assert",
      row: row.id,
      cells: writeCells,
      binds,
      consumes: [
        ...dependentVariableIds(
          facts,
          writeCells.map((cell) => cell.value)
        ),
        ...dependentVariableIds(
          facts,
          writeCells.map((cell) => cell.relative?.operand)
        ),
        // A bound key addresses the row; a fresh key is established here.
        ...(row.fresh ? [] : dependentVariableIds(facts, row.key)),
      ],
      needsRows: references.map((reference) => reference.referenced),
      ...(row.arm === undefined ? {} : { arm: row.arm }),
      taken,
      required: false,
      ...(references.length === 1 ? { reference: references[0] } : {}),
      cascadeCarried: [],
    });
  }

  // 3. Key transitions: the cascade pseudo-statement and the occupied-slot premise.
  for (const row of pattern.rows) {
    if (!row.newKey || row.newKey.length === 0) continue;
    const seen = new Set<string>();
    for (const reference of pattern.references) {
      if (reference.referenced !== row.id) continue;
      const key = `${reference.relation.field}:${reference.columns
        .map((c) => c.holderColumn)
        .join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (reference.onKeyChange === "cascade") {
        push({
          kind: "cascade",
          row: row.id,
          cells: [],
          binds: [],
          consumes: row.newKey.map((v) => v.id),
          needsRows: [],
          taken: true,
          required: false,
          reference,
          cascadeCarried: [],
        });
      } else {
        push({
          kind: "unreferenced",
          row: row.id,
          cells: [],
          binds: [],
          consumes: dependentVariableIds(facts, row.key),
          needsRows: [],
          taken: true,
          required: false,
          premise: { kind: "unreferenced", row: row.id, raceable: false },
          reference,
          cascadeCarried: [],
        });
      }
    }
  }

  // 4. The terminal projection reads the root's final key after every write.
  if (pattern.projection) {
    const root = facts.row(pattern.root);
    push({
      kind: "terminal",
      row: root.id,
      cells: [],
      binds: [],
      consumes: dependentVariableIds(facts, root.newKey ?? root.key),
      needsRows: [],
      taken: true,
      required: false,
      cascadeCarried: [],
    });
  }

  return applyCascade(pattern, facts, nodes);
}

/**
 * §6.2 cascade: a holder cell asserting the referenced row's NEW key over a
 * cascading reference is rewritten to assert the OLD key. It then reads `k`
 * (read-before-rebind places it before the root) and the database rebinds it
 * to `k′` at the root statement; the post-root assert is dead and never built.
 */
function applyCascade(
  pattern: Pattern,
  facts: PatternFacts,
  nodes: Node[]
): Node[] {
  const oldFor = new Map<VariableId, Variable>();
  const cascading = new Set<string>();
  for (const row of pattern.rows) {
    if (!row.newKey) continue;
    row.newKey.forEach((next, index) => {
      const previous = row.key[index];
      if (previous) oldFor.set(next.id, previous);
    });
  }
  for (const reference of pattern.references) {
    if (reference.onKeyChange !== "cascade") continue;
    const referenced = facts.row(reference.referenced);
    if (!referenced.newKey) continue;
    for (const column of reference.columns) {
      cascading.add(`${reference.holder}:${column.holderColumn}`);
    }
  }
  if (cascading.size === 0) return nodes;
  return nodes.map((node) => {
    if (node.kind !== "assert") return node;
    const carried: Cell[] = [];
    const cells = node.cells.map((cell) => {
      const previous = oldFor.get(cell.value.id);
      if (!(previous && cascading.has(`${cell.row}:${cell.column}`)))
        return cell;
      const rewritten: Cell = { ...cell, value: previous };
      carried.push(rewritten);
      return rewritten;
    });
    if (carried.length === 0) return node;
    return {
      ...node,
      cells,
      cascadeCarried: carried,
      consumes: [
        ...dependentVariableIds(
          facts,
          cells.map((cell) => cell.value)
        ),
        ...dependentVariableIds(
          facts,
          cells.map((cell) => cell.relative?.operand)
        ),
        ...(facts.row(node.row).fresh
          ? []
          : dependentVariableIds(facts, facts.row(node.row).key)),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Dataflow graph (§6.2)
// ---------------------------------------------------------------------------

interface Graph {
  readonly predecessors: ReadonlyMap<number, ReadonlySet<number>>;
  readonly binders: ReadonlyMap<VariableId, Node>;
  readonly establishes: ReadonlyMap<RowId, Node>;
}

function buildGraph(
  pattern: Pattern,
  facts: PatternFacts,
  nodes: Node[]
): Graph {
  const predecessors = new Map<number, Set<number>>();
  for (const node of nodes) predecessors.set(node.index, new Set());
  const edge = (from: Node, to: Node) => {
    if (from.index === to.index) return;
    predecessors.get(to.index)!.add(from.index);
  };

  const binders = new Map<VariableId, Node>();
  const establishes = new Map<RowId, Node>();
  const assertOf = new Map<RowId, Node>();
  const matchOf = new Map<RowId, Node>();
  const writesOf = nodes.filter(
    (node) => node.kind === "assert" || node.kind === "retract"
  );
  for (const node of nodes) {
    for (const variable of node.binds) {
      if (binders.has(variable)) {
        throw new Error(
          `query-engine pattern: variable ${variable} bound twice (single assignment, D4)`
        );
      }
      binders.set(variable, node);
    }
    if (node.kind === "match") matchOf.set(node.row, node);
    if (node.kind === "assert") assertOf.set(node.row, node);
  }
  for (const row of pattern.rows) {
    const establisher = row.fresh
      ? assertOf.get(row.id)
      : (matchOf.get(row.id) ?? assertOf.get(row.id));
    if (establisher) establishes.set(row.id, establisher);
  }

  for (const node of nodes) {
    // use-after-bind
    for (const variable of node.consumes) {
      const binder = binders.get(variable);
      if (binder) edge(binder, node);
    }
    // a reference is written after its referent exists
    for (const row of node.needsRows) {
      const establisher = establishes.get(row);
      if (establisher) edge(establisher, node);
    }
    // the row's own match precedes its write
    if (node.kind === "assert" || node.kind === "retract") {
      const own = matchOf.get(node.row);
      if (own) edge(own, node);
    }
    // the terminal observes every write; a cascade rides its root statement
    if (node.kind === "terminal") {
      for (const write of writesOf) edge(write, node);
    }
  }
  // read-before-rebind: every consumer of `k` precedes the statement binding `k′`
  for (const row of pattern.rows) {
    if (!row.newKey || row.newKey.length === 0) continue;
    const rebinder = assertOf.get(row.id);
    if (!rebinder) continue;
    const oldKey = new Set(dependentVariableIds(facts, row.key));
    if (oldKey.size === 0) continue;
    for (const node of nodes) {
      if (node.index === rebinder.index || node.kind === "terminal") continue;
      if (node.consumes.some((v) => oldKey.has(v))) edge(node, rebinder);
    }
  }
  return { predecessors, binders, establishes };
}

/** Kahn's algorithm with the payload-order tie-break (§6.2). */
function topological(nodes: readonly Node[], graph: Graph): Node[] {
  const remaining = new Map<number, Set<number>>();
  for (const node of nodes) {
    remaining.set(node.index, new Set(graph.predecessors.get(node.index)));
  }
  const successors = new Map<number, number[]>();
  for (const [to, preds] of graph.predecessors) {
    for (const from of preds) {
      let list = successors.get(from);
      if (!list) {
        list = [];
        successors.set(from, list);
      }
      list.push(to);
    }
  }
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const ready = nodes
    .filter((n) => remaining.get(n.index)!.size === 0)
    .map((n) => n.index);
  const order: Node[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const next = ready.shift()!;
    order.push(byIndex.get(next)!);
    for (const to of successors.get(next) ?? []) {
      const preds = remaining.get(to)!;
      preds.delete(next);
      if (preds.size === 0) ready.push(to);
    }
  }
  if (order.length !== nodes.length) {
    throw new Error(
      "query-engine pattern: the dataflow graph has a cycle; the pattern cannot be scheduled"
    );
  }
  return order;
}

function withLevels(order: readonly Node[], graph: Graph): Node[] {
  const level = new Map<number, number>();
  return order.map((node) => {
    let depth = 0;
    for (const pred of graph.predecessors.get(node.index) ?? []) {
      depth = Math.max(depth, (level.get(pred) ?? 0) + 1);
    }
    level.set(node.index, depth);
    return { ...node, level: depth };
  });
}

// ---------------------------------------------------------------------------
// Fragments and the match phase (§6.3)
// ---------------------------------------------------------------------------

function cutFragments(
  order: readonly Node[],
  graph: Graph,
  pattern: Pattern,
  substrate: Substrate
): ScheduledFragment[] {
  const fragments: ScheduledFragment[] = [];
  let current: Node[] = [];
  const consumersAfter = (position: number, variable: VariableId) =>
    order.slice(position + 1).some((node) => node.consumes.includes(variable));
  const armAfter = (position: number, arm: ArmId) =>
    order.slice(position + 1).some((node) => node.arm === arm);
  const close = (boundary: FragmentBoundary) => {
    fragments.push(finishFragment(current, graph, boundary));
    current = [];
  };

  for (const [position, node] of order.entries()) {
    // A match that must observe a write of this fragment opens a new one.
    if (node.kind === "match" && current.length > 0) {
      const inFragment = new Set(current.map((n) => n.index));
      const dependsOnWrite = [
        ...(graph.predecessors.get(node.index) ?? []),
      ].some((pred) => {
        const predecessor = current.find((n) => n.index === pred);
        return (
          predecessor !== undefined &&
          inFragment.has(pred) &&
          predecessor.kind !== "match"
        );
      });
      if (dependsOnWrite) {
        const variable = node.consumes.find((v) => {
          const binder = graph.binders.get(v);
          return binder !== undefined && inFragment.has(binder.index);
        });
        close({
          kind: "executionBinding",
          variable: variable ?? -1,
          statement: `row ${node.row} match`,
        });
      }
    }
    current.push(node);
    if (node.kind !== "assert") continue;
    // A generated key the substrate cannot bind in place, consumed later.
    if (substrate.bindsGeneratedKey === "none") {
      const returned = node.binds.find((variable) => {
        const binding = pattern.variables.find(
          (v) => v.id === variable
        )?.binding;
        return (
          binding?.kind === "returned" && consumersAfter(position, variable)
        );
      });
      if (returned !== undefined) {
        close({
          kind: "executionBinding",
          variable: returned,
          statement: `row ${node.row} assert`,
        });
        continue;
      }
    }
    // A merge whose outcome is the write itself, observed before its dependents.
    const outcome = pattern.arms.find(
      (arm) => arm.decision === node.row && armAfter(position, arm.id)
    );
    if (outcome) close({ kind: "mergeOutcome", row: node.row });
  }
  if (current.length > 0 || fragments.length === 0) close({ kind: "end" });
  return fragments;
}

function finishFragment(
  nodes: readonly Node[],
  graph: Graph,
  boundary: FragmentBoundary
): ScheduledFragment {
  const matches = nodes.filter((node) => node.kind === "match");
  const inFragment = new Set(matches.map((node) => node.index));
  const level = new Map<number, number>();
  const byLevel: Node[][] = [];
  for (const node of matches) {
    let depth = 0;
    for (const pred of graph.predecessors.get(node.index) ?? []) {
      if (inFragment.has(pred))
        depth = Math.max(depth, (level.get(pred) ?? 0) + 1);
    }
    level.set(node.index, depth);
    (byLevel[depth] ??= []).push(node);
  }
  return {
    matches: byLevel.map((group) => group ?? []),
    writes: nodes.filter((node) => node.kind !== "match"),
    boundary,
  };
}

// ---------------------------------------------------------------------------
// Legality (§6.4) — the overlap classification of TargetConstraint.ts
// ---------------------------------------------------------------------------

interface ReadFact {
  readonly node: Node;
  readonly model: Model<any>;
  readonly constraint: TargetConstraint;
  readonly fields: PredicateFieldSet;
  readonly memberships: readonly MembershipFact[];
}

interface MembershipFact {
  readonly key: string;
  readonly holder: TargetConstraint;
  readonly referenced: TargetConstraint;
}

type WriteFact =
  | {
      readonly kind: "existence";
      readonly node: Node;
      readonly model: Model<any>;
      readonly constraint: TargetConstraint;
    }
  | {
      readonly kind: "predicate";
      readonly node: Node;
      readonly model: Model<any>;
      readonly constraint: TargetConstraint;
      readonly changed: ReadonlySet<string>;
    }
  | {
      readonly kind: "membership";
      readonly node: Node;
      readonly membership: MembershipFact;
    };

function fieldOf(model: Model<any>, column: string): string {
  for (const field of Object.keys(model["~"].state.scalars)) {
    if (getColumnName(model, field) === column) return field;
  }
  return column;
}

function literalValue(variable: Variable): { known: boolean; value?: unknown } {
  return variable.binding.kind === "literal"
    ? { known: true, value: variable.binding.value }
    : { known: false };
}

function predicateValues(
  model: Model<any>,
  predicate: Predicate | undefined,
  values: Record<string, unknown>,
  fields: Set<string>
): boolean {
  if (!predicate) return true;
  switch (predicate.kind) {
    case "scalar": {
      const field = fieldOf(model, predicate.column);
      fields.add(field);
      if (
        predicate.operator === "equals" &&
        !Array.isArray(predicate.operand)
      ) {
        const literal = literalValue(predicate.operand as Variable);
        if (literal.known) values[field] = literal.value;
      }
      return true;
    }
    case "and":
      return predicate.items.every((item) =>
        predicateValues(model, item, values, fields)
      );
    case "or":
    case "not":
    case "relation":
    case "structural":
      return false;
    default:
      return false;
  }
}

function keyConstraint(
  model: Model<any>,
  row: Row,
  cells: readonly Cell[]
): TargetConstraint {
  const identity = getModelKeyCatalog(model).uniqueOverlapFields;
  const values: Record<string, unknown> = {};
  for (const cell of cells) {
    const literal = literalValue(cell.value);
    if (literal.known) values[fieldOf(model, cell.column)] = literal.value;
  }
  const catalog = getModelKeyCatalog(model).rowKey?.fields ?? [];
  row.key.forEach((variable, index) => {
    const literal = literalValue(variable);
    const field = catalog[index];
    if (literal.known && field) values[field] = literal.value;
  });
  return normalizeTargetConstraint(model, identity, values);
}

function membershipKey(reference: Reference): string {
  return `${reference.relation.field}@${reference.columns
    .map((c) => `${c.holderColumn}=${c.referencedColumn}`)
    .join(",")}`;
}

function readFact(facts: PatternFacts, node: Node): ReadFact {
  const row = facts.row(node.row);
  const model = row.table.model;
  const values: Record<string, unknown> = {};
  const fieldSet = new Set<string>();
  const enumerable = predicateValues(model, row.predicate, values, fieldSet);
  const identity = getModelKeyCatalog(model).uniqueOverlapFields;
  const memberships: MembershipFact[] = [];
  for (const reference of facts.referencesWritten(node.row, node.cells)) {
    memberships.push({
      key: membershipKey(reference),
      holder: normalizeTargetConstraint(model, identity, values),
      referenced: keyConstraint(
        facts.row(reference.referenced).table.model,
        facts.row(reference.referenced),
        []
      ),
    });
  }
  return {
    node,
    model,
    constraint: normalizeTargetConstraint(model, identity, values),
    fields: enumerable ? fieldSet : "unknown",
    memberships,
  };
}

function writeFacts(facts: PatternFacts, node: Node): WriteFact[] {
  const row = facts.row(node.row);
  const model = row.table.model;
  const out: WriteFact[] = [];
  if (node.kind === "retract" || (node.kind === "assert" && row.fresh)) {
    out.push({
      kind: "existence",
      node,
      model,
      constraint: keyConstraint(model, row, node.cells),
    });
  } else if (node.kind === "assert") {
    out.push({
      kind: "predicate",
      node,
      model,
      constraint: keyConstraint(model, row, []),
      changed: new Set(node.cells.map((cell) => fieldOf(model, cell.column))),
    });
  }
  if (node.kind === "assert" || node.kind === "retract") {
    for (const reference of facts.referencesWritten(node.row, node.cells)) {
      out.push({
        kind: "membership",
        node,
        membership: {
          key: membershipKey(reference),
          holder: keyConstraint(model, row, node.cells),
          referenced: keyConstraint(
            facts.row(reference.referenced).table.model,
            facts.row(reference.referenced),
            []
          ),
        },
      });
    }
  }
  return out;
}

function classifyMembership(
  write: MembershipFact,
  read: MembershipFact
): TargetConstraintOverlap {
  const first = classifyTargetConstraintOverlap(write.holder, read.holder);
  if (first === "disjoint") return "disjoint";
  const second = classifyTargetConstraintOverlap(
    write.referenced,
    read.referenced
  );
  if (second === "disjoint") return "disjoint";
  return first === "equal" && second === "equal" ? "equal" : "unknown";
}

function overlap(
  write: WriteFact,
  read: ReadFact
):
  | { readonly overlap: TargetConstraintOverlap; readonly dimension: string }
  | undefined {
  if (write.kind === "membership") {
    for (const membership of read.memberships) {
      if (membership.key !== write.membership.key) continue;
      return {
        overlap: classifyMembership(write.membership, membership),
        dimension: "membership",
      };
    }
    return undefined;
  }
  if (write.model !== read.model) return undefined;
  if (
    write.kind === "predicate" &&
    !predicateFieldSetsIntersect(write.changed, read.fields)
  )
    return undefined;
  return {
    overlap: classifyTargetConstraintOverlap(write.constraint, read.constraint),
    dimension: "targetExistence",
  };
}

/**
 * For each fragment: no match may observe an assert or retract that precedes it
 * in payload order, over BOTH arms. Deduplicated targets share one match by
 * construction (the second occurrence takes the first's variable), so there is
 * no second read to refuse — the exemption needs no rule.
 */
function assertLegal(
  facts: PatternFacts,
  fragment: ScheduledFragment,
  order: readonly Node[]
): void {
  const inFragment = new Set([
    ...fragment.matches.flat().map((n) => n.index),
    ...fragment.writes.map((n) => n.index),
  ]);
  const writes = order
    .filter(
      (n) =>
        inFragment.has(n.index) && (n.kind === "assert" || n.kind === "retract")
    )
    .flatMap((n) => writeFacts(facts, n));
  for (const match of fragment.matches.flat()) {
    const read = readFact(facts, match);
    for (const write of writes) {
      if (write.node.index >= match.index) continue;
      // A row's own locate is not a read of its own write.
      if (write.node.row === match.row) continue;
      const verdict = overlap(write, read);
      if (!verdict || verdict.overlap === "disjoint") continue;
      const relationName = facts.relationOf(match.row);
      const readOperation = facts.verb(facts.row(match.row), "match");
      const writeOperation = facts.verb(
        facts.row(write.node.row),
        write.node.kind
      );
      const dependencyLabel =
        verdict.dimension === "targetExistence" ? "target" : "membership";
      throw new NestedWriteError(
        `Nested operation '${readOperation}' on relation '${relationName}' depends on an earlier '${writeOperation}' ${dependencyLabel} write in the same nested write. Split these operations into separate queries.`,
        relationName,
        {
          meta: {
            operation: readOperation,
            conflictsWith: writeOperation,
            dependency: verdict.dimension,
            overlap: verdict.overlap,
          },
        }
      );
    }
  }
}
