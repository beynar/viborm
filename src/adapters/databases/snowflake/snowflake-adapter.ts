/**
 * Snowflake's SQL, for the reads VibORM runs on a warehouse (`viborm/snowflake`).
 *
 * VibORM only READS Snowflake: the driver refuses every write before it builds a
 * statement, so the members below that spell a write exist for the interface
 * and are never asked. What this adapter owns is the reading side:
 *
 * - identifiers are always quoted, so a name is the catalog's own spelling
 *   (an unquoted `orders` is stored `ORDERS`; introspection reports it so);
 * - JSON is Snowflake's semi-structured `VARIANT`: `OBJECT_CONSTRUCT_KEEP_NULL`,
 *   `ARRAY_AGG`, `GET_PATH`-style bracket access and `PARSE_JSON` operands;
 * - a datetime operand binds as an instant (`TIMESTAMP_TZ`), which the
 *   driver's UTC session compares against `TIMESTAMP_NTZ`, `_LTZ` and `_TZ`
 *   columns alike;
 * - `LIKE` patterns escape with a backslash, which a Snowflake string literal
 *   spells `'\\'`;
 * - `s.vector()` is `VECTOR(FLOAT, n)` and `s.point()` a `GEOGRAPHY` point.
 *
 * Nested relation reads are not spelled here: Snowflake refuses a correlated
 * subquery holding a `LIMIT` or a correlated derived table, so the driver's
 * `SnowflakeQueries` writes them as uncorrelated grouped tables.
 */

import { FeatureNotSupportedError, UnsupportedOperationError } from "@errors";
import { type Sql, sql } from "@sql";
import {
  type DecimalDescriptor,
  encodePhysicalDecimal,
} from "@validation/primitives/decimal-codec";
import { GEO_POINT_EARTH_RADIUS_METERS } from "@validation/primitives/geo-area-codec";
import type { IdRepresentation } from "@validation/primitives/id-codec";
import { createIdentifierQuoter } from "../../../sql/identifiers";
import type {
  ArithmeticTarget,
  BatchReferenceSqlAdapter,
  CastType,
} from "../../adapter-core-types";
import { installAdapterInternals } from "../../adapter-internals";
import type { QueryParts } from "../../adapter-query-parts";
import { passThroughParseResult } from "../../adapter-result-parser";
import { createNamedConstraintIdentities } from "../../constraint-identity";
import {
  type DatabaseAdapter,
  type GeoPointSql,
  installGeoPointSql,
  type TextMatch,
} from "../../database-adapter";
import {
  type ExactIntegerArithmetic,
  logicalDecimalAverage,
  logicalDecimalDivide,
  logicalDecimalMultiply,
} from "../../shared/decimal-arithmetic";
import {
  createGeoPointCoordinatePredicates,
  geoPolygonJson,
} from "../../shared/geo-point";
import {
  assembleDistinctOnEmulation,
  assembleSelectQuery,
} from "../../shared/select-assembly";
import {
  createAggregateFunctions,
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
  createMutationCommands,
  createNullOperators,
  createNumericSetOperations,
  createRangeOperators,
  createRawSql,
  createRelationFilters,
  createSetOperations,
  createStandardClauses,
  createStandardLiterals,
  createSubqueries,
  escapeLikeLiteral,
  stringifyJson,
} from "../../shared/standard-sql";

const quoteIdent = createIdentifierQuoter('"');

const ARRAY_INDEX = /^\d+$/;
const LEADING_ZEROS = /^0+/;

/** Snowflake's widest `NUMBER`. */
export const SNOWFLAKE_MAX_PRECISION = 38;

/** A string literal: Snowflake reads a backslash in one as an escape. */
export const snowflakeString = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** The `NUMBER(p,s)` a fixed decimal reads in: no wider than Snowflake's. */
const numberType = ({ precision, scale }: DecimalDescriptor): string =>
  `NUMBER(${Math.min(precision, SNOWFLAKE_MAX_PRECISION)},${scale})`;

/**
 * Exact integer arithmetic on `NUMBER`: `/` widens the scale and rounds, so a
 * quotient that would round up to the next integer is taken as the exact
 * division of a multiple instead. `MOD` takes its sign from `n`.
 */
const SNOWFLAKE_INTEGERS: ExactIntegerArithmetic = {
  quotient: (n: Sql, d: Sql): Sql => sql`((${n} - MOD(${n}, ${d})) / ${d})`,
  remainder: (n: Sql, d: Sql): Sql => sql`MOD(${n}, ${d})`,
};

/**
 * `value`'s match as a function of its own: `CONTAINS`, `STARTSWITH` and
 * `ENDSWITH` are exact and case-sensitive on any operand, a column included,
 * so no pattern has to be escaped in SQL.
 */
const TEXT_FUNCTION: Readonly<Record<TextMatch, string>> = {
  contains: "CONTAINS",
  startsWith: "STARTSWITH",
  endsWith: "ENDSWITH",
};

/** One JSON path as bracket accesses; the empty path is the document. */
function jsonPath(column: Sql, path: readonly string[]): Sql {
  if (path.length === 0) return column;
  const steps = path
    .map((segment) =>
      ARRAY_INDEX.test(segment)
        ? `[${segment}]`
        : `[${snowflakeString(segment)}]`
    )
    .join("");
  return sql`(${column})${sql.raw(steps)}`;
}

/** A SQL NULL inside an `ARRAY_CONSTRUCT` would be `undefined`, not JSON null. */
const jsonMember = (value: Sql): Sql =>
  sql`COALESCE(TO_VARIANT(${value}), PARSE_JSON('null'))`;

function jsonObject(pairs: [string, Sql][]): Sql {
  if (pairs.length === 0) return sql.raw("OBJECT_CONSTRUCT()");
  return sql`OBJECT_CONSTRUCT_KEEP_NULL(${sql.join(
    pairs.map(
      ([key, value]) => sql`${sql.raw(snowflakeString(key))}, ${value}`
    ),
    ", "
  )})`;
}

/** A semi-structured operand: the JSON text, parsed by Snowflake. */
const parsedJson = (value: unknown): Sql =>
  sql`PARSE_JSON(${stringifyJson(value)})`;

/**
 * A list's members as JSON reads their text: the engine binds a `bigint` or
 * `decimal` member as its exact digits, a string, while a Snowflake ARRAY
 * holds numbers; parsed, `"9007199254740993"` is that exact number. A member
 * whose text is no JSON stays as it is.
 */
const parsedMembers = (values: Sql): Sql =>
  sql`TRANSFORM(${values}, member VARIANT -> COALESCE(TRY_PARSE_JSON(member::VARCHAR), member))`;

/** Some member of `values`, as it is or as its text reads, is in `column`. */
const overlaps = (column: Sql, values: Sql): Sql =>
  sql`(ARRAYS_OVERLAP(${column}, ${values}) OR ARRAYS_OVERLAP(${column}, ${parsedMembers(values)}))`;

/** Every member of the JSON array `values` is a member of `column`. */
const containsEvery = (column: Sql, values: Sql): Sql =>
  sql`(ARRAY_SIZE(ARRAY_EXCEPT(ARRAY_DISTINCT(${values}), ${column})) = 0)`;

/**
 * A recursive walk, which every recursive filter lowers to: Snowflake refuses
 * the one VibORM writes (a correlated anchor, `UNION`), measured as "is an
 * invalid Recursive CTE". Refused while the statement is built, so nothing
 * is sent, whether the filter is the caller's or a permission rule's.
 */
function noRecursion(): never {
  throw new UnsupportedOperationError(
    "Snowflake reads a relation without recursion. Read it with a second query, or with $queryRaw.",
    { meta: { dialect: "snowflake", feature: "recursion" } }
  );
}

/** A statement Snowflake has no spelling for, asked only of a write. */
function noSpelling(statement: string): never {
  throw new FeatureNotSupportedError(
    "snowflake",
    statement,
    "VibORM only reads Snowflake, which has no such statement here."
  );
}

/**
 * A timestamp ending a VARIANT's text (`2024-01-02 03:04:05.678 -0800`) or a
 * nanosecond ISO instant, as the provider timestamp grammar reads it: the
 * fraction cut to microseconds and the offset joined to the clock.
 */
const VARIANT_TIMESTAMP =
  /^(\d{4,}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?: ?(Z|[+-]\d{2}:?\d{2}))?$/;

/**
 * A TIME as the driver answers it (`12:34:56.120000000`, nine digits) without
 * its fraction's trailing zeros (`12:34:56.12`): the provider time grammar
 * holds six digits, and VibORM's time milliseconds. A digit past the
 * millisecond that is not zero stays, and the time decoder refuses it.
 */
export function normalizeSnowflakeTime(value: string): string {
  return value.includes(".") ? value.replace(FRACTION_ZEROS, "") : value;
}

const FRACTION_ZEROS = /\.?0+$/;

export function normalizeSnowflakeTimestamp(value: string): string {
  const match = VARIANT_TIMESTAMP.exec(value);
  if (!match) return value;
  const [, date, clock, fraction, zone] = match;
  const micros = fraction ? `.${fraction.slice(0, 6)}` : "";
  return `${date}T${clock}${micros}${zone ?? "Z"}`;
}

/**
 * GeoPoint on `GEOGRAPHY`: `ST_MAKEPOINT`, `ST_X`/`ST_Y`, the shared exact
 * coordinate predicates, `ST_INTERSECTS` with a GeoJSON polygon (geodesic
 * edges, boundary included, holes excluded, measured on a real account), and
 * the haversine distance PostgreSQL spells, on the same fixed radius, so the
 * metres agree across providers.
 */
function createSnowflakeGeoPointSql(
  operators: Parameters<typeof createGeoPointCoordinatePredicates>[2]
): GeoPointSql {
  const longitude = (point: Sql): Sql => sql`ST_X(${point})`;
  const latitude = (point: Sql): Sql => sql`ST_Y(${point})`;
  return {
    value: (pointLongitude, pointLatitude) =>
      sql`ST_MAKEPOINT(${pointLongitude}, ${pointLatitude})`,
    longitude,
    latitude,
    ...createGeoPointCoordinatePredicates(longitude, latitude, operators),
    withinPolygon: (point, polygon) =>
      sql`ST_INTERSECTS(TO_GEOGRAPHY(${geoPolygonJson(polygon)}), ${point})`,
    distance: (left, right) => {
      const leftLongitude = sql`RADIANS(ST_X(${left}))`;
      const leftLatitude = sql`RADIANS(ST_Y(${left}))`;
      const rightLongitude = sql`RADIANS(ST_X(${right}))`;
      const rightLatitude = sql`RADIANS(ST_Y(${right}))`;
      const haversine = sql`POWER(SIN((${rightLatitude} - ${leftLatitude}) / 2), 2) + COS(${leftLatitude}) * COS(${rightLatitude}) * POWER(SIN((${rightLongitude} - ${leftLongitude}) / 2), 2)`;
      // LEAST/GREATEST would answer NULL for a NULL point anyway; the arm
      // says it where a reader looks for it.
      return sql`CASE WHEN ${left} IS NULL OR ${right} IS NULL THEN NULL ELSE CAST(${GEO_POINT_EARTH_RADIUS_METERS} AS FLOAT) * 2 * ASIN(SQRT(LEAST(1, GREATEST(0, ${haversine})))) END`;
    },
  };
}

export class SnowflakeAdapter implements DatabaseAdapter {
  /**
   * The schema persistent objects are qualified with, exactly as the
   * catalog spells it, or absent: unqualified names then resolve in the
   * session's schema, which the driver states on every request.
   */
  declare readonly namespace: string | undefined;

  constructor(namespace?: string) {
    if (
      namespace !== undefined &&
      (typeof namespace !== "string" || namespace.length === 0)
    )
      throw new TypeError(
        "A Snowflake namespace is a schema name: a non-empty string."
      );
    Object.defineProperty(this, "namespace", {
      value: namespace,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    this.identifiers = createIdentifiers(quoteIdent, namespace, true);
    // A GeoPoint is a GEOGRAPHY point: WGS 84, VibORM's own EPSG:4326.
    installGeoPointSql(this, createSnowflakeGeoPointSql(this.operators));
    installAdapterInternals(this, {
      batchRefs: SNOWFLAKE_BATCH_REFS,
      constraints: createNamedConstraintIdentities(
        (tableName) => `${tableName}_pkey`
      ),
      select: this.#select,
    });
  }

  raw = createRawSql();

  identifiers: DatabaseAdapter["identifiers"];

  literals = {
    ...createStandardLiterals(),

    // An instant: the driver binds a `Date` as `TIMESTAMP_TZ` at UTC, which
    // compares against every timestamp column kind in the UTC session.
    dateTime: (iso: string): Sql => sql`${new Date(iso)}`,

    true: (): Sql => sql.raw("TRUE"),
    false: (): Sql => sql.raw("FALSE"),

    json: parsedJson,

    // Snowflake's NUMBER holds 38 digits, so NUMBER(38,s) holds 38 - s of
    // them before the point: an operand that fits is exact there, and one
    // that does not is refused rather than rounded or failed by the cast.
    decimal: (canonical: string, descriptor: DecimalDescriptor): Sql => {
      const text = encodePhysicalDecimal(canonical, descriptor, "text");
      const whole = text
        .replace("-", "")
        .split(".")[0]!
        .replace(LEADING_ZEROS, "");
      if (
        descriptor.scale >= SNOWFLAKE_MAX_PRECISION ||
        whole.length > SNOWFLAKE_MAX_PRECISION - descriptor.scale
      )
        throw new UnsupportedOperationError(
          `Snowflake's NUMBER holds ${SNOWFLAKE_MAX_PRECISION} digits, and the decimal ${canonical} at scale ${descriptor.scale} needs more: no stored value can be compared with it.`,
          { meta: { dialect: "snowflake", scalarType: "decimal" } }
        );
      return sql`CAST(${text} AS ${sql.raw(numberType(descriptor))})`;
    },

    // A text-stored identifier compares as text and a byte-stored one as the
    // binary parameter blobs bind; Snowflake has no UUID type.
    id: (physical: string | Uint8Array): Sql => sql`${physical}`,
  };

  operators = {
    ...createComparisonOperators(),

    containsText: (column: Sql, value: Sql): Sql =>
      sql`CONTAINS(${column}, ${value})`,
    startsWithText: (column: Sql, value: Sql): Sql =>
      sql`STARTSWITH(${column}, ${value})`,
    endsWithText: (column: Sql, value: Sql): Sql =>
      sql`ENDSWITH(${column}, ${value})`,
    // Snowflake folds case with its own `LOWER`, Unicode-aware.
    insensitiveText: (kind: TextMatch, column: Sql, value: Sql): Sql =>
      sql`${sql.raw(TEXT_FUNCTION[kind])}(LOWER(${column}), LOWER(${value}))`,
    // A constant `LIKE 'abc%'` is what Snowflake prunes micro-partitions on.
    startsWithPrefix: (column: Sql, value: string): Sql =>
      sql`${column} LIKE ${`${escapeLikeLiteral(value)}%`} ESCAPE '\\\\'`,

    exactTextEq: (column: Sql, value: Sql): Sql => sql`${column} = ${value}`,
    exactTextIn: (column: Sql, values: Sql): Sql => sql`${column} IN ${values}`,

    in: (column: Sql, values: Sql): Sql => sql`${column} IN ${values}`,
    notIn: (column: Sql, values: Sql): Sql => sql`${column} NOT IN ${values}`,

    ...createNullOperators(),
    ...createRangeOperators(),
    ...createLogicalOperators(this.literals.true, this.literals.false),
    ...createExistenceOperators(),
  };

  expressions = {
    ...createCommonExpressions(),

    // Without a column collation Snowflake compares text by its bytes.
    caseSensitiveText: (expr: Sql): Sql => expr,
    caseFold: (expr: Sql): Sql => sql`LOWER(${expr})`,

    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw("''");
      if (parts.length === 1) return parts[0]!;
      return sql`(${sql.join(parts, " || ")})`;
    },

    greatest: (...exprs: Sql[]): Sql => sql`GREATEST(${sql.join(exprs, ", ")})`,
    least: (...exprs: Sql[]): Sql => sql`LEAST(${sql.join(exprs, ", ")})`,

    integerDivide: (left: Sql, right: Sql): Sql =>
      SNOWFLAKE_INTEGERS.quotient(left, right),

    decimalCast: (expr: Sql, descriptor: DecimalDescriptor): Sql =>
      sql`CAST(${expr} AS ${sql.raw(numberType(descriptor))})`,

    idCast: (expr: Sql, representation: IdRepresentation): Sql =>
      representation === "bytes"
        ? sql`TO_BINARY(${expr}, 'HEX')`
        : sql`CAST(${expr} AS VARCHAR)`,

    cast: (expr: Sql, type: CastType): Sql =>
      sql`CAST(${expr} AS ${sql.raw(CAST_TYPES[type])})`,

    blobToHex: (expr: Sql): Sql => sql`HEX_ENCODE(${expr}, 0)`,
  };

  aggregates = {
    ...createAggregateFunctions("'inf'::FLOAT"),

    // An integer column's AVG is a NUMBER whose scale Snowflake chooses; the
    // public `_avg` is a double.
    avg: (expr: Sql): Sql => sql`CAST(AVG(${expr}) AS FLOAT)`,
    min: (column: Sql, boolean = false): Sql =>
      boolean ? sql`BOOLAND_AGG(${column})` : sql`MIN(${column})`,
    max: (column: Sql, boolean = false): Sql =>
      boolean ? sql`BOOLOR_AGG(${column})` : sql`MAX(${column})`,

    decimalAvg: (column: Sql, descriptor: DecimalDescriptor): Sql =>
      logicalDecimalAverage(SNOWFLAKE_INTEGERS, column, descriptor),

    decimalSumOperandPrecision: createDecimalSumOperandPrecision(
      SNOWFLAKE_MAX_PRECISION
    ),
  };

  json = {
    equals: (left: Sql, right: Sql): Sql => sql`(${left}) = (${right})`,
    boolean: (condition: Sql): Sql => condition,
    document: (expression: Sql): Sql => expression,
    // A double inside a VARIANT prints with 16 significant digits, one short
    // of what reads every double back: it travels as its own shortest text
    // (`0.30000000000000004`), which every number decoder reads.
    number: (expression: Sql): Sql => sql`TO_VARCHAR(${expression})`,
    object: jsonObject,
    array: (items: Sql[]): Sql =>
      sql`ARRAY_CONSTRUCT(${sql.join(items.map(jsonMember), ", ")})`,
    emptyArray: (): Sql => sql.raw("ARRAY_CONSTRUCT()"),
    agg: (expr: Sql): Sql =>
      sql`COALESCE(ARRAY_AGG(${expr}), ARRAY_CONSTRUCT())`,
    objectFromColumns: jsonObject,
    extract: jsonPath,
    extractText: (column: Sql, path: string[]): Sql =>
      sql`TO_VARCHAR(${jsonPath(column, path)})`,
    // NULL for any member that is not a number. A CAST under a CASE on its
    // TYPEOF is not enough: Snowflake may evaluate the CAST first, and fails
    // on an array (measured).
    numberAtPath: (column: Sql, path: string[]): Sql =>
      sql`AS_DOUBLE(${jsonPath(column, path)})`,
    // Without a collation Snowflake orders text by code point already.
    stringAtPath: (column: Sql, path: string[]): Sql =>
      this.json.foldableStringAtPath(column, path),
    foldableStringAtPath: (column: Sql, path: string[]): Sql => {
      const value = jsonPath(column, path);
      return sql`(CASE WHEN TYPEOF(${value}) = 'VARCHAR' THEN TO_VARCHAR(${value}) END)`;
    },
    contains: (target: Sql, value: Sql): Sql =>
      sql`(IS_ARRAY(${target}) AND ${containsEvery(sql`${target}::ARRAY`, sql`${value}::ARRAY`)})`,
    lastElement: (target: Sql): Sql =>
      sql`GET(${target}, ARRAY_SIZE(${target}) - 1)`,
    value: parsedJson,
  };

  arrays = {
    literal: (items: Sql[]): Sql =>
      sql`ARRAY_CONSTRUCT(${sql.join(items.map(jsonMember), ", ")})`,
    value: (values: unknown[]): Sql => sql`${parsedJson(values)}::ARRAY`,
    enumValue: (values: unknown[]): Sql => sql`${parsedJson(values)}::ARRAY`,
    // A list member compared as it is bound and as its text reads, so a
    // number list matches the exact text a bigint or decimal binds as
    // (measured: ARRAY_CONTAINS of the text found no number).
    has: (column: Sql, value: Sql): Sql =>
      overlaps(column, sql`ARRAY_CONSTRUCT(${value})`),
    hasEvery: (column: Sql, values: Sql): Sql =>
      sql`(ARRAY_SIZE(ARRAY_EXCEPT(${parsedMembers(
        sql`ARRAY_EXCEPT(ARRAY_DISTINCT(${values}), ${column})`
      )}, ${column})) = 0)`,
    hasSome: overlaps,
    isEmpty: (column: Sql): Sql =>
      sql`(ARRAY_SIZE(${column}) = 0 OR ${column} IS NULL)`,
    // Each member as exact text, so no JSON number rounds it on the way.
    exactNumericProjection: (column: Sql): Sql =>
      sql`TRANSFORM(${column}, member VARIANT -> TO_VARCHAR(member))`,
    length: (column: Sql): Sql => sql`ARRAY_SIZE(${column})`,
    get: (column: Sql, index: Sql): Sql => sql`GET(${column}, ${index})`,
    push: (column: Sql, value: Sql): Sql =>
      sql`ARRAY_APPEND(${column}, ${value})`,
    set: (column: Sql, index: Sql, value: Sql): Sql =>
      sql`ARRAY_CAT(ARRAY_APPEND(ARRAY_SLICE(${column}, 0, ${index}), ${value}), ARRAY_SLICE(${column}, ${index} + 1, ARRAY_SIZE(${column})))`,
  };

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

  /**
   * The spellings a nested relation read takes here (`SnowflakeQueries`
   * decides its structure): rows numbered per key, a page kept by its
   * numbers, an ordered aggregate and its first member, and the text a
   * timestamp or a date travels as inside a document.
   */
  relations = {
    rank: (partition: readonly Sql[], order: Sql | undefined): Sql =>
      sql`ROW_NUMBER() OVER (PARTITION BY ${sql.join(partition, ", ")} ORDER BY ${order ?? sql.raw("1")})`,
    qualify: (select: Sql, condition: Sql): Sql =>
      sql`${select} QUALIFY ${condition}`,
    arrayAgg: (value: Sql, order: Sql | undefined): Sql =>
      order
        ? sql`ARRAY_AGG(${value}) WITHIN GROUP (ORDER BY ${order})`
        : sql`ARRAY_AGG(${value})`,
    first: (array: Sql): Sql => sql`GET(${array}, 0)`,
    timestampText: (column: Sql): Sql =>
      sql`TO_VARCHAR(CAST(${column} AS TIMESTAMP_TZ), 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')`,
    dateText: (column: Sql): Sql => sql`TO_VARCHAR(${column}, 'YYYY-MM-DD')`,
    /**
     * A time as {@link normalizeSnowflakeTime} spells the driver's: its nine
     * digits without their trailing zeros. A VARIANT drops a TIME's fraction
     * (`12:34:56.123456789` prints `"12:34:56"`, measured).
     */
    timeText: (column: Sql): Sql =>
      sql`RTRIM(RTRIM(TO_VARCHAR(${column}, 'HH24:MI:SS.FF9'), '0'), '.')`,
    /**
     * A vector as the JSON text of its members, each the exact double its
     * float32 widens to (`0.10000000149011612`): the SQL API prints a VECTOR
     * with six decimals, and a VARIANT prints a double with sixteen digits,
     * both short of it. The vector decoder parses the text, flat or carried.
     */
    vectorText: (column: Sql): Sql =>
      sql`('[' || ARRAY_TO_STRING(TRANSFORM(CAST(${column} AS ARRAY), member VARIANT -> TO_VARCHAR(member::FLOAT)), ',') || ']')`,
    /**
     * A point as its two coordinates, each a JSON number parsed from the
     * double's shortest text, so no VARIANT print rounds it; NULL stays NULL.
     */
    pointObject: (column: Sql): Sql =>
      sql`IFF(${column} IS NULL, NULL, OBJECT_CONSTRUCT_KEEP_NULL('longitude', PARSE_JSON(TO_VARCHAR(ST_X(${column}))), 'latitude', PARSE_JSON(TO_VARCHAR(ST_Y(${column})))))`,
  };

  /** `LIMIT NULL OFFSET n`: Snowflake has no bare `OFFSET`. */
  noLimitValue = sql.raw("NULL");

  clauses = createStandardClauses();

  set = {
    ...createNumericSetOperations(),
    multiply: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? logicalDecimalMultiply(SNOWFLAKE_INTEGERS, column, by, target.decimal)
        : sql`${column} = ${column} * ${by}`,
    divide: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? logicalDecimalDivide(SNOWFLAKE_INTEGERS, column, by, target.decimal)
        : target?.integer
          ? sql`${column} = ${SNOWFLAKE_INTEGERS.quotient(column, by)}`
          : sql`${column} = ${column} / ${by}`,
    push: (column: Sql, values: Sql): Sql =>
      sql`${column} = ARRAY_CAT(COALESCE(${column}, ARRAY_CONSTRUCT()), ${values})`,
    unshift: (column: Sql, values: Sql): Sql =>
      sql`${column} = ARRAY_CAT(${values}, COALESCE(${column}, ARRAY_CONSTRUCT()))`,
  };

  filters = createRelationFilters();

  subqueries = createSubqueries(quoteIdent);

  readonly #select = (parts: QueryParts): Sql =>
    // Snowflake has no `DISTINCT ON`: a distinct page keeps each group's
    // first row by `ROW_NUMBER()`, as MySQL and SQLite do.
    parts.distinct
      ? assembleDistinctOnEmulation(
          parts,
          parts.distinct,
          this.identifiers.escape,
          this.noLimitValue
        )
      : assembleSelectQuery(sql`SELECT ${parts.columns}`, parts, {
          // Snowflake takes no row lock a read could ask for.
          forUpdate: "omit",
          noLimitValue: this.noLimitValue,
        });

  // Every walk is this one: Snowflake shares no relation body, so none is a
  // recursive member of a statement's WITH list.
  cte: DatabaseAdapter["cte"] = {
    ...createCteBuilders(quoteIdent),
    recursive: noRecursion,
  };

  mutations = {
    // Snowflake enforces no unique key, so there is no duplicate to skip.
    skipDuplicatesStrategy: "recoverableUniqueError" as const,
    insert: createInsertStatement(quoteIdent),
    insertDefault: (table: Sql): Sql =>
      sql`INSERT INTO ${table} SELECT NULL WHERE FALSE`,
    ...createMutationCommands(),
    returning: (): Sql => noSpelling("RETURNING"),
    onConflict: (): Sql => noSpelling("ON CONFLICT"),
    onConflictUpdate: (): Sql => noSpelling("ON CONFLICT"),
    insertAbsent: (): Sql[] => noSpelling("ON CONFLICT"),
    skipDuplicates: (): { prefix: Sql; suffix: Sql } =>
      noSpelling("ON CONFLICT"),
  };

  assertions = {
    exists: (query: Sql): Sql =>
      sql`SELECT 1 / IFF(EXISTS (${query}), 1, 0) AS "__viborm_assert__"`,
    notExists: (query: Sql): Sql =>
      sql`SELECT 1 / IFF(NOT EXISTS (${query}), 1, 0) AS "__viborm_assert__"`,
    holds: (condition: Sql, from?: Sql): Sql =>
      sql`SELECT 1 / IFF(${condition}, 1, 0) AS "__viborm_judged__"${from ? sql` FROM ${from}` : sql``}`,
  };

  capabilities: DatabaseAdapter["capabilities"] = {
    supportsReturning: false,
    supportsCteWithMutations: false,
    supportsFullOuterJoin: true,
    // Snowflake refuses most correlated inline views; nothing reads through one.
    supportsLateralJoins: false,
    supportsVector: true,
    supportsUpsertWhere: false,
    supportsTargetedUpsert: false,
    supportsMutationTargetInSubquery: true,
    supportsMutationRowLimit: false,
    supportsRowLocks: false,
  };

  lastInsertId = (): Sql => noSpelling("LAST_INSERT_ID");

  joins = {
    ...createCoreJoins(),
    full: (table: Sql, condition: Sql): Sql =>
      sql`FULL OUTER JOIN ${table} ON ${condition}`,
    ...createLateralJoins(quoteIdent),
  };

  setOperations = createSetOperations(quoteIdent);

  /**
   * `VECTOR(FLOAT, n)`: an operand is its JSON array cast into the column's
   * type. Snowflake has no vector index, so every order is exact, whatever
   * key the engine asks for.
   */
  vector = {
    literal: (values: number[]): Sql =>
      sql`CAST(PARSE_JSON(${JSON.stringify(values)}) AS ARRAY)::VECTOR(FLOAT, ${sql.raw(String(values.length))})`,
    l2: (column: Sql, vector: Sql): Sql =>
      sql`VECTOR_L2_DISTANCE(${column}, ${vector})`,
    // A zero vector's cosine is NaN; read as NULL, as on PostgreSQL.
    cosine: (column: Sql, vector: Sql): Sql =>
      sql`NULLIF(1 - VECTOR_COSINE_SIMILARITY(${column}, ${vector}), 'NaN'::FLOAT)`,
  };

  result: DatabaseAdapter["result"] = {
    parseResult: passThroughParseResult,
    // The driver parses every semi-structured value it reads.
    parseRelation: (_value: unknown, next: (value?: unknown) => unknown) =>
      next(),
    // A timestamp inside a VARIANT keeps Snowflake's own text; a top-level
    // one arrives as a nanosecond ISO instant. Both cross to the provider
    // timestamp grammar here, where the leaf says it is a timestamp.
    parseField: (
      value: unknown,
      scalarType: string,
      next: (value?: unknown) => unknown
    ): unknown => {
      if (scalarType === "datetime" && typeof value === "string")
        return next(normalizeSnowflakeTimestamp(value));
      if (scalarType === "time" && typeof value === "string")
        return next(normalizeSnowflakeTime(value));
      return next();
    },
  };
}

const CAST_TYPES: Readonly<Record<CastType, string>> = {
  text: "VARCHAR",
  integer: "INTEGER",
  bigint: "NUMBER(38,0)",
  boolean: "BOOLEAN",
  numeric: "NUMBER(38,10)",
};

/** Snowflake keeps no batch scratch: VibORM writes nothing there. */
const SNOWFLAKE_BATCH_REFS: BatchReferenceSqlAdapter = {
  setup: () => noSpelling("batch references"),
  cleanup: () => noSpelling("batch references"),
  store: () => noSpelling("batch references"),
  read: () => noSpelling("batch references"),
};
