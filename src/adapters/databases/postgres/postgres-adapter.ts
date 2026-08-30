import { type Sql, sql } from "@sql";
import {
  type DecimalDescriptor,
  decimalColumnType,
  encodePhysicalDecimal,
} from "@validation/primitives/decimal-codec";
import { GEO_POINT_EARTH_RADIUS_METERS } from "@validation/primitives/geo-area-codec";
import { createIdentifierQuoter } from "../../../sql/identifiers";
import { JsonParameter } from "../../../sql/json-parameter";
import type { ArithmeticTarget } from "../../adapter-core-types";
import { installAdapterInternals } from "../../adapter-internals";
import { installAdapterNamespace } from "../../adapter-namespace";
import type { QueryParts } from "../../adapter-query-parts";
import {
  type DatabaseAdapter,
  type GeoPointSql,
  installGeoPointSql,
} from "../../database-adapter";
import { createOnConflictBatchRefs } from "../../shared/batch-refs";
import {
  type ExactIntegerArithmetic,
  logicalDecimalAverage,
  logicalDecimalDivide,
  logicalDecimalMultiply,
} from "../../shared/decimal-arithmetic";
import {
  createGeoPointCoordinatePredicates,
  geoBoundsIndexPolygons,
  geoPolygonJson,
} from "../../shared/geo-point";
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
  createDecimalSumOperandPrecision,
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
 * `div`/`mod` rather than `/` and a hand-rolled remainder: both are exact on
 * `numeric` for any operand, including a fractional divisor, and `div`
 * truncates toward zero — which is what the half-even rule's quotient means.
 * `/` on numerics picks its own result scale and would round the last digit.
 */
const POSTGRES_INTEGERS: ExactIntegerArithmetic = {
  quotient: (n: Sql, d: Sql): Sql => sql`div(${n}, ${d})`,
  remainder: (n: Sql, d: Sql): Sql => sql`mod(${n}, ${d})`,
};

/** The two characters PostgreSQL reads structurally inside a quoted member. */
const ARRAY_LITERAL_ESCAPES = /(["\\])/g;

/**
 * PostgreSQL's own text spelling of one list, for a column whose element type
 * the driver cannot serialize.
 *
 * Every member is quoted, so a member that is empty, spells `NULL`, or holds a
 * brace, comma, quote or backslash is still exactly one member: those are the
 * only characters the server reads structurally, and quoting makes the reading
 * unambiguous without a per-member decision.
 */
function arrayLiteralText(values: readonly unknown[]): string {
  const members = values.map(
    (value) => `"${String(value).replace(ARRAY_LITERAL_ESCAPES, "\\$1")}"`
  );
  return `{${members.join(",")}}`;
}

/** The list column with every member appended, one element at a time. */
function appendedMembers(column: Sql, values: readonly unknown[]): Sql {
  let list = sql`COALESCE(${column}, '{}')`;
  for (const value of values) {
    list = sql`array_append(${list}, ${value})`;
  }
  return list;
}

/** {@link appendedMembers} at the front, so the members keep their order. */
function prependedMembers(column: Sql, values: readonly unknown[]): Sql {
  let list = sql`COALESCE(${column}, '{}')`;
  for (const value of [...values].reverse()) {
    list = sql`array_prepend(${value}, ${list})`;
  }
  return list;
}

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
  readonly geoPoint: GeoPointSql | undefined;

  constructor(namespace = "public", postgis = false) {
    installAdapterNamespace(this, namespace, "postgresql");
    // Reads the installed value, so it cannot be a field initializer: those run
    // before the constructor body.
    this.identifiers = createIdentifiers(quoteIdent, this.namespace);
    installGeoPointSql(this, postgis ? this.createGeoPointSql() : undefined);
    installAdapterInternals(this, {
      batchRefs: this.#batchRefs,
      select: this.#assemble.select,
    });
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
    // 'hello' is not valid JSON input, '"hello"' is. The carrier is what tells
    // a transport that this text is already a document; see json-parameter.ts.
    json: (v: unknown): Sql => sql`${JsonParameter.from(v)}`,

    // Cast into the operand's own `NUMERIC(p,s)` domain, the same type the DDL
    // emits for the field. PostgreSQL would usually infer `numeric` from the
    // column context anyway; saying it makes the comparison independent of what
    // the surrounding expression does to the operand's inferred type, and
    // naming the precision keeps the operand and the column one domain rather
    // than two that happen to agree.
    decimal: (canonical: string, descriptor: DecimalDescriptor): Sql =>
      sql`CAST(${encodePhysicalDecimal(canonical, descriptor, "text")} AS ${sql.raw(decimalColumnType("pg", descriptor))})`,
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

    decimalCast: (expr: Sql, descriptor: DecimalDescriptor): Sql =>
      sql`CAST(${expr} AS ${sql.raw(decimalColumnType("pg", descriptor))})`,

    // PostgreSQL type mappings
    cast: createCastExpression({
      text: "TEXT",
      integer: "INTEGER",
      boolean: "BOOLEAN",
      numeric: "NUMERIC",
    }),

    blobToHex: (expr: Sql): Sql => sql`encode(${expr}, 'hex')`,
  };

  // ============================================================
  // AGGREGATES
  // ============================================================

  aggregates = {
    ...createAggregateFunctions(),

    decimalAvg: (column: Sql, descriptor: DecimalDescriptor): Sql =>
      logicalDecimalAverage(POSTGRES_INTEGERS, column, descriptor),

    // `sum(numeric)` is itself unbounded on PostgreSQL; 1000 is the widest
    // `NUMERIC(p,s)` an operand can be CAST into to meet it, which is the
    // domain a comparison against that sum is actually limited by.
    decimalSumOperandPrecision: createDecimalSumOperandPrecision(1000),
  };

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
    value: (v: unknown): Sql => sql`${JsonParameter.from(v)}`,
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

    // One untyped parameter holding PostgreSQL's own array literal. A managed
    // enum's array OID is created by the estate, so no driver has a serializer
    // for it and the native parameter above arrives malformed; an unknown
    // parameter instead takes its type from the column or operand it meets,
    // which is how the enum type is reached without naming it here.
    enumValue: (values: unknown[]): Sql => sql`${arrayLiteralText(values)}`,

    has: (column: Sql, value: Sql): Sql => sql`${value} = ANY(${column})`,

    hasEvery: (column: Sql, values: Sql): Sql => sql`${column} @> ${values}`,

    hasSome: (column: Sql, values: Sql): Sql => sql`${column} && ${values}`,

    isEmpty: (column: Sql): Sql =>
      sql`(cardinality(${column}) = 0 OR ${column} IS NULL)`,

    // `numeric[]::text[]` casts every ELEMENT. `numeric[]::text` would produce
    // one string holding PostgreSQL's array literal, and `to_json(numeric[])`
    // JSON numbers — the two spellings a decimal list cannot survive.
    decimalProjection: (column: Sql): Sql => sql`CAST(${column} AS TEXT[])`,

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

    // A decimal target rounds the product/quotient back to the field's scale
    // half-to-even; every other numeric column keeps PostgreSQL's own
    // arithmetic, whose integer division already truncates toward zero.
    multiply: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? logicalDecimalMultiply(POSTGRES_INTEGERS, column, by, target.decimal)
        : sql`${column} = ${column} * ${by}`,

    divide: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? logicalDecimalDivide(POSTGRES_INTEGERS, column, by, target.decimal)
        : sql`${column} = ${column} / ${by}`,

    // One `array_append`/`array_prepend` per member rather than one bound
    // array: an ELEMENT parameter resolves against `anyelement` from the
    // column's own type, which is the only reading a managed enum's array has
    // (its OID is in no driver's serializer table — see `arrays.enumValue`) and
    // is exactly what a bound array got from `array_cat` for every other
    // element type. COALESCE keeps NULL columns appendable.
    push: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = ${appendedMembers(column, values)}`,

    unshift: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = ${prependedMembers(column, values)}`,
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

  readonly #assemble = {
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
    supportsUpsertWhere: true, // PostgreSQL supports WHERE in ON CONFLICT
    supportsTargetedUpsert: true, // ON CONFLICT (cols) arbitrates on those cols
    supportsMutationTargetInSubquery: true,
    supportsMutationRowLimit: false, // PostgreSQL has no UPDATE/DELETE ... LIMIT
  };

  lastInsertId = (): Sql => sql.raw`lastval()`;

  readonly #batchRefs = createOnConflictBatchRefs({
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
  // GEOPOINT (PostGIS)
  // ============================================================

  private createGeoPointSql(): GeoPointSql {
    const longitude = (point: Sql): Sql => sql`ST_X(${point}::geometry)`;
    const latitude = (point: Sql): Sql => sql`ST_Y(${point}::geometry)`;
    return {
      value: (pointLongitude, pointLatitude) =>
        sql`ST_SetSRID(ST_MakePoint(${pointLongitude}, ${pointLatitude}), 4326)::geography`,
      longitude,
      latitude,
      ...createGeoPointCoordinatePredicates(
        longitude,
        latitude,
        this.operators,
        (point, bounds) => {
          const polygons = geoBoundsIndexPolygons(bounds);
          if (polygons.length === 0) return;
          return this.operators.or(
            ...polygons.map(
              (polygon) =>
                sql`${point} && ST_SetSRID(ST_GeomFromGeoJSON(${polygon}), 4326)::geography`
            )
          );
        }
      ),
      withinPolygon: (point, polygon) => {
        const geography = sql`ST_SetSRID(ST_GeomFromGeoJSON(${geoPolygonJson(
          polygon
        )}), 4326)::geography`;
        return sql`ST_Intersects(${geography}, ${point})`;
      },
      distance: (left, right) => {
        const leftLongitude = sql`RADIANS(ST_X(${left}::geometry))`;
        const leftLatitude = sql`RADIANS(ST_Y(${left}::geometry))`;
        const rightLongitude = sql`RADIANS(ST_X(${right}::geometry))`;
        const rightLatitude = sql`RADIANS(ST_Y(${right}::geometry))`;
        const haversine = sql`POWER(SIN((${rightLatitude} - ${leftLatitude}) / 2), 2) + COS(${leftLatitude}) * COS(${rightLatitude}) * POWER(SIN((${rightLongitude} - ${leftLongitude}) / 2), 2)`;
        // PostgreSQL's LEAST/GREATEST ignore NULL operands. The explicit arm is
        // what keeps a nullable source point's distance NULL rather than zero.
        return sql`CASE WHEN ${left} IS NULL OR ${right} IS NULL THEN NULL ELSE CAST(${GEO_POINT_EARTH_RADIUS_METERS} AS double precision) * 2 * ASIN(SQRT(LEAST(1, GREATEST(0, ${haversine})))) END`;
      },
    };
  }

  // ============================================================
  // RESULT PARSING
  // PostgreSQL: Mostly passthrough - native JSON and boolean types
  // ============================================================

  result = {
    // PostgreSQL returns native JS scalars and parseField below is a pure
    // passthrough, so the result parser may take the identity fast path for
    // plain string/int/number/boolean columns (byte-identical, guarded).
    nativeScalarPassthrough: true,

    // A managed enum's array OID is in no driver's result-type table, so an
    // enum LIST comes back as the array's own text rather than a JS array.
    enumListRepresentation: "arrayText" as const,

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
