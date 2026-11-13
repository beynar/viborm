import {
  FeatureNotSupportedError,
  QueryEngineError,
  unsupportedVector,
} from "@errors";
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

/** Where `integerSum` splits a member: 2^32, as a BIGINT. */
const INTEGER_SPLIT = sql.raw("CAST(4294967296 AS BIGINT)");

/** The widest exact decimal T-SQL computes: `DECIMAL(38, s)`. */
const MSSQL_EXACT_DIGITS = 38;

/** Code-point comparison, independent of the column's or database's collation. */
const BINARY_COLLATION = sql.raw("COLLATE Latin1_General_100_BIN2");

/**
 * The length of a text operand in characters, trailing spaces included: `LEN`
 * ignores them, and `=` pads the shorter operand with them, so every exact
 * text predicate below compares lengths through a one-character suffix. The
 * operand is widened first: `VARCHAR(n) + N'.'` is `NVARCHAR(4000)` at most,
 * which cut an adopted `VARCHAR(4001…8000)` column's value short.
 */
const textLength = (value: Sql): Sql =>
  sql`(LEN(CAST(${value} AS NVARCHAR(MAX)) + N'.') - 1)`;

/** Expressions already under the binary collation: T-SQL takes one `COLLATE`. */
const collated = new WeakSet<Sql>();

const binary = (expr: Sql): Sql => {
  if (collated.has(expr)) return expr;
  const result = sql`${expr} ${BINARY_COLLATION}`;
  collated.add(result);
  return result;
};

/**
 * Exact text comparison, the one mechanism every text filter uses: `=` and
 * `<` pad the shorter operand with spaces under every collation, `IN`,
 * `GROUP BY` and `DISTINCT` too, so `"ab"` and `"ab "` compare equal. An
 * operand compared as its key, under the binary collation with NCHAR(0)
 * appended, keeps its trailing spaces significant and sorts a prefix first
 * (NCHAR(0) is the lowest code unit, and BIN2 does not ignore it). A value
 * holding NCHAR(0) itself is the one it can misplace.
 */
const exactKey = (text: Sql): Sql =>
  sql`(CAST(${text} AS NVARCHAR(MAX)) + NCHAR(0)) ${BINARY_COLLATION}`;

/** Two `OPENJSON` members `m` and `v` equal, a string exactly. */
const SAME_MEMBER = sql`"m"."value" = "v"."value" AND ("m"."type" <> 1 OR ${exactKey(sql.raw('"m"."value"'))} = ${exactKey(sql.raw('"v"."value"'))})`;

/** `caseSensitiveText`'s results, each to the operand it compares exactly. */
const exactOperands = new WeakMap<Sql, Sql>();

/** A list literal's members, for the exact comparisons that take one. */
const listMembers = new WeakMap<Sql, readonly Sql[]>();

/** A list's members, which an exact text list comparison needs. */
const membersOf = (list: Sql): readonly Sql[] => {
  const members = listMembers.get(list);
  // A list built elsewhere would compare keys with raw values: nothing.
  if (!members)
    throw new QueryEngineError(
      "An exact text list comparison needs a list built by `literals.list`."
    );
  return members;
};

const keysOf = (list: Sql): Sql =>
  sql`(${sql.join(membersOf(list).map(exactKey), ", ")})`;

/**
 * The longest text list `in` keeps beside its keys a collation-native
 * `IN`, which an index can seek: each member is then bound twice, so past
 * half the bind budget (2,098) the list is compared by its keys alone,
 * each member bound once.
 */
const SEEKING_LIST_LIMIT = 1049;

/**
 * The longest prefix a `LIKE` pattern carries: a pattern is at most 4,000
 * characters (8152 past it), and the prefix takes a `%`.
 */
const LIKE_PREFIX_LIMIT = 3999;

/** Whether `text` holds a character below the space a shorter operand pads with. */
const holdsBelowSpace = (text: string): boolean => {
  for (let index = 0; index < text.length; index++)
    if (text.charCodeAt(index) < 32) return true;
  return false;
};

/** `right`, where it is one bound string: the value a filter compares. */
const boundText = (right: Sql): string | undefined => {
  const { strings, values } = Sql.peek(right);
  const [value] = values;
  return values.length === 1 &&
    strings.length === 2 &&
    strings[0] === "" &&
    strings[1] === "" &&
    typeof value === "string"
    ? value
    : undefined;
};

/**
 * A comparison whose left operand is `caseSensitiveText`'s, as their keys;
 * any other, as `plain` spells it.
 *
 * Keys are no index's: an ordering filter on a bound string keeps a
 * collation-native superset of its rows in front, under the binary
 * collation. Padded and exact order disagree only where one value is the
 * other followed by a character below the space, so for a bound value
 * holding none, `col <= v` holds of every row exactly below or at `v`, and
 * `col >= v OR col LIKE v%` of every row above or at it (a row extending
 * `v` with a tab pads below it). A bound value holding one has no such
 * superset and is compared by its keys alone.
 */
const exactly =
  (operator: string, plain: (left: Sql, right: Sql) => Sql) =>
  (left: Sql, right: Sql): Sql => {
    const operand = exactOperands.get(left);
    if (operand === undefined) return plain(left, right);
    const exact = sql`${exactKey(operand)} ${sql.raw(operator)} ${exactKey(right)}`;
    const bound = boundText(right);
    if (bound === undefined || holdsBelowSpace(bound)) return exact;
    const native = binary(operand);
    if (operator === "<" || operator === "<=")
      return sql`(${native} <= ${right} AND ${exact})`;
    if (
      (operator === ">" || operator === ">=") &&
      bound.length <= LIKE_PREFIX_LIMIT
    )
      return sql`((${native} >= ${right} OR ${native} LIKE ${`${escapeLikeLiteral(bound).replaceAll("[", "\\[")}%`} ESCAPE '\\') AND ${exact})`;
    return exact;
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

const standardComparisons = createComparisonOperators();
const exactComparisons = {
  ...standardComparisons,
  eq: exactly("=", standardComparisons.eq),
  neq: exactly("<>", standardComparisons.neq),
  lt: exactly("<", standardComparisons.lt),
  lte: exactly("<=", standardComparisons.lte),
  gt: exactly(">", standardComparisons.gt),
  gte: exactly(">=", standardComparisons.gte),
};

const isSqlList = (other: Sql | readonly Sql[]): other is readonly Sql[] =>
  Array.isArray(other);

/** `items` ≤ `bound` lexicographically, from column `index` on. */
const rowAtMost = (
  items: readonly Sql[],
  bound: readonly Sql[],
  index: number
): Sql => {
  const item = items[index]!;
  const limit = bound[index]!;
  if (index === items.length - 1) return sql`${item} <= ${limit}`;
  return sql`(${item} < ${limit} OR (${item} = ${limit} AND ${rowAtMost(items, bound, index + 1)}))`;
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
 * An `OPENJSON` row's member as JSON text: `null`, a string quoted and
 * escaped, the rest as stored. STRING_ESCAPE writes `/` as `\/`, which
 * JSON.stringify does not, so text equality with a bound value missed every
 * string holding one, and a pushed member was stored so: the escape is
 * undone. Each `/` it wrote follows its own `\`, so no backslash of the
 * value is taken with it.
 */
const OPENJSON_MEMBER = sql.raw(
  `CASE "type" WHEN 0 THEN N'null' WHEN 1 THEN N'"' + REPLACE(STRING_ESCAPE("value", 'json'), N'\\/', N'/') + N'"' ELSE "value" END`
);

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
  return sql`(SELECT ${OPENJSON_MEMBER} FROM OPENJSON(${container(column)}, ${parent}) WHERE "key" = ${key})`;
};

/** The JSON type code `OPENJSON` reports at `path`, NULL where absent. */
const jsonTypeAt = (column: Sql, path: string[]): Sql => {
  const [document, at] = rooted(column, path);
  return sql`(SELECT "type" FROM OPENJSON(${container(document)}, ${buildJsonPath(at.slice(0, -1))}) WHERE "key" = ${at.at(-1)!})`;
};

/**
 * The scalar text at `path`, the root included; NULL for an object, an
 * array, `null` or nothing. Read from `OPENJSON`'s `NVARCHAR(MAX)` value, as
 * `jsonTypeAt` reads its type: `JSON_VALUE` answers NULL past 4,000
 * characters.
 */
const jsonValueAt = (column: Sql, path: string[]): Sql => {
  const [document, at] = rooted(column, path);
  return sql`(SELECT "value" FROM OPENJSON(${container(document)}, ${buildJsonPath(at.slice(0, -1))}) WHERE "key" = ${at.at(-1)!} AND "type" < 4)`;
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
    list: (values: Sql[]): Sql => {
      const list =
        values.length === 0 ? sql.raw("()") : sql`(${sql.join(values, ", ")})`;
      listMembers.set(list, values);
      return list;
    },
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
    ...exactComparisons,

    // `CHARINDEX` answers 0 for an empty needle, which every string
    // contains, and refuses one past 4,000 characters (Msg 8152), as LIKE
    // and REPLACE refuse such a pattern. There, every window of the value
    // as long as the needle is compared with it (GENERATE_SERIES, 2022+;
    // same lengths, so no padding). Either side is negative on a match, 0
    // otherwise and NULL for a NULL value; the CASE evaluates one.
    containsText: (column: Sql, value: Sql): Sql => {
      const needle = textLength(value);
      const windows = sql`GENERATE_SERIES(CAST(1 AS BIGINT), CAST(${textLength(column)} - ${needle} + 1 AS BIGINT), CAST(1 AS BIGINT))`;
      const scan = sql`CASE WHEN ${column} IS NULL THEN NULL WHEN EXISTS (SELECT 1 FROM ${windows} AS "g" WHERE SUBSTRING(${binary(sql`CAST(${column} AS NVARCHAR(MAX))`)}, "g"."value", ${needle}) = ${binary(value)}) THEN -1 ELSE 0 END`;
      return sql`(CASE WHEN ${needle} > 4000 THEN ${scan} ELSE -CHARINDEX(${binary(value)}, ${binary(column)}) END < 0 OR (${column} IS NOT NULL AND ${needle} = 0))`;
    },
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
      value.length > LIKE_PREFIX_LIMIT
        ? this.operators.startsWithText(column, sql`${value}`)
        : sql`(${column} LIKE ${`${escapeLikeLiteral(value).replaceAll("[", "\\[")}%`} ESCAPE '\\' AND ${this.operators.startsWithText(column, sql`${value}`)})`,
    // The collation-native comparison seeks the index; the binary comparison
    // and the padded lengths decide.
    exactTextEq: (column: Sql, value: Sql): Sql =>
      sql`(${column} = ${value} AND ${exactKey(column)} = ${exactKey(value)})`,
    exactTextIn: (column: Sql, values: Sql): Sql =>
      membersOf(values).length > SEEKING_LIST_LIMIT
        ? sql`${exactKey(column)} IN ${keysOf(values)}`
        : sql`(${column} IN ${values} AND ${exactKey(column)} IN ${keysOf(values)})`,

    ...createMembershipOperators(),
    notIn: (column: Sql, values: Sql): Sql => {
      const operand = exactOperands.get(column);
      return operand
        ? sql`${exactKey(operand)} NOT IN ${keysOf(values)}`
        : sql`${column} NOT IN ${values}`;
    },
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

    // T-SQL has no row value. Membership reads the rows through a derived
    // table whose columns it names (`AS "r" ("r0", …)`, whatever the query
    // calls them); a bound is spelled column by column.
    rows: (items: readonly Sql[], other: Sql | readonly Sql[]): Sql => {
      if (isSqlList(other)) return rowAtMost(items, other, 0);
      if (items.length === 1) return sql`${items[0]!} IN (${other})`;
      const names = items.map((_, index) => `r${index}`);
      return sql`EXISTS (SELECT 1 FROM (${other}) AS "r" (${sql.raw(
        names.map(quoteIdent).join(", ")
      )}) WHERE ${sql.join(
        items.map(
          (item, index) =>
            sql`${sql.raw(`"r".${quoteIdent(names[index]!)}`)} = ${item}`
        ),
        " AND "
      )})`;
    },
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
    caseSensitiveText: (expr: Sql): Sql => {
      const result = binary(expr);
      exactOperands.set(result, expr);
      return result;
    },
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
    // `SUM` of an INT is an INT and of a BIGINT a BIGINT, each raising past
    // its type (Msg 8115), where PostgreSQL widens. Each member splits at
    // 2^32 (T-SQL's `/` and `%` truncate, so both parts keep its sign and
    // `high * 2^32 + low` is it exactly), read as text (a JSON number past
    // 2^53 is rounded by its reader), and compared and sorted as one exact
    // DECIMAL(38, 0).
    integerSum: (column: Sql) => {
      const member = sql`CAST(${column} AS BIGINT)`;
      const exact = sql`SUM(CAST(${column} AS DECIMAL(38, 0)))`;
      return {
        parts: [
          sql`CAST(SUM(${member} / ${INTEGER_SPLIT}) AS VARCHAR(20))`,
          sql`CAST(SUM(${member} % ${INTEGER_SPLIT}) AS VARCHAR(20))`,
        ] as const,
        value: exact,
        order: [exact],
      };
    },
  };

  json = {
    // Both sides are canonical text (see `canonicalJson`).
    equals: (left: Sql, right: Sql): Sql =>
      predicate(sql`${exactKey(left)} = ${exactKey(right)}`),
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
    // Compared exactly, as a text column is (`exactly`): ranges at a path
    // keep trailing spaces significant.
    stringAtPath: (column: Sql, path: string[]): Sql => {
      const text = sql`(CASE WHEN ${jsonTypeAt(column, path)} = 1 THEN ${jsonValueAt(column, path)} END)`;
      const compared = binary(text);
      exactOperands.set(compared, text);
      return compared;
    },
    foldableStringAtPath: (column: Sql, path: string[]): Sql =>
      sql`(CASE WHEN ${jsonTypeAt(column, path)} = 1 THEN ${jsonValueAt(column, path)} END)`,
    // Every member of `value` is a member of `target` of its type: `null`
    // (whose OPENJSON value is SQL NULL) equal to `null`, any other member's
    // text compared exactly (trailing spaces count).
    contains: (target: Sql, value: Sql): Sql =>
      predicate(
        sql`(ISJSON(${target}, ARRAY) = 1 AND NOT EXISTS (SELECT 1 FROM OPENJSON(${container(value)}) AS "c" WHERE NOT EXISTS (SELECT 1 FROM OPENJSON(${container(target)}) AS "t" WHERE "t"."type" = "c"."type" AND ("c"."type" = 0 OR ${exactKey(sql.raw('"t"."value"'))} = ${exactKey(sql.raw('"c"."value"'))}))))`
      ),
    lastElement: (target: Sql): Sql =>
      sql`(SELECT TOP (1) ${OPENJSON_MEMBER} FROM OPENJSON(CASE WHEN ISJSON(${target}, ARRAY) = 1 THEN ${target} END) ORDER BY CAST("key" AS INT) DESC)`,
    value: (v: unknown): Sql => sql`${canonicalJson(v)}`,
  };

  arrays = {
    literal: (items: Sql[]): Sql => this.json.array(items),
    value: jsonListValue,
    enumValue: jsonListValue,
    has: (column: Sql, value: Sql): Sql =>
      predicate(
        // A bound string compares exactly; any other value (a `Date`)
        // as T-SQL converts the member to it.
        boundText(value) === undefined
          ? sql`EXISTS (SELECT 1 FROM OPENJSON(${column}) AS "m" WHERE "m"."value" = ${value})`
          : sql`EXISTS (SELECT 1 FROM OPENJSON(${column}) AS "m" WHERE "m"."type" = 1 AND ${exactKey(sql.raw('"m"."value"'))} = ${exactKey(value)})`
      ),
    hasEvery: (column: Sql, values: Sql): Sql =>
      predicate(
        sql`NOT EXISTS (SELECT 1 FROM OPENJSON(${values}) AS "v" WHERE NOT EXISTS (SELECT 1 FROM OPENJSON(${column}) AS "m" WHERE ${SAME_MEMBER}))`
      ),
    hasSome: (column: Sql, values: Sql): Sql =>
      predicate(
        sql`EXISTS (SELECT 1 FROM OPENJSON(${column}) AS "m" INNER JOIN OPENJSON(${values}) AS "v" ON ${SAME_MEMBER})`
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
      sql`SELECT ${sql.raw(String(rank))} AS "r", CAST("key" AS INT) AS "k", ${OPENJSON_MEMBER} AS "j" FROM OPENJSON(${list})`;
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
    // No rowid: a SQL Server table keeps none `SELECT *` leaves out.
    rows: (from: Sql, _row: string, where: Sql | undefined, alias: string) =>
      sql`(SELECT * FROM ${from} WHERE ${where ? condition(where) : TRUE_CONDITION}) AS ${sql.raw(quoteIdent(alias))}`,
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
    // A select of the bare true literal (a lock, an existence) may be a
    // derived table, whose every column T-SQL wants named (Msg 8155).
    const listed =
      parts.columns === TRUE_VALUE
        ? sql`${TRUE_VALUE} AS ${sql.raw(quoteIdent("__viborm_true"))}`
        : asValue(parts.columns);
    const columns =
      ordinal && parts.orderBy
        ? sql`${listed}, ROW_NUMBER() OVER (ORDER BY ${parts.orderBy}) AS ${sql.raw(quoteIdent(ORDINAL))}`
        : listed;
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
    // T-SQL aggregates no subquery (Msg 130), so a judged update cannot keep
    // `MIN(guard) = 1` per key. One scalar `CASE` judges a row its filter
    // keeps and answers true for any other: a plan that reads the guard
    // before the filter still refuses no row the update does not write.
    keptWhere: (kept: Sql, inner: Sql): Sql =>
      sql`CASE WHEN ${condition(kept)} THEN CASE WHEN ${condition(inner)} THEN 1 ELSE 0 END ELSE 1 END = 1`,
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
