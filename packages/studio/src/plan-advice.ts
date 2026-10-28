/**
 * What a plan says to do, read by the rules a person reading `EXPLAIN` applies, and only where the plan and the
 * catalog bear them out:
 *
 * - a table read in full to keep a few of its rows wants an index on what the filter compares: the correlation key
 *   of a subquery run once per outer row, then the single-value equalities, then the many-value ones (`IN`), then
 *   one range. Only conditions that must all hold count: a branch of an `OR` or a `NOT` narrows nothing.
 * - a page of sorted rows wants the equalities then the order, in its directions, so the database reads the page
 *   and stops; a sort by an expression (`count(...)`) has no index to want.
 * - no index is asked for that one already there begins with; no column the table does not have is named.
 * - a search inside text (`contains`) wants a trigram, full-text or FTS index, a prefix on PostgreSQL a pattern
 *   operator class; an estimate far from what came, fresh statistics; a sort, a hash or a bitmap that outgrew
 *   memory, memory.
 *
 * How much it matters is the work the plan did: the rows it visited, not the size of the table.
 */

import type { PlanNode, PlanTree } from "./plan";
import { walk } from "./plan";
import type { StudioModel } from "./schema";

export type Dialect = "postgresql" | "mysql" | "sqlite";

export interface TableIndex {
  readonly name: string;
  readonly columns: readonly string[];
  /** Key directions, in the same positions as columns. Unknown directions cannot prove an order. */
  readonly descending?: readonly boolean[];
  readonly unique: boolean;
  /** A b-tree, which serves equalities, ranges and order; a hash, a GIN or a full-text index serves less. */
  readonly ordered: boolean;
  /** It holds only the rows its predicate keeps. */
  readonly partial: boolean;
  /** The statement that builds it, when the database says it. */
  readonly definition?: string;
}

export interface PlanContext {
  readonly dialect: Dialect;
  /** The statement the plan is of. */
  readonly sql: string;
  readonly params?: readonly unknown[];
  /** The indexes the database holds, by table. */
  readonly indexes: Readonly<Record<string, readonly TableIndex[]>>;
  /** The columns each table has, as the catalog says. */
  readonly columns: Readonly<Record<string, readonly string[]>>;
  /** How many rows each table holds, as the database counts them. */
  readonly tableRows: Readonly<Record<string, number>>;
  readonly models: readonly StudioModel[];
}

export type Severity = "critical" | "warning" | "info";

export interface PlanAdvice {
  readonly id: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  /** The nodes it is about. */
  readonly nodes: readonly string[];
  readonly fix?: {
    /** On the model, in the VibORM schema. */
    readonly schema?: string;
    /** The statement, in the database's own SQL. */
    readonly sql?: string;
    readonly note?: string;
  };
}

/** A comparison a filter, a join or an index condition makes on one column. */
export interface Predicate {
  readonly alias?: string;
  readonly column: string;
  /**
   * `equal`: one value (or `IS NULL`); `multi`: one of several (`IN`, `= ANY`); `join`: another table's column (a
   * join or a correlated subquery); `other`: nothing an index on the column serves (`<>`, `IS NOT NULL`, a branch
   * of an `OR`, a function of the column).
   */
  readonly kind:
    | "equal"
    | "multi"
    | "range"
    | "prefix"
    | "suffix"
    | "contains"
    | "join"
    | "other";
}

// Reading conditions ---------------------------------------------------------------------------------------------

const KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "case",
  "when",
  "then",
  "else",
  "end",
  "null",
  "true",
  "false",
  "select",
  "where",
  "on",
  "as",
  "escape",
  "in",
  "is",
  "like",
  "any",
]);
const FUNCTION_NAMES = new Set([
  "locate",
  "instr",
  "strpos",
  "position",
  "lower",
  "upper",
  "replace",
  "chr",
  "left",
  "right",
  "substr",
  "length",
  "octet_length",
  "count",
  "coalesce",
  "abs",
]);
/** `cast(q0.status as char charset binary)` → `q0.status`; `BINARY x`, `x COLLATE BINARY`, `x::text` → `x`. */
const CAST_CALL = /\bcast\(\s*([^()]+?)\s+as\s+[^()]+\)/gi;
const NOISE =
  /\bBINARY\s+|\s+COLLATE\s+"?\w+"?|::[A-Za-z_]\w*(?:\s+(?:precision|varying|zone|with time|without time))*(?:\[\])?/gi;
const clean = (text: string) =>
  text.replace(CAST_CALL, "$1").replace(NOISE, "");

/** The index of the parenthesis that closes the one at `open`, quotes skipped; -1 when there is none. */
function closing(text: string, open: number): number {
  let depth = 0;
  let inQuote = false;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (inQuote) {
      if (char === "'") inQuote = false;
    } else if (char === "'") inQuote = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
}

const unwrap = (text: string): string => {
  let trimmed = text.trim();
  while (trimmed.startsWith("(") && closing(trimmed, 0) === trimmed.length - 1)
    trimmed = trimmed.slice(1, -1).trim();
  return trimmed;
};

const SEPARATORS = {
  AND: /^\s+AND\s+/i,
  OR: /^\s+OR\s+/i,
} as const;

/** The parts of a condition joined by `word` (AND, OR) outside every parenthesis and quote. */
function splitTop(text: string, word: keyof typeof SEPARATORS): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (inQuote) {
      if (char === "'") inQuote = false;
    } else if (char === "'") inQuote = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0) {
      const match = SEPARATORS[word].exec(text.slice(at));
      if (match) {
        parts.push(text.slice(start, at));
        at += match[0].length - 1;
        start = at + 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The conditions that must all hold: a condition split at its top-level ANDs, nested ones flattened. */
export function conjunctsOf(text: string): string[] {
  const unwrapped = unwrap(text);
  const parts = splitTop(unwrapped, "AND");
  return parts.length === 1 ? [unwrapped] : parts.flatMap(conjunctsOf);
}

const IDENTIFIER = '[`"]?([A-Za-z_]\\w*)[`"]?';
const REFERENCE = new RegExp(
  `(?:${IDENTIFIER}\\.)?${IDENTIFIER}(?!\\w)(?!\\s*\\()`,
  "g"
);
const COMPARISON = new RegExp(
  `^(?:${IDENTIFIER}\\.)?${IDENTIFIER}\\s*(=\\s*ANY|IS\\s+NOT\\s+NULL|IS\\s+NULL|NOT\\s+LIKE|NOT\\s+IN|ILIKE|LIKE|GLOB|!?~~\\*?|<>|!=|<=|>=|=|<|>|IN\\b|BETWEEN\\b)\\s*(.*)$`,
  "is"
);
/** A column on the right of `=`: `q0.id`, or PostgreSQL's unqualified `"customerId"`. */
const COLUMN_OPERAND = new RegExp(
  `^\\(?(?:${IDENTIFIER}\\.)?${IDENTIFIER}\\)?$`
);
const SEARCH_FUNCTION = /^(?:locate|instr|strpos|position)\s*\(/i;
const PREFIX_FUNCTION = /^(?:left\s*\(|substr\s*\([^,]+,\s*1\s*,)/i;
const SUFFIX_FUNCTION = /^(?:right\s*\(|substr\s*\([^,]+,\s*length\s*\()/i;
const FUNCTION_CALL = /^[A-Za-z_]\w*\s*\(/;
const NEGATION = /^NOT\b/i;
const LITERAL = /^\(?\s*'((?:[^']|'')*)'/;
const QUOTED = /'(?:[^']|'')*'/g;
const ARRAY_LITERAL = /'\{([^}]*)\}'/;
/** A pattern that begins with a wildcard searches anywhere in the text; one that does not, by its start. */
const LIKE_WILDCARD = /^[%_]/;
const GLOB_WILDCARD = /^[*?[]/;
const PARAMETER = /^\s*\$\d+\s*$/;
const NUMBER = /^\d/;

/** The columns a piece of a condition names (`q0.status`, `"name"`), keywords, functions and literals left out. */
function referencesIn(text: string): { alias?: string; column: string }[] {
  const out: { alias?: string; column: string }[] = [];
  for (const [, alias, column = ""] of text
    .replace(QUOTED, "''")
    .matchAll(REFERENCE)) {
    const lower = column.toLowerCase();
    if (KEYWORDS.has(lower) || FUNCTION_NAMES.has(lower) || NUMBER.test(column))
      continue;
    out.push({ ...(alias ? { alias } : {}), column });
  }
  return out;
}

/** How many values a list holds: `(?, ?)`, `('{paid,shipped}')`; a single parameter (`$3`), several. */
function valueCount(operand: string): number {
  const array = ARRAY_LITERAL.exec(operand);
  if (array) return array[1]!.split(",").length;
  const open = operand.indexOf("(");
  const inner =
    open >= 0 ? operand.slice(open + 1, closing(operand, open)) : operand;
  if (PARAMETER.test(inner)) return 2;
  let depth = 0;
  let count = 1;
  for (const char of inner) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) count += 1;
  }
  return count;
}

/** One condition that must hold, read: the column it compares and how. */
function predicatesOfConjunct(conjunct: string): Predicate[] {
  const text = unwrap(conjunct);
  const all = (kind: Predicate["kind"]) =>
    referencesIn(text).map((reference) => ({ ...reference, kind }));
  if (NEGATION.test(text) || splitTop(text, "OR").length > 1)
    return all("other");
  if (SEARCH_FUNCTION.test(text)) return all("contains");
  if (PREFIX_FUNCTION.test(text)) return all("prefix");
  if (SUFFIX_FUNCTION.test(text)) return all("suffix");
  if (FUNCTION_CALL.test(text)) return all("other");
  const match = COMPARISON.exec(text);
  if (!match) return [];
  const [, alias, column = "", rawOperator = "", operand = ""] = match;
  if (KEYWORDS.has(column.toLowerCase())) return [];
  const own = { ...(alias ? { alias } : {}), column };
  const operator = rawOperator.toUpperCase().replace(/\s+/g, " ");
  const [, otherAlias, otherColumn = ""] =
    COLUMN_OPERAND.exec(operand.trim()) ?? [];
  if (
    otherColumn !== "" &&
    operator === "=" &&
    !KEYWORDS.has(otherColumn.toLowerCase())
  ) {
    return [
      { ...own, kind: "join" },
      {
        ...(otherAlias ? { alias: otherAlias } : {}),
        column: otherColumn,
        kind: "join",
      },
    ];
  }
  const literal = LITERAL.exec(operand.trim())?.[1];
  const pattern = (wildcard: RegExp): Predicate["kind"] =>
    literal === undefined
      ? "other"
      : wildcard.test(literal)
        ? "contains"
        : "prefix";
  let kind: Predicate["kind"];
  if (operator === "GLOB") kind = pattern(GLOB_WILDCARD);
  else if (operator.includes("LIKE") || operator.includes("~~"))
    kind =
      operator.startsWith("NOT") || operator.startsWith("!")
        ? "other"
        : pattern(LIKE_WILDCARD);
  else if (operator === "IS NULL" || operator === "=") kind = "equal";
  else if (["IS NOT NULL", "<>", "!=", "NOT IN"].includes(operator))
    kind = "other";
  else if (operator.startsWith("= ANY") || operator === "IN")
    kind = valueCount(operand) === 1 ? "equal" : "multi";
  else kind = "range";
  return [{ ...own, kind }];
}

/** The comparisons a condition makes that must all hold, one per column it names. */
export function predicatesOf(text: string): Predicate[] {
  return conjunctsOf(clean(text)).flatMap(predicatesOfConjunct);
}

// Reading statements ---------------------------------------------------------------------------------------------

const CLAUSE =
  /\b(?:WHERE|ON|HAVING)\b(.*?)(?=\bWHERE\b|\b(?:(?:LEFT|RIGHT|FULL|INNER|CROSS)\s+(?:OUTER\s+)?)?JOIN\b|\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b|\bHAVING\b|\bUNION\b|\)\s*AS\b|$)/gis;
/** What a statement compares where it filters (`WHERE`, `ON`, `HAVING`), not what it computes. */
export const filtersOf = (sql: string) =>
  [...sql.matchAll(CLAUSE)]
    .map(([, clause = ""]) => clause.trim())
    .filter((clause) => clause !== "");

// Bind only the pattern literals used for advice. This text is never executed. Skip quoted SQL and comments
// so a question mark in a literal cannot shift SQLite/MySQL's positional bindings.
const SQL_TOKEN =
  /'(?:''|\\[\s\S]|[^'\\])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\n]*|\/\*[\s\S]*?\*\/|\$(\d+)|\?/g;
function boundPatterns(sql: string, params: readonly unknown[]): string {
  let position = 0;
  return sql.replace(
    SQL_TOKEN,
    (token: string, numbered: string | undefined) => {
      if (token !== "?" && numbered === undefined) return token;
      const value =
        params[numbered === undefined ? position++ : Number(numbered) - 1];
      return typeof value === "string"
        ? `'${value.replaceAll("'", "''")}'`
        : token;
    }
  );
}

const TABLE_NAME = '(?:"(?:""|[^"])*"|`(?:``|[^`])*`|\\w+)';
const ALIAS = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(?:(${TABLE_NAME})\\.)?(${TABLE_NAME})\\s+(?:AS\\s+)?(${TABLE_NAME})`,
  "gi"
);
const identifierOf = (name: string) =>
  name.startsWith('"')
    ? name.slice(1, -1).replaceAll('""', '"')
    : name.startsWith("`")
      ? name.slice(1, -1).replaceAll("``", "`")
      : name;
/** The tables a statement reads, by the alias it gives them (`FROM "public"."orders" AS "q0"`). */
export function aliasesOf(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, , table = "", alias = ""] of sql.matchAll(ALIAS)) {
    if (!KEYWORDS.has(alias.toLowerCase()))
      out[identifierOf(alias)] = identifierOf(table);
  }
  return out;
}
/** The schema a statement names for each table it reads (`"public"."orders"`), when it names one. */
export function schemasOf(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, schema, table = ""] of sql.matchAll(ALIAS)) {
    if (schema) out[identifierOf(table)] = identifierOf(schema);
  }
  return out;
}

const ORDER = /\bORDER BY\s+(.+?)(?=\bLIMIT\b|\bOFFSET\b|\)\s*AS\b|$)/gis;
const GROUP = /\bGROUP BY\s+(.+?)(?=\bHAVING\b|\bORDER BY\b|\bLIMIT\b|\)|$)/is;
const ORDER_TERM = new RegExp(
  `^(?:${IDENTIFIER}\\.)?${IDENTIFIER}(?:\\s+(ASC|DESC))?(?:\\s+NULLS\\s+(?:FIRST|LAST))?$`,
  "i"
);
const LIMIT_INPUT = /,?\s*limit input to.*$/i;
const TRAILING_LIMIT = /\bLIMIT\b[^)]*$/i;
const GROUPING = /^USE TEMP B-TREE FOR (GROUP BY|DISTINCT)/;
const SUBPLAN = /SubPlan|InitPlan/;
const DEPENDENT = /correlated|dependent/i;

export interface OrderTerm {
  readonly alias?: string;
  readonly column: string;
  readonly desc: boolean;
}

/**
 * The terms of an order: each a column, in a direction. An expression (`count(...)`, a computed value) has no
 * column: the order is then none an index can give, and undefined.
 */
export function termsOf(list: string): OrderTerm[] | undefined {
  const terms: OrderTerm[] = [];
  for (const raw of list
    .replace(LIMIT_INPUT, "")
    .split(",")
    .map((term) => clean(term).trim())
    .filter((term) => term !== "")) {
    const term = ORDER_TERM.exec(raw);
    if (!term) return undefined;
    const [, alias, column = "", direction] = term;
    terms.push({
      ...(alias ? { alias } : {}),
      column,
      desc: direction?.toUpperCase() === "DESC",
    });
  }
  return terms.length > 0 ? terms : undefined;
}

/** The orders a statement asks, outermost last (`ORDER BY "q0"."total" DESC`); undefined for an expression. */
export const orderOf = (sql: string) =>
  [...sql.matchAll(ORDER)].map(([, list = ""]) => termsOf(list));

// Writing fixes ------------------------------------------------------------------------------------------------

const quote = (dialect: Dialect, name: string) =>
  dialect === "mysql" ? `\`${name}\`` : `"${name}"`;

/** Qualify every suggested persistent-object operation exactly as the explained statement does. */
function tableSql(context: PlanContext, table: string): string {
  const namespace = schemasOf(context.sql)[table];
  return `${namespace ? `${quote(context.dialect, namespace)}.` : ""}${quote(context.dialect, table)}`;
}

interface IndexColumn {
  readonly column: string;
  readonly desc?: boolean;
}

/**
 * The statement that builds an index, and the `.index([...])` that declares it on the model. A b-tree is read in
 * either direction: an order all one way needs no direction; a mixed one does, which `.index()` cannot say.
 */
function indexFix(
  context: PlanContext,
  table: string,
  columns: readonly IndexColumn[]
): NonNullable<PlanAdvice["fix"]> {
  const model = context.models.find((candidate) => candidate.table === table);
  const directions = new Set(
    columns
      .filter((entry) => entry.desc !== undefined)
      .map((entry) => entry.desc)
  );
  const mixed = directions.size > 1;
  const fields = columns.map(
    ({ column }) =>
      model?.fields.find((field) => field.column === column)?.name ?? column
  );
  const name =
    `${table}_${columns.map((entry) => entry.column).join("_")}_idx`.slice(
      0,
      63
    );
  const list = columns
    .map(
      (entry) =>
        `${quote(context.dialect, entry.column)}${mixed && entry.desc ? " DESC" : ""}`
    )
    .join(", ");
  return {
    ...(model && !mixed
      ? {
          schema: `// the "${model.name}" model\n.index([${fields.map((field) => JSON.stringify(field)).join(", ")}])`,
        }
      : {}),
    sql: `CREATE INDEX ${quote(context.dialect, name)} ON ${tableSql(context, table)} (${list});`,
    ...(mixed
      ? {
          note: "Mixed directions require a SQL migration.",
        }
      : {}),
  };
}

const ANALYZE_SQL = (context: PlanContext, table: string) =>
  context.dialect === "mysql"
    ? `ANALYZE TABLE ${tableSql(context, table)};`
    : `ANALYZE ${tableSql(context, table)};`;

const formatRows = (rows: number) =>
  rows >= 1_000_000
    ? `${(rows / 1_000_000).toFixed(1)}M`
    : rows >= 10_000
      ? `${Math.round(rows / 1000)}k`
      : Math.round(rows).toLocaleString("en-US");

/** How much a piece of work matters: the rows the plan visited for it. */
function severityOf(visited: number): Severity {
  if (visited >= 50_000) return "critical";
  if (visited >= 5000) return "warning";
  return "info";
}

const factOf = (node: PlanNode, label: string) =>
  node.facts.find((fact) => fact.label === label)?.value;
const conditionOf = (node: PlanNode, label: string) =>
  node.conditions.find((condition) => condition.label === label)?.text;
/** Operations that read all their input before they hand up a row: a limit above them does not cut what is under. */
const BLOCKING = new Set(["sort", "aggregate", "materialize"]);
const LEFTOVER = new Set<Predicate["kind"]>([
  "range",
  "prefix",
  "contains",
  "multi",
  "other",
]);

const dedupe = <T extends { column: string }>(entries: readonly T[]): T[] => {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.column)) return false;
    seen.add(entry.column);
    return true;
  });
};

// The advice -----------------------------------------------------------------------------------------------------

interface SortSeen {
  readonly node: PlanNode;
  readonly table: string;
  readonly alias?: string;
  readonly source: PlanNode;
  readonly terms: readonly OrderTerm[];
  readonly rows: number | undefined;
  readonly limited: boolean;
}

export function adviseOn(plan: PlanTree, context: PlanContext): PlanAdvice[] {
  const advice: PlanAdvice[] = [];
  const aliases = aliasesOf(context.sql);
  const all = [...walk(plan.root)];
  const parents = new Map<string, PlanNode>();
  for (const node of all) {
    for (const child of node.children) parents.set(child.id, node);
  }
  const ancestors = (node: PlanNode): PlanNode[] => {
    const out: PlanNode[] = [];
    for (
      let parent = parents.get(node.id);
      parent;
      parent = parents.get(parent.id)
    )
      out.push(parent);
    return out;
  };
  /** A limit cuts this node's reading short: one above it, with nothing between that reads all its input first. */
  const cutByLimit = (node: PlanNode) => {
    for (const ancestor of ancestors(node)) {
      if (ancestor.kind === "limit") return true;
      if (BLOCKING.has(ancestor.kind)) return false;
    }
    return false;
  };
  const tableOf = (node: PlanNode) =>
    node.relation ?? (node.alias ? aliases[node.alias] : undefined);
  const hasColumn = (table: string, column: string) =>
    context.columns[table]?.includes(column) ?? false;
  const sqlPredicates = filtersOf(
    boundPatterns(context.sql, context.params ?? [])
  ).flatMap(predicatesOf);
  const limitNodes = all.some((node) => node.kind === "limit");
  const pageAsked = limitNodes || TRAILING_LIMIT.test(context.sql);
  /**
   * The comparisons on a node's table: its own conditions' (PostgreSQL writes them without the alias), else the
   * statement's on its alias.
   */
  const predicatesFor = (node: PlanNode, alias: string | undefined) => {
    const parent = parents.get(node.id);
    const own = [
      conditionOf(node, "Index Cond"),
      conditionOf(node, "Recheck Cond"),
      conditionOf(node, "Filter"),
      conditionOf(node, "Join Filter"),
      parent?.operation.startsWith("Filter")
        ? conditionOf(parent, "Filter")
        : undefined,
    ]
      .filter((entry): entry is string => entry !== undefined)
      .flatMap(predicatesOf);
    // A node's own condition names its table's columns bare (PostgreSQL's filters, MySQL's lookups); the
    // statement's name every column by its alias.
    const fromOwn =
      context.dialect !== "sqlite" &&
      (own.length > 0 || context.dialect === "postgresql");
    const table = tableOf(node);
    return (fromOwn ? own : sqlPredicates).filter(
      (predicate) =>
        (predicate.alias === undefined ? fromOwn : predicate.alias === alias) &&
        (table === undefined || hasColumn(table, predicate.column))
    );
  };
  /** Run once per row of the plan above it: a correlated subquery, or the inner side of a nested loop. */
  const correlated = (node: PlanNode) =>
    (node.actual !== undefined &&
      node.actual.loops > 1 &&
      !node.actual.parallel) ||
    ancestors(node).some(
      (ancestor) =>
        ancestor.kind === "subquery" ||
        SUBPLAN.test(factOf(ancestor, "Parent Relationship") ?? "") ||
        DEPENDENT.test(
          `${ancestor.operation} ${ancestor.detail ?? ""} ${conditionOf(ancestor, "Condition") ?? ""}`
        )
    );
  /** An index there already that begins with these columns, in this order: an ordered one, holding every row. */
  const covering = (table: string, columns: readonly IndexColumn[]) =>
    (context.indexes[table] ?? []).find(
      (index) =>
        index.ordered &&
        !index.partial &&
        columns.every((entry, at) => index.columns[at] === entry.column) &&
        [false, true].some((reverse) =>
          columns.every(
            (entry, at) =>
              entry.desc === undefined ||
              (index.descending?.[at] !== undefined &&
                entry.desc === (index.descending[at] !== reverse))
          )
        )
    );

  // The sorts first: a scan below a sort for a page wants the index that serves both.
  const sorts = new Map<string, SortSeen>();
  const spills: PlanNode[] = [];
  for (const node of all) {
    if (node.kind !== "sort" || node.neverExecuted) continue;
    if (
      factOf(node, "Sort Space Type") === "Disk" ||
      (factOf(node, "Sort Method") ?? "").includes("external")
    ) {
      spills.push(node);
      continue;
    }
    const key = conditionOf(node, "Sort Key");
    // Sorted by an expression: no index gives that order.
    // SQLite puts the scan and its sort beside each other inside the same query/co-routine.
    // Never borrow a scan through a nested subquery, or an outer query's ORDER BY.
    const siblings = parents.get(node.id)?.children ?? [];
    const siblingScans = siblings
      .slice(0, siblings.indexOf(node))
      .filter((entry) => tableOf(entry) !== undefined);
    const sibling =
      context.dialect === "sqlite" && siblingScans.length === 1
        ? siblingScans[0]
        : undefined;
    const terms =
      key === undefined
        ? sibling
          ? orderOf(context.sql).find((order) =>
              order?.every((term) => term.alias === sibling.alias)
            )
          : context.dialect === "sqlite"
            ? undefined
            : orderOf(context.sql).at(-1)
        : termsOf(key);
    if (!terms) continue;
    const candidates = sibling
      ? [sibling]
      : [...walk(node)].filter((entry) => tableOf(entry) !== undefined);
    const first = terms[0]!;
    const below = first.alias
      ? candidates.find(
          (entry) =>
            entry.alias === first.alias ||
            (entry.alias === undefined &&
              tableOf(entry) === aliases[first.alias!])
        )
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!below) continue;
    const alias = first.alias ?? below.alias;
    const table =
      (first.alias ? aliases[first.alias] : undefined) ?? tableOf(below);
    if (
      !(
        table &&
        terms.every(
          (term) =>
            (!term.alias || term.alias === alias) &&
            hasColumn(table, term.column)
        )
      )
    )
      continue;
    const input = node.children[0];
    sorts.set(node.id, {
      node,
      table,
      ...(alias ? { alias } : {}),
      source: below,
      terms,
      rows:
        (input?.actual ? input.actual.rows * input.actual.loops : undefined) ??
        input?.estimate?.rows ??
        node.estimate?.rows,
      limited: limitNodes
        ? ancestors(node).some((entry) => entry.kind === "limit")
        : pageAsked,
    });
  }
  const sortHandled = new Set<string>();

  for (const node of all) {
    const table = tableOf(node);

    // A table read in full ------------------------------------------------------------------------------------
    if (node.fullScan && table && !node.neverExecuted) {
      const parent = parents.get(node.id);
      const predicates = predicatesFor(node, node.alias);
      const loops = node.actual?.loops ?? 1;
      const parallel = node.actual?.parallel === true;
      // The rows visited and those kept: measured when the plan ran, else the table's size.
      let visited: number | undefined;
      let kept: number | undefined;
      if (node.actual && context.dialect === "postgresql") {
        const removed = Number(factOf(node, "Rows Removed by Filter") ?? 0);
        visited = Math.round((node.actual.rows + removed) * loops);
        kept = Math.round(node.actual.rows * loops);
      } else if (node.actual) {
        visited = Math.round(node.actual.rows * loops);
        if (parent?.operation.startsWith("Filter") && parent.actual)
          kept = Math.round(parent.actual.rows * parent.actual.loops);
      } else {
        visited = context.tableRows[table];
      }
      const size = context.tableRows[table];
      // Both measured branches above establish visited; an estimate supplies no measured severity.
      const severity = node.actual ? severityOf(visited!) : "info";
      const isCorrelated = correlated(node);
      const repeated = parallel
        ? ` ${loops} parallel workers.`
        : loops > 1
          ? ` ${loops.toLocaleString("en-US")} runs.`
          : "";
      const stopped =
        visited !== undefined &&
        size !== undefined &&
        node.actual &&
        cutByLimit(node) &&
        visited < size / 2
          ? ` Stopped at LIMIT (${formatRows(visited)}/${formatRows(size)} rows).`
          : "";
      const counted =
        visited === undefined
          ? "Scan planned; row count unknown"
          : node.actual
            ? `${formatRows(visited)} rows scanned${kept === undefined ? "" : ` · ${formatRows(kept)} kept`}`
            : `Scan planned (~${formatRows(visited)} table rows); reads unmeasured`;
      const smallNote =
        severity === "info" && size !== undefined && size < 5000
          ? ` Small table (${formatRows(size)} rows); indexing may not help yet.`
          : "";
      const keptShare =
        visited && kept !== undefined ? kept / visited : undefined;
      const correlation = isCorrelated
        ? dedupe(predicates.filter((entry) => entry.kind === "join"))
        : [];
      const single = dedupe(
        predicates.filter((entry) => entry.kind === "equal")
      );
      const multi = dedupe(
        predicates.filter((entry) => entry.kind === "multi")
      );
      const range = predicates.find(
        (entry) =>
          entry.kind === "range" ||
          (entry.kind === "prefix" && context.dialect !== "postgresql")
      );
      const sort = [...sorts.values()].find(
        (entry) => entry.source.id === node.id
      );
      const pageTerms = sort?.limited
        ? sort.terms
        : !sort && node.kind === "index" && pageAsked
          ? (orderOf(context.sql).at(-1) ?? []).filter(
              (term) => term.alias === undefined || term.alias === node.alias
            )
          : [];
      const correlationNote =
        correlation.length > 0
          ? ` Index starts with ${correlation.map((entry) => entry.column).join(", ")} for each lookup.`
          : "";
      if (
        pageTerms.length > 0 &&
        (keptShare === undefined || keptShare <= 0.3 || node.kind === "index")
      ) {
        // A page of sorted rows: correlation, single values, then the order; IN lists would break the order.
        const columns: IndexColumn[] = dedupe<IndexColumn>([
          ...correlation.map(({ column }) => ({ column })),
          ...single.map(({ column }) => ({ column })),
          ...pageTerms.map(({ column, desc }) => ({ column, desc })),
        ]);
        if (
          columns.every((entry) => hasColumn(table, entry.column)) &&
          !covering(table, columns)
        ) {
          if (sort) sortHandled.add(sort.node.id);
          const rest = predicates.some((entry) => LEFTOVER.has(entry.kind));
          advice.push({
            id: `page-${node.id}`,
            severity,
            title: `Index "${table}" on ${columns.map((entry) => `"${entry.column}"${entry.desc ? " DESC" : ""}`).join(", ")} for this page`,
            detail: `${counted}.${repeated}${stopped}${correlationNote} Index supports filtering and page order.${rest ? " Other filters still apply." : ""}${smallNote}`,
            nodes: sort ? [node.id, sort.node.id] : [node.id],
            fix: indexFix(context, table, columns),
          });
        }
      } else {
        const columns: IndexColumn[] = dedupe<IndexColumn>([
          ...correlation.map(({ column }) => ({ column })),
          ...single.map(({ column }) => ({ column })),
          ...multi.map(({ column }) => ({ column })),
          ...(range ? [{ column: range.column }] : []),
        ]);
        const leading =
          columns.length > 0 ? covering(table, columns.slice(0, 1)) : undefined;
        if (columns.length === 0) {
          // Nothing an index serves: no advice from the filter.
        } else if (
          keptShare !== undefined &&
          keptShare > 0.3 &&
          !isCorrelated
        ) {
          advice.push({
            id: `scan-${node.id}`,
            severity: "info",
            title: `Full scan of "${table}": the filter keeps most rows`,
            detail: `${counted}.${repeated} Keeps ${Math.round(keptShare * 100)}%; a scan may be cheaper.`,
            nodes: [node.id],
          });
        } else if (leading && covering(table, columns)) {
          advice.push({
            id: `scan-${node.id}`,
            severity,
            title: `Full scan of "${table}" despite the index ${leading.name}`,
            detail: `${counted}.${repeated} Refresh statistics and check filter compatibility.`,
            nodes: [node.id],
            fix: {
              sql: ANALYZE_SQL(context, table),
              note: "If unchanged, check casts and column types.",
            },
          });
        } else {
          advice.push({
            id: `scan-${node.id}`,
            severity,
            title: `Index "${table}" on ${columns.map((entry) => `"${entry.column}"`).join(", ")}`,
            detail: `${counted}.${repeated}${stopped}${correlationNote} Index narrows the scan.${leading ? ` Extends ${leading.name}.` : ""}${multi.length > 0 ? ` Multiple lookups for ${multi.map((entry) => `"${entry.column}"`).join(", ")}.` : ""}${smallNote}`,
            nodes: [node.id],
            fix: indexFix(context, table, columns),
          });
        }
      }
      for (const predicate of dedupe(
        predicates.filter(
          (entry) => entry.kind === "contains" || entry.kind === "suffix"
        )
      )) {
        advice.push({
          id: `contains-${node.id}-${predicate.column}`,
          severity: severity === "critical" ? "warning" : "info",
          title:
            predicate.kind === "suffix"
              ? `"${predicate.column}" is searched by its end`
              : `"${predicate.column}" is searched for anywhere in the text`,
          detail: `A standard b-tree cannot accelerate this search. ${counted}.${repeated}`,
          nodes: [node.id],
          fix:
            context.dialect === "postgresql"
              ? {
                  sql: `CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE INDEX ${quote(context.dialect, `${table}_${predicate.column}_trgm_idx`)} ON ${tableSql(context, table)} USING gin (${quote(context.dialect, predicate.column)} gin_trgm_ops);`,
                  note: "Trigrams support LIKE/ILIKE. Requires a SQL migration.",
                }
              : context.dialect === "mysql"
                ? {
                    sql: `CREATE FULLTEXT INDEX ${quote(context.dialect, `${table}_${predicate.column}_ft`)} ON ${tableSql(context, table)} (${quote(context.dialect, predicate.column)});`,
                    note: "Requires MATCH … AGAINST; does not accelerate LIKE/LOCATE.",
                  }
                : {
                    note: "Consider FTS5; search semantics differ.",
                  },
        });
      }
      if (context.dialect === "postgresql") {
        for (const predicate of dedupe(
          predicates.filter((entry) => entry.kind === "prefix")
        )) {
          advice.push({
            id: `prefix-${node.id}-${predicate.column}`,
            severity,
            title: `"${predicate.column}" is searched by its start`,
            detail: `Prefix search needs C collation or text_pattern_ops. ${counted}.`,
            nodes: [node.id],
            fix: {
              sql: `CREATE INDEX ${quote(context.dialect, `${table}_${predicate.column}_pattern_idx`)} ON ${tableSql(context, table)} (${quote(context.dialect, predicate.column)} text_pattern_ops);`,
              note: "Requires a SQL migration.",
            },
          });
        }
      }
    }

    // SQLite grouping in a temporary b-tree -----------------------------------------------------------------------
    if (GROUPING.test(node.detail ?? "")) {
      const terms = termsOf(GROUP.exec(context.sql)?.[1] ?? "");
      const first = terms?.[0];
      const groupTable = first?.alias ? aliases[first.alias] : undefined;
      const rows = groupTable ? (context.tableRows[groupTable] ?? 0) : 0;
      if (
        terms &&
        groupTable &&
        terms.every((term) => hasColumn(groupTable, term.column)) &&
        rows >= 1000 &&
        !covering(
          groupTable,
          terms.map(({ column }) => ({ column }))
        )
      ) {
        advice.push({
          id: `group-${node.id}`,
          severity: "info",
          title: `Plans to group "${groupTable}" in a temporary b-tree`,
          detail: `Index avoids the temporary b-tree. ~${formatRows(rows)} table rows; reads unmeasured.`,
          nodes: [node.id],
          fix: indexFix(
            context,
            groupTable,
            terms.map(({ column }) => ({ column }))
          ),
        });
      }
    }

    // An estimate far from what came --------------------------------------------------------------------------
    if (
      node.actual &&
      node.estimate?.rows !== undefined &&
      !node.neverExecuted &&
      table &&
      !cutByLimit(node)
    ) {
      const expected = node.estimate.rows;
      const came = node.actual.rows;
      const ratio =
        Math.max(expected, came) / Math.max(Math.min(expected, came), 1);
      if (ratio >= 10 && Math.max(expected, came) >= 1000) {
        advice.push({
          id: `estimate-${node.id}`,
          severity: "warning",
          title: `The planner expected ${formatRows(expected)} rows from "${table}", ${formatRows(came)} came`,
          detail:
            "Refresh statistics; consider extended statistics if estimates stay inaccurate.",
          nodes: [node.id],
          fix: { sql: ANALYZE_SQL(context, table) },
        });
      }
    }

    // PostgreSQL's own signs ----------------------------------------------------------------------------------
    const batches = Number(factOf(node, "Hash Batches") ?? 1);
    if (batches > 1) {
      advice.push({
        id: `hash-${node.id}`,
        severity: "warning",
        title: "The hash table spilled to disk",
        detail: `${batches} batches; exceeded work_mem.`,
        nodes: [node.id],
        fix: {
          sql: "SET work_mem = '64MB';",
          note: "Session setting. Alternatively, filter before joining.",
        },
      });
    }
    const heapFetches = Number(factOf(node, "Heap Fetches") ?? 0);
    if (
      heapFetches > 0 &&
      node.actual &&
      heapFetches > node.actual.rows * node.actual.loops * 0.1 &&
      table
    ) {
      advice.push({
        id: `heap-${node.id}`,
        severity: "info",
        title: `The index-only scan of "${table}" still read the table`,
        detail: `${formatRows(heapFetches)} heap fetches; refresh the visibility map.`,
        nodes: [node.id],
        fix: { sql: `VACUUM ${tableSql(context, table)};` },
      });
    }
    const lossy = Number(factOf(node, "Lossy Heap Blocks") ?? 0);
    if (lossy > 0) {
      advice.push({
        id: `lossy-${node.id}`,
        severity: "info",
        title: "The bitmap was too large for memory",
        detail: `${lossy} pages rechecked; increase work_mem.`,
        nodes: [node.id],
        fix: { sql: "SET work_mem = '64MB';", note: "For this session." },
      });
    }
  }

  // Sorts ------------------------------------------------------------------------------------------------------
  for (const node of spills) {
    const input = node.children[0];
    const rows = input?.actual ? input.actual.rows * input.actual.loops : 0;
    advice.push({
      id: `spill-${node.id}`,
      severity: "critical",
      title: "The sort spilled to disk",
      detail: `${formatRows(rows)} rows · ${factOf(node, "Sort Space Used") ?? "?"} kB on disk.`,
      nodes: [node.id],
      fix: {
        ...(context.dialect === "postgresql"
          ? { sql: "SET work_mem = '64MB';" }
          : {}),
        note: "Increase sort memory or index the sort columns.",
      },
    });
  }
  for (const sort of sorts.values()) {
    const repeated = correlated(sort.node);
    if (
      sortHandled.has(sort.node.id) ||
      (sort.rows !== undefined && sort.rows < 1000 && !repeated)
    )
      continue;
    const predicates = predicatesFor(sort.source, sort.alias);
    // Sorted once per outer row: the index begins with what ties the rows to that row.
    const correlation = repeated
      ? dedupe(predicates.filter((entry) => entry.kind === "join"))
      : [];
    const single = dedupe(predicates.filter((entry) => entry.kind === "equal"));
    const columns: IndexColumn[] = dedupe<IndexColumn>([
      ...correlation.map(({ column }) => ({ column })),
      ...single.map(({ column }) => ({ column })),
      ...sort.terms.map(({ column, desc }) => ({ column, desc })),
    ]);
    if (
      !columns.every((entry) => hasColumn(sort.table, entry.column)) ||
      covering(sort.table, columns)
    )
      continue;
    advice.push({
      id: `sort-${sort.node.id}`,
      severity: severityOf(sort.rows ?? 0) === "critical" ? "warning" : "info",
      title: `${plan.analyzed ? "Sorted" : "Plans to sort"} ${sort.rows === undefined ? "rows" : `${formatRows(sort.rows)}${plan.analyzed ? "" : " estimated"} rows`} of "${sort.table}" by ${sort.terms.map((term) => `${term.column}${term.desc ? " DESC" : ""}`).join(", ")}`,
      detail: `${sort.limited ? "Index avoids sorting before pagination." : "Index provides sorted rows."}${correlation.length > 0 ? ` Repeated per ${correlation.map((entry) => entry.column).join(", ")}.` : ""}${plan.analyzed ? "" : " Estimates per invocation; work unmeasured."}`,
      nodes: [sort.node.id],
      fix: indexFix(context, sort.table, columns),
    });
  }

  // Over the whole plan --------------------------------------------------------------------------------------
  // The top node's pages count its children's.
  const hit = plan.root.buffers?.hit ?? 0;
  const read = plan.root.buffers?.read ?? 0;
  if (read > 1000 && read / Math.max(hit + read, 1) > 0.5) {
    advice.push({
      id: "cold",
      severity: "info",
      title: "Most pages came from disk",
      detail: `${formatRows(read)} disk reads · ${formatRows(hit)} cache hits. Rerun to check warm-cache performance.`,
      nodes: [plan.root.id],
    });
  }
  if (
    plan.planningTime !== undefined &&
    plan.executionTime !== undefined &&
    plan.planningTime > 5 &&
    plan.planningTime > plan.executionTime
  ) {
    advice.push({
      id: "planning",
      severity: "info",
      title: "Planning took longer than running",
      detail: `${plan.planningTime.toFixed(1)} ms planning · ${plan.executionTime.toFixed(1)} ms execution. Consider a prepared statement.`,
      nodes: [plan.root.id],
    });
  }

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  // One piece of advice per fix: two scans asking for the same index say it once.
  const seen = new Set<string>();
  return advice
    .sort((left, right) => rank[left.severity] - rank[right.severity])
    .filter((entry) => {
      const key = entry.fix?.sql ?? entry.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
