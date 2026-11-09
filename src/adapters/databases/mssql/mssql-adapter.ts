import { FeatureNotSupportedError, unsupportedVector } from "@errors";
import { Sql, sql } from "@sql";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import { encodePhysicalDecimal } from "@validation/primitives/decimal-codec";
import type { IdRepresentation } from "@validation/primitives/id-codec";
import { createIdentifierQuoter } from "../../../sql/identifiers";
import type {
  ArithmeticTarget,
  BatchReferenceSqlAdapter,
} from "../../adapter-core-types";
import { installAdapterInternals } from "../../adapter-internals";
import type { QueryParts } from "../../adapter-query-parts";
import {
  type AdapterResultParser,
  passThroughParseResult,
} from "../../adapter-result-parser";
import { createNamedConstraintIdentities } from "../../constraint-identity";
import {
  type DatabaseAdapter,
  installGeoPointSql,
  type TextMatch,
} from "../../database-adapter";
import {
  type ExactIntegerArithmetic,
  logicalDecimalAverage,
  logicalDecimalDivide,
  logicalDecimalMultiply,
} from "../../shared/decimal-arithmetic";
import { parseIntegerBoolean } from "../../shared/result-parsing";
import {
  buildJsonPath,
  createAggregateFunctions,
  createComparisonOperators,
  createCoreJoins,
  createDecimalSumOperandPrecision,
  createDirectionOrderBy,
  createIdentifiers,
  createInsertStatement,
  createMembershipOperators,
  createNullOperators,
  createNumericSetOperations,
  createRangeOperators,
  createRawSql,
  createRelationFilters,
  createSetOperations,
  createStandardLiterals,
  escapeLikeLiteral,
  stringifyJson,
} from "../../shared/standard-sql";

/**
 * Microsoft SQL Server, 2022 (16.x) and later, and Azure SQL.
 *
 * 2022 is the floor because it is the first release with `JSON_OBJECT` and
 * `JSON_ARRAY`, which keep a nested document a document when one carrier is
 * built inside another (the JSON flag survives a derived table's column).
 * `JSON_ARRAYAGG` arrived only in 2025, so the to-many carrier is
 * `STRING_AGG` (2017) over the members' JSON text, an ordinary aggregate the
 * engine's `SELECT agg(...) FROM (page)` already has the shape of.
 *
 * Identifiers are double-quoted: `QUOTED_IDENTIFIER` is ON for every
 * connection tedious (and ODBC, OLE DB, JDBC) opens.
 */
const quoteIdent = createIdentifierQuoter('"');
/** Constraints named as PostgreSQL names them: `<table>_pkey`, `<table>_<key>_key`. */
const MSSQL_CONSTRAINTS = createNamedConstraintIdentities(
  (table) => `${table}_pkey`
);

/** The widest exact decimal T-SQL computes: `DECIMAL(38, s)`. */
const MSSQL_EXACT_DIGITS = 38;

/** Code-point comparison, independent of the column's or database's collation. */
const BINARY_COLLATION = sql.raw("COLLATE Latin1_General_100_BIN2");

/**
 * The length of a text operand in characters, trailing spaces included: `LEN`
 * ignores them, and `=` pads the shorter operand with them, so every exact
 * text predicate below compares lengths through a one-character suffix.
 */
const textLength = (value: Sql): Sql => sql`(LEN(${value} + N'.') - 1)`;

/** Expressions already under the binary collation: T-SQL takes one `COLLATE`. */
const collated = new WeakSet<Sql>();

const binary = (expr: Sql): Sql => {
  if (collated.has(expr)) return expr;
  const result = sql`${expr} ${BINARY_COLLATION}`;
  collated.add(result);
  return result;
};

/**
 * T-SQL has no boolean value: a predicate (`a = b`) is not an expression and
 * an expression (`1`) is not a predicate. The adapter's two boolean literals
 * are therefore VALUES (`bit`), and every adapter entry that takes a
 * CONDITION reads them back as the constant predicates by identity. The
 * engine passes the literal it was handed, so identity is what it holds.
 */
const TRUE_VALUE = sql.raw("CAST(1 AS BIT)");
const FALSE_VALUE = sql.raw("CAST(0 AS BIT)");
const TRUE_CONDITION = sql.raw("1 = 1");
const FALSE_CONDITION = sql.raw("1 = 0");

/**
 * The reverse direction: a predicate this adapter built, met where T-SQL wants
 * a value (a select-list column, a JSON member, a `CASE` arm), becomes the
 * `bit` it answers. Every predicate-producing member marks its result here.
 */
const predicates = new WeakSet<Sql>();

const predicate = (expr: Sql): Sql => {
  predicates.add(expr);
  return expr;
};

const asValue = (expr: Sql): Sql =>
  predicates.has(expr)
    ? sql`CASE WHEN ${expr} THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END`
    : expr;

/** `members`, each function's result marked as a predicate. */
function markingPredicates<T extends Record<string, unknown>>(members: T): T {
  for (const [name, member] of Object.entries(members))
    if (typeof member === "function")
      Reflect.set(members, name, (...args: unknown[]) => {
        const result: unknown = member(...args);
        if (result instanceof Sql) predicates.add(result);
        return result;
      });
  return members;
}

const condition = (value: Sql): Sql => {
  if (value === TRUE_VALUE) return TRUE_CONDITION;
  if (value === FALSE_VALUE) return FALSE_CONDITION;
  return value;
};

/**
 * T-SQL's exact integer arithmetic over `DECIMAL(38, 0)`. `%` is defined on
 * exact numerics, and `n - n % d` is divisible by `d`, so its quotient has no
 * fractional digit to round.
 */
const MSSQL_INTEGERS: ExactIntegerArithmetic = {
  quotient: (n: Sql, d: Sql): Sql =>
    sql`CAST((${n} - ${n} % ${d}) / ${d} AS DECIMAL(38,0))`,
  remainder: (n: Sql, d: Sql): Sql => sql`(${n} % ${d})`,
};

const decimalType = (descriptor: DecimalDescriptor): Sql =>
  sql.raw(`DECIMAL(${descriptor.precision},${descriptor.scale})`);

/**
 * The aggregated carrier: `STRING_AGG` over each member's JSON text, read
 * back as JSON so the carrier holding it embeds it as a document. Over no
 * rows `STRING_AGG` is NULL, hence the empty array.
 */
const jsonAgg = (expr: Sql, order?: Sql): Sql =>
  sql`JSON_QUERY(COALESCE(N'[' + STRING_AGG(CAST(${expr} AS NVARCHAR(MAX)), N',')${
    order ? sql` WITHIN GROUP (ORDER BY ${order})` : sql.empty
  } + N']', N'[]'))`;

/**
 * The member each carrier aggregate was built over, so the select reading it
 * from an ordered page can state that order (`MssqlAdapter.#select`).
 */
const aggregated = new WeakMap<Sql, Sql>();

/** The ordinal column an ordered page carries for the aggregate reading it. */
const ORDINAL = "__viborm_ord";

/**
 * Stored JSON documents embedded in a carrier, by the text they read: a
 * document may be a scalar (`1.5`, `"x"`), which `JSON_QUERY` refuses.
 */
const documents = new WeakMap<Sql, Sql>();

/**
 * A JSON column's document where T-SQL's JSON functions can read it: an object
 * or an array. They refuse a scalar document (`42`, `"x"`) as malformed JSON,
 * so a scalar document reads as SQL NULL, which no path filter matches.
 */
const container = (column: Sql): Sql =>
  sql`(CASE WHEN ISJSON(${column}, OBJECT) = 1 OR ISJSON(${column}, ARRAY) = 1 THEN ${column} END)`;

/**
 * A carrier object. `JSON_OBJECT` encodes every SQL value by its type; a
 * member that is a stored document is spliced as the JSON text it holds, so
 * an object holding one is written as text: each other member's encoding is
 * cut out of a one-member `JSON_OBJECT` (`{"v":` … `}`).
 */
const jsonObject = (pairs: [string, Sql][]): Sql => {
  if (pairs.length === 0) return sql.raw("JSON_OBJECT()");
  if (pairs.some(([, value]) => documents.has(value))) {
    const members = pairs.map(([key, value], index) => {
      const text = documents.get(value);
      const encoded = sql`JSON_OBJECT('v': ${asValue(value)} NULL ON NULL)`;
      return sql`${`${index === 0 ? "{" : ","}${JSON.stringify(key)}:`} + ${
        text === undefined
          ? sql`SUBSTRING(${encoded}, 6, LEN(${encoded}) - 6)`
          : sql`COALESCE(${text}, N'null')`
      }`;
    });
    return sql`JSON_QUERY(${sql.join(members, " + ")} + N'}')`;
  }
  return sql`JSON_OBJECT(${sql.join(
    pairs.map(([key, value]) => sql`${key}: ${asValue(value)}`),
    ", "
  )} NULL ON NULL)`;
};

/**
 * The JSON text at `path`, or NULL where it is absent: an object or array
 * through `JSON_QUERY`, a scalar re-encoded from `OPENJSON`'s typed row (`type`
 * 0 null, 1 string, 2 number, 3 boolean). `JSON_VALUE` alone cannot tell the
 * string `"1"` from the number `1`.
 */
const jsonAt = (column: Sql, path: string[]): Sql => {
  if (path.length === 0) return column;
  return scalarAt(column, path);
};

/**
 * A path into `column`, the document root included: T-SQL's JSON functions
 * read only an object or an array, so the root is read as the one member of
 * an array holding it.
 */
const rooted = (column: Sql, path: string[]): [Sql, string[]] =>
  path.length === 0 ? [sql`(N'[' + ${column} + N']')`, ["0"]] : [column, path];

const scalarAt = (column: Sql, path: string[]): Sql => {
  const parent = buildJsonPath(path.slice(0, -1));
  const key = path.at(-1)!;
  return sql`(SELECT CASE "type" WHEN 0 THEN N'null' WHEN 1 THEN N'"' + STRING_ESCAPE("value", 'json') + N'"' ELSE "value" END FROM OPENJSON(${container(column)}, ${parent}) WHERE "key" = ${key})`;
};

/** The JSON type code `OPENJSON` reports at `path`, NULL where absent. */
const jsonTypeAt = (column: Sql, path: string[]): Sql => {
  const [document, at] = rooted(column, path);
  return sql`(SELECT "type" FROM OPENJSON(${container(document)}, ${buildJsonPath(at.slice(0, -1))}) WHERE "key" = ${at.at(-1)!})`;
};

/** The scalar text at `path` (`JSON_VALUE`), the root included. */
const jsonValueAt = (column: Sql, path: string[]): Sql => {
  const [document, at] = rooted(column, path);
  return sql`JSON_VALUE(${container(document)}, ${buildJsonPath(at)})`;
};

/**
 * One JSON document's canonical text, for structural equality: the stored and
 * the bound document are both written by `stringifyJson` over key-sorted
 * objects (`canonicalJson`), so equal documents are equal text compared code
 * point by code point.
 */
const canonicalJson = (value: unknown): string =>
  stringifyJson(sortJsonKeys(value));

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value === null || typeof value !== "object" || value instanceof Date)
    return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort())
    sorted[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
  return sorted;
}

const jsonListValue = (values: unknown[]): Sql => sql`${stringifyJson(values)}`;

/** The emulated `NULLS FIRST`/`LAST`: SQL Server sorts NULL lowest. */
const nullsKey = (column: Sql, rank: string, direction: "asc" | "desc"): Sql =>
  sql`CASE WHEN ${column} IS NULL THEN ${sql.raw(rank)} ELSE 1 END, ${column} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`;

/**
 * A datetime operand as T-SQL reads it into `DATETIME2`: ISO 8601 with the
 * `T` separator (never language- or DATEFORMAT-dependent), naive UTC.
 */
const UTC_OFFSET = /[+-]00:00$/;

const naiveIso = (iso: string): string =>
  iso.length === 10 ? iso : iso.replace("Z", "").replace(UTC_OFFSET, "");

const NAIVE_DATETIME_REGEX =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

/** Reattach UTC to a naive `DATETIME2` text, as a JSON carrier spells it. */
const naiveDateTimeToIso = (value: string): string | undefined => {
  const match = NAIVE_DATETIME_REGEX.exec(value);
  if (!match) return undefined;
  const fraction = match[3] ? match[3].padEnd(4, "0").slice(0, 4) : ".000";
  return `${match[1]}T${match[2]}${fraction}Z`;
};

const RECURSION_REFUSAL =
  "T-SQL allows no WITH inside a subquery and no UNION in a recursive member, so a recursive filter or projection cannot be spelled.";

const unsupported = (method: string, reason: string): never => {
  throw new FeatureNotSupportedError("mssql", method, reason);
};

/** A schema name SQL Server accepts unquoted-or-quoted alike: 1–128 characters. */
const normalizeSchema = (namespace: unknown): string | undefined => {
  if (namespace === undefined) return "dbo";
  if (
    typeof namespace !== "string" ||
    namespace.length === 0 ||
    namespace.length > 128
  )
    throw new FeatureNotSupportedError(
      "namespace",
      "construction",
      'The "namespace" option must be a SQL Server schema name of 1 to 128 characters.'
    );
  return namespace;
};

export class MssqlAdapter implements DatabaseAdapter {
  /** The SQL Server schema persistent objects live in: `dbo` by default. */
  declare readonly namespace: string;

  constructor(namespace?: string) {
    Object.defineProperty(this, "namespace", {
      value: normalizeSchema(namespace),
      writable: false,
      enumerable: true,
      configurable: false,
    });
    const identifiers = createIdentifiers(quoteIdent, this.namespace);
    this.identifiers = {
      ...identifiers,
      aliased: (expression: Sql, alias: string): Sql =>
        identifiers.aliased(asValue(expression), alias),
    };
    installGeoPointSql(this, undefined);
    installAdapterInternals(this, {
      batchRefs: this.#batchRefs,
      constraints: MSSQL_CONSTRAINTS,
      select: this.#select,
    });
  }

  raw = createRawSql();

  identifiers: DatabaseAdapter["identifiers"];

  literals = {
    ...createStandardLiterals(),
    true: (): Sql => TRUE_VALUE,
    false: (): Sql => FALSE_VALUE,
    json: (v: unknown): Sql => sql`${canonicalJson(v)}`,
    dateTime: (iso: string): Sql =>
      iso.length === 10
        ? sql`CAST(${iso} AS DATE)`
        : sql`CAST(${naiveIso(iso)} AS DATETIME2(3))`,
    decimal: (canonical: string, descriptor: DecimalDescriptor): Sql =>
      sql`CAST(${encodePhysicalDecimal(canonical, descriptor, "text")} AS ${decimalType(descriptor)})`,
    id: (physical: string | Uint8Array, _representation: IdRepresentation) =>
      sql`${physical}`,
  };

  operators = markingPredicates({
    ...createComparisonOperators(),

    // `CHARINDEX` answers 0 for an empty needle, which every string contains.
    containsText: (column: Sql, value: Sql): Sql =>
      sql`(CHARINDEX(${binary(value)}, ${binary(column)}) > 0 OR (${column} IS NOT NULL AND ${textLength(value)} = 0))`,
    startsWithText: (column: Sql, value: Sql): Sql =>
      sql`(LEFT(${binary(column)}, ${textLength(value)}) = ${binary(value)} AND ${textLength(column)} >= ${textLength(value)})`,
    endsWithText: (column: Sql, value: Sql): Sql =>
      sql`(RIGHT(${binary(column)}, ${textLength(value)}) = ${binary(value)} AND ${textLength(column)} >= ${textLength(value)})`,
    insensitiveText: (kind: TextMatch, column: Sql, value: Sql): Sql =>
      this.operators[`${kind}Text`](
        sql`LOWER(${column})`,
        sql`LOWER(${value})`
      ),
    // The collation-native `LIKE` ranges an index; the exact conjunct decides.
    startsWithPrefix: (column: Sql, value: string): Sql =>
      sql`(${column} LIKE ${`${escapeLikeLiteral(value).replaceAll("[", "\\[")}%`} ESCAPE '\\' AND ${this.operators.startsWithText(column, sql`${value}`)})`,
    // The collation-native comparison seeks the index; the binary comparison
    // and the padded lengths decide.
    exactTextEq: (column: Sql, value: Sql): Sql =>
      sql`(${column} = ${value} AND ${binary(column)} = ${value} AND ${textLength(column)} = ${textLength(value)})`,
    exactTextIn: (column: Sql, values: Sql): Sql =>
      sql`(${column} IN ${values} AND ${binary(column)} IN ${values})`,

    ...createMembershipOperators(),
    ...createNullOperators(),
    ...createRangeOperators(),

    and: (...conditions: Sql[]): Sql => {
      if (conditions.length === 0) return TRUE_CONDITION;
      if (conditions.length === 1) return condition(conditions[0]!);
      return sql`(${sql.join(conditions.map(condition), " AND ")})`;
    },
    or: (...conditions: Sql[]): Sql => {
      if (conditions.length === 0) return FALSE_CONDITION;
      if (conditions.length === 1) return condition(conditions[0]!);
      return sql`(${sql.join(conditions.map(condition), " OR ")})`;
    },
    not: (inner: Sql): Sql => sql`NOT (${condition(inner)})`,

    exists: (subquery: Sql): Sql => sql`EXISTS (${subquery})`,
    notExists: (subquery: Sql): Sql => sql`NOT EXISTS (${subquery})`,
  });

  expressions = {
    caseWhen: (
      branches: readonly { readonly when: Sql; readonly then: Sql }[],
      otherwise: Sql
    ): Sql =>
      branches.length === 0
        ? otherwise
        : sql`CASE ${sql.join(
            branches.map(
              (branch) =>
                sql`WHEN ${condition(branch.when)} THEN ${asValue(branch.then)}`
            ),
            " "
          )} ELSE ${asValue(otherwise)} END`,
    add: (left: Sql, right: Sql): Sql => sql`(${left} + ${right})`,
    subtract: (left: Sql, right: Sql): Sql => sql`(${left} - ${right})`,
    multiply: (left: Sql, right: Sql): Sql => sql`(${left} * ${right})`,
    divide: (left: Sql, right: Sql): Sql => sql`(${left} / ${right})`,
    // Integer `/` truncates toward zero in T-SQL.
    integerDivide: (left: Sql, right: Sql): Sql => sql`(${left} / ${right})`,
    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw("N''");
      if (parts.length === 1) return parts[0]!;
      return sql`CONCAT(${sql.join(parts, ", ")})`;
    },
    upper: (expr: Sql): Sql => sql`UPPER(${expr})`,
    lower: (expr: Sql): Sql => sql`LOWER(${expr})`,
    caseFold: (expr: Sql): Sql => sql`LOWER(${expr})`,
    caseSensitiveText: (expr: Sql): Sql => binary(expr),
    decimalCast: (expr: Sql, descriptor: DecimalDescriptor): Sql =>
      sql`CAST(${expr} AS ${decimalType(descriptor)})`,
    idCast: (expr: Sql, representation: IdRepresentation): Sql =>
      representation === "bytes"
        ? sql`CONVERT(VARBINARY(MAX), ${expr}, 2)`
        : sql`CAST(${expr} AS NVARCHAR(MAX))`,
    coalesce: (...exprs: Sql[]): Sql => sql`COALESCE(${sql.join(exprs, ", ")})`,
    greatest: (...exprs: Sql[]): Sql => sql`GREATEST(${sql.join(exprs, ", ")})`,
    least: (...exprs: Sql[]): Sql => sql`LEAST(${sql.join(exprs, ", ")})`,
    cast: (
      expr: Sql,
      type: "text" | "integer" | "bigint" | "boolean" | "numeric"
    ) =>
      sql`CAST(${expr} AS ${sql.raw(
        {
          text: "NVARCHAR(MAX)",
          integer: "INT",
          bigint: "BIGINT",
          boolean: "BIT",
          numeric: "FLOAT",
        }[type]
      )})`,
    blobToHex: (expr: Sql): Sql =>
      sql`LOWER(CONVERT(VARCHAR(MAX), ${expr}, 2))`,
  };

  aggregates = {
    ...createAggregateFunctions(),
    // `MIN`/`MAX` refuse `bit`.
    min: (expr: Sql, boolean?: boolean): Sql =>
      boolean ? sql`MIN(CAST(${expr} AS INT))` : sql`MIN(${expr})`,
    max: (expr: Sql, boolean?: boolean): Sql =>
      boolean ? sql`MAX(CAST(${expr} AS INT))` : sql`MAX(${expr})`,
    // `AVG` of an integer column is an integer in T-SQL.
    avg: (expr: Sql): Sql => sql`AVG(CAST(${expr} AS FLOAT))`,
    decimalAvg: (column: Sql, descriptor: DecimalDescriptor): Sql =>
      logicalDecimalAverage(MSSQL_INTEGERS, column, descriptor),
    decimalSumOperandPrecision:
      createDecimalSumOperandPrecision(MSSQL_EXACT_DIGITS),
  };

  json = {
    // Both sides are canonical text (see `canonicalJson`).
    equals: (left: Sql, right: Sql): Sql =>
      predicate(
        sql`(${binary(left)} = ${right} AND ${textLength(left)} = ${textLength(right)})`
      ),
    boolean: (inner: Sql): Sql =>
      sql`CASE WHEN ${condition(inner)} THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END`,
    document: (expression: Sql): Sql => {
      const embedded = sql`JSON_QUERY(${expression})`;
      documents.set(embedded, expression);
      return embedded;
    },
    // `float` inside `JSON_OBJECT` keeps 16 digits; style 3 keeps 17.
    number: (expression: Sql): Sql =>
      sql`CONVERT(VARCHAR(32), CAST(${expression} AS FLOAT), 3)`,
    object: jsonObject,
    array: (items: Sql[]): Sql =>
      items.length === 0
        ? sql.raw("JSON_ARRAY()")
        : sql`JSON_ARRAY(${sql.join(items.map(asValue), ", ")} NULL ON NULL)`,
    emptyArray: (): Sql => sql.raw("JSON_QUERY(N'[]')"),
    agg: (expr: Sql): Sql => {
      const aggregate = jsonAgg(expr);
      aggregated.set(aggregate, expr);
      return aggregate;
    },
    objectFromColumns: jsonObject,
    extract: jsonAt,
    // A string unquoted, an object or array as its text.
    extractText: (column: Sql, path: string[]): Sql =>
      path.length === 0
        ? sql`COALESCE(${jsonValueAt(column, path)}, ${column})`
        : sql`COALESCE(${jsonValueAt(column, path)}, JSON_QUERY(${container(column)}, ${buildJsonPath(path)}))`,
    numberAtPath: (column: Sql, path: string[]): Sql =>
      sql`(CASE WHEN ${jsonTypeAt(column, path)} = 2 THEN CAST(${jsonValueAt(column, path)} AS FLOAT) END)`,
    stringAtPath: (column: Sql, path: string[]): Sql =>
      sql`(CASE WHEN ${jsonTypeAt(column, path)} = 1 THEN ${jsonValueAt(column, path)} ${BINARY_COLLATION} END)`,
    foldableStringAtPath: (column: Sql, path: string[]): Sql =>
      sql`(CASE WHEN ${jsonTypeAt(column, path)} = 1 THEN ${jsonValueAt(column, path)} END)`,
    // Every member of `value` is a member of `target`, compared as JSON text.
    contains: (target: Sql, value: Sql): Sql =>
      predicate(
        sql`(ISJSON(${target}, ARRAY) = 1 AND NOT EXISTS (SELECT 1 FROM OPENJSON(${container(value)}) AS "c" WHERE NOT EXISTS (SELECT 1 FROM OPENJSON(${container(target)}) AS "t" WHERE "t"."type" = "c"."type" AND "t"."value" ${BINARY_COLLATION} = "c"."value")))`
      ),
    lastElement: (target: Sql): Sql =>
      sql`(SELECT TOP (1) CASE "type" WHEN 0 THEN N'null' WHEN 1 THEN N'"' + STRING_ESCAPE("value", 'json') + N'"' ELSE "value" END FROM OPENJSON(CASE WHEN ISJSON(${target}, ARRAY) = 1 THEN ${target} END) ORDER BY CAST("key" AS INT) DESC)`,
    value: (v: unknown): Sql => sql`${canonicalJson(v)}`,
  };

  arrays = {
    literal: (items: Sql[]): Sql => this.json.array(items),
    value: jsonListValue,
    enumValue: jsonListValue,
    has: (column: Sql, value: Sql): Sql =>
      predicate(
        sql`EXISTS (SELECT 1 FROM OPENJSON(${column}) AS "m" WHERE "m"."value" = ${value})`
      ),
    hasEvery: (column: Sql, values: Sql): Sql =>
      predicate(
        sql`NOT EXISTS (SELECT 1 FROM OPENJSON(${values}) AS "v" WHERE NOT EXISTS (SELECT 1 FROM OPENJSON(${column}) AS "m" WHERE "m"."value" = "v"."value"))`
      ),
    hasSome: (column: Sql, values: Sql): Sql =>
      predicate(
        sql`EXISTS (SELECT 1 FROM OPENJSON(${column}) AS "m" INNER JOIN OPENJSON(${values}) AS "v" ON "m"."value" = "v"."value")`
      ),
    isEmpty: (column: Sql): Sql =>
      predicate(
        sql`(${column} IS NULL OR NOT EXISTS (SELECT 1 FROM OPENJSON(${column})))`
      ),
    exactNumericProjection: (column: Sql): Sql => column,
    length: (column: Sql): Sql =>
      sql`(SELECT COUNT(*) FROM OPENJSON(${column}))`,
    get: (column: Sql, index: Sql): Sql =>
      sql`JSON_VALUE(${column}, CONCAT('$[', ${index}, ']'))`,
    push: (column: Sql, value: Sql): Sql =>
      sql`JSON_MODIFY(${column}, 'append $', ${value})`,
    set: (column: Sql, index: Sql, value: Sql): Sql =>
      sql`JSON_MODIFY(${column}, CONCAT('$[', ${index}, ']'), ${value})`,
  };

  orderBy = {
    ...createDirectionOrderBy(),
    nullsFirst: (column: Sql, direction: "asc" | "desc"): Sql =>
      nullsKey(column, "0", direction),
    nullsLast: (column: Sql, direction: "asc" | "desc"): Sql =>
      nullsKey(column, "2", direction),
  };

  /**
   * The bound an ordered derived table states when its caller asked for none:
   * T-SQL refuses an `ORDER BY` in a derived table without `TOP` or `OFFSET`,
   * so the page states `OFFSET 0 ROWS` (see {@link MssqlAdapter.#select}).
   */
  noLimitValue = sql.raw("0");

  clauses = {
    select: (columns: Sql): Sql => sql`SELECT ${columns}`,
    selectDistinct: (columns: Sql): Sql => sql`SELECT DISTINCT ${columns}`,
    from: (table: Sql): Sql => sql`FROM ${table}`,
    where: (inner: Sql): Sql => sql`WHERE ${condition(inner)}`,
    orderBy: (orders: Sql): Sql => sql`ORDER BY ${orders}`,
    limit: (count: Sql): Sql =>
      sql`OFFSET 0 ROWS FETCH NEXT ${count} ROWS ONLY`,
    offset: (count: Sql): Sql => sql`OFFSET ${count} ROWS`,
    groupBy: (columns: Sql): Sql => sql`GROUP BY ${columns}`,
    having: (inner: Sql): Sql => sql`HAVING ${condition(inner)}`,
  };

  set = {
    ...createNumericSetOperations(),
    multiply: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? logicalDecimalMultiply(MSSQL_INTEGERS, column, by, target.decimal)
        : sql`${column} = ${column} * ${by}`,
    // Integer `/` already truncates toward zero.
    divide: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? logicalDecimalDivide(MSSQL_INTEGERS, column, by, target.decimal)
        : sql`${column} = ${column} / ${by}`,
    push: (column: Sql, values: Sql): Sql =>
      sql`${column} = ${this.#concatLists(sql`COALESCE(${column}, N'[]')`, values)}`,
    unshift: (column: Sql, values: Sql): Sql =>
      sql`${column} = ${this.#concatLists(values, sql`COALESCE(${column}, N'[]')`)}`,
  };

  /** Two JSON arrays' members, in order, as one array's text. */
  #concatLists(first: Sql, second: Sql): Sql {
    const members = (list: Sql, rank: number) =>
      sql`SELECT ${sql.raw(String(rank))} AS "r", CAST("key" AS INT) AS "k", CASE "type" WHEN 0 THEN N'null' WHEN 1 THEN N'"' + STRING_ESCAPE("value", 'json') + N'"' ELSE "value" END AS "j" FROM OPENJSON(${list})`;
    return sql`(SELECT N'[' + COALESCE(STRING_AGG(CAST("j" AS NVARCHAR(MAX)), N',') WITHIN GROUP (ORDER BY "r", "k"), N'') + N']' FROM (${members(first, 0)} UNION ALL ${members(second, 1)}) AS "l")`;
  }

  filters = markingPredicates(createRelationFilters());

  subqueries = {
    scalar: (query: Sql): Sql => sql`(${query})`,
    correlate: (query: Sql, alias: string): Sql => {
      const correlated = sql`(${query}) AS ${sql.raw(quoteIdent(alias))}`;
      const page = this.#pages.get(query);
      if (page) this.#correlated.set(correlated, { page, alias });
      return correlated;
    },
    existsCheck: (from: Sql, where: Sql): Sql =>
      sql`SELECT 1 FROM ${from} WHERE ${condition(where)}`,
    isolated: (inner: Sql): Sql => condition(inner),
  };

  /**
   * `SELECT [TOP] … ORDER BY … OFFSET … FETCH`: T-SQL has no `LIMIT`. A bound
   * without an order is `TOP (n)`; an ordered read states its window with
   * `OFFSET`, and an ordered read with none states `OFFSET 0 ROWS`, which is
   * what makes its `ORDER BY` legal inside a derived table. A locking read
   * holds its rows (and the range a miss reads) with table hints on its
   * `FROM` item, the one place T-SQL spells them.
   */
  readonly #select = (parts: QueryParts): Sql => {
    const member = aggregated.get(parts.columns);
    const read = this.#correlated.get(parts.from);
    if (member && read) {
      // A carrier aggregating an ordered page: `STRING_AGG` reads its rows in
      // no promised order, so the page numbers them and the aggregate states it.
      const alias = sql.raw(quoteIdent(read.alias));
      return this.#assemble({
        ...parts,
        columns: jsonAgg(member, sql`${alias}.${sql.raw(quoteIdent(ORDINAL))}`),
        from: sql`(${this.#assemble(read.page, true)}) AS ${alias}`,
      });
    }
    const assembled = this.#assemble(parts);
    if (parts.orderBy || parts.distinctOrder) this.#pages.set(assembled, parts);
    return assembled;
  };

  /** Ordered pages, by the statement assembled for them. */
  readonly #pages = new WeakMap<Sql, QueryParts>();
  /** Ordered pages read as a derived table, by that `FROM` item. */
  readonly #correlated = new WeakMap<
    Sql,
    { readonly page: QueryParts; readonly alias: string }
  >();

  /** `ordinal`: the page also numbers its rows in its order, `ORDINAL`. */
  #assemble(parts: QueryParts, ordinal = false): Sql {
    if (parts.distinct) return this.#distinct(parts, ordinal);
    const unbounded = parts.limit === this.noLimitValue;
    const limit = unbounded ? undefined : parts.limit;
    const ordered = parts.orderBy !== undefined;
    const top = limit && !ordered && !parts.offset;
    const columns =
      ordinal && parts.orderBy
        ? sql`${asValue(parts.columns)}, ROW_NUMBER() OVER (ORDER BY ${parts.orderBy}) AS ${sql.raw(quoteIdent(ORDINAL))}`
        : asValue(parts.columns);
    const fragments: Sql[] = [
      top ? sql`SELECT TOP (${limit}) ${columns}` : sql`SELECT ${columns}`,
      parts.forUpdate
        ? sql`FROM ${parts.from} WITH (UPDLOCK, HOLDLOCK, ROWLOCK)`
        : sql`FROM ${parts.from}`,
    ];
    this.#filters(fragments, parts);
    if (ordered) fragments.push(sql`ORDER BY ${parts.orderBy}`);
    else if (parts.offset || (limit && !top))
      fragments.push(sql.raw("ORDER BY (SELECT NULL)"));
    if (!top)
      this.#window(fragments, limit, parts.offset, ordered || unbounded);
    return sql.join(fragments, " ");
  }

  #filters(fragments: Sql[], parts: QueryParts): void {
    if (parts.joins && parts.joins.length > 0) fragments.push(...parts.joins);
    if (parts.where) fragments.push(sql`WHERE ${condition(parts.where)}`);
    if (parts.groupBy) fragments.push(sql`GROUP BY ${parts.groupBy}`);
    if (parts.having) fragments.push(sql`HAVING ${condition(parts.having)}`);
  }

  #window(
    fragments: Sql[],
    limit: Sql | undefined,
    offset: Sql | undefined,
    ordered: boolean
  ): void {
    if (offset || limit || ordered)
      fragments.push(sql`OFFSET ${offset ?? sql.raw("0")} ROWS`);
    if (limit) fragments.push(sql`FETCH NEXT ${limit} ROWS ONLY`);
  }

  /** `DISTINCT ON` as one `ROW_NUMBER()` window, as on MySQL. */
  #distinct(parts: QueryParts, ordinal = false): Sql {
    const order = parts.distinctOrder;
    const rowNumberOrder =
      parts.distinctOrderBy ?? parts.orderBy ?? parts.distinct!;
    const columns: Sql[] = [parts.columns];
    if (order) columns.push(order.keys);
    columns.push(
      sql`ROW_NUMBER() OVER (PARTITION BY ${parts.distinct!} ORDER BY ${rowNumberOrder}) AS "_rn"`
    );
    const inner: Sql[] = [
      sql`SELECT ${sql.join(columns, ", ")}`,
      sql`FROM ${parts.from}`,
    ];
    this.#filters(inner, parts);
    const outerColumns = parts.distinctColumnAliases!.map((alias) =>
      sql.raw(quoteIdent(alias))
    );
    if (ordinal && order)
      outerColumns.push(
        sql`ROW_NUMBER() OVER (ORDER BY ${order.orderBy}) AS ${sql.raw(quoteIdent(ORDINAL))}`
      );
    const outer: Sql[] = [
      sql`SELECT ${sql.join(outerColumns, ", ")} FROM (${sql.join(inner, " ")}) AS "_distinct_subquery"`,
      sql.raw(`WHERE "_rn" = 1`),
    ];
    const limit = parts.limit === this.noLimitValue ? undefined : parts.limit;
    if (order) outer.push(sql`ORDER BY ${order.orderBy}`);
    else if (limit || parts.offset)
      outer.push(sql.raw("ORDER BY (SELECT NULL)"));
    this.#window(outer, limit, parts.offset, order !== undefined);
    return sql.join(outer, " ");
  }

  cte: DatabaseAdapter["cte"] = {
    // T-SQL has no `WITH` inside a subquery and no `UNION` in a recursive
    // member, which is where every recursive walk lives.
    with: (definitions) => {
      if (definitions.some((definition) => definition.recursive))
        unsupported("recurse", RECURSION_REFUSAL);
      return sql`WITH ${sql.join(
        definitions.map(
          ({ name, query }) => sql`${sql.raw(quoteIdent(name))} AS (${query})`
        ),
        ", "
      )}`;
    },
    recursive: () => unsupported("recurse", RECURSION_REFUSAL),
    opens: (query: Sql): boolean =>
      Sql.peek(query).strings[0]!.trimStart().startsWith("WITH"),
  };

  mutations = {
    skipDuplicatesStrategy: "recoverableUniqueError" as const,
    insert: (
      table: Sql,
      columns: string[],
      source: Sql[][] | { readonly select: Sql },
      prefix?: Sql
    ): Sql =>
      // T-SQL bounds an `INSERT … VALUES` at 1,000 rows; a derived table of
      // `VALUES` has no such bound.
      Array.isArray(source) && source.length > 1000
        ? this.#insertRows(table, columns, source)
        : this.#insert(table, columns, source, prefix),
    insertDefault: (table: Sql): Sql =>
      sql`INSERT INTO ${table} DEFAULT VALUES`,
    update: (table: Sql, sets: Sql, where?: Sql): Sql =>
      where
        ? sql`UPDATE ${table} SET ${sets} WHERE ${condition(where)}`
        : sql`UPDATE ${table} SET ${sets}`,
    updateFrom: (table: Sql, sets: Sql, source: Sql, on: Sql, where?: Sql) =>
      sql`UPDATE ${table} SET ${sets} FROM ${table} INNER JOIN ${source} ON ${condition(on)}${
        where ? sql` WHERE ${condition(where)}` : sql.empty
      }`,
    delete: (table: Sql, where?: Sql): Sql =>
      where
        ? sql`DELETE FROM ${table} WHERE ${condition(where)}`
        : sql`DELETE FROM ${table}`,
    returning: (_columns: Sql): Sql => sql.empty,
    // No targeted upsert grammar (`supportsTargetedUpsert: false`): the engine
    // never executes these, and `MERGE` is not one statement's suffix.
    onConflict: (): Sql =>
      unsupported("onConflict", "T-SQL has no conflict clause."),
    onConflictUpdate: (sets: Sql): Sql => sets,
    skipDuplicates: () => ({ prefix: sql.empty, suffix: sql.empty }),
  };

  readonly #insert = createInsertStatement(quoteIdent);

  #insertRows(table: Sql, columns: string[], rows: Sql[][]): Sql {
    const names = columns.map((column) => sql.raw(quoteIdent(column)));
    return this.#insert(table, columns, {
      select: sql`SELECT * FROM (VALUES ${sql.join(
        rows.map((row) => sql`(${sql.join(row, ", ")})`),
        ", "
      )}) AS "v" (${sql.join(names, ", ")})`,
    });
  }

  /**
   * A refused premise or judgement raises a conversion error naming its
   * sentinel; `CASE` evaluates the arm only for a refused row, and T-SQL
   * defers a constant's conversion error to execution.
   */
  assertions = {
    exists: (query: Sql): Sql =>
      sql`SELECT CASE WHEN EXISTS (${query}) THEN 1 ELSE CAST('__viborm_assert__' AS INT) END AS "__viborm_assert__"`,
    notExists: (query: Sql): Sql =>
      sql`SELECT CASE WHEN NOT EXISTS (${query}) THEN 1 ELSE CAST('__viborm_assert__' AS INT) END AS "__viborm_assert__"`,
    holds: (inner: Sql, from?: Sql): Sql =>
      sql`SELECT CASE WHEN ${condition(inner)} THEN 1 ELSE CAST('__viborm_refused__' AS INT) END AS "__viborm_judged__"${from ? sql` FROM ${from}` : sql.empty}`,
  };

  joins = {
    ...createCoreJoins(),
    inner: (table: Sql, on: Sql): Sql =>
      sql`INNER JOIN ${table} ON ${condition(on)}`,
    left: (table: Sql, on: Sql): Sql =>
      sql`LEFT JOIN ${table} ON ${condition(on)}`,
    right: (table: Sql, on: Sql): Sql =>
      sql`RIGHT JOIN ${table} ON ${condition(on)}`,
    full: (table: Sql, on: Sql): Sql =>
      sql`FULL OUTER JOIN ${table} ON ${condition(on)}`,
    lateral: (subquery: Sql, alias: string): Sql =>
      sql`CROSS APPLY (${subquery}) AS ${sql.raw(quoteIdent(alias))}`,
    lateralLeft: (subquery: Sql, alias: string): Sql =>
      sql`OUTER APPLY (${subquery}) AS ${sql.raw(quoteIdent(alias))}`,
  };

  setOperations = createSetOperations(quoteIdent);

  capabilities = {
    supportsReturning: false,
    supportsCteWithMutations: false,
    supportsFullOuterJoin: true,
    supportsLateralJoins: true,
    supportsVector: false,
    supportsUpsertWhere: false,
    supportsTargetedUpsert: false,
    supportsMutationTargetInSubquery: true,
    supportsMutationRowLimit: false,
    supportsRowLocks: true,
    locksMissingKeys: true,
    padsTrailingSpaces: true,
  };

  lastInsertId = (): Sql => sql.raw("SCOPE_IDENTITY()");

  /**
   * The batch scratch: a session temporary table, written by one `MERGE` per
   * reference (T-SQL has neither `ON CONFLICT` nor `ON DUPLICATE KEY`). It
   * stores no inserted identity: `SCOPE_IDENTITY()` is exact only inside the
   * request that inserted, which the driver reads it in.
   */
  readonly #batchRefs: BatchReferenceSqlAdapter = (() => {
    const table = sql.raw(`"#__viborm_batch_refs"`);
    const store = (batchId: string, key: string, valueSql: Sql): Sql =>
      sql`MERGE INTO ${table} AS "d" USING (SELECT ${batchId} AS "b", ${key} AS "k", CAST((${valueSql}) AS NVARCHAR(MAX)) AS "v") AS "s" ON "d"."batch_id" = "s"."b" AND "d"."ref_key" = "s"."k" WHEN MATCHED THEN UPDATE SET "ref_value" = "s"."v" WHEN NOT MATCHED THEN INSERT ("batch_id", "ref_key", "ref_value") VALUES ("s"."b", "s"."k", "s"."v");`;
    return {
      setup: () => [
        sql.raw(
          `IF OBJECT_ID('tempdb..#__viborm_batch_refs') IS NULL CREATE TABLE "#__viborm_batch_refs" ("batch_id" NVARCHAR(191) NOT NULL, "ref_key" NVARCHAR(191) NOT NULL, "ref_value" NVARCHAR(MAX), PRIMARY KEY ("batch_id", "ref_key"))`
        ),
      ],
      cleanup: (batchId) =>
        sql`DELETE FROM ${table} WHERE "batch_id" = ${batchId}`,
      store,
      read: (batchId, key) =>
        sql`(SELECT TOP (1) "ref_value" FROM ${table} WHERE "batch_id" = ${batchId} AND "ref_key" = ${key})`,
    };
  })();

  vector = unsupportedVector;

  declare readonly geoPoint: undefined;

  result: AdapterResultParser = {
    // Every list is JSON text, and a decimal member is its coefficient.
    decimalListRepresentation: "coefficient",
    // No native type vocabulary for SQL Server yet: every identifier is text.
    idRepresentation: () => "text",
    parseResult: passThroughParseResult,
    parseRelation: (_value, next) => next(),
    parseField: (value, scalarType, next) => {
      if (scalarType === "boolean") {
        const parsed = parseIntegerBoolean(
          value === "0" ? 0 : value === "1" ? 1 : value
        );
        if (parsed !== undefined) return next(parsed);
      }
      // A JSON column is NVARCHAR(MAX) text; tedious hands it back as such.
      // A scalar document (`1`, `"a"`, `null`) is text like any other.
      if (scalarType === "json" && typeof value === "string")
        return next(JSON.parse(value));
      // tedious reads `TIME` as a Date on 1970-01-01 UTC.
      if (scalarType === "time" && value instanceof Date)
        return next(value.toISOString().slice(11, 23));
      if (scalarType === "datetime" && typeof value === "string") {
        const iso = naiveDateTimeToIso(value);
        if (iso !== undefined) return next(iso);
      }
      return next();
    },
  };
}
