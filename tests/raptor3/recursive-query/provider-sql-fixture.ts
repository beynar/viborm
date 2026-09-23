// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers are invoked only from registered tests.
import assert from "node:assert/strict";
import type { Operations, Schema } from "@client/types";
import { QueryEngineError } from "@errors";
import { s } from "@schema";

/** A statement carrying a recursive CTE, and the two mutation statements. */
const RECURSIVE_CTE = /WITH RECURSIVE/;
const UPDATE_STATEMENT = /^UPDATE\b/;
const DELETE_STATEMENT = /^DELETE\b/;

const TREE_TABLE = "rq_provider_nodes";
const NOTE_TABLE = "rq_provider_notes";
const FOREST_TABLE = "rq_provider_forests";
const GRAPH_TABLE = "rq_provider_links";
const CHAIN_TABLE = "rq_provider_chain";

export const providerSchema = (() => {
  const node = s
    .model({
      tenant: s.string().map("tenant_key"),
      code: s.string().map("node_code"),
      label: s.string(),
      rank: s.int(),
      visible: s.boolean(),
      parentTenant: s.string().nullable().map("parent_tenant"),
      parentCode: s.string().nullable().map("parent_code"),
      parent: s
        .toOne(() => node)
        .fields("parentTenant", "parentCode")
        .references("tenant", "code")
        .name("tree"),
      children: s.toMany(() => node).name("tree"),
      notes: s.toMany(() => note).name("notes"),
      forests: s.toMany(() => forest).name("forest-entry"),
      neighbors: s
        .toMany(() => node)
        .name("graph")
        .through(GRAPH_TABLE)
        .source("from")
        .target("to"),
      neighborsOf: s.toMany(() => node).name("graph"),
    })
    .id(["tenant", "code"])
    .map(TREE_TABLE);

  const note = s
    .model({
      id: s.string().id(),
      text: s.string(),
      position: s.int(),
      nodeTenant: s.string().map("node_tenant"),
      nodeCode: s.string().map("node_code"),
      node: s
        .toOne(() => node)
        .fields("nodeTenant", "nodeCode")
        .references("tenant", "code")
        .name("notes"),
    })
    .map(NOTE_TABLE);

  const forest = s
    .model({
      id: s.string().id(),
      name: s.string(),
      entryTenant: s.string().map("entry_tenant"),
      entryCode: s.string().map("entry_code"),
      entry: s
        .toOne(() => node)
        .fields("entryTenant", "entryCode")
        .references("tenant", "code")
        .name("forest-entry"),
    })
    .map(FOREST_TABLE);

  const chain = s
    .model({
      id: s.string().id(),
      nextId: s.string().nullable().unique().map("next_id"),
      next: s
        .toOne(() => chain)
        .fields("nextId")
        .references("id")
        .name("chain"),
      previous: s.toOne(() => chain).name("chain"),
    })
    .map(CHAIN_TABLE);

  return { node, note, forest, chain };
})();

/** The placement matrix's own tables, provider-neutral like every RQ world. */
export const PLACEMENT_MATRIX_TABLES: readonly TableSpec[] = Object.freeze([
  {
    name: TREE_TABLE,
    columns: [
      { name: "tenant_key", type: "text" },
      { name: "node_code", type: "text" },
      { name: "label", type: "text" },
      { name: "rank", type: "integer" },
      { name: "visible", type: "boolean" },
      { name: "parent_tenant", type: "text", nullable: true },
      { name: "parent_code", type: "text", nullable: true },
    ],
    primaryKey: ["tenant_key", "node_code"],
    rows: [
      {
        tenant_key: "t",
        node_code: "root-a",
        label: "Root A",
        rank: 0,
        visible: true,
        parent_tenant: null,
        parent_code: null,
      },
      {
        tenant_key: "t",
        node_code: "root-b",
        label: "Root B",
        rank: 0,
        visible: true,
        parent_tenant: null,
        parent_code: null,
      },
      {
        tenant_key: "t",
        node_code: "hidden",
        label: "Hidden",
        rank: 5,
        visible: false,
        parent_tenant: "t",
        parent_code: "root-a",
      },
      {
        tenant_key: "t",
        node_code: "beta",
        label: "Beta",
        rank: 10,
        visible: true,
        parent_tenant: "t",
        parent_code: "root-a",
      },
      {
        tenant_key: "t",
        node_code: "alpha",
        label: "Alpha",
        rank: 10,
        visible: true,
        parent_tenant: "t",
        parent_code: "root-a",
      },
      {
        tenant_key: "t",
        node_code: "beta-child",
        label: "Beta child",
        rank: 1,
        visible: true,
        parent_tenant: "t",
        parent_code: "beta",
      },
      {
        tenant_key: "t",
        node_code: "alpha-child",
        label: "Alpha child",
        rank: 1,
        visible: true,
        parent_tenant: "t",
        parent_code: "alpha",
      },
      {
        tenant_key: "t",
        node_code: "gamma",
        label: "Gamma",
        rank: 1,
        visible: true,
        parent_tenant: "t",
        parent_code: "root-b",
      },
      {
        tenant_key: "t",
        node_code: "merge",
        label: "Merge",
        rank: 30,
        visible: true,
        parent_tenant: null,
        parent_code: null,
      },
    ],
  },
  {
    name: NOTE_TABLE,
    columns: [
      { name: "id", type: "text" },
      { name: "text", type: "text" },
      { name: "position", type: "integer" },
      { name: "node_tenant", type: "text" },
      { name: "node_code", type: "text" },
    ],
    primaryKey: ["id"],
    rows: [
      {
        id: "n2",
        text: "alpha second",
        position: 2,
        node_tenant: "t",
        node_code: "alpha",
      },
      {
        id: "n1",
        text: "alpha first",
        position: 1,
        node_tenant: "t",
        node_code: "alpha",
      },
      {
        id: "n3",
        text: "beta note",
        position: 1,
        node_tenant: "t",
        node_code: "beta",
      },
    ],
  },
  {
    name: FOREST_TABLE,
    columns: [
      { name: "id", type: "text" },
      { name: "name", type: "text" },
      { name: "entry_tenant", type: "text" },
      { name: "entry_code", type: "text" },
    ],
    primaryKey: ["id"],
    rows: [
      {
        id: "forest-a",
        name: "Forest A",
        entry_tenant: "t",
        entry_code: "root-a",
      },
    ],
  },
  {
    name: CHAIN_TABLE,
    columns: [
      { name: "id", type: "text" },
      { name: "next_id", type: "text", nullable: true, unique: true },
    ],
    primaryKey: ["id"],
    rows: [
      { id: "a", next_id: "b" },
      { id: "b", next_id: "c" },
      { id: "c", next_id: null },
    ],
  },
  {
    name: GRAPH_TABLE,
    columns: [
      { name: "from_1", type: "text" },
      { name: "from_2", type: "text" },
      { name: "to_1", type: "text" },
      { name: "to_2", type: "text" },
    ],
    primaryKey: ["from_1", "from_2", "to_1", "to_2"],
    rows: [
      { from_1: "t", from_2: "root-a", to_1: "t", to_2: "beta" },
      { from_1: "t", from_2: "root-a", to_1: "t", to_2: "alpha" },
      { from_1: "t", from_2: "beta", to_1: "t", to_2: "merge" },
      { from_1: "t", from_2: "alpha", to_1: "t", to_2: "merge" },
      { from_1: "t", from_2: "merge", to_1: "t", to_2: "root-a" },
    ],
  },
]);

export interface ProviderCase {
  readonly name: string;
  readonly model: string;
  readonly operation: "findMany" | "findUnique" | "update" | "delete";
  readonly args: Record<string, unknown>;
  /** The public value — or, with `summarize`, what that value reduces to. */
  readonly expected?: unknown;
  /** The exact `QueryEngineError` sentence the read owes instead of a value. */
  readonly failure?: string;
  /** An ITERATIVE reduction of a result nested too deep for a deep-equal. */
  readonly summarize?: (value: unknown) => unknown;
  /** Occurrence ownership the value must also satisfy: fresh objects per path. */
  readonly check?: (value: unknown) => void;
  /** What the ROOT slot's private carrier transports: node documents and edge facts. */
  readonly transport?: {
    readonly relation: string;
    readonly nodes: number;
    readonly edges: number;
  };
  /**
   * The traversal needs more iterations than MySQL's default
   * `cte_max_recursion_depth` (1000) admits. There the provider's own failure is
   * the answer — never a truncated success — and the engine does not touch the
   * session limit (§2.4, §5).
   */
  readonly exceedsMySQLRecursionLimit?: true;
  /** An ORDINARY control: the same read without recursion — no recursive CTE. */
  readonly control?: true;
}

const leaf = (label: string) => ({ label });

export const ORDINARY_MUTATION_CONTROL: ProviderCase = Object.freeze({
  name: "ordinary relation mutation readback control",
  model: "node",
  operation: "update",
  args: {
    where: { tenant_code: { tenant: "t", code: "root-a" } },
    data: { rank: { increment: 1 } },
    select: {
      label: true,
      rank: true,
      children: {
        where: { visible: true },
        orderBy: [{ rank: "asc" }, { code: "asc" }],
        select: { label: true },
      },
    },
  },
  expected: {
    label: "Root A",
    rank: 1,
    children: [leaf("Alpha"), leaf("Beta")],
  },
});

export const PROVIDER_CASES: readonly ProviderCase[] = Object.freeze([
  {
    name: "mapped compound identity, multiple roots and tied sibling order",
    model: "node",
    operation: "findMany",
    args: {
      where: { OR: [{ code: "root-a" }, { code: "root-b" }] },
      orderBy: { code: "asc" },
      select: {
        label: true,
        children: {
          recurse: { depth: 2 },
          where: { visible: true },
          orderBy: { rank: "asc" },
          select: { label: true, rank: true },
        },
      },
    },
    expected: [
      {
        label: "Root A",
        children: [
          {
            label: "Alpha",
            rank: 10,
            children: [{ label: "Alpha child", rank: 1 }],
          },
          {
            label: "Beta",
            rank: 10,
            children: [{ label: "Beta child", rank: 1 }],
          },
        ],
      },
      {
        label: "Root B",
        children: [{ label: "Gamma", rank: 1, children: [] }],
      },
    ],
  },
  {
    name: "owning foreign-key direction",
    model: "node",
    operation: "findMany",
    args: {
      where: { tenant: "t", code: "beta-child" },
      select: {
        label: true,
        parent: { recurse: { depth: 2 }, select: { label: true } },
      },
    },
    expected: [
      {
        label: "Beta child",
        parent: { label: "Beta", parent: { label: "Root A" } },
      },
    ],
  },
  {
    name: "inverse one-to-one direction",
    model: "chain",
    operation: "findMany",
    args: {
      where: { id: "c" },
      select: {
        id: true,
        previous: { recurse: { depth: 2 }, select: { id: true } },
      },
    },
    expected: [{ id: "c", previous: { id: "b", previous: { id: "a" } } }],
  },
  {
    name: "ordinary relation to recursive relation",
    model: "forest",
    operation: "findMany",
    args: {
      select: {
        name: true,
        entry: {
          select: {
            label: true,
            children: {
              recurse: { depth: 1 },
              where: { visible: true },
              orderBy: { rank: "asc" },
              select: { label: true },
            },
          },
        },
      },
    },
    expected: [
      {
        name: "Forest A",
        entry: { label: "Root A", children: [leaf("Alpha"), leaf("Beta")] },
      },
    ],
  },
  {
    name: "recursive node to ordinary relation and second recursive slot",
    model: "node",
    operation: "findMany",
    args: {
      where: { tenant: "t", code: "root-a" },
      select: {
        label: true,
        children: {
          recurse: { depth: 1 },
          where: { visible: true },
          orderBy: [{ rank: "asc" }, { code: "asc" }],
          select: {
            label: true,
            notes: { orderBy: { position: "asc" }, select: { text: true } },
            neighbors: { recurse: { depth: 1 }, select: { label: true } },
          },
        },
      },
    },
    expected: [
      {
        label: "Root A",
        children: [
          {
            label: "Alpha",
            notes: [{ text: "alpha first" }, { text: "alpha second" }],
            neighbors: [leaf("Merge")],
          },
          {
            label: "Beta",
            notes: [{ text: "beta note" }],
            neighbors: [leaf("Merge")],
          },
        ],
      },
    ],
  },
  {
    name: "junction diamond and cycle with exhaustive path pruning",
    model: "node",
    operation: "findMany",
    args: {
      where: { tenant: "t", code: "root-a" },
      select: {
        label: true,
        neighbors: {
          recurse: { depth: false },
          orderBy: { rank: "asc" },
          select: { label: true },
        },
      },
    },
    expected: [
      {
        label: "Root A",
        neighbors: [
          { label: "Alpha", neighbors: [{ label: "Merge", neighbors: [] }] },
          { label: "Beta", neighbors: [{ label: "Merge", neighbors: [] }] },
        ],
      },
    ],
  },
  {
    name: "junction cycle bounded unfolding",
    model: "node",
    operation: "findMany",
    args: {
      where: { tenant: "t", code: "root-a" },
      select: {
        label: true,
        neighbors: {
          recurse: { depth: 3, preventCycles: false },
          orderBy: { rank: "asc" },
          select: { label: true },
        },
      },
    },
    expected: [
      {
        label: "Root A",
        neighbors: [
          {
            label: "Alpha",
            neighbors: [{ label: "Merge", neighbors: [leaf("Root A")] }],
          },
          {
            label: "Beta",
            neighbors: [{ label: "Merge", neighbors: [leaf("Root A")] }],
          },
        ],
      },
    ],
  },
  {
    name: "mutation readback recursive placement",
    model: "node",
    operation: "update",
    args: {
      where: { tenant_code: { tenant: "t", code: "root-a" } },
      data: { rank: { increment: 1 } },
      select: {
        label: true,
        rank: true,
        children: {
          recurse: { depth: 1 },
          where: { visible: true },
          orderBy: { rank: "asc" },
          select: { label: true },
        },
      },
    },
    expected: {
      label: "Root A",
      rank: 2,
      children: [leaf("Alpha"), leaf("Beta")],
    },
  },
  {
    name: "pre-delete recursive readback placement",
    model: "node",
    operation: "delete",
    args: {
      where: { tenant_code: { tenant: "t", code: "root-b" } },
      select: {
        label: true,
        children: {
          recurse: { depth: 1 },
          orderBy: { rank: "asc" },
          select: { label: true },
        },
      },
    },
    expected: {
      label: "Root B",
      children: [leaf("Gamma")],
    },
  },
]);

// ===========================================================================
// RQ-03 / RQ-04 worlds — provider-neutral tables, cases grouped by falsifier.
//
// Every expectation below is written by hand from the stored rows; none is
// read back from a candidate. A group is ONE registered cell on SQLite and
// PGlite; the native lane runs every group of a world inside one live world.
// ===========================================================================

export type ColumnType = "text" | "integer" | "boolean" | "json";

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable?: true;
  readonly unique?: true;
}

/** One table, spelled by each provider test in its own DDL and literals. */
export interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  readonly primaryKey: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

/**
 * One table's column and primary-key definitions in a provider's DDL: the one
 * speller of the provider-neutral table language, for every provider test and
 * native campaign alike.
 */
export function columnDefinitions(
  table: Omit<TableSpec, "rows">,
  types: Readonly<Record<ColumnType, string>>,
  quote: (identifier: string) => string
): string {
  return [
    ...table.columns.map(
      (column) =>
        `${quote(column.name)} ${types[column.type]}${
          column.nullable ? "" : " NOT NULL"
        }${column.unique ? " UNIQUE" : ""}`
    ),
    `PRIMARY KEY (${table.primaryKey.map(quote).join(", ")})`,
  ].join(", ");
}

export interface CaseGroup {
  readonly name: string;
  readonly cases: readonly ProviderCase[];
}

export interface RecursiveWorld {
  readonly name: string;
  readonly schema: Schema;
  readonly tables: readonly TableSpec[];
  readonly groups: readonly CaseGroup[];
}

type Occurrence = Record<string, unknown>;

function occurrence(value: unknown): Occurrence {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "a recursive occurrence is one public object"
  );
  return value as Occurrence;
}

/**
 * One recursive chain, read ITERATIVELY from its outer row: the `field` of
 * every occurrence along it (its label unless a caller names another field)
 * and how it ends — `omitted` (numeric cutoff: the repeated key is absent),
 * `empty` (a collection's natural end) or `null` (a singular's). A thousand
 * nested levels are too deep for a recursive deep-equal to be the judge.
 */
export function chainSummary(relation: string, field = "label") {
  return (value: unknown) => {
    const labels: unknown[] = [];
    let current = occurrence(value);
    for (;;) {
      if (!Object.hasOwn(current, relation)) return { labels, end: "omitted" };
      const next = current[relation];
      if (next === null) return { labels, end: "null" };
      if (Array.isArray(next)) {
        if (next.length === 0) return { labels, end: "empty" };
        if (next.length !== 1) return { labels, end: `branching ${next.length}` };
        current = occurrence(next[0]);
      } else current = occurrence(next);
      labels.push(current[field]);
    }
  };
}

/** Every public occurrence under the outer row's slot, counted iteratively. */
export function occurrenceCount(relation: string) {
  return (value: unknown) => {
    let occurrences = 0;
    const pending: unknown[] = [occurrence(value)[relation]];
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === null || next === undefined) continue;
      for (const member of Array.isArray(next) ? next : [next]) {
        occurrences += 1;
        pending.push(occurrence(member)[relation]);
      }
    }
    return { occurrences };
  };
}

const labels = (prefix: string, from: number, to: number) => {
  const step = from <= to ? 1 : -1;
  const out: string[] = [];
  for (let index = from; index !== to + step; index += step)
    out.push(`${prefix}${index}`);
  return out;
};

const cycle = (relation: string) =>
  `Recursive relation '${relation}' contains a cycle.`;

// ---------------------------------------------------------------------------
// RQ-03 — foreign-key chains and hierarchies
// ---------------------------------------------------------------------------

export const SPINE_TABLE = "rq_provider_spine";
export const STEP_TABLE = "rq_provider_steps";
export const ALTERNATE_TABLE = "rq_provider_alternates";
export const PAIR_TABLE = "rq_provider_pairs";
export const PAIR_LINK_TABLE = "rq_provider_pair_links";
/** Beyond MySQL's default recursion ceiling and the public depth ceiling. */
export const SPINE_LENGTH = 1_100;

export const hierarchySchema = (() => {
  const spine = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int().nullable().map("parent_id"),
      parent: s
        .toOne(() => spine)
        .fields("parentId")
        .references("id")
        .name("spine"),
      children: s.toMany(() => spine).name("spine"),
    })
    .map(SPINE_TABLE);
  const step = s
    .model({
      id: s.int().id(),
      label: s.string(),
      nextId: s.int().nullable().unique().map("next_id"),
      next: s
        .toOne(() => step)
        .fields("nextId")
        .references("id")
        .name("steps"),
      previous: s.toOne(() => step).name("steps"),
    })
    .map(STEP_TABLE);
  /**
   * The reference is an ALTERNATE nullable unique (`code`), not the row's
   * primary identity (`id`): two rows with a NULL `code` are two nodes, and
   * neither is anyone's parent.
   */
  const alternate = s
    .model({
      id: s.string().id(),
      code: s.string().nullable().unique(),
      label: s.string(),
      parentCode: s.string().nullable().map("parent_code"),
      parent: s
        .toOne(() => alternate)
        .fields("parentCode")
        .references("code")
        .name("alternate"),
      children: s.toMany(() => alternate).name("alternate"),
    })
    .map(ALTERNATE_TABLE);
  /**
   * A compound identity declared in the OTHER order from its scalars: the one
   * shape where the row key's constraint order (`code`, `tenant`) and the
   * order owner's identity order (`tenant`, `code`) differ, so it is where a
   * second complete-key tie-break would show.
   */
  const pair = s
    .model({
      tenant: s.string(),
      code: s.string(),
      rank: s.int(),
      parentCode: s.string().nullable().map("parent_code"),
      parentTenant: s.string().nullable().map("parent_tenant"),
      parent: s
        .toOne(() => pair)
        .fields("parentCode", "parentTenant")
        .references("code", "tenant")
        .name("pairs"),
      children: s.toMany(() => pair).name("pairs"),
      links: s
        .toMany(() => pair)
        .name("pairLinks")
        .through(PAIR_LINK_TABLE)
        .source("from")
        .target("to"),
      linkedBy: s.toMany(() => pair).name("pairLinks"),
    })
    .id(["code", "tenant"])
    .map(PAIR_TABLE);
  return { spine, step, alternate, pair };
})();

const spineRow = (id: number, label: string, parent: number | null) => ({
  id,
  label,
  parent_id: parent,
});

export const HIERARCHY_TABLES: readonly TableSpec[] = Object.freeze([
  {
    name: SPINE_TABLE,
    columns: [
      { name: "id", type: "integer" },
      { name: "label", type: "text" },
      { name: "parent_id", type: "integer", nullable: true },
    ],
    primaryKey: ["id"],
    rows: [
      // A chain s0 ← s1 ← … ← s1100: `children` walks down, `parent` up.
      spineRow(0, "s0", null),
      ...Array.from({ length: SPINE_LENGTH }, (_, index) =>
        spineRow(index + 1, `s${index + 1}`, index)
      ),
      // A three-row FK ring: every hop from any member closes it at hop 3.
      spineRow(2001, "ring-1", 2003),
      spineRow(2002, "ring-2", 2001),
      spineRow(2003, "ring-3", 2002),
      // A lasso: lasso-1 → lasso-2 ⇄ lasso-3 upward, a cycle off the root.
      spineRow(3001, "lasso-1", 3002),
      spineRow(3002, "lasso-2", 3003),
      spineRow(3003, "lasso-3", 3002),
      // A row that is its own parent.
      spineRow(4001, "self", 4001),
      // A small tree whose leaves end BEFORE any cutoff below.
      spineRow(5001, "tree", null),
      spineRow(5002, "tree-a", 5001),
      spineRow(5003, "tree-a-1", 5002),
      spineRow(5004, "tree-b", 5001),
    ],
  },
  {
    name: STEP_TABLE,
    columns: [
      { name: "id", type: "integer" },
      { name: "label", type: "text" },
      { name: "next_id", type: "integer", nullable: true, unique: true },
    ],
    primaryKey: ["id"],
    rows: [
      { id: 1, label: "step-1", next_id: 2 },
      { id: 2, label: "step-2", next_id: 3 },
      { id: 3, label: "step-3", next_id: null },
      { id: 10, label: "step-10", next_id: null },
    ],
  },
  {
    name: ALTERNATE_TABLE,
    columns: [
      { name: "id", type: "text" },
      { name: "code", type: "text", nullable: true, unique: true },
      { name: "label", type: "text" },
      { name: "parent_code", type: "text", nullable: true },
    ],
    primaryKey: ["id"],
    rows: [
      { id: "a1", code: "A", label: "A", parent_code: null },
      { id: "a2", code: "B", label: "B", parent_code: "A" },
      { id: "a3", code: null, label: "unreferenced-1", parent_code: "A" },
      { id: "a4", code: null, label: "unreferenced-2", parent_code: "A" },
      { id: "a5", code: "C", label: "C", parent_code: "B" },
      { id: "a6", code: "D", label: "D", parent_code: "C" },
    ],
  },
  {
    name: PAIR_TABLE,
    columns: [
      { name: "tenant", type: "text" },
      { name: "code", type: "text" },
      { name: "rank", type: "integer" },
      { name: "parent_code", type: "text", nullable: true },
      { name: "parent_tenant", type: "text", nullable: true },
    ],
    primaryKey: ["code", "tenant"],
    // Three siblings tied on `rank`: by tenant they read a, b, c; by code the
    // reverse (w, x, y).
    rows: [
      { tenant: "r", code: "root", rank: 0, parent_code: null, parent_tenant: null },
      { tenant: "b", code: "x", rank: 1, parent_code: "root", parent_tenant: "r" },
      { tenant: "a", code: "y", rank: 1, parent_code: "root", parent_tenant: "r" },
      { tenant: "c", code: "w", rank: 1, parent_code: "root", parent_tenant: "r" },
    ],
  },
  {
    name: PAIR_LINK_TABLE,
    // Junction members follow the row key's constraint order: `_1` is `code`.
    columns: [
      { name: "from_1", type: "text" },
      { name: "from_2", type: "text" },
      { name: "to_1", type: "text" },
      { name: "to_2", type: "text" },
    ],
    primaryKey: ["from_1", "from_2", "to_1", "to_2"],
    rows: [
      { from_1: "root", from_2: "r", to_1: "x", to_2: "b" },
      { from_1: "root", from_2: "r", to_1: "y", to_2: "a" },
      { from_1: "root", from_2: "r", to_1: "w", to_2: "c" },
    ],
  },
]);

const spineRead = (
  id: number,
  relation: "children" | "parent",
  recurse: unknown,
  extra: Record<string, unknown> = {}
) => ({
  where: { id },
  select: {
    label: true,
    [relation]: {
      recurse,
      ...(relation === "children" ? { orderBy: { id: "asc" } } : {}),
      ...extra,
      select: { label: true },
    },
  },
});

const spineChain = (
  name: string,
  id: number,
  relation: "children" | "parent",
  recurse: unknown,
  expected: { labels: string[]; end: string },
  transport?: number
): ProviderCase => ({
  name,
  model: "spine",
  operation: "findUnique",
  args: spineRead(id, relation, recurse),
  summarize: chainSummary(relation),
  expected,
  ...(transport === undefined
    ? {}
    : { transport: { relation, nodes: transport, edges: transport } }),
});

const node = (label: string, relation?: string, members?: unknown) =>
  relation === undefined ? { label } : { label, [relation]: members };

export const HIERARCHY_GROUPS: readonly CaseGroup[] = Object.freeze([
  {
    name: "RQ-03 FK directions and inverse one-to-one end naturally before the cutoff",
    cases: [
      {
        name: "downward collection: [] at a natural end before the cutoff",
        model: "spine",
        operation: "findUnique",
        args: spineRead(5001, "children", { depth: 3 }),
        expected: node("tree", "children", [
          node("tree-a", "children", [node("tree-a-1", "children", [])]),
          node("tree-b", "children", []),
        ]),
        transport: { relation: "children", nodes: 3, edges: 3 },
      },
      {
        name: "upward owning singular: null at a natural end before the cutoff",
        model: "spine",
        operation: "findUnique",
        args: spineRead(5003, "parent", { depth: 3 }),
        expected: node(
          "tree-a-1",
          "parent",
          node("tree-a", "parent", node("tree", "parent", null))
        ),
        transport: { relation: "parent", nodes: 2, edges: 2 },
      },
      {
        name: "the outer collection key is present at a natural end",
        model: "spine",
        operation: "findUnique",
        args: spineRead(5004, "children", { depth: 3 }),
        expected: node("tree-b", "children", []),
        transport: { relation: "children", nodes: 0, edges: 0 },
      },
      {
        name: "the outer singular key is present at a natural end",
        model: "spine",
        operation: "findUnique",
        args: spineRead(5001, "parent", true),
        expected: node("tree", "parent", null),
      },
      {
        name: "inverse one-to-one ends naturally before the cutoff",
        model: "step",
        operation: "findUnique",
        args: {
          where: { id: 3 },
          select: {
            label: true,
            previous: { recurse: { depth: 5 }, select: { label: true } },
          },
        },
        expected: node(
          "step-3",
          "previous",
          node("step-2", "previous", node("step-1", "previous", null))
        ),
        transport: { relation: "previous", nodes: 2, edges: 2 },
      },
      {
        name: "inverse one-to-one outer key is null when nothing refers to the row",
        model: "step",
        operation: "findUnique",
        args: {
          where: { id: 10 },
          select: {
            label: true,
            previous: { recurse: true, select: { label: true } },
          },
        },
        expected: node("step-10", "previous", null),
      },
      {
        name: "owning one-to-one: exhaustive to the natural end",
        model: "step",
        operation: "findMany",
        args: {
          where: { id: { in: [1, 2] } },
          orderBy: { id: "asc" },
          select: {
            label: true,
            next: { recurse: { depth: false }, select: { label: true } },
          },
        },
        expected: [
          node(
            "step-1",
            "next",
            node("step-2", "next", node("step-3", "next", null))
          ),
          node("step-2", "next", node("step-3", "next", null)),
        ],
        check(value) {
          assert(Array.isArray(value));
          const [first, second] = value.map(occurrence);
          // Each root's carrier unfolds its OWN occurrences: `step-3` under
          // step-1 → step-2 and `step-3` under the root step-2 are equal
          // values and two objects.
          const nested = occurrence(occurrence(occurrence(first).next).next);
          const direct = occurrence(occurrence(second).next);
          assert.deepEqual(nested, direct);
          assert.notStrictEqual(nested, direct);
        },
      },
      {
        name: "owning one-to-one at depth 1 omits the repeated key",
        model: "step",
        operation: "findUnique",
        args: {
          where: { id: 1 },
          select: {
            label: true,
            next: { recurse: { depth: 1 }, select: { label: true } },
          },
        },
        expected: node("step-1", "next", node("step-2")),
        transport: { relation: "next", nodes: 1, edges: 1 },
      },
    ],
  },
  {
    name: "RQ-03 depth 1, 2, 100 (the default) and 1000 cut off without an extra hop",
    cases: [
      spineChain(
        "depth 1",
        0,
        "children",
        { depth: 1 },
        { labels: ["s1"], end: "omitted" },
        1
      ),
      spineChain(
        "depth 2",
        0,
        "children",
        { depth: 2 },
        { labels: ["s1", "s2"], end: "omitted" },
        2
      ),
      spineChain(
        "recurse: true is depth 100",
        0,
        "children",
        true,
        { labels: labels("s", 1, 100), end: "omitted" },
        100
      ),
      spineChain(
        "recurse: {} is depth 100",
        0,
        "children",
        {},
        { labels: labels("s", 1, 100), end: "omitted" },
        100
      ),
      spineChain(
        "depth 1000 downward",
        0,
        "children",
        { depth: 1000 },
        { labels: labels("s", 1, 1000), end: "omitted" },
        1000
      ),
      spineChain(
        "depth 1000 upward",
        SPINE_LENGTH,
        "parent",
        { depth: 1000 },
        { labels: labels("s", SPINE_LENGTH - 1, SPINE_LENGTH - 1000), end: "omitted" },
        1000
      ),
      spineChain(
        "depth 1000 upward ends naturally at the chain's root",
        2,
        "parent",
        { depth: 1000 },
        { labels: ["s1", "s0"], end: "null" },
        2
      ),
    ],
  },
  {
    name: "RQ-03 an exhaustive acyclic chain beyond the public depth ceiling",
    cases: [
      {
        ...spineChain(
          "exhaustive downward to the natural end",
          0,
          "children",
          { depth: false },
          { labels: labels("s", 1, SPINE_LENGTH), end: "empty" },
          SPINE_LENGTH
        ),
        exceedsMySQLRecursionLimit: true,
      },
      {
        ...spineChain(
          "exhaustive upward to the natural end",
          SPINE_LENGTH,
          "parent",
          { depth: false },
          { labels: labels("s", SPINE_LENGTH - 1, 0), end: "null" },
          SPINE_LENGTH
        ),
        exceedsMySQLRecursionLimit: true,
      },
    ],
  },
  {
    name: "RQ-03 an FK cycle closing inside the traversed window fails; outside it, it does not",
    cases: [
      {
        name: "ring closes at hop 3: depth 2 is outside the window",
        model: "spine",
        operation: "findUnique",
        args: spineRead(2001, "children", { depth: 2 }),
        expected: node("ring-1", "children", [
          node("ring-2", "children", [node("ring-3")]),
        ]),
        transport: { relation: "children", nodes: 2, edges: 2 },
      },
      {
        name: "ring closes at hop 3: depth 3 is inside the window",
        model: "spine",
        operation: "findUnique",
        args: spineRead(2001, "children", { depth: 3 }),
        failure: cycle("children"),
      },
      {
        name: "ring, exhaustive downward",
        model: "spine",
        operation: "findUnique",
        args: spineRead(2001, "children", { depth: false }),
        failure: cycle("children"),
      },
      {
        name: "ring upward, depth 2 is outside the window",
        model: "spine",
        operation: "findUnique",
        args: spineRead(2001, "parent", { depth: 2 }),
        expected: node(
          "ring-1",
          "parent",
          node("ring-3", "parent", node("ring-2"))
        ),
      },
      {
        name: "ring upward, depth 3 is inside the window",
        model: "spine",
        operation: "findUnique",
        args: spineRead(2001, "parent", { depth: 3 }),
        failure: cycle("parent"),
      },
      {
        name: "lasso: a cycle off the outer row, outside the window",
        model: "spine",
        operation: "findUnique",
        args: spineRead(3001, "parent", { depth: 2 }),
        expected: node(
          "lasso-1",
          "parent",
          node("lasso-2", "parent", node("lasso-3"))
        ),
      },
      {
        name: "lasso: a cycle off the outer row, inside the window",
        model: "spine",
        operation: "findUnique",
        args: spineRead(3001, "parent", { depth: 3 }),
        failure: cycle("parent"),
      },
      {
        name: "lasso, exhaustive upward",
        model: "spine",
        operation: "findUnique",
        args: spineRead(3001, "parent", { depth: false }),
        failure: cycle("parent"),
      },
      {
        name: "lasso downward: the closing edge sits beyond depth 1",
        model: "spine",
        operation: "findUnique",
        args: spineRead(3002, "children", { depth: 1 }),
        expected: node("lasso-2", "children", [
          node("lasso-1"),
          node("lasso-3"),
        ]),
      },
      {
        name: "lasso downward: the closing edge sits at depth 2",
        model: "spine",
        operation: "findUnique",
        args: spineRead(3002, "children", { depth: 2 }),
        failure: cycle("children"),
      },
      {
        name: "a row that is its own child closes at hop 1",
        model: "spine",
        operation: "findUnique",
        args: spineRead(4001, "children", { depth: 1 }),
        failure: cycle("children"),
      },
      {
        name: "a row that is its own parent closes at hop 1",
        model: "spine",
        operation: "findUnique",
        args: spineRead(4001, "parent", { depth: 1 }),
        failure: cycle("parent"),
      },
      {
        name: "independent roots on one ring are never globally deduplicated",
        model: "spine",
        operation: "findMany",
        args: {
          where: { id: { in: [2001, 2002, 2003] } },
          orderBy: { id: "asc" },
          select: {
            label: true,
            children: {
              recurse: { depth: 2 },
              orderBy: { id: "asc" },
              select: { label: true },
            },
          },
        },
        expected: [
          node("ring-1", "children", [
            node("ring-2", "children", [node("ring-3")]),
          ]),
          node("ring-2", "children", [
            node("ring-3", "children", [node("ring-1")]),
          ]),
          node("ring-3", "children", [
            node("ring-1", "children", [node("ring-2")]),
          ]),
        ],
        check(value) {
          assert(Array.isArray(value));
          const [first, second] = value.map(occurrence);
          const nested = occurrence(
            (occurrence(first).children as unknown[])[0]
          );
          assert.notStrictEqual(nested, second);
        },
      },
    ],
  },
  {
    name: "RQ-03 an alternate nullable reference is not the row's primary identity",
    cases: [
      {
        name: "two unreferenced rows with a NULL reference are two leaves",
        model: "alternate",
        operation: "findUnique",
        args: {
          where: { id: "a1" },
          select: {
            label: true,
            children: {
              recurse: { depth: 2 },
              orderBy: { id: "asc" },
              select: { label: true },
            },
          },
        },
        expected: node("A", "children", [
          node("B", "children", [node("C")]),
          node("unreferenced-1", "children", []),
          node("unreferenced-2", "children", []),
        ]),
        transport: { relation: "children", nodes: 4, edges: 4 },
      },
      {
        name: "upward through the alternate reference to the natural end",
        model: "alternate",
        operation: "findMany",
        args: {
          where: { id: { in: ["a3", "a6"] } },
          orderBy: { id: "asc" },
          select: {
            label: true,
            parent: { recurse: { depth: false }, select: { label: true } },
          },
        },
        expected: [
          node("unreferenced-1", "parent", node("A", "parent", null)),
          node(
            "D",
            "parent",
            node("C", "parent", node("B", "parent", node("A", "parent", null)))
          ),
        ],
      },
    ],
  },
  {
    name: "RQ-03/RQ-04 sibling ties break on the order owner's one complete key",
    cases: [
      {
        name: "ordinary windowed collection: the order owner's tie-break",
        control: true,
        model: "pair",
        operation: "findMany",
        args: {
          where: { code: "root" },
          select: {
            code: true,
            children: {
              orderBy: { rank: "asc" },
              take: 10,
              select: { tenant: true, code: true },
            },
          },
        },
        expected: [
          {
            code: "root",
            children: [
              { tenant: "a", code: "y" },
              { tenant: "b", code: "x" },
              { tenant: "c", code: "w" },
            ],
          },
        ],
      },
      {
        name: "recursive FK collection: the same ties in the same order",
        model: "pair",
        operation: "findMany",
        args: {
          where: { code: "root" },
          select: {
            code: true,
            children: {
              recurse: { depth: 1 },
              orderBy: { rank: "asc" },
              select: { tenant: true, code: true },
            },
          },
        },
        expected: [
          {
            code: "root",
            children: [
              { tenant: "a", code: "y" },
              { tenant: "b", code: "x" },
              { tenant: "c", code: "w" },
            ],
          },
        ],
      },
      {
        name: "recursive junction graph: the same ties in the same order",
        model: "pair",
        operation: "findMany",
        args: {
          where: { code: "root" },
          select: {
            code: true,
            links: {
              recurse: { depth: 1 },
              orderBy: { rank: "asc" },
              select: { tenant: true, code: true },
            },
          },
        },
        expected: [
          {
            code: "root",
            links: [
              { tenant: "a", code: "y" },
              { tenant: "b", code: "x" },
              { tenant: "c", code: "w" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "RQ-03 omitted compound keys stay the private identity in both directions",
    cases: [
      {
        name: "three siblings whose public rows are identical stay three occurrences",
        model: "pair",
        operation: "findMany",
        args: {
          where: { code: "root" },
          select: {
            rank: true,
            children: {
              recurse: { depth: false },
              orderBy: { rank: "asc" },
              select: { rank: true },
            },
          },
        },
        expected: [
          {
            rank: 0,
            children: [
              { rank: 1, children: [] },
              { rank: 1, children: [] },
              { rank: 1, children: [] },
            ],
          },
        ],
      },
      {
        name: "upward through a compound reference with the key omitted",
        model: "pair",
        operation: "findMany",
        args: {
          where: { code: "x" },
          select: {
            rank: true,
            parent: { recurse: { depth: 3 }, select: { rank: true } },
          },
        },
        expected: [{ rank: 1, parent: { rank: 0, parent: null } }],
      },
    ],
  },
  {
    name: "RQ-03 include placement, counts and a second recursive slot in the repeated node",
    cases: [
      {
        name: "include: default scalars, _count and the reverse direction at every level",
        model: "spine",
        operation: "findUnique",
        args: {
          where: { id: 5001 },
          include: {
            children: {
              recurse: { depth: 2 },
              orderBy: { id: "asc" },
              include: {
                parent: { recurse: { depth: 1 }, select: { label: true } },
                _count: { select: { children: true } },
              },
            },
          },
        },
        expected: {
          id: 5001,
          label: "tree",
          parentId: null,
          children: [
            {
              id: 5002,
              label: "tree-a",
              parentId: 5001,
              parent: { label: "tree" },
              _count: { children: 1 },
              children: [
                {
                  id: 5003,
                  label: "tree-a-1",
                  parentId: 5002,
                  parent: { label: "tree-a" },
                  _count: { children: 0 },
                },
              ],
            },
            {
              id: 5004,
              label: "tree-b",
              parentId: 5001,
              parent: { label: "tree" },
              _count: { children: 0 },
              children: [],
            },
          ],
        },
      },
    ],
  },
]);

export const HIERARCHY_WORLD: RecursiveWorld = Object.freeze({
  name: "RQ-03 foreign-key chains and hierarchies",
  schema: hierarchySchema,
  tables: HIERARCHY_TABLES,
  groups: HIERARCHY_GROUPS,
});

// ---------------------------------------------------------------------------
// RQ-04 — junction graphs through the same mechanism
// ---------------------------------------------------------------------------

export const VERTEX_TABLE = "rq_provider_vertices";
export const ARC_TABLE = "rq_provider_arcs";
export const HOLDER_TABLE = "rq_provider_holders";
/** Rungs of the measurement ladder: every rung doubles the simple paths. */
export const LADDER_RUNGS = 8;

export const graphSchema = (() => {
  const vertex = s
    .model({
      id: s.string().id(),
      label: s.string(),
      rank: s.int(),
      open: s.boolean(),
      payload: s.json(),
      out: s
        .toMany(() => vertex)
        .name("arc")
        .through(ARC_TABLE)
        .source("tail")
        .target("head"),
      in: s.toMany(() => vertex).name("arc"),
      holders: s.toMany(() => holder).name("holder"),
    })
    .map(VERTEX_TABLE);
  const holder = s
    .model({
      id: s.string().id(),
      name: s.string(),
      vertexId: s.string().map("vertex_id"),
      vertex: s
        .toOne(() => vertex)
        .fields("vertexId")
        .references("id")
        .name("holder"),
    })
    .map(HOLDER_TABLE);
  return { vertex, holder };
})();

const vertexRow = (id: string, rank: number, open = true) => ({
  id,
  label: id,
  rank,
  open,
  payload: JSON.stringify({ id }),
});

const ladderVertices = () => {
  const rows = [vertexRow("m0", 0)];
  for (let rung = 1; rung <= LADDER_RUNGS; rung += 1)
    rows.push(
      vertexRow(`m${rung}a`, 1),
      vertexRow(`m${rung}b`, 2),
      vertexRow(`m${rung}`, 0)
    );
  return rows;
};

const ladderArcs = () => {
  const rows: [string, string][] = [];
  for (let rung = 1; rung <= LADDER_RUNGS; rung += 1)
    rows.push(
      [`m${rung - 1}`, `m${rung}a`],
      [`m${rung - 1}`, `m${rung}b`],
      [`m${rung}a`, `m${rung}`],
      [`m${rung}b`, `m${rung}`]
    );
  return rows;
};

const ARCS: readonly (readonly [string, string])[] = [
  // A diamond with a shared tail, and a row pointing INTO it from outside.
  ["d0", "d1"],
  ["d0", "d2"],
  ["d1", "d3"],
  ["d2", "d3"],
  ["d3", "d4"],
  ["z0", "d1"],
  // Converging paths of different lengths.
  ["c0", "c1"],
  ["c1", "c2"],
  ["c0", "c2"],
  // A self-loop on the outer row and another one level below.
  ["l0", "l0"],
  ["l0", "l1"],
  ["l1", "l1"],
  // A cycle back to the outer row.
  ["r0", "r1"],
  ["r1", "r2"],
  ["r2", "r0"],
  // Every ordered pair of three rows: the simple paths.
  ["k0", "k1"],
  ["k0", "k2"],
  ["k1", "k2"],
  ["k2", "k1"],
  ["k1", "k0"],
  ["k2", "k0"],
  // b1 and b4 are closed: a filtered bridge and a filtered inner hop.
  ["b0", "b1"],
  ["b1", "b2"],
  ["b0", "b3"],
  ["b3", "b4"],
  ["b4", "b5"],
  ["b3", "b2"],
  ...ladderArcs(),
];

export const GRAPH_TABLES: readonly TableSpec[] = Object.freeze([
  {
    name: VERTEX_TABLE,
    columns: [
      { name: "id", type: "text" },
      { name: "label", type: "text" },
      { name: "rank", type: "integer" },
      { name: "open", type: "boolean" },
      { name: "payload", type: "json" },
    ],
    primaryKey: ["id"],
    rows: [
      ...["d0", "d1", "d2", "d3", "d4"].map((id, rank) => vertexRow(id, rank)),
      vertexRow("z0", 9),
      vertexRow("x0", 0),
      ...["c0", "c1", "c2"].map((id, rank) => vertexRow(id, rank)),
      ...["l0", "l1"].map((id, rank) => vertexRow(id, rank)),
      ...["r0", "r1", "r2"].map((id, rank) => vertexRow(id, rank)),
      ...["k0", "k1", "k2"].map((id, rank) => vertexRow(id, rank)),
      ...["b0", "b1", "b2", "b3", "b4", "b5"].map((id, rank) =>
        vertexRow(id, rank, id !== "b1" && id !== "b4")
      ),
      ...ladderVertices(),
    ],
  },
  {
    name: ARC_TABLE,
    columns: [
      { name: "tail", type: "text" },
      { name: "head", type: "text" },
    ],
    primaryKey: ["tail", "head"],
    rows: ARCS.map(([tail, head]) => ({ tail, head })),
  },
  {
    name: HOLDER_TABLE,
    columns: [
      { name: "id", type: "text" },
      { name: "name", type: "text" },
      { name: "vertex_id", type: "text" },
    ],
    primaryKey: ["id"],
    rows: [
      { id: "h1", name: "h1", vertex_id: "d0" },
      { id: "h2", name: "h2", vertex_id: "r0" },
    ],
  },
]);

const walk = (
  id: string,
  relation: "out" | "in",
  recurse: unknown,
  extra: Record<string, unknown> = {}
) => ({
  where: { id },
  select: {
    label: true,
    [relation]: {
      recurse,
      orderBy: { rank: "asc" },
      ...extra,
      select: { label: true },
    },
  },
});

const graphCase = (
  name: string,
  id: string,
  relation: "out" | "in",
  recurse: unknown,
  expected: unknown,
  transport?: { nodes: number; edges: number },
  extra: Record<string, unknown> = {}
): ProviderCase => ({
  name,
  model: "vertex",
  operation: "findUnique",
  args: walk(id, relation, recurse, extra),
  expected,
  ...(transport === undefined ? {} : { transport: { relation, ...transport } }),
});

const diamondTree = (relation: string) => [
  node("d1", relation, [
    node("d3", relation, [node("d4", relation, [])]),
  ]),
  node("d2", relation, [
    node("d3", relation, [node("d4", relation, [])]),
  ]),
];

/** The same stored row on two paths is two public objects, leaves included. */
function assertFreshDiamond(value: unknown): void {
  const [left, right] = occurrence(value).out as unknown[];
  const leftShared = occurrence((occurrence(left).out as unknown[])[0]);
  const rightShared = occurrence((occurrence(right).out as unknown[])[0]);
  assert.deepEqual(leftShared, rightShared);
  assert.notStrictEqual(leftShared, rightShared);
  assert.notStrictEqual(leftShared.payload, rightShared.payload);
  assert.notStrictEqual(leftShared.out, rightShared.out);
  const leftTail = occurrence((leftShared.out as unknown[])[0]);
  const rightTail = occurrence((rightShared.out as unknown[])[0]);
  assert.notStrictEqual(leftTail, rightTail);
  assert.notStrictEqual(leftTail.payload, rightTail.payload);
  (leftTail.payload as Record<string, unknown>).changed = true;
  assert.equal((rightTail.payload as Record<string, unknown>).changed, undefined);
}

const ladder = (from: string, rungs: number): ProviderCase => ({
  name: `ladder of ${rungs}: transport grows with facts, output with paths`,
  model: "vertex",
  operation: "findUnique",
  args: walk(from, "out", { depth: false }),
  summarize: occurrenceCount("out"),
  expected: { occurrences: 4 * (2 ** rungs - 1) },
  transport: { relation: "out", nodes: 3 * rungs, edges: 4 * rungs },
});

export const GRAPH_GROUPS: readonly CaseGroup[] = Object.freeze([
  {
    name: "RQ-04 both paired directions, a diamond, converging paths and disconnected rows",
    cases: [
      {
        name: "a diamond's shared descendant occurs once per path",
        model: "vertex",
        operation: "findUnique",
        args: {
          where: { id: "d0" },
          select: {
            label: true,
            out: {
              recurse: true,
              orderBy: { rank: "asc" },
              select: { label: true, payload: true },
            },
          },
        },
        expected: {
          label: "d0",
          out: [
            {
              label: "d1",
              payload: { id: "d1" },
              out: [
                {
                  label: "d3",
                  payload: { id: "d3" },
                  out: [{ label: "d4", payload: { id: "d4" }, out: [] }],
                },
              ],
            },
            {
              label: "d2",
              payload: { id: "d2" },
              out: [
                {
                  label: "d3",
                  payload: { id: "d3" },
                  out: [{ label: "d4", payload: { id: "d4" }, out: [] }],
                },
              ],
            },
          ],
        },
        check: assertFreshDiamond,
        transport: { relation: "out", nodes: 4, edges: 5 },
      },
      graphCase(
        "the paired inverse direction walks the same junction backwards",
        "d3",
        "in",
        true,
        node("d3", "in", [
          node("d1", "in", [node("d0", "in", []), node("z0", "in", [])]),
          node("d2", "in", [node("d0", "in", [])]),
        ]),
        { nodes: 4, edges: 5 }
      ),
      graphCase(
        "converging paths: one row is a natural end at depth 1 and cut off at depth 2",
        "c0",
        "out",
        { depth: 2 },
        node("c0", "out", [
          node("c1", "out", [node("c2")]),
          node("c2", "out", []),
        ]),
        { nodes: 2, edges: 3 }
      ),
      graphCase(
        "a disconnected row has an empty outgoing slot",
        "x0",
        "out",
        true,
        node("x0", "out", []),
        { nodes: 0, edges: 0 }
      ),
      graphCase(
        "a disconnected row has an empty incoming slot",
        "x0",
        "in",
        true,
        node("x0", "in", [])
      ),
    ],
  },
  {
    name: "RQ-04 self-loops, a cycle to the outer row, pruning versus bounded unfolding, simple paths",
    cases: [
      graphCase(
        "default prevention prunes both self-loops",
        "l0",
        "out",
        true,
        node("l0", "out", [node("l1", "out", [])])
      ),
      graphCase(
        "bounded unfolding repeats self-loops to the cutoff",
        "l0",
        "out",
        { depth: 3, preventCycles: false },
        node("l0", "out", [
          node("l0", "out", [
            node("l0", "out", [node("l0"), node("l1")]),
            node("l1", "out", [node("l1")]),
          ]),
          node("l1", "out", [node("l1", "out", [node("l1")])]),
        ]),
        { nodes: 2, edges: 8 }
      ),
      graphCase(
        "default prevention prunes the edge back to the outer row",
        "r0",
        "out",
        true,
        node("r0", "out", [node("r1", "out", [node("r2", "out", [])])])
      ),
      graphCase(
        "exhaustive traversal always prevents cycles",
        "r0",
        "out",
        { depth: false },
        node("r0", "out", [node("r1", "out", [node("r2", "out", [])])]),
        { nodes: 3, edges: 3 }
      ),
      graphCase(
        "a cycle outside a bounded window needs no pruning",
        "r0",
        "out",
        { depth: 2 },
        node("r0", "out", [node("r1", "out", [node("r2")])])
      ),
      graphCase(
        "bounded unfolding returns the outer row as a new occurrence",
        "r0",
        "out",
        { depth: 5, preventCycles: false },
        node("r0", "out", [
          node("r1", "out", [
            node("r2", "out", [
              node("r0", "out", [node("r1", "out", [node("r2")])]),
            ]),
          ]),
        ]),
        { nodes: 3, edges: 5 }
      ),
      {
        name: "prevention disabled at the default depth unfolds to 100 levels",
        model: "vertex",
        operation: "findUnique",
        args: walk("r0", "out", { preventCycles: false }),
        summarize: occurrenceCount("out"),
        expected: { occurrences: 100 },
        transport: { relation: "out", nodes: 3, edges: 100 },
      },
      graphCase(
        "exhaustive simple paths through every ordered pair",
        "k0",
        "out",
        { depth: false },
        node("k0", "out", [
          node("k1", "out", [node("k2", "out", [])]),
          node("k2", "out", [node("k1", "out", [])]),
        ]),
        { nodes: 3, edges: 6 }
      ),
      graphCase(
        "bounded unfolding through every ordered pair",
        "k0",
        "out",
        { depth: 2, preventCycles: false },
        node("k0", "out", [
          node("k1", "out", [node("k0"), node("k2")]),
          node("k2", "out", [node("k0"), node("k1")]),
        ]),
        { nodes: 3, edges: 6 }
      ),
    ],
  },
  {
    name: "RQ-04 the collection filter prunes every hop, a bridge included",
    cases: [
      graphCase(
        "a filtered bridge hides what only it reaches",
        "b0",
        "out",
        { depth: false },
        node("b0", "out", [node("b3", "out", [node("b2", "out", [])])]),
        { nodes: 2, edges: 2 },
        { where: { open: true } }
      ),
      graphCase(
        "the unfiltered control reaches every row",
        "b0",
        "out",
        { depth: false },
        node("b0", "out", [
          node("b1", "out", [node("b2", "out", [])]),
          node("b3", "out", [
            node("b2", "out", []),
            node("b4", "out", [node("b5", "out", [])]),
          ]),
        ]),
        { nodes: 5, edges: 6 }
      ),
      graphCase(
        "the filter applies to direct children",
        "b0",
        "out",
        { depth: 1 },
        node("b0", "out", [node("b3")]),
        { nodes: 1, edges: 1 },
        { where: { open: true } }
      ),
    ],
  },
  {
    name: "RQ-04 independent roots and graph recursion under an ordinary relation",
    cases: [
      {
        name: "two roots, one inside the other's graph",
        model: "vertex",
        operation: "findMany",
        args: {
          where: { id: { in: ["d0", "d1"] } },
          orderBy: { rank: "asc" },
          select: {
            label: true,
            out: {
              recurse: true,
              orderBy: { rank: "asc" },
              select: { label: true },
            },
          },
        },
        expected: [
          node("d0", "out", diamondTree("out")),
          node("d1", "out", [
            node("d3", "out", [node("d4", "out", [])]),
          ]),
        ],
        check(value) {
          assert(Array.isArray(value));
          const [outer, inner] = value.map(occurrence);
          const nested = occurrence((occurrence(outer).out as unknown[])[0]);
          assert.notStrictEqual(nested, inner);
          assert.notStrictEqual(nested.out, occurrence(inner).out);
          // Each root's carrier unfolds its OWN occurrences: `d3` under
          // d0 → d1 and `d3` under the root d1 are two objects.
          assert.notStrictEqual(
            occurrence((nested.out as unknown[])[0]),
            occurrence((occurrence(inner).out as unknown[])[0])
          );
        },
      },
      {
        name: "graph recursion under an ordinary to-one relation",
        model: "holder",
        operation: "findMany",
        args: {
          orderBy: { id: "asc" },
          select: {
            name: true,
            vertex: {
              select: {
                label: true,
                out: {
                  recurse: { depth: 2 },
                  orderBy: { rank: "asc" },
                  select: { label: true },
                },
              },
            },
          },
        },
        expected: [
          {
            name: "h1",
            vertex: node("d0", "out", [
              node("d1", "out", [node("d3")]),
              node("d2", "out", [node("d3")]),
            ]),
          },
          {
            name: "h2",
            vertex: node("r0", "out", [node("r1", "out", [node("r2")])]),
          },
        ],
      },
    ],
  },
  {
    name: "RQ-04 transport grows with distinct edge facts while output grows with paths",
    cases: [
      ladder(`m${LADDER_RUNGS - 1}`, 1),
      ladder(`m${LADDER_RUNGS - 2}`, 2),
      ladder(`m${LADDER_RUNGS - 4}`, 4),
      ladder("m0", LADDER_RUNGS),
    ],
  },
]);

export const GRAPH_WORLD: RecursiveWorld = Object.freeze({
  name: "RQ-04 junction graphs through the same mechanism",
  schema: graphSchema,
  tables: GRAPH_TABLES,
  groups: GRAPH_GROUPS,
});

/** The ROOT slot's private carrier inside one provider row, parsed. */
export function carrierOf(
  row: Record<string, unknown>,
  relation: string
): { readonly nodes: number; readonly edges: number } {
  const raw = row[relation];
  const carrier = occurrence(typeof raw === "string" ? JSON.parse(raw) : raw);
  const nodes = carrier.__rq_nodes;
  const edges = carrier.__rq_edges;
  assert(Array.isArray(nodes) && Array.isArray(edges));
  return { nodes: nodes.length, edges: edges.length };
}

/** What one provider test observed: each statement and the rows it answered. */
export interface ObservedStatements {
  readonly statements: readonly string[];
  readonly rows: readonly (readonly Record<string, unknown>[] | undefined)[];
}

export interface CaseEngine {
  execute(
    modelName: string,
    operation: Operations,
    rawArgs: unknown
  ): Promise<unknown>;
}

/**
 * The RQ-00 placement matrix on one provider: the ordinary relation mutation
 * control first — no recursive CTE — then every placement case: its public
 * value, ONE recursive projected read, one statement for a find, the update's
 * write before its read in the control's statement count, and the delete's
 * read before its write.
 */
export async function runPlacementMatrix(
  engine: CaseEngine,
  observed: ObservedStatements
): Promise<void> {
  const controlValue = await engine.execute(
    ORDINARY_MUTATION_CONTROL.model,
    ORDINARY_MUTATION_CONTROL.operation,
    ORDINARY_MUTATION_CONTROL.args
  );
  assert.deepEqual(
    controlValue,
    ORDINARY_MUTATION_CONTROL.expected,
    ORDINARY_MUTATION_CONTROL.name
  );
  assert(observed.statements.length > 0);
  assert.equal(
    observed.statements.filter((statement) => RECURSIVE_CTE.test(statement))
      .length,
    0
  );
  const ordinaryMutationStatements = observed.statements.length;
  for (const providerCase of PROVIDER_CASES) {
    const statementStart = observed.statements.length;
    const value = await engine.execute(
      providerCase.model,
      providerCase.operation,
      providerCase.args
    );
    assert.deepEqual(value, providerCase.expected, providerCase.name);
    const statements = observed.statements.slice(statementStart);
    assert.equal(
      statements.filter((statement) => RECURSIVE_CTE.test(statement)).length,
      1,
      `${providerCase.name}: recursive projected read count`
    );
    if (providerCase.operation === "findMany")
      assert.equal(
        statements.length,
        1,
        `${providerCase.name}: statement count`
      );
    if (providerCase.operation === "update") {
      assert.equal(statements.length, ordinaryMutationStatements);
      const write = statements.findIndex((statement) =>
        UPDATE_STATEMENT.test(statement)
      );
      const read = statements.findIndex((statement) =>
        RECURSIVE_CTE.test(statement)
      );
      assert(write >= 0 && read > write);
    }
    if (providerCase.operation === "delete") {
      const read = statements.findIndex((statement) =>
        RECURSIVE_CTE.test(statement)
      );
      const write = statements.findIndex((statement) =>
        DELETE_STATEMENT.test(statement)
      );
      assert(read >= 0 && write > read);
    }
  }
}

/** What one case answers: its public value, or the refusal it raised. */
export type CaseOutcome =
  | { readonly value: unknown }
  | { readonly failure: string };

/** What one case owes: its expected value, or its exact refusal sentence. */
export function owedOutcome(providerCase: ProviderCase): CaseOutcome {
  if (providerCase.failure !== undefined)
    return { failure: providerCase.failure };
  return { value: providerCase.expected };
}

/**
 * One case through the ordinary engine entry, in {@link owedOutcome}'s terms:
 * the public value (or its reduction) as the engine answered it, taken BEFORE
 * the case's check runs — a check may mutate what it received to prove the
 * occurrences share nothing — or a `QueryEngineError`'s sentence. Any other
 * failure is the caller's to judge, and is rethrown.
 */
export async function caseOutcome(
  engine: CaseEngine,
  providerCase: ProviderCase
): Promise<CaseOutcome> {
  let value: unknown;
  try {
    value = await engine.execute(
      providerCase.model,
      providerCase.operation,
      providerCase.args
    );
  } catch (failure) {
    if (failure instanceof QueryEngineError)
      return { failure: failure.message };
    throw failure;
  }
  const reported = providerCase.summarize
    ? providerCase.summarize(value)
    : providerCase.check
      ? structuredClone(value)
      : value;
  providerCase.check?.(value);
  return { value: reported };
}

/**
 * One case through the ordinary engine entry: its public value (or its exact
 * refusal), ONE provider statement carrying the recursive projection, and —
 * where the case states it — what the root carrier transported.
 */
export async function runCase(
  engine: CaseEngine,
  observed: ObservedStatements,
  providerCase: ProviderCase
): Promise<void> {
  const start = observed.statements.length;
  assert.deepEqual(
    await caseOutcome(engine, providerCase),
    owedOutcome(providerCase),
    providerCase.name
  );
  const statements = observed.statements.slice(start);
  assert.equal(statements.length, 1, `${providerCase.name}: statement count`);
  assert.equal(
    RECURSIVE_CTE.test(statements[0]!),
    providerCase.control === undefined,
    `${providerCase.name}: recursive CTE`
  );
  if (providerCase.transport === undefined) return;
  const rows = observed.rows[start];
  assert(rows?.length === 1, `${providerCase.name}: one outer row`);
  assert.deepEqual(
    carrierOf(rows[0]!, providerCase.transport.relation),
    {
      nodes: providerCase.transport.nodes,
      edges: providerCase.transport.edges,
    },
    `${providerCase.name}: transport`
  );
}
