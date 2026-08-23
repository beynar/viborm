import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { type Sql, sql } from "@sql";
import type { DatabaseAdapter, QueryParts } from "../../database-adapter";
import { createOnConflictBatchRefs } from "../../shared/batch-refs";
import {
  assembleDistinctOnEmulation,
  assembleSelectQuery,
} from "../../shared/select-assembly";
import {
  createAggregateFunctions,
  createCastExpression,
  createCommonExpressions,
  createComparisonOperators,
  createCoreJoins,
  createCteBuilders,
  createDirectionOrderBy,
  createExistenceOperators,
  createIdentifierQuoter,
  createIdentifiers,
  createInsertStatement,
  createLogicalOperators,
  createMembershipOperators,
  createMutationCommands,
  createNullOperators,
  createNumericSetOperations,
  createOnConflictBuilders,
  createRangeOperators,
  createRawSql,
  createRelationFilters,
  createSetOperations,
  createStandardClauses,
  createStandardLiterals,
  createSubqueries,
  escapeGlobLiteral,
  stringifyJson,
} from "../../shared/standard-sql";

const quoteIdent = createIdentifierQuoter('"');

const JSON_ARRAY_INDEX_SEGMENT = /^\d+$/;
const JSON_UNADDRESSABLE_LABEL = /["\\]/;

// Each path segment binds as its own single-leg JSONPath ('$[N]' for
// array indices, '$."seg"' otherwise) chained with -> , so segments can
// never splice extra legs into the path. SQLite's path grammar has no
// escape syntax inside quoted labels, so the portable query contract rejects
// keys containing " or \ before adapter execution. This throw is defensive.
const jsonPathLeg = (segment: string): string => {
  if (JSON_ARRAY_INDEX_SEGMENT.test(segment)) {
    return `$[${segment}]`;
  }
  if (JSON_UNADDRESSABLE_LABEL.test(segment)) {
    throw new Error(
      'SQLite JSON path segments containing " or \\ must be rejected by the portable query contract.'
    );
  }
  return `$."${segment}"`;
};

/** Chain one bound `-> '$leg'` per path segment ('$' alone = document root). */
const jsonExtract = (column: Sql, path: string[]): Sql => {
  let expr = sql`${column} -> '$'`;
  for (const segment of path) {
    const leg = jsonPathLeg(segment);
    expr = sql`${expr} -> ${leg}`;
  }
  return expr;
};

/** Same chain, but the final leg uses `->>` so strings come back unquoted. */
const jsonExtractText = (column: Sql, path: string[]): Sql => {
  const legs: string[] = [];
  for (const segment of path) {
    const leg = jsonPathLeg(segment);
    legs.push(leg);
  }
  const last = legs.pop();
  if (last === undefined) {
    return sql`${column} ->> '$'`;
  }
  let expr: Sql = column;
  for (const leg of legs) {
    expr = sql`${expr} -> ${leg}`;
  }
  return sql`${expr} ->> ${last}`;
};

/**
 * Concatenate two JSON array texts by string surgery: strip `left`'s closing
 * bracket and `right`'s opening bracket. SQLite has no JSON array-concat
 * function, and json_insert('$[#]') can only append one element per pair.
 * Both sides must be canonical JSON (json() output or JSON.stringify).
 */
const jsonArrayConcat = (left: Sql, right: Sql): Sql =>
  sql`(CASE WHEN ${left} = '[]' THEN ${right} WHEN ${right} = '[]' THEN ${left} ELSE substr(${left}, 1, length(${left}) - 1) || ',' || substr(${right}, 2) END)`;

/**
 * SQLite Database Adapter
 *
 * Implements the DatabaseAdapter interface for SQLite-specific SQL generation.
 *
 * Key SQLite features:
 * - Double-quote identifier escaping: "table"."column"
 * - No native ARRAY type - uses JSON for arrays
 * - Portable text predicates do not depend on SQLite's LIKE behavior
 * - json_object(), json_group_array() for JSON operations (SQLite 3.38+)
 * - RETURNING clause supported (SQLite 3.35+)
 * - No NULLS FIRST/LAST ordering
 * - ON CONFLICT DO UPDATE/NOTHING (same as PostgreSQL)
 * - || for string concatenation
 * - Boolean stored as 0/1 integers
 */
export class SQLiteAdapter implements DatabaseAdapter {
  // ============================================================
  // RAW
  // ============================================================

  raw = createRawSql();

  // ============================================================
  // IDENTIFIERS
  // ============================================================

  identifiers = createIdentifiers(quoteIdent);

  // ============================================================
  // LITERALS
  // ============================================================

  literals = {
    ...createStandardLiterals(),

    // SQLite uses 1/0 for booleans
    true: (): Sql => sql.raw`1`,

    false: (): Sql => sql.raw`0`,

    // SQLite requires JSON values to be stringified
    json: (v: unknown): Sql => sql`${JSON.stringify(v)}`,

    // SQLite has no exact decimal type, so a decimal lives in a TEXT column as
    // its canonical spelling and the operand stays text. Casting to NUMERIC or
    // REAL here would put the comparison through a double — which is exactly
    // what the TEXT column exists to avoid. Text equality is EXACT numeric
    // equality precisely because both sides are canonical; the operators that
    // text cannot answer (ordering, aggregation, arithmetic) are refused
    // outright rather than answered approximately.
    decimal: (canonical: string): Sql => sql`${canonical}`,
  };

  // ============================================================
  // OPERATORS
  // ============================================================

  operators = {
    // Comparison
    ...createComparisonOperators(),

    // Pattern matching
    // Explicit ESCAPE '\' pairs with wildcard escaping in the where-builder
    like: (column: Sql, pattern: Sql): Sql =>
      sql`${column} LIKE ${pattern} ESCAPE '\\'`,
    notLike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern} ESCAPE '\\'`,
    ilike: (column: Sql, pattern: Sql): Sql =>
      sql`lower(${column}) LIKE lower(${pattern}) ESCAPE '\\'`,
    notIlike: (column: Sql, pattern: Sql): Sql =>
      sql`lower(${column}) NOT LIKE lower(${pattern}) ESCAPE '\\'`,
    containsText: (column: Sql, value: Sql): Sql =>
      sql`instr(${column}, ${value}) > 0`,
    startsWithText: (column: Sql, value: Sql): Sql =>
      sql`substr(${column}, 1, length(${value})) COLLATE BINARY = ${value}`,
    endsWithText: (column: Sql, value: Sql): Sql =>
      sql`CASE WHEN length(${value}) = 0 THEN 1 ELSE substr(${column}, -length(${value})) COLLATE BINARY = ${value} END`,
    // GLOB, not LIKE — and this is the one place the "portable escaped LIKE"
    // premise of Decision 7.3 does not survive contact with SQLite. Both of
    // SQLite's LIKE-optimization preconditions fail here: an ESCAPE clause
    // disqualifies the optimization outright, and with `case_sensitive_like`
    // off (the default, and connection-global, so not ours to flip) the
    // optimization additionally wants a NOCASE-collated index, while `push()`
    // only ever creates BINARY ones. Measured on better-sqlite3, 20k rows,
    // plain index: `col LIKE ? ESCAPE '\'` is a SCAN — exactly what the
    // `substr` spelling above already costs — AND it answers case-insensitively,
    // which would break the case-sensitivity contract this operator holds.
    //
    // GLOB has neither problem. It compares bytes, so it is case- and
    // accent-sensitive by construction (that is what `COLLATE BINARY` buys
    // above, so nothing is lost by dropping it), and it ranges on the ordinary
    // BINARY index: the same probe plans this as a covering index SEARCH over
    // 111 rows against a 20000-row SCAN. Its wildcards are `*`/`?`/`[`, and it
    // has no ESCAPE clause, so `escapeGlobLiteral` quotes them as classes.
    startsWithPrefix: (column: Sql, value: string): Sql =>
      sql`${column} GLOB ${`${escapeGlobLiteral(value)}*`}`,

    // `COLLATE BINARY` names a COLLATION, not a function of the column, and
    // SQLite's ordinary index is a BINARY index — so the case-sensitive
    // spelling is already the index-usable one and there is nothing to add.
    // Byte-identical to what shipped before §10.2.
    exactTextEq: (column: Sql, value: Sql): Sql =>
      sql`${column} COLLATE BINARY = ${value}`,
    exactTextIn: (column: Sql, values: Sql): Sql =>
      sql`${column} COLLATE BINARY IN ${values}`,

    // Set membership
    ...createMembershipOperators(),

    // Null checks
    ...createNullOperators(),

    // Range
    ...createRangeOperators(),

    // Logical (vacuous cases use SQLite's 1/0 booleans)
    ...createLogicalOperators(this.literals.true, this.literals.false),

    // Subquery existence
    ...createExistenceOperators(),
  };

  // ============================================================
  // EXPRESSIONS
  // ============================================================

  expressions = {
    ...createCommonExpressions(),

    // SQLite lower() intentionally provides the portable ASCII-only contract.
    asciiCaseFold: (expr: Sql): Sql => sql`lower(${expr})`,
    caseSensitiveText: (expr: Sql): Sql => sql`${expr} COLLATE BINARY`,

    // String concatenation via ||
    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw`''`;
      if (parts.length === 1) return parts[0]!;
      return sql`(${sql.join(parts, " || ")})`;
    },

    // SQLite has no GREATEST/LEAST; multi-arg MAX/MIN are the scalar forms
    greatest: (...exprs: Sql[]): Sql => sql`MAX(${sql.join(exprs, ", ")})`,
    least: (...exprs: Sql[]): Sql => sql`MIN(${sql.join(exprs, ", ")})`,

    // SQLite type mappings
    cast: createCastExpression({
      text: "TEXT",
      integer: "INTEGER",
      boolean: "INTEGER",
      numeric: "NUMERIC",
      // TEXT, matching the storage column and `literals.decimal`. `CAST(x AS
      // NUMERIC)` would put the canonical spelling through a double — the exact
      // thing the TEXT column exists to avoid.
      decimal: "TEXT",
    }),

    blobToHex: (expr: Sql): Sql => sql`lower(hex(${expr}))`,
  };

  // ============================================================
  // AGGREGATES
  // ============================================================

  aggregates = createAggregateFunctions();

  // ============================================================
  // JSON (SQLite 3.38+ JSON functions)
  // ============================================================

  json = {
    boolean: (condition: Sql): Sql =>
      sql`json(CASE WHEN ${condition} THEN 'true' ELSE 'false' END)`,
    // SQLite drops the JSON subtype across scalar-subquery boundaries. Restore it
    // before embedding the value in json_object/json_array, or an object becomes a
    // quoted JSON string inside the outer document.
    document: (expression: Sql): Sql => sql`json(${expression})`,

    object: (pairs: [string, Sql][]): Sql => {
      if (pairs.length === 0) return sql.raw`json_object()`;
      const args = pairs.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`json_object(${sql.join(args, ", ")})`;
    },

    array: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`json_array()`;
      return sql`json_array(${sql.join(items, ", ")})`;
    },

    emptyArray: (): Sql => sql.raw`json_array()`,

    // Use json() to ensure the aggregated value is treated as JSON, not string
    // Without json(), json_group_array produces ["{...}"] instead of [{...}]
    agg: (expr: Sql): Sql =>
      sql`COALESCE(json_group_array(json(${expr})), json_array())`,

    objectFromColumns: (columns: [string, Sql][]): Sql => {
      if (columns.length === 0) return sql.raw`json_object()`;
      const args = columns.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`json_object(${sql.join(args, ", ")})`;
    },

    // `->` returns the value as canonical JSON text ('"str"', '2', 'null'),
    // the same format json.value binds, so extracted values compare with
    // plain equality (json_extract would return native SQL values instead)
    extract: jsonExtract,

    // `->>` returns text with strings unquoted, for LIKE matching
    extractText: jsonExtractText,

    // json_type reads the chained `->` result (canonical JSON text), so it
    // sees 'integer'/'real' only for real JSON numbers; every other shape —
    // and an absent path, where `->` is NULL — falls through to NULL
    numberAtPath: (column: Sql, path: string[]): Sql =>
      sql`(CASE WHEN json_type(${jsonExtract(column, path)}) IN ('integer', 'real') THEN CAST(${jsonExtractText(column, path)} AS REAL) END)`,

    // COLLATE BINARY is SQLite's default for these columns; naming it keeps
    // the code-point ordering contract explicit alongside PG's COLLATE "C"
    stringAtPath: (column: Sql, path: string[]): Sql =>
      sql`((CASE WHEN json_type(${jsonExtract(column, path)}) = 'text' THEN ${jsonExtractText(column, path)} END) COLLATE BINARY)`,

    // json_each pairs match hasEvery; the json_type guard keeps scalar
    // targets and NULLs from matching (mirrors PG @> / MySQL JSON_CONTAINS)
    contains: (target: Sql, value: Sql): Sql =>
      sql`(json_type(${target}) = 'array' AND (SELECT COUNT(*) FROM json_each(${value}) WHERE value IN (SELECT value FROM json_each(${target}))) = json_array_length(${value}))`,

    lastElement: (target: Sql): Sql => sql`${target} -> '$[#-1]'`,

    // Stored JSON is canonical (written via stringifyJson / SQLite json
    // functions), so text equality against a canonical param is JSON equality
    value: (v: unknown): Sql => sql`${stringifyJson(v)}`,
  };

  // ============================================================
  // ARRAYS (JSON-based for SQLite)
  // ============================================================

  arrays = {
    // SQLite uses JSON arrays
    literal: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`json_array()`;
      return sql`json_array(${sql.join(items, ", ")})`;
    },

    value: (values: unknown[]): Sql => sql`${stringifyJson(values)}`,

    // Check if value exists in JSON array using json_each
    has: (column: Sql, value: Sql): Sql =>
      sql`EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ${value})`,

    hasEvery: (column: Sql, values: Sql): Sql =>
      sql`(SELECT COUNT(*) FROM json_each(${values}) WHERE value IN (SELECT value FROM json_each(${column}))) = json_array_length(${values})`,

    hasSome: (column: Sql, values: Sql): Sql =>
      sql`EXISTS (SELECT 1 FROM json_each(${column}) AS a, json_each(${values}) AS b WHERE a.value = b.value)`,

    isEmpty: (column: Sql): Sql =>
      sql`(json_array_length(${column}) = 0 OR ${column} IS NULL)`,

    length: (column: Sql): Sql => sql`json_array_length(${column})`,

    get: (column: Sql, index: Sql): Sql =>
      sql`json_extract(${column}, '$[' || ${index} || ']')`,

    push: (column: Sql, value: Sql): Sql =>
      sql`json_insert(${column}, '$[#]', ${value})`,

    set: (column: Sql, index: Sql, value: Sql): Sql =>
      sql`json_set(${column}, '$[' || ${index} || ']', ${value})`,
  };

  // ============================================================
  // ORDER BY
  // ============================================================

  // SQLite parses NULLS FIRST/LAST natively since 3.30 (2019-10-04), which is
  // below this adapter's documented 3.35+ floor. The `(col IS NULL)` emulation
  // this replaces was an extra leading sort key, and an index can never supply
  // a sort key that is an expression: on a 100,000-row table with an index over
  // the sort columns, the emulated spelling planned `SCAN t | USE TEMP B-TREE
  // FOR ORDER BY` at 3.356 ms per page and the native one plans `SCAN t USING
  // INDEX` at 0.005 ms. MySQL keeps the emulation — it has no native syntax at
  // any version.
  orderBy = {
    ...createDirectionOrderBy(),
    nullsFirst: (column: Sql, direction: "asc" | "desc"): Sql =>
      direction === "desc"
        ? sql`${column} DESC NULLS FIRST`
        : sql`${column} ASC NULLS FIRST`,
    nullsLast: (column: Sql, direction: "asc" | "desc"): Sql =>
      direction === "desc"
        ? sql`${column} DESC NULLS LAST`
        : sql`${column} ASC NULLS LAST`,
  };

  // ============================================================
  // CLAUSES
  // ============================================================

  clauses = createStandardClauses();

  // ============================================================
  // SET (UPDATE operations)
  // ============================================================

  set = {
    ...createNumericSetOperations(),

    // SQLite drivers bind JS numbers as REAL, so `col / ?` runs real division
    // and would persist a fractional value into an INTEGER column. Casting the
    // divisor to INTEGER makes it native INT/INT division (truncating toward
    // zero, matching Postgres) for integer columns; real columns keep real
    // division since the column itself carries REAL affinity.
    divide: (column: Sql, by: Sql, columnIsInteger?: boolean): Sql =>
      columnIsInteger
        ? sql`${column} = ${column} / CAST(${by} AS INTEGER)`
        : sql`${column} = ${column} / ${by}`,

    push: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = ${jsonArrayConcat(
        sql`json(COALESCE(${column}, '[]'))`,
        sql`${stringifyJson(values)}`
      )}`,

    unshift: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = ${jsonArrayConcat(
        sql`${stringifyJson(values)}`,
        sql`json(COALESCE(${column}, '[]'))`
      )}`,
  };

  // ============================================================
  // FILTERS (Relation subquery wrappers)
  // ============================================================

  filters = createRelationFilters();

  // ============================================================
  // SUBQUERIES
  // ============================================================

  subqueries = createSubqueries(quoteIdent);

  // ============================================================
  // ASSEMBLE (Build complete SQL statements)
  // ============================================================

  // SQLite has no bare OFFSET; LIMIT -1 means "no limit"
  noLimitValue = sql.raw`-1`;

  assemble = {
    select: (parts: QueryParts): Sql => {
      // SQLite doesn't support DISTINCT ON natively
      // Simulate using ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)
      if (parts.distinct) {
        return assembleDistinctOnEmulation(
          parts,
          parts.distinct,
          this.identifiers.escape,
          this.noLimitValue
        );
      }

      // SQLite uses database-level locking, so FOR UPDATE is a no-op
      // (ignoring parts.forUpdate intentionally)
      return assembleSelectQuery(sql`SELECT ${parts.columns}`, parts, {
        forUpdate: "omit",
        noLimitValue: this.noLimitValue,
      });
    },
  };

  // ============================================================
  // CTE (Common Table Expressions)
  // ============================================================

  cte = createCteBuilders(quoteIdent);

  // ============================================================
  // MUTATIONS
  // ============================================================

  mutations = {
    skipDuplicatesStrategy: "sql" as const,
    insert: createInsertStatement(quoteIdent),
    insertDefault: (table: Sql): Sql =>
      sql`INSERT INTO ${table} DEFAULT VALUES`,

    ...createMutationCommands(),

    // SQLite 3.35+ supports RETURNING
    returning: (columns: Sql): Sql => sql`RETURNING ${columns}`,

    // SQLite uses same ON CONFLICT syntax as PostgreSQL (3.24+/3.35+)
    ...createOnConflictBuilders(),
  };

  assertions = {
    exists: (query: Sql): Sql =>
      sql`SELECT CASE WHEN EXISTS (${query}) THEN 1 ELSE json_extract('x', '$') END AS "__viborm_assert__"`,
    notExists: (query: Sql): Sql =>
      sql`SELECT CASE WHEN NOT EXISTS (${query}) THEN 1 ELSE json_extract('x', '$') END AS "__viborm_assert__"`,
  };

  // ============================================================
  // JOINS
  // ============================================================

  joins = {
    ...createCoreJoins(),

    // SQLite doesn't support RIGHT JOIN (before 3.39, and driver support varies).
    // Never silently downgrade: emitting LEFT JOIN without swapping operands
    // returns wrong rows. The query engine never calls this today.
    right: (_table: Sql, _condition: Sql): Sql => {
      throw new Error(
        "SQLite does not support RIGHT JOIN. Restructure the query with joins.left and swapped operands."
      );
    },

    // SQLite doesn't support FULL OUTER JOIN (before 3.39, and driver support varies).
    full: (_table: Sql, _condition: Sql): Sql => {
      throw new Error(
        "SQLite does not support FULL OUTER JOIN. Check adapter.capabilities.supportsFullOuterJoin before calling."
      );
    },

    // SQLite does NOT support LATERAL joins
    // These methods should never be called - query engine should check capability first
    lateral: (_subquery: Sql, _alias: string): Sql => {
      throw new Error(
        "SQLite does not support LATERAL joins. Check adapter.capabilities.supportsLateralJoins before calling."
      );
    },

    lateralLeft: (_subquery: Sql, _alias: string): Sql => {
      throw new Error(
        "SQLite does not support LATERAL joins. Check adapter.capabilities.supportsLateralJoins before calling."
      );
    },
  };

  // ============================================================
  // SET OPERATIONS
  // ============================================================

  setOperations = createSetOperations();

  // ============================================================
  // CAPABILITIES
  // ============================================================

  capabilities = {
    supportsReturning: true, // SQLite 3.35+
    // FALSE IN FACT, and it read `true` until the Phase 8 fold gave the flag its
    // first reader (query-performance-plan Phase 10.1). SQLite's `WITH` grammar
    // admits a SELECT and nothing else: measured on SQLite 3.51.2, each of
    // `WITH x AS (UPDATE …/INSERT …/DELETE … RETURNING …) SELECT * FROM x` is a
    // parse error (`near "UPDATE": syntax error`). Kept as a capability rather
    // than deleted because Phase 8's `WITH u AS (UPDATE … RETURNING *) SELECT …`
    // fold reads it to decide whether it may emit at all.
    supportsCteWithMutations: false,
    supportsFullOuterJoin: false,
    supportsLateralJoins: false, // SQLite does not support LATERAL joins
    supportsVector: false,
    supportsUpsertWhere: true, // SQLite supports WHERE in ON CONFLICT (3.24+)
    supportsTargetedUpsert: true, // ON CONFLICT (cols) arbitrates on those cols
    supportsMutationTargetInSubquery: true,
    // UPDATE/DELETE ... LIMIT needs SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which is
    // off in the builds this project targets (better-sqlite3, libSQL, D1).
    supportsMutationRowLimit: false,
    // No exact decimal type exists in SQLite — see the flag's own docs.
    supportsExactDecimal: false,
  };

  lastInsertId = (): Sql => sql.raw`last_insert_rowid()`;

  batchRefs = createOnConflictBatchRefs({
    table: sql.raw`"__viborm_batch_refs"`,
    batchIdColumn: sql.raw`"batch_id"`,
    keyColumn: sql.raw`"ref_key"`,
    valueColumn: sql.raw`"ref_value"`,
    createTable: sql.raw`CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key"))`,
    castValue: (valueSql) => sql`CAST((${valueSql}) AS TEXT)`,
    lastInsertId: () => this.lastInsertId(),
  });

  // ============================================================
  // VECTOR (not natively supported in SQLite)
  // ============================================================

  vector = unsupportedVector;

  // ============================================================
  // GEOSPATIAL (not natively supported in SQLite)
  // ============================================================

  geospatial = unsupportedGeospatial;

  // RESULT PARSING
  // SQLite-specific parsing is handled by the driver (SQLite3Driver.result)
  // Adapter just passes through to default parsing
  // ============================================================

  result = {
    parseResult: (
      _raw: unknown,
      _operation: import("../../../query-engine/types").Operation,
      next: (value?: unknown) => unknown
    ): unknown => next(),

    parseRelation: (
      _value: unknown,
      next: (value?: unknown) => unknown
    ): unknown => next(),

    parseField: (
      _value: unknown,
      _scalarType: string,
      next: (value?: unknown) => unknown
    ): unknown => next(),
  };
}

// Export singleton instance
export const sqliteAdapter = new SQLiteAdapter();
