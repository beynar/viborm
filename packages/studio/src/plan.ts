/**
 * A query plan as the database tells it, in one shape whatever the database: a tree of operations, each with what
 * it reads (a table, an index), what it compares, how many rows the planner expected and how many came, how long
 * it took on its own and with what it waited for, and how many pages it found in memory or read from disk.
 *
 * PostgreSQL answers `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; MySQL `EXPLAIN ANALYZE`'s text tree; SQLite
 * `EXPLAIN QUERY PLAN`, which says the plan but not what it cost.
 */

export type PlanKind =
  | "scan"
  | "index"
  | "join"
  | "sort"
  | "aggregate"
  | "limit"
  | "subquery"
  | "materialize"
  | "filter"
  | "other";

export interface PlanNode {
  readonly id: string;
  /** The operation as the database names it: `Seq Scan`, `Index Scan`, `Hash Join`, `SCAN`, `Table scan`. */
  readonly operation: string;
  readonly kind: PlanKind;
  /** Reads every row of its table (a sequential scan, a table scan). */
  readonly fullScan: boolean;
  readonly relation?: string;
  readonly alias?: string;
  readonly index?: string;
  /** The line the database wrote for it, when it writes lines (MySQL, SQLite). */
  readonly detail?: string;
  /** What the planner expected. */
  readonly estimate?: { readonly rows?: number; readonly cost?: number };
  /** What happened, when the plan ran (`ANALYZE`): rows per loop, loops, and time in milliseconds. */
  readonly actual?: {
    readonly rows: number;
    readonly loops: number;
    /** Elapsed over every loop, its children's time included: parallel workers' loops count once. */
    readonly time: number;
    /** Its own: its time less its children's. */
    readonly self: number;
    /** Until its first row, per loop. */
    readonly startup?: number;
    /** Every worker's time added up, when workers ran it side by side (larger than the time elapsed). */
    readonly work?: number;
    /** Run by workers side by side (under a Gather). */
    readonly parallel?: boolean;
  };
  /** The plan placed it, the query never reached it. */
  readonly neverExecuted?: boolean;
  /** Pages found in shared memory (`hit`) and read from the disk or the OS cache (`read`). */
  readonly buffers?: {
    readonly hit: number;
    readonly read: number;
    readonly dirtied: number;
    readonly written: number;
    readonly tempRead: number;
    readonly tempWritten: number;
  };
  /** What it compares: `Filter`, `Index Cond`, `Hash Cond`, `Sort Key`, `Group Key`. */
  readonly conditions: readonly {
    readonly label: string;
    readonly text: string;
  }[];
  /** What else it says: rows removed by its filter, how it sorted, how many workers. */
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly children: readonly PlanNode[];
}

export interface PlanTree {
  readonly root: PlanNode;
  /** The plan ran: actual rows and times are known. */
  readonly analyzed: boolean;
  readonly planningTime?: number;
  readonly executionTime?: number;
}

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
const round = (value: number) => Math.round(value * 1000) / 1000;

/** The time its children took, to take from a node's own: theirs over every loop. */
const childrenTime = (children: readonly PlanNode[]) =>
  children.reduce((total, child) => total + (child.actual?.time ?? 0), 0);

function kindOf(operation: string): PlanKind {
  const name = operation.toLowerCase();
  if (name.includes("index") || name.startsWith("search")) return "index";
  if (name.includes("join") || name.includes("nested loop")) return "join";
  if (name.includes("sort") || name.includes("temp b-tree for order"))
    return "sort";
  if (
    name.includes("aggregate") ||
    name.includes("group") ||
    name.includes("unique")
  )
    return "aggregate";
  if (name.includes("limit")) return "limit";
  if (
    name.includes("subquery") ||
    name.includes("subplan") ||
    name.includes("select #") ||
    name.includes("cte")
  )
    return "subquery";
  if (
    name.includes("materialize") ||
    name.includes("memoize") ||
    name.includes("hash") ||
    name.includes("temporary")
  )
    return "materialize";
  if (name.includes("filter")) return "filter";
  if (name.includes("scan")) return "scan";
  return "other";
}

// PostgreSQL ------------------------------------------------------------------------------------------------------

const PG_CONDITIONS = [
  "Index Cond",
  "Recheck Cond",
  "Filter",
  "Join Filter",
  "Hash Cond",
  "Merge Cond",
  "One-Time Filter",
  "TID Cond",
] as const;
const PG_LISTS = ["Sort Key", "Group Key", "Presorted Key"] as const;
const PG_FACTS = [
  "Join Type",
  "Parent Relationship",
  "Subplan Name",
  "Strategy",
  "Rows Removed by Filter",
  "Rows Removed by Join Filter",
  "Rows Removed by Index Recheck",
  "Heap Fetches",
  "Sort Method",
  "Sort Space Used",
  "Sort Space Type",
  "Hash Buckets",
  "Hash Batches",
  "Original Hash Batches",
  "Peak Memory Usage",
  "Workers Planned",
  "Workers Launched",
  "Exact Heap Blocks",
  "Lossy Heap Blocks",
  "Cache Hits",
  "Cache Misses",
  "Scan Direction",
  "Partial Mode",
] as const;

/**
 * A node's time over its loops. Under a Gather, the loops are workers running side by side: their average is the
 * time they took, not their sum.
 */
function pgNode(plan: Json, id: string, parallel = false): PlanNode {
  const operation = String(plan["Node Type"] ?? "Plan");
  const gathers = operation === "Gather" || operation === "Gather Merge";
  const children = (Array.isArray(plan.Plans) ? plan.Plans : [])
    .filter(isJson)
    .map((child, index) =>
      pgNode(child, `${id}.${index}`, parallel || gathers)
    );
  const loops = num(plan["Actual Loops"]);
  const perLoop = num(plan["Actual Total Time"]);
  const analyzed = loops !== undefined && perLoop !== undefined;
  const time = analyzed ? (parallel ? perLoop : perLoop * loops) : 0;
  const startup = num(plan["Actual Startup Time"]);
  const conditions = [
    ...PG_CONDITIONS.flatMap((label) =>
      typeof plan[label] === "string"
        ? [{ label, text: String(plan[label]) }]
        : []
    ),
    ...PG_LISTS.flatMap((label) => {
      const list: unknown = plan[label];
      return Array.isArray(list)
        ? [{ label, text: list.map(String).join(", ") }]
        : [];
    }),
  ];
  const facts = PG_FACTS.flatMap((label) =>
    plan[label] === undefined || plan[label] === null
      ? []
      : [{ label, value: String(plan[label]) }]
  );
  const relation =
    typeof plan["Relation Name"] === "string"
      ? plan["Relation Name"]
      : undefined;
  const hit = num(plan["Shared Hit Blocks"]);
  return {
    id,
    operation,
    kind: kindOf(operation),
    // A sequential scan, or an index read end to end (no condition on it): every row is read.
    fullScan:
      operation === "Seq Scan" ||
      operation === "Parallel Seq Scan" ||
      ((operation === "Index Scan" || operation === "Index Only Scan") &&
        typeof plan["Index Cond"] !== "string"),
    ...(relation ? { relation } : {}),
    ...(typeof plan.Alias === "string" ? { alias: plan.Alias } : {}),
    ...(typeof plan["Index Name"] === "string"
      ? { index: plan["Index Name"] }
      : {}),
    estimate: {
      ...(num(plan["Plan Rows"]) === undefined
        ? {}
        : { rows: num(plan["Plan Rows"]) }),
      ...(num(plan["Total Cost"]) === undefined
        ? {}
        : { cost: num(plan["Total Cost"]) }),
    },
    ...(analyzed && loops === 0 ? { neverExecuted: true } : {}),
    ...(analyzed
      ? {
          actual: {
            rows: num(plan["Actual Rows"]) ?? 0,
            loops,
            time: round(time),
            self: round(Math.max(0, time - childrenTime(children))),
            ...(startup === undefined ? {} : { startup }),
            ...(parallel && loops > 1
              ? { work: round(perLoop * loops), parallel: true }
              : {}),
          },
        }
      : {}),
    ...(hit === undefined
      ? {}
      : {
          buffers: {
            hit,
            read: num(plan["Shared Read Blocks"]) ?? 0,
            dirtied: num(plan["Shared Dirtied Blocks"]) ?? 0,
            written: num(plan["Shared Written Blocks"]) ?? 0,
            tempRead: num(plan["Temp Read Blocks"]) ?? 0,
            tempWritten: num(plan["Temp Written Blocks"]) ?? 0,
          },
        }),
    conditions,
    facts,
    children,
  };
}

/** `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`: one row, its one column a list holding one plan. */
export function postgresPlan(answer: unknown): PlanTree {
  const list = Array.isArray(answer) ? answer : [answer];
  const top = list.find(isJson);
  if (!top) throw new Error("PostgreSQL returned no plan");
  const root = top.Plan;
  if (!isJson(root)) throw new Error("PostgreSQL returned no plan");
  const node = pgNode(root, "0");
  const planningTime = num(top["Planning Time"]);
  const executionTime = num(top["Execution Time"]);
  return {
    root: node,
    analyzed: node.actual !== undefined,
    ...(planningTime === undefined ? {} : { planningTime }),
    ...(executionTime === undefined ? {} : { executionTime }),
  };
}

// MySQL ------------------------------------------------------------------------------------------------------------

const MYSQL_LINE = /^(\s*)-> (.*)$/;
const MYSQL_ESTIMATE = /\(cost=([\d.e+]+)(?:\.\.[\d.e+]+)? rows=([\d.e+]+)\)/;
const MYSQL_ACTUAL =
  /\(actual time=([\d.e+]+)\.\.([\d.e+]+) rows=([\d.e+]+) loops=(\d+)\)/;
const MYSQL_NEVER = /\(never executed\)/;
const MYSQL_TABLE =
  /^(?:Table scan|Index scan|Index lookup|Index range scan|Single-row index lookup|Covering index lookup|Covering index scan|Covering index range scan|Full-text index search|Index range scan \(Multi-Range Read\)|Constant row from|Single-row covering index lookup) on (\S+)(?: using (\S+))?/;
const MYSQL_PARENS = /\s+\((?:cost|actual|never)[^)]*\)/g;
/** What follows the operation in a table's line: the table, the index, the condition. */
const MYSQL_TABLE_TAIL = / on \S+.*$/;
const MYSQL_TRAILING = /^(.*?) \((.+)\)$/;

/** `EXPLAIN ANALYZE`'s text tree: an operation per line, four spaces deeper per level. */
export function mysqlPlan(text: string): PlanTree {
  const lines = text.split("\n").flatMap((line) => {
    const [matched, indent = "", body = ""] = MYSQL_LINE.exec(line) ?? [];
    return matched ? [{ indent, body }] : [];
  });
  if (lines.length === 0) throw new Error("MySQL returned no plan");
  type Draft = {
    depth: number;
    line: string;
    children: Draft[];
  };
  const top: Draft = { depth: -1, line: "", children: [] };
  const stack: Draft[] = [top];
  for (const { indent, body } of lines) {
    const draft: Draft = { depth: indent.length, line: body, children: [] };
    while (stack.length > 1 && stack.at(-1)!.depth >= draft.depth) stack.pop();
    stack.at(-1)!.children.push(draft);
    stack.push(draft);
  }
  const build = (draft: Draft, id: string): PlanNode => {
    const children = draft.children.map((child, index) =>
      build(child, `${id}.${index}`)
    );
    const label = draft.line.replace(MYSQL_PARENS, "").trim();
    // `Select #2 (subquery in projection; dependent)` times nothing itself: its work is its children's, which the
    // statement's own root does not count.
    const timed = children.filter((child) => child.actual);
    const estimate = MYSQL_ESTIMATE.exec(draft.line);
    const actual = MYSQL_ACTUAL.exec(draft.line);
    const table = MYSQL_TABLE.exec(label);
    const loops = actual ? Number(actual[4]) : 0;
    const time = actual ? Number(actual[2]) * loops : 0;
    // `Sort: o.total DESC`, `Filter: (o.status = 'paid')`, `Inner hash join (c.id = o.customerId)`,
    // `Index lookup on i using idx (orderId=o.id)`: the operation, then what it compares.
    const colon = label.indexOf(": ");
    const trailing = MYSQL_TRAILING.exec(label);
    const operation = table
      ? table[0].replace(MYSQL_TABLE_TAIL, "")
      : colon > 0
        ? label.slice(0, colon)
        : (trailing?.[1] ?? label);
    const compared = table
      ? trailing?.[2]
      : colon > 0
        ? label.slice(colon + 2)
        : trailing?.[2];
    const conditionLabel = table
      ? "Index Cond"
      : operation.startsWith("Sort")
        ? "Sort Key"
        : operation.startsWith("Filter")
          ? "Filter"
          : operation.startsWith("Limit")
            ? "Limit"
            : kindOf(operation) === "join"
              ? "Join Cond"
              : kindOf(operation) === "aggregate"
                ? "Group Key"
                : "Condition";
    return {
      id,
      operation,
      kind: kindOf(operation),
      fullScan: operation === "Table scan" || operation === "Index scan",
      ...(table
        ? { alias: table[1], ...(table[2] ? { index: table[2] } : {}) }
        : {}),
      detail: label,
      ...(estimate
        ? { estimate: { cost: Number(estimate[1]), rows: Number(estimate[2]) } }
        : {}),
      ...(MYSQL_NEVER.test(draft.line) ? { neverExecuted: true } : {}),
      ...(actual
        ? {
            actual: {
              rows: Number(actual[3]),
              loops,
              time: round(time),
              self: round(Math.max(0, time - childrenTime(children))),
              startup: Number(actual[1]),
            },
          }
        : timed.length > 0
          ? {
              actual: {
                rows: timed[0]!.actual!.rows,
                loops: timed[0]!.actual!.loops,
                time: round(childrenTime(children)),
                self: 0,
              },
            }
          : {}),
      conditions: compared ? [{ label: conditionLabel, text: compared }] : [],
      facts: [],
      children,
    };
  };
  const roots = top.children.map((draft, index) => build(draft, String(index)));
  // The statement and its dependent subqueries, side by side: their times add up.
  const time = round(childrenTime(roots));
  const root =
    roots.length === 1
      ? roots[0]!
      : {
          id: "query",
          operation: "Query",
          kind: "other" as const,
          fullScan: false,
          ...(roots[0]?.actual
            ? {
                actual: {
                  rows: roots[0].actual.rows,
                  loops: 1,
                  time,
                  self: 0,
                },
              }
            : {}),
          conditions: [],
          facts: [],
          children: roots,
        };
  return { root, analyzed: MYSQL_ACTUAL.test(text) };
}

// SQLite -----------------------------------------------------------------------------------------------------------

const SQLITE_TABLE =
  /^(SCAN|SEARCH) (\S+)(?: USING (?:(?:COVERING|PRIMARY KEY|INTEGER PRIMARY KEY|AUTOMATIC (?:COVERING |PARTIAL )?)?INDEX ?(\S*))?)?(?: \((.*)\))?/;

/** `EXPLAIN QUERY PLAN`'s rows: an id, its parent's, and what it does. */
export function sqlitePlan(
  rows: readonly { id: unknown; parent: unknown; detail: unknown }[]
): PlanTree {
  if (rows.length === 0) throw new Error("SQLite returned no plan");
  const byParent = new Map<number, typeof rows>();
  for (const row of rows) {
    const parent = Number(row.parent);
    byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
  }
  const build = (row: (typeof rows)[number]): PlanNode => {
    const detail = String(row.detail);
    const table = SQLITE_TABLE.exec(detail);
    const operation = table
      ? `${table[1]}${detail.includes(" USING ") ? " using index" : ""}`
      : detail;
    const children = (byParent.get(Number(row.id)) ?? []).map(build);
    const usesIndex = table !== null && detail.includes(" USING ");
    return {
      id: String(row.id),
      operation,
      kind: table ? (usesIndex ? "index" : "scan") : kindOf(detail),
      fullScan: table !== null && table[1] === "SCAN" && !usesIndex,
      ...(table
        ? {
            alias: table[2]!,
            ...(table[3]
              ? { index: table[3] }
              : detail.includes("PRIMARY KEY")
                ? { index: "PRIMARY KEY" }
                : {}),
          }
        : {}),
      detail,
      conditions: table?.[4] ? [{ label: "Index Cond", text: table[4] }] : [],
      facts: [],
      children,
    };
  };
  const roots = (byParent.get(0) ?? []).map(build);
  return {
    root: {
      id: "query",
      operation: "Query",
      kind: "other",
      fullScan: false,
      conditions: [],
      facts: [],
      children: roots,
    },
    analyzed: false,
  };
}

/** Every node, depth first. */
export function* walk(node: PlanNode): Generator<PlanNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}
