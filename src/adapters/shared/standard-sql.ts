import { type Sql, sql } from "@sql";
import {
  createQualifiedIdentifierRenderer,
  type IdentifierQuoter,
} from "../../sql/identifiers";
import type { CastType, DatabaseAdapter } from "../database-adapter";

type StandardLiterals = Pick<
  DatabaseAdapter["literals"],
  "value" | "null" | "list" | "dateTime"
>;

type ComparisonOperators = Pick<
  DatabaseAdapter["operators"],
  "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
>;

type NullOperators = Pick<DatabaseAdapter["operators"], "isNull" | "isNotNull">;

type RangeOperators = Pick<
  DatabaseAdapter["operators"],
  "between" | "notBetween"
>;

type ExistenceOperators = Pick<
  DatabaseAdapter["operators"],
  "exists" | "notExists"
>;

type DirectionOrderBy = Pick<DatabaseAdapter["orderBy"], "asc" | "desc">;

type NumericSetOperations = Pick<
  DatabaseAdapter["set"],
  "assign" | "increment" | "decrement" | "multiply" | "divide"
>;

type MutationCommands = Pick<DatabaseAdapter["mutations"], "update" | "delete">;

export const createRawSql = (): DatabaseAdapter["raw"] => {
  return (sqlString: string): Sql => sql.raw(sqlString);
};

/**
 * JSON-serialize a value for dialects that store lists/JSON as JSON text
 * (MySQL, SQLite). BigInt has no JSON representation, so it serializes as a
 * string; the result parser converts it back via the scalar's bigint type.
 */
export const stringifyJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v
  );

const JSON_PATH_ARRAY_INDEX = /^\d+$/;

/**
 * Build a MySQL/SQLite JSONPath string from path segments: '$' plus `[N]`
 * for integer segments (array indices) and `."seg"` for object keys.
 * Keys are JSON-string-escaped so quotes/dots/backslashes in a segment
 * cannot alter the path structure; the result is bound as a parameter.
 */
export const buildJsonPath = (path: string[]): string => {
  let jsonPath = "$";
  for (const segment of path) {
    jsonPath += JSON_PATH_ARRAY_INDEX.test(segment)
      ? `[${segment}]`
      : `.${JSON.stringify(segment)}`;
  }
  return jsonPath;
};

export const createStandardLiterals = (): StandardLiterals => ({
  value: (v: unknown): Sql => sql`${v}`,
  null: (): Sql => sql.raw`NULL`,
  list: (values: Sql[]): Sql => {
    if (values.length === 0) return sql.raw`()`;
    return sql`(${sql.join(values, ", ")})`;
  },
  // PG/SQLite accept ISO-8601 directly
  dateTime: (iso: string): Sql => sql`${iso}`,
});

export const createComparisonOperators = (): ComparisonOperators => ({
  eq: (left: Sql, right: Sql): Sql => sql`${left} = ${right}`,
  neq: (left: Sql, right: Sql): Sql => sql`${left} <> ${right}`,
  lt: (left: Sql, right: Sql): Sql => sql`${left} < ${right}`,
  lte: (left: Sql, right: Sql): Sql => sql`${left} <= ${right}`,
  gt: (left: Sql, right: Sql): Sql => sql`${left} > ${right}`,
  gte: (left: Sql, right: Sql): Sql => sql`${left} >= ${right}`,
});

export const createNullOperators = (): NullOperators => ({
  isNull: (expr: Sql): Sql => sql`${expr} IS NULL`,
  isNotNull: (expr: Sql): Sql => sql`${expr} IS NOT NULL`,
});

export const createRangeOperators = (): RangeOperators => ({
  between: (column: Sql, min: Sql, max: Sql): Sql =>
    sql`${column} BETWEEN ${min} AND ${max}`,
  notBetween: (column: Sql, min: Sql, max: Sql): Sql =>
    sql`${column} NOT BETWEEN ${min} AND ${max}`,
});

export const createExistenceOperators = (): ExistenceOperators => ({
  exists: (subquery: Sql): Sql => sql`EXISTS (${subquery})`,
  notExists: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
});

type StandardAggregates = Omit<
  DatabaseAdapter["aggregates"],
  "decimalAvg" | "decimalSumOperandPrecision"
>;

/**
 * The aggregate functions every dialect spells identically. `decimalAvg` is
 * deliberately absent: an exact decimal average is derived from `SUM` and
 * `COUNT` in the column's own physical domain, which is the one thing the three
 * dialects do not agree on, so each adapter states it.
 * `decimalSumOperandPrecision` is absent because each dialect also owns exact
 * admission of an operand compared with a widened sum.
 */
export const createAggregateFunctions = (): StandardAggregates => ({
  count: (expr?: Sql): Sql => (expr ? sql`COUNT(${expr})` : sql.raw`COUNT(*)`),
  countDistinct: (expr: Sql): Sql => sql`COUNT(DISTINCT ${expr})`,
  sum: (expr: Sql): Sql => sql`SUM(${expr})`,
  avg: (expr: Sql): Sql => sql`AVG(${expr})`,
  min: (expr: Sql): Sql => sql`MIN(${expr})`,
  max: (expr: Sql): Sql => sql`MAX(${expr})`,
});

/** The widened precision carried by one trusted coefficient spelling. */
export function decimalCoefficientPrecision(coefficient: string): number {
  return coefficient.startsWith("-")
    ? coefficient.length - 1
    : coefficient.length;
}

/** Exact-decimal aggregate operand admission for precision-bounded dialects. */
export function createDecimalSumOperandPrecision(
  maxPrecision: number
): (coefficient: string) => number | undefined {
  return (coefficient) => {
    const precision = decimalCoefficientPrecision(coefficient);
    return precision <= maxPrecision ? precision : undefined;
  };
}

export const createDirectionOrderBy = (): DirectionOrderBy => ({
  asc: (column: Sql): Sql => sql`${column} ASC`,
  desc: (column: Sql): Sql => sql`${column} DESC`,
});

const directionKeyword = (direction: "asc" | "desc"): Sql =>
  direction === "desc" ? sql.raw`DESC` : sql.raw`ASC`;

/**
 * NULLS FIRST/LAST emulation for dialects without native support
 * (MySQL, SQLite): prepend an IS NULL sort key. IS NULL yields 1 for
 * NULL rows, so DESC puts them first and ASC puts them last.
 */
export const createEmulatedNullsOrderBy = (): Pick<
  DatabaseAdapter["orderBy"],
  "nullsFirst" | "nullsLast"
> => ({
  nullsFirst: (column: Sql, direction: "asc" | "desc"): Sql =>
    sql`(${column} IS NULL) DESC, ${column} ${directionKeyword(direction)}`,
  nullsLast: (column: Sql, direction: "asc" | "desc"): Sql =>
    sql`(${column} IS NULL) ASC, ${column} ${directionKeyword(direction)}`,
});

export const createStandardClauses = (): DatabaseAdapter["clauses"] => ({
  select: (columns: Sql): Sql => sql`SELECT ${columns}`,
  selectDistinct: (columns: Sql): Sql => sql`SELECT DISTINCT ${columns}`,
  from: (table: Sql): Sql => sql`FROM ${table}`,
  where: (condition: Sql): Sql => sql`WHERE ${condition}`,
  orderBy: (orders: Sql): Sql => sql`ORDER BY ${orders}`,
  limit: (count: Sql): Sql => sql`LIMIT ${count}`,
  offset: (count: Sql): Sql => sql`OFFSET ${count}`,
  groupBy: (columns: Sql): Sql => sql`GROUP BY ${columns}`,
  having: (condition: Sql): Sql => sql`HAVING ${condition}`,
});

/**
 * The native arithmetic every dialect shares.
 *
 * `increment`/`decrement` are complete here for EVERY scalar including decimal:
 * addition of two values already in the column's domain — logical decimals on
 * PostgreSQL/MySQL, unscaled coefficients at the same scale on SQLite — creates
 * no digit beyond that domain and therefore never rounds.
 *
 * `multiply` and `divide` do create such digits, so each adapter overrides them
 * to route a decimal target through the shared half-even rule.
 */
export const createNumericSetOperations = (): NumericSetOperations => ({
  assign: (column: Sql, value: Sql): Sql => sql`${column} = ${value}`,
  increment: (column: Sql, by: Sql): Sql => sql`${column} = ${column} + ${by}`,
  decrement: (column: Sql, by: Sql): Sql => sql`${column} = ${column} - ${by}`,
  multiply: (column: Sql, by: Sql): Sql => sql`${column} = ${column} * ${by}`,
  divide: (column: Sql, by: Sql): Sql => sql`${column} = ${column} / ${by}`,
});

export const createRelationFilters = (): DatabaseAdapter["filters"] => ({
  some: (subquery: Sql): Sql => sql`EXISTS (${subquery})`,
  every: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
  none: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
  is: (subquery: Sql): Sql => sql`EXISTS (${subquery})`,
  isNot: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
});

export const createMutationCommands = (): MutationCommands => ({
  update: (table: Sql, sets: Sql, where?: Sql): Sql => {
    if (where) {
      return sql`UPDATE ${table} SET ${sets} WHERE ${where}`;
    }
    return sql`UPDATE ${table} SET ${sets}`;
  },
  delete: (table: Sql, where?: Sql): Sql => {
    if (where) {
      return sql`DELETE FROM ${table} WHERE ${where}`;
    }
    return sql`DELETE FROM ${table}`;
  },
});

export const createSetOperations = (): DatabaseAdapter["setOperations"] => ({
  union: (...queries: Sql[]): Sql => sql.join(queries, " UNION "),
  unionAll: (...queries: Sql[]): Sql => sql.join(queries, " UNION ALL "),
  intersect: (...queries: Sql[]): Sql => sql.join(queries, " INTERSECT "),
  except: (left: Sql, right: Sql): Sql => sql`${left} EXCEPT ${right}`,
});

// ============================================================
// Dialect-parameterized factories: identical grammar across
// adapters, differing only in the identifier quote character.
// ============================================================

/**
 * `namespace` is the adapter's prevalidated database namespace, or `undefined`
 * for the unqualified dialects. It is quoted once here, at adapter
 * construction — `table()` runs once per persistent table per compiled
 * statement and must not re-quote it.
 */
export const createIdentifiers = (
  quoteIdent: IdentifierQuoter,
  namespace?: string
): DatabaseAdapter["identifiers"] => {
  const qualify = createQualifiedIdentifierRenderer(quoteIdent, namespace);
  return {
    escape: (name: string): Sql => sql.raw(quoteIdent(name)),

    column: (alias: string, field: string): Sql => {
      const identifier = alias
        ? `${quoteIdent(alias)}.${quoteIdent(field)}`
        : quoteIdent(field);
      return sql.raw(identifier);
    },

    table: (tableName: string, alias?: string): Sql => {
      const qualified = qualify(tableName);
      return sql.raw(
        alias === undefined ? qualified : `${qualified} AS ${quoteIdent(alias)}`
      );
    },

    aliased: (expression: Sql, alias: string): Sql =>
      sql`${expression} AS ${sql.raw(quoteIdent(alias))}`,
  };
};

export const createSubqueries = (
  quoteIdent: IdentifierQuoter
): DatabaseAdapter["subqueries"] => ({
  scalar: (query: Sql): Sql => sql`(${query})`,

  correlate: (query: Sql, alias: string): Sql =>
    sql`(${query}) AS ${sql.raw`${quoteIdent(alias)}`}`,

  existsCheck: (from: Sql, where: Sql): Sql =>
    sql`SELECT 1 FROM ${from} WHERE ${where}`,
});

export const createCteBuilders = (
  quoteIdent: IdentifierQuoter
): DatabaseAdapter["cte"] => ({
  with: (definitions: { name: string; query: Sql }[]): Sql => {
    const defs = definitions.map(
      ({ name, query }) => sql`${sql.raw(quoteIdent(name))} AS (${query})`
    );
    return sql`WITH ${sql.join(defs, ", ")}`;
  },

  recursive: (
    name: string,
    anchor: Sql,
    recursive: Sql,
    union: "all" | "distinct" = "all"
  ): Sql => {
    const unionKeyword = union === "all" ? sql.raw`UNION ALL` : sql.raw`UNION`;
    return sql`WITH RECURSIVE ${sql.raw(quoteIdent(name))} AS (
        ${anchor}
        ${unionKeyword}
        ${recursive}
      )`;
  },
});

export const createInsertStatement =
  (quoteIdent: IdentifierQuoter): DatabaseAdapter["mutations"]["insert"] =>
  (
    table: Sql,
    columns: string[],
    source: Sql[][] | { readonly select: Sql },
    prefix?: Sql
  ): Sql => {
    const cols = columns.map((c) => sql.raw`${quoteIdent(c)}`);
    const body = Array.isArray(source)
      ? sql`VALUES ${sql.join(
          source.map((row) => sql`(${sql.join(row, ", ")})`),
          ", "
        )}`
      : source.select;
    const prefixPart = prefix ? sql`${prefix} ` : sql``;
    return sql`INSERT ${prefixPart}INTO ${table} (${sql.join(
      cols,
      ", "
    )}) ${body}`;
  };

/**
 * Standard ON CONFLICT grammar shared by PostgreSQL and SQLite.
 * MySQL's ON DUPLICATE KEY UPDATE is a different grammar with different
 * semantics — it stays in the MySQL adapter.
 */
export const createOnConflictBuilders = (): Pick<
  DatabaseAdapter["mutations"],
  "onConflict" | "onConflictUpdate" | "skipDuplicates"
> => ({
  onConflict: (target: Sql | null, action: Sql, targetWhere?: Sql): Sql => {
    if (target) {
      if (targetWhere) {
        // ON CONFLICT (id) WHERE <targetWhere> DO UPDATE ...
        return sql`ON CONFLICT (${target}) WHERE ${targetWhere} DO ${action}`;
      }
      return sql`ON CONFLICT (${target}) DO ${action}`;
    }
    return sql`ON CONFLICT DO ${action}`;
  },

  onConflictUpdate: (sets: Sql, setWhere?: Sql): Sql => {
    if (setWhere) {
      // UPDATE SET x = y WHERE <setWhere>
      return sql`UPDATE SET ${sets} WHERE ${setWhere}`;
    }
    return sql`UPDATE SET ${sets}`;
  },

  // The UNTARGETED skip, and the only caller left is top-level `createMany`,
  // whose `skipDuplicates: true` means "any unique constraint". Junction
  // membership inserts want the opposite — only an exact repeat of the complete
  // membership key — and reach `onConflict` above with that key as the target.
  skipDuplicates: () => ({
    prefix: sql``,
    suffix: sql`ON CONFLICT DO NOTHING`,
  }),
});

export const createMembershipOperators = (): Pick<
  DatabaseAdapter["operators"],
  "in" | "notIn"
> => ({
  in: (column: Sql, values: Sql): Sql => sql`${column} IN ${values}`,
  notIn: (column: Sql, values: Sql): Sql => sql`${column} NOT IN ${values}`,
});

/**
 * AND/OR/NOT with vacuous-case literals: the dialect's TRUE for an empty
 * AND and FALSE for an empty OR (pass the adapter's literals.true/false).
 */
export const createLogicalOperators = (
  vacuousTrue: () => Sql,
  vacuousFalse: () => Sql
): Pick<DatabaseAdapter["operators"], "and" | "or" | "not"> => ({
  and: (...conditions: Sql[]): Sql => {
    if (conditions.length === 0) return vacuousTrue();
    if (conditions.length === 1) return conditions[0]!;
    return sql`(${sql.join(conditions, " AND ")})`;
  },

  or: (...conditions: Sql[]): Sql => {
    if (conditions.length === 0) return vacuousFalse();
    if (conditions.length === 1) return conditions[0]!;
    return sql`(${sql.join(conditions, " OR ")})`;
  },

  not: (condition: Sql): Sql => sql`NOT (${condition})`,
});

export const createCommonExpressions = (): Pick<
  DatabaseAdapter["expressions"],
  | "caseWhen"
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "upper"
  | "lower"
  | "coalesce"
> => ({
  caseWhen: (branches, otherwise): Sql =>
    branches.length === 0
      ? otherwise
      : sql`CASE ${sql.join(
          branches.map(
            (branch) => sql`WHEN ${branch.when} THEN ${branch.then}`
          ),
          " "
        )} ELSE ${otherwise} END`,
  add: (left: Sql, right: Sql): Sql => sql`(${left} + ${right})`,
  subtract: (left: Sql, right: Sql): Sql => sql`(${left} - ${right})`,
  multiply: (left: Sql, right: Sql): Sql => sql`(${left} * ${right})`,
  divide: (left: Sql, right: Sql): Sql => sql`(${left} / ${right})`,
  upper: (expr: Sql): Sql => sql`UPPER(${expr})`,
  lower: (expr: Sql): Sql => sql`LOWER(${expr})`,
  coalesce: (...exprs: Sql[]): Sql => sql`COALESCE(${sql.join(exprs, ", ")})`,
});

export const createCastExpression =
  (typeMap: Record<CastType, string>): DatabaseAdapter["expressions"]["cast"] =>
  (expr: Sql, type: CastType): Sql =>
    sql`CAST(${expr} AS ${sql.raw`${typeMap[type]}`})`;

export const createCoreJoins = (): Pick<
  DatabaseAdapter["joins"],
  "inner" | "left" | "right" | "cross"
> => ({
  inner: (table: Sql, condition: Sql): Sql =>
    sql`INNER JOIN ${table} ON ${condition}`,

  left: (table: Sql, condition: Sql): Sql =>
    sql`LEFT JOIN ${table} ON ${condition}`,

  right: (table: Sql, condition: Sql): Sql =>
    sql`RIGHT JOIN ${table} ON ${condition}`,

  cross: (table: Sql): Sql => sql`CROSS JOIN ${table}`,
});

export const createLateralJoins = (
  quoteIdent: IdentifierQuoter
): Pick<DatabaseAdapter["joins"], "lateral" | "lateralLeft"> => ({
  lateral: (subquery: Sql, alias: string): Sql =>
    sql`JOIN LATERAL (${subquery}) AS ${sql.raw`${quoteIdent(alias)}`} ON TRUE`,

  lateralLeft: (subquery: Sql, alias: string): Sql =>
    sql`LEFT JOIN LATERAL (${subquery}) AS ${sql.raw`${quoteIdent(alias)}`} ON TRUE`,
});

/**
 * Escape a user value so a SQL `LIKE` pattern matches it literally.
 *
 * `%`, `_` and the escape character itself become escaped; every other
 * character is left alone. The caller appends its own wildcard and must emit
 * a matching `ESCAPE` clause — backslash is only the escape character because
 * every `ESCAPE` clause in this codebase spells backslash.
 */
export const escapeLikeLiteral = (value: string): string =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Escape a user value so a SQLite `GLOB` pattern matches it literally.
 *
 * GLOB has no `ESCAPE` clause, so a metacharacter is quoted by wrapping it in
 * a one-character class: `*` becomes `[*]`. Only `*`, `?` and `[` need it —
 * a `]` outside a class is already literal in SQLite's GLOB, and backslash is
 * not a GLOB metacharacter at all.
 */
export const escapeGlobLiteral = (value: string): string =>
  value.replace(/[*?[]/g, (char) => `[${char}]`);
