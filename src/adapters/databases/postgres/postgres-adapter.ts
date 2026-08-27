import { type Sql, sql } from "@sql";
import { createIdentifierQuoter } from "../../../sql/identifiers";
import { installAdapterNamespace } from "../../adapter-namespace";
import type { DatabaseAdapter, QueryParts } from "../../database-adapter";
import { createOnConflictBatchRefs } from "../../shared/batch-refs";
import { convertBigIntToNumber } from "../../shared/result-parsing";
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
  createIdentifiers,
  createInsertStatement,
  createLateralJoins,
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
  escapeLikeLiteral,
} from "../../shared/standard-sql";

const quoteIdent = createIdentifierQuoter('"');

/**
 * PostgreSQL Database Adapter
 *
 * Implements the DatabaseAdapter interface for PostgreSQL-specific SQL generation.
 *
 * Key PostgreSQL features:
 * - Double-quote identifier escaping: "table"."column"
 * - Native ARRAY type with operators: @>, &&, ANY()
 * - ILIKE for case-insensitive matching
 * - json_build_object(), json_agg() for JSON operations
 * - RETURNING clause for mutations
 * - NULLS FIRST/LAST ordering
 * - ON CONFLICT DO UPDATE/NOTHING
 */
export class PostgresAdapter implements DatabaseAdapter {
  // ============================================================
  // NAMESPACE
  // ============================================================

  /**
   * The bound schema. PostgreSQL always qualifies, so this adapter has no
   * unbound mode: an omitted or explicitly `undefined` argument means the
   * `public` schema, whatever a connection's `search_path` says.
   */
  declare readonly namespace: string;

  constructor(namespace = "public") {
    installAdapterNamespace(this, namespace, "postgresql");
    // Reads the installed value, so it cannot be a field initializer: those run
    // before the constructor body.
    this.identifiers = createIdentifiers(quoteIdent, this.namespace);
  }

  // ============================================================
  // RAW
  // ============================================================

  raw = createRawSql();

  // ============================================================
  // IDENTIFIERS
  // ============================================================

  identifiers: DatabaseAdapter["identifiers"];

  // ============================================================
  // LITERALS
  // ============================================================

  literals = {
    ...createStandardLiterals(),

    true: (): Sql => sql.raw`TRUE`,

    false: (): Sql => sql.raw`FALSE`,

    // Serialized JSON text — PG casts the param to json/jsonb from the column
    // context. Stringifying (not raw binding) keeps primitives valid: a bare
    // 'hello' is not valid JSON input, '"hello"' is.
    json: (v: unknown): Sql => sql`${JSON.stringify(v)}`,

    // `numeric` is exact and unconstrained, so the cast is all it takes. PG
    // would usually infer `numeric` from the column context anyway; saying it
    // makes the comparison independent of what the surrounding expression does
    // to the operand's inferred type.
    decimal: (canonical: string): Sql => sql`CAST(${canonical} AS NUMERIC)`,
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
      sql`TRANSLATE(${column}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') LIKE TRANSLATE(${pattern}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') ESCAPE '\\'`,
    notIlike: (column: Sql, pattern: Sql): Sql =>
      sql`TRANSLATE(${column}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') NOT LIKE TRANSLATE(${pattern}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') ESCAPE '\\'`,
    containsText: (column: Sql, value: Sql): Sql =>
      sql`POSITION(${value} IN ${column}) > 0`,
    startsWithText: (column: Sql, value: Sql): Sql =>
      sql`LEFT(${column}, LENGTH(${value})) = ${value}`,
    endsWithText: (column: Sql, value: Sql): Sql =>
      sql`RIGHT(${column}, LENGTH(${value})) = ${value}`,
    // PostgreSQL is the one dialect where the escaped LIKE spelling is both
    // exact and index-usable, so it stands alone here: `LIKE` is case- and
    // accent-sensitive natively, which is the contract `startsWithText` holds,
    // and `match_pattern_prefix` extracts `name >= 'x' AND name < 'y'` from the
    // constant-folded pattern even though it arrives as a bound parameter.
    //
    // THE INDEX RANGE HAS A COLLATION PRECONDITION, and the common case does
    // not meet it. Measured, 20k rows, plain btree index:
    //   - C-collated database (PGlite, `datcollate = 'C'`): Bitmap Index Scan
    //     over 111 rows, where `LEFT(col, LENGTH($1)) = $1` is a Seq Scan over
    //     all 20000.
    //   - `en_US.utf8` (postgres:16 — the project's own test container, and
    //     what a default `initdb` produces): BOTH spellings Seq Scan. Only a
    //     `(col text_pattern_ops)` index ranges, and `generateCreateIndex`
    //     (src/migrations/drivers/postgres/index.ts) emits no opclass, so
    //     viborm cannot create one.
    // What survives on a default-locale cluster — and the reason this spelling
    // still stands there — is the row estimate: `LIKE` tracks the data
    // (202/1010/11111/19998 against truths 111/1111/11111/20000) while
    // `LEFT(...)` is an opaque function estimated at a flat 100 for every
    // prefix width, a 111x error at `name1%` that propagates into the row
    // estimate of any join above it. It is never worse than the spelling it
    // replaced on any measured leg. Full record: Decision 7.3 in
    // docs/architecture/query-performance-plan.md.
    startsWithPrefix: (column: Sql, value: string): Sql =>
      sql`${column} LIKE ${`${escapeLikeLiteral(value)}%`} ESCAPE '\\'`,

    // PostgreSQL's text comparison is already byte-exact and already
    // index-usable — `caseSensitiveText` is the identity here — so these are
    // the plain comparisons, byte-identical to what shipped before §10.2.
    exactTextEq: (column: Sql, value: Sql): Sql => sql`${column} = ${value}`,
    exactTextIn: (column: Sql, values: Sql): Sql => sql`${column} IN ${values}`,

    // Set membership — values is a parenthesized list from literals.list(),
    // so ANY/ALL (which need an array) would produce invalid SQL here
    ...createMembershipOperators(),

    // Null checks
    ...createNullOperators(),

    // Range
    ...createRangeOperators(),

    // Logical
    ...createLogicalOperators(this.literals.true, this.literals.false),

    // Subquery existence
    ...createExistenceOperators(),
  };

  // ============================================================
  // EXPRESSIONS
  // ============================================================

  expressions = {
    ...createCommonExpressions(),

    asciiCaseFold: (expr: Sql): Sql =>
      sql`TRANSLATE(${expr}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`,
    caseSensitiveText: (expr: Sql): Sql => expr,

    // String concatenation via ||
    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw`''`;
      if (parts.length === 1) return parts[0]!;
      return sql`(${sql.join(parts, " || ")})`;
    },

    greatest: (...exprs: Sql[]): Sql => sql`GREATEST(${sql.join(exprs, ", ")})`,
    least: (...exprs: Sql[]): Sql => sql`LEAST(${sql.join(exprs, ", ")})`,

    // PostgreSQL type mappings
    cast: createCastExpression({
      text: "TEXT",
      integer: "INTEGER",
      boolean: "BOOLEAN",
      numeric: "NUMERIC",
      // Same type `literals.decimal` casts into: exact and unconstrained.
      decimal: "NUMERIC",
    }),

    blobToHex: (expr: Sql): Sql => sql`encode(${expr}, 'hex')`,
  };

  // ============================================================
  // AGGREGATES
  // ============================================================

  aggregates = createAggregateFunctions();

  // ============================================================
  // JSON
  // ============================================================

  json = {
    boolean: (condition: Sql): Sql => condition,
    document: (expression: Sql): Sql => expression,

    object: (pairs: [string, Sql][]): Sql => {
      if (pairs.length === 0) return sql.raw`'{}'::json`;
      const args = pairs.flatMap(([key, value]) => [sql`${key}::text`, value]);
      return sql`json_build_object(${sql.join(args, ", ")})`;
    },

    array: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`'[]'::json`;
      return sql`json_build_array(${sql.join(items, ", ")})`;
    },

    emptyArray: (): Sql => sql.raw`'[]'::json`,

    agg: (expr: Sql): Sql => sql`COALESCE(json_agg(${expr}), '[]'::json)`,

    objectFromColumns: (columns: [string, Sql][]): Sql => {
      if (columns.length === 0) return sql.raw`'{}'::json`;
      const args = columns.flatMap(([key, value]) => [
        sql`${key}::text`,
        value,
      ]);
      return sql`json_build_object(${sql.join(args, ", ")})`;
    },

    // #>/#>> with a text[] param handles every path shape uniformly:
    // '{}' returns the document root, and integer segments address array
    // elements (a single-segment `-> '0'` would only match an object key)
    extract: (column: Sql, path: string[]): Sql =>
      sql`${column}#>${path}::text[]`,

    extractText: (column: Sql, path: string[]): Sql =>
      sql`${column}#>>${path}::text[]`,

    // jsonb_typeof gates the cast: a non-number (or an absent path, where
    // jsonb_typeof is NULL) short-circuits to NULL instead of raising
    // "invalid input syntax for type double precision"
    numberAtPath: (column: Sql, path: string[]): Sql =>
      sql`(CASE WHEN jsonb_typeof(${column}#>${path}::text[]) = 'number' THEN (${column}#>>${path}::text[])::double precision END)`,

    // COLLATE "C" pins byte (= code point) ordering; the database's default
    // collation (en_US.UTF-8 and friends) orders 'a' before 'B', which would
    // make < / > disagree with MySQL and SQLite
    stringAtPath: (column: Sql, path: string[]): Sql =>
      sql`((CASE WHEN jsonb_typeof(${column}#>${path}::text[]) = 'string' THEN ${column}#>>${path}::text[] END) COLLATE "C")`,

    contains: (target: Sql, value: Sql): Sql => sql`${target} @> ${value}`,

    lastElement: (target: Sql): Sql => sql`${target} -> -1`,

    // Serialized JSON text, same format literals.json writes — PG casts the
    // param to jsonb from the comparison context
    value: (v: unknown): Sql => sql`${JSON.stringify(v)}`,
  };

  // ============================================================
  // ARRAYS (Native PostgreSQL arrays)
  // ============================================================

  arrays = {
    literal: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`'{}'`;
      return sql`ARRAY[${sql.join(items, ", ")}]`;
    },

    // Native array parameter; drivers serialize JS arrays to PG array format
    value: (values: unknown[]): Sql => sql`${values}`,

    has: (column: Sql, value: Sql): Sql => sql`${value} = ANY(${column})`,

    hasEvery: (column: Sql, values: Sql): Sql => sql`${column} @> ${values}`,

    hasSome: (column: Sql, values: Sql): Sql => sql`${column} && ${values}`,

    isEmpty: (column: Sql): Sql =>
      sql`(cardinality(${column}) = 0 OR ${column} IS NULL)`,

    length: (column: Sql): Sql => sql`cardinality(${column})`,

    get: (column: Sql, index: Sql): Sql => sql`${column}[${index}]`,

    push: (column: Sql, value: Sql): Sql =>
      sql`array_append(${column}, ${value})`,

    set: (column: Sql, index: Sql, value: Sql): Sql =>
      sql`${column}[:${index}-1] || ARRAY[${value}] || ${column}[${index}+1:]`,
  };

  // ============================================================
  // ORDER BY
  // ============================================================

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

    // array_cat (not ||) so the untyped array param resolves unambiguously
    // to the column's array type; COALESCE keeps NULL columns appendable.
    push: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = array_cat(COALESCE(${column}, '{}'), ${values})`,

    unshift: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = array_cat(${values}, COALESCE(${column}, '{}'))`,
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

  assemble = {
    select: (parts: QueryParts): Sql => {
      // DISTINCT ON requires ORDER BY to lead with the distinct columns, which
      // would override the user's ordering — emulate via ROW_NUMBER() instead
      if (parts.distinct && parts.orderBy) {
        return assembleDistinctOnEmulation(
          parts,
          parts.distinct,
          this.identifiers.escape
        );
      }

      // PostgreSQL supports DISTINCT ON (columns)
      const selectClause = parts.distinct
        ? sql`SELECT DISTINCT ON (${parts.distinct}) ${parts.columns}`
        : sql`SELECT ${parts.columns}`;

      return assembleSelectQuery(selectClause, parts, { forUpdate: "append" });
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

    returning: (columns: Sql): Sql => sql`RETURNING ${columns}`,

    ...createOnConflictBuilders(),
  };

  assertions = {
    exists: (query: Sql): Sql =>
      sql`SELECT 1 / CASE WHEN EXISTS (${query}) THEN 1 ELSE 0 END AS "__viborm_assert__"`,
    notExists: (query: Sql): Sql =>
      sql`SELECT 1 / CASE WHEN NOT EXISTS (${query}) THEN 1 ELSE 0 END AS "__viborm_assert__"`,
  };

  // ============================================================
  // JOINS
  // ============================================================

  joins = {
    ...createCoreJoins(),

    full: (table: Sql, condition: Sql): Sql =>
      sql`FULL OUTER JOIN ${table} ON ${condition}`,

    ...createLateralJoins(quoteIdent),
  };

  // ============================================================
  // SET OPERATIONS
  // ============================================================

  setOperations = createSetOperations();

  // ============================================================
  // CAPABILITIES
  // ============================================================

  capabilities = {
    supportsReturning: true,
    supportsCteWithMutations: true,
    supportsFullOuterJoin: true,
    supportsLateralJoins: true,
    supportsVector: false,
    // PostGIS is an installed extension; the pg-family drivers flip this and
    // replace `geospatial` together when `postgis` is enabled.
    supportsGeospatial: false,
    supportsUpsertWhere: true, // PostgreSQL supports WHERE in ON CONFLICT
    supportsTargetedUpsert: true, // ON CONFLICT (cols) arbitrates on those cols
    supportsMutationTargetInSubquery: true,
    supportsMutationRowLimit: false, // PostgreSQL has no UPDATE/DELETE ... LIMIT
    supportsExactDecimal: true, // `numeric`: exact, unconstrained precision
  };

  lastInsertId = (): Sql => sql.raw`lastval()`;

  batchRefs = createOnConflictBatchRefs({
    table: sql.raw`"__viborm_batch_refs"`,
    batchIdColumn: sql.raw`"batch_id"`,
    keyColumn: sql.raw`"ref_key"`,
    valueColumn: sql.raw`"ref_value"`,
    createTable: sql.raw`CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key")) ON COMMIT DROP`,
    castValue: (valueSql) => sql`CAST((${valueSql}) AS TEXT)`,
  });

  // ============================================================
  // VECTOR (pgvector)
  // ============================================================

  vector = {
    literal: (values: number[]): Sql => sql`${`[${values.join(",")}]`}::vector`,

    l2: (column: Sql, vector: Sql): Sql => sql`${column} <-> ${vector}`,

    cosine: (column: Sql, vector: Sql): Sql => sql`${column} <=> ${vector}`,
  };

  // ============================================================
  // GEOSPATIAL (PostGIS)
  // ============================================================

  geospatial = {
    point: (lng: Sql, lat: Sql): Sql =>
      sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`,

    equals: (geom1: Sql, geom2: Sql): Sql => sql`ST_Equals(${geom1}, ${geom2})`,

    intersects: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Intersects(${geom1}, ${geom2})`,

    contains: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Contains(${geom1}, ${geom2})`,

    within: (geom1: Sql, geom2: Sql): Sql => sql`ST_Within(${geom1}, ${geom2})`,

    crosses: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Crosses(${geom1}, ${geom2})`,

    overlaps: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Overlaps(${geom1}, ${geom2})`,

    touches: (geom1: Sql, geom2: Sql): Sql =>
      sql`ST_Touches(${geom1}, ${geom2})`,

    covers: (geom1: Sql, geom2: Sql): Sql => sql`ST_Covers(${geom1}, ${geom2})`,

    dWithin: (geom1: Sql, geom2: Sql, distance: Sql): Sql =>
      sql`ST_DWithin(${geom1}::geography, ${geom2}::geography, ${distance})`,
  };

  // ============================================================
  // RESULT PARSING
  // PostgreSQL: Mostly passthrough - native JSON and boolean types
  // ============================================================

  result = {
    // PostgreSQL returns native JS scalars and parseField below is a pure
    // passthrough, so the result parser may take the identity fast path for
    // plain string/int/number/boolean columns (byte-identical, guarded).
    nativeScalarPassthrough: true,

    parseResult: (
      raw: unknown,
      _operation: import("../../../query-engine/types").Operation,
      next: (value?: unknown) => unknown
    ): unknown => {
      // PostgreSQL returns bigint for COUNT - convert to number
      const converted = convertBigIntToNumber(raw);
      if (converted !== undefined) {
        return converted;
      }
      return next();
    },

    parseRelation: (
      _value: unknown,
      next: (value?: unknown) => unknown
    ): unknown => {
      // PostgreSQL returns native JSON objects - passthrough
      return next();
    },

    parseField: (
      _value: unknown,
      _scalarType: string,
      next: (value?: unknown) => unknown
    ): unknown => {
      // PostgreSQL has native types - passthrough
      return next();
    },
  };
}

// Export singleton instance
export const postgresAdapter = new PostgresAdapter();
