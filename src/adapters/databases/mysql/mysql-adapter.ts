import { unsupportedVector } from "@errors";
import { type Sql, sql } from "@sql";
import {
  type DecimalDescriptor,
  decimalColumnType,
  encodePhysicalDecimal,
} from "@validation/primitives/decimal-codec";
import { GEO_POINT_EARTH_RADIUS_METERS } from "@validation/primitives/geo-area-codec";
import { createIdentifierQuoter } from "../../../sql/identifiers";
import type { ArithmeticTarget } from "../../adapter-core-types";
import { installAdapterInternals } from "../../adapter-internals";
import { installAdapterNamespace } from "../../adapter-namespace";
import type { QueryParts } from "../../adapter-query-parts";
import type { AdapterResultParser } from "../../adapter-result-parser";
import {
  type DatabaseAdapter,
  type GeoPointSql,
  installGeoPointSql,
} from "../../database-adapter";
import { createMySqlBatchRefs } from "../../shared/batch-refs";
import {
  type ExactIntegerArithmetic,
  halfEvenQuotient,
  scaleFactorSql,
  scaleUnitSql,
  signedNumerator,
} from "../../shared/decimal-arithmetic";
import {
  createGeoPointCoordinatePredicates,
  geoBoundsIndexPolygons,
  geoPolygonJson,
} from "../../shared/geo-point";
import {
  normalizeCountResult,
  parseIntegerBoolean,
} from "../../shared/result-parsing";
import {
  assembleDistinctOnEmulation,
  assembleSelectQuery,
} from "../../shared/select-assembly";
import {
  buildJsonPath,
  createAggregateFunctions,
  createCastExpression,
  createCommonExpressions,
  createComparisonOperators,
  createCoreJoins,
  createCteBuilders,
  createDecimalSumOperandPrecision,
  createDirectionOrderBy,
  createEmulatedNullsOrderBy,
  createExistenceOperators,
  createIdentifiers,
  createInsertStatement,
  createLateralJoins,
  createLogicalOperators,
  createMembershipOperators,
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

const quoteIdent = createIdentifierQuoter("`");

/**
 * MySQL has `MOD()` but no exact integer-quotient function for decimals: `DIV`
 * converts both sides to BIGINT (so it overflows and truncates a wide
 * `DECIMAL`), and `TRUNCATE(n / d, 0)` computes `n / d` to
 * `div_precision_increment` extra digits and ROUNDS there first, which can turn
 * a value just below a half into an exact-looking tie.
 *
 * `(n - MOD(n, d)) / d` avoids both: the numerator is exactly divisible by `d`,
 * so the division's true result has no fractional digits and the extra digits
 * MySQL computes are all zero.
 */
const MYSQL_INTEGERS: ExactIntegerArithmetic = {
  // The CAST is not decoration. MySQL's `/` ALWAYS returns
  // `div_precision_increment` (four, by default) fractional digits, so an exact
  // integer quotient arrives typed `DECIMAL(w, 4)` — four digits of the 65-digit
  // exact domain spent on zeros, and any product taking that value as an operand
  // would carry them into ITS width. Casting back to the widest exact integer
  // domain is exact here (the value has no fraction to lose) and is what keeps
  // every downstream term integer-typed.
  quotient: (n: Sql, d: Sql): Sql =>
    sql`CAST((${n} - MOD(${n}, ${d})) / ${d} AS DECIMAL(65,0))`,
  remainder: (n: Sql, d: Sql): Sql => sql`MOD(${n}, ${d})`,
};

/**
 * MySQL's exact decimal domain, in digits — the ceiling every expression below
 * is written to stay under (plan 5.3: "MySQL expressions avoid an intermediate
 * wider than its 65-digit exact domain").
 */
const MYSQL_EXACT_DIGITS = 65;

const mysqlMaximumCoefficient = (digits: number): Sql =>
  sql.raw("9".repeat(digits));

const mysqlStrictMode = sql`(FIND_IN_SET('STRICT_TRANS_TABLES', @@SESSION.sql_mode) > 0 OR FIND_IN_SET('STRICT_ALL_TABLES', @@SESSION.sql_mode) > 0)`;

const mysqlArithmeticFailure = sql`JSON_EXTRACT('x', '$')`;

/** `CAST(<expr> AS DECIMAL(precision,scale))`, the width-declaring device. */
const decimalCast = (expr: Sql, precision: number, scale: number): Sql =>
  sql`CAST(${expr} AS ${sql.raw(`DECIMAL(${precision},${scale})`)})`;

/**
 * The signed unscaled COEFFICIENT of a logical `DECIMAL(p,s)` expression, as an
 * exact integer — WITHOUT ever multiplying the whole value by `10^s`.
 *
 * `column * 10^s` is the obvious spelling and it is the unsafe one. MySQL types
 * a product as `DECIMAL(p1+p2, s1+s2)` capped at `(65, 30)`, so multiplying a
 * `DECIMAL(65,30)` column by a `DECIMAL(31,0)` factor asks for a 96-digit type,
 * gets a 65-digit one whose 30 fractional digits leave 35 for an integer that
 * needs 65 — and MySQL answers ZERO, with no warning and no error (measured on
 * 8.4: `SELECT CAST(REPEAT('9',50) AS DECIMAL(65,0)) * 0.<29 zeros>1` is
 * `0.000…0`). Splitting the value first is what keeps every factor small:
 *
 *   whole    = TRUNCATE(v, 0)            |whole|    < 10^(p-s), scale 0
 *   fraction = v - whole                 |fraction| < 1,        scale s
 *   coefficient = whole * 10^s + fraction * 10^s
 *
 * Widths, by construction, for every descriptor MySQL admits (`p <= 65`,
 * `s <= 30`, `p + s <= 65`): `whole * 10^s` is typed
 * `DECIMAL(min(p+2,65), 0)` and valued
 * below `10^p`; `fraction * 10^s` is typed `DECIMAL(2s+2, s)` — at most 62
 * digits — and valued below `10^s`, so its cast to `DECIMAL(s,0)` is exact.
 * Neither product's operands sum past the exact domain, so neither can take the
 * silent arm above.
 */
const mysqlCoefficient = (value: Sql, descriptor: DecimalDescriptor): Sql => {
  const { scale } = descriptor;
  if (scale === 0) return value;
  const factor = scaleFactorSql(scale);
  const whole = sql`TRUNCATE(${value}, 0)`;
  const fraction = decimalCast(sql`(${value} - ${whole})`, scale + 1, scale);
  return sql`(${whole} * ${factor} + ${decimalCast(sql`(${fraction} * ${factor})`, scale, 0)})`;
};

/**
 * The logical `DECIMAL(p,s)` value of an exact integer COEFFICIENT — the
 * inverse of {@link mysqlCoefficient}, and unsafe for the same reason in the
 * same place.
 *
 * `coefficient * 10^-s` would multiply a `p`-digit integer by a
 * `DECIMAL(s+1,s)` literal: `p + s + 1` digits of type for a value that needs
 * `p`, which is the silent-zero arm again for a wide descriptor. So the
 * coefficient is split by `10^s` FIRST — an integer part that is already the
 * answer's integer part, and a remainder below `10^s` that is the only thing
 * the tiny `10^-s` literal ever multiplies:
 *
 *   integer part = (coefficient - MOD(coefficient, 10^s)) / 10^s
 *   fraction     = MOD(coefficient, 10^s) * 10^-s
 *
 * Widths: the division is typed `DECIMAL(w, 4)` over a value below `10^(p-s)`,
 * and the fractional product's operands sum to `2s + 1` — at most 61 digits.
 */
const mysqlLogical = (coefficient: Sql, descriptor: DecimalDescriptor): Sql => {
  const { scale } = descriptor;
  if (scale === 0) return coefficient;
  const factor = scaleFactorSql(scale);
  const remainder = sql`MOD(${coefficient}, ${factor})`;
  return sql`((${coefficient} - ${remainder}) / ${factor} + ${decimalCast(remainder, scale, 0)} * ${scaleUnitSql(scale)})`;
};

/**
 * Assign one coefficient-space answer without letting a non-strict MySQL
 * session turn overflow into a clipped value. Strict sessions retain their
 * native error. A non-strict session reaches the answer only after the caller's
 * operation-specific precondition proves its intermediate is exact and the
 * target-domain check proves the final coefficient fits.
 *
 * The session-mode arm is deliberately first. `CASE` is the same lazy error
 * primitive used by this adapter's assertion queries, so a safe or NULL arm
 * never evaluates the invalid JSON expression that raises the provider error.
 */
const mysqlGuardedDecimalAssignment = (
  column: Sql,
  coefficient: Sql,
  descriptor: DecimalDescriptor,
  intermediateFits: Sql
): Sql => {
  const maximum = mysqlMaximumCoefficient(descriptor.precision);
  const logical = mysqlLogical(coefficient, descriptor);
  return sql`${column} = CASE WHEN ${mysqlStrictMode} THEN ${logical} WHEN ${column} IS NULL THEN NULL WHEN ${intermediateFits} THEN CASE WHEN ${coefficient} BETWEEN -${maximum} AND ${maximum} THEN ${logical} ELSE ${mysqlArithmeticFailure} END ELSE ${mysqlArithmeticFailure} END`;
};

const mysqlDecimalIncrement = (
  column: Sql,
  by: Sql,
  descriptor: DecimalDescriptor
): Sql => {
  const current = mysqlCoefficient(column, descriptor);
  const operand = mysqlCoefficient(by, descriptor);
  const maximum = mysqlMaximumCoefficient(descriptor.precision);
  const fits = sql`CASE WHEN ${operand} > 0 THEN ${current} <= ${maximum} - ${operand} WHEN ${operand} < 0 THEN ${current} >= -${maximum} - ${operand} ELSE TRUE END`;
  return mysqlGuardedDecimalAssignment(
    column,
    sql`(${current} + ${operand})`,
    descriptor,
    fits
  );
};

const mysqlDecimalDecrement = (
  column: Sql,
  by: Sql,
  descriptor: DecimalDescriptor
): Sql => {
  const current = mysqlCoefficient(column, descriptor);
  const operand = mysqlCoefficient(by, descriptor);
  const maximum = mysqlMaximumCoefficient(descriptor.precision);
  const fits = sql`CASE WHEN ${operand} > 0 THEN ${current} >= -${maximum} + ${operand} WHEN ${operand} < 0 THEN ${current} <= ${maximum} + ${operand} ELSE TRUE END`;
  return mysqlGuardedDecimalAssignment(
    column,
    sql`(${current} - ${operand})`,
    descriptor,
    fits
  );
};

/**
 * `column = halfEven(column x by)`, computed on COEFFICIENTS.
 *
 * This is plan 5.3's rule verbatim — `multiply = halfEven((x * y) / F)` — and
 * it is stated on integers because MySQL cannot state it on logical values: the
 * exact product of two `DECIMAL(p,s)` values carries `2s` fractional digits,
 * and MySQL caps an expression's scale at 30, ROUNDING anything finer away
 * before the tie this rule exists to decide is ever visible (measured: `1e-30 *
 * 1e-30` is `0.000…0` at `DECIMAL(65,30)`, no warning). Coefficients have no
 * fractional digits at all, so nothing can be rounded away underneath the rule.
 *
 * WIDTH, BY CONSTRUCTION. `|x|, |y| < 10^p`, and the answer is in the field's
 * domain exactly when `|x * y| < 10^(p+s)`, so the product needs at most
 * `p + s` digits: within the 65-digit exact domain for every descriptor with
 * `precision + scale <= 65`. The quotient is `< 10^p`, the remainder `< 10^s`,
 * and the tie test compares `|r|` against `10^s - |r|` — the non-doubling form,
 * so nothing widens there either.
 *
 * Outside that bound the operation is loud on every session. A strict session
 * reaches MySQL's native overflow error. A non-strict session first proves the
 * product can be formed inside 65 digits and that the rounded coefficient fits
 * the field; a failed proof evaluates the adapter's lazy error expression
 * instead of letting MySQL clip the assignment. Both leave the row unchanged.
 */
const mysqlDecimalMultiply = (
  column: Sql,
  by: Sql,
  descriptor: DecimalDescriptor
): Sql => {
  const left = mysqlCoefficient(column, descriptor);
  const right = mysqlCoefficient(by, descriptor);
  const maximumIntermediate = mysqlMaximumCoefficient(MYSQL_EXACT_DIGITS);
  const coefficient = halfEvenQuotient(
    MYSQL_INTEGERS,
    sql`(${left} * ${right})`,
    scaleFactorSql(descriptor.scale)
  );
  const intermediateFits = sql`CASE WHEN ${right} = 0 THEN TRUE ELSE ABS(${left}) <= ${MYSQL_INTEGERS.quotient(maximumIntermediate, sql`ABS(${right})`)} END`;
  return mysqlGuardedDecimalAssignment(
    column,
    coefficient,
    descriptor,
    intermediateFits
  );
};

/**
 * `column = halfEven(column / by)`, computed on COEFFICIENTS — plan 5.3's
 * `divide = halfEven((x * F) / y)`.
 *
 * The divisor is the operand's COEFFICIENT rather than its logical value: an
 * exact quotient is spelled `(n - MOD(n, d)) / d`, and with a fractional `d`
 * the numerator `n - MOD(n, d)` is `q * d` — a `p`-digit magnitude carrying `s`
 * fractional digits, `p + s` digits for a value the integer form states in `p`.
 * Integers on both sides keep every term at its own width.
 *
 * WIDTH, BY CONSTRUCTION: `|x * F| < 10^(p+s)` — inside the exact domain for
 * every descriptor with `precision + scale <= 65`, and unconditionally, not
 * only when the answer fits. The quotient is the answer's coefficient
 * (`< 10^p` when it fits the field), the remainder is below `|y| < 10^p`, and
 * the tie compares `|r|` against `|y| - |r|`, which is why the doubled form was
 * dropped: `2|r|` at `p = 65` needs 66.
 *
 * `by` is never zero — division by canonical zero is refused before I/O.
 */
const mysqlDecimalDivide = (
  column: Sql,
  by: Sql,
  descriptor: DecimalDescriptor
): Sql => {
  const divisor = mysqlCoefficient(by, descriptor);
  const coefficient = halfEvenQuotient(
    MYSQL_INTEGERS,
    signedNumerator(
      sql`(${mysqlCoefficient(column, descriptor)} * ${scaleFactorSql(descriptor.scale)})`,
      divisor
    ),
    sql`ABS(${divisor})`
  );
  return mysqlGuardedDecimalAssignment(
    column,
    coefficient,
    descriptor,
    sql.raw`TRUE`
  );
};

/**
 * The exact decimal average, on coefficients: `SUM` of the column's
 * coefficients over `COUNT(column)`, quantized half to even.
 *
 * Summing the COEFFICIENTS rather than scaling the sum is what removes the last
 * `x 10^s` from this expression: `SUM(column) * 10^s` multiplies a value MySQL
 * already types up to 65 digits by a 31-digit factor, which is the silent-zero
 * arm {@link mysqlCoefficient} exists to avoid. Every row's coefficient is
 * below `10^p`, so the only way the sum leaves the exact domain is by genuinely
 * exceeding it, and MySQL raises there.
 *
 * `COUNT(column)` counts non-nulls, so an empty or all-null group answers NULL
 * through the null-strict operators instead of dividing by zero.
 */
const mysqlDecimalAverage = (
  column: Sql,
  descriptor: DecimalDescriptor
): Sql => {
  const coefficient = halfEvenQuotient(
    MYSQL_INTEGERS,
    sql`SUM(${mysqlCoefficient(column, descriptor)})`,
    sql`COUNT(${column})`
  );
  return mysqlLogical(coefficient, descriptor);
};
const ASCII_UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";

const asciiCaseFold = (expr: Sql): Sql => {
  let folded = expr;
  for (let index = 0; index < ASCII_UPPERCASE.length; index++) {
    const upper = sql.raw`'${ASCII_UPPERCASE[index]}'`;
    const lower = sql.raw`'${ASCII_LOWERCASE[index]}'`;
    folded = sql`REPLACE(${folded}, ${upper}, ${lower})`;
  }
  return folded;
};

// MySQL DATETIME rejects ISO-8601's 'Z' suffix ("Incorrect datetime value"),
// so datetimes are stored as naive UTC wall-clock 'YYYY-MM-DD HH:MM:SS.mmm'.
const toMySqlDateTime = (iso: string): string =>
  new Date(iso).toISOString().slice(0, 23).replace("T", " ");

// Naive datetime string as it comes back from MySQL (top-level on string
// drivers, or inside JSON_ARRAYAGG/JSON_OBJECT includes): no 'Z'/offset.
const NAIVE_DATETIME_REGEX =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

/** Reattach UTC to a naive MySQL datetime string so it parses as the stored instant. */
const naiveDateTimeToIso = (value: string): string | undefined => {
  const match = NAIVE_DATETIME_REGEX.exec(value);
  if (!match) return undefined;
  const fraction = match[3] ? match[3].padEnd(4, "0").slice(0, 4) : ".000";
  return `${match[1]}T${match[2]}${fraction}Z`;
};

/** Replace a single-integer-parameter fragment with an inline literal. */
const inlineIntegerLiteral = (fragment: Sql): Sql => {
  const value = fragment.values.length === 1 ? fragment.values[0] : undefined;
  return typeof value === "number" && Number.isInteger(value)
    ? sql.raw`${String(value)}`
    : fragment;
};

/**
 * MySQL Database Adapter
 *
 * Implements the DatabaseAdapter interface for MySQL-specific SQL generation.
 *
 * Key MySQL features:
 * - Backtick identifier escaping: `table`.`column`
 * - No native ARRAY type - uses JSON for arrays
 * - Portable string filters override the database collation explicitly
 * - JSON_OBJECT(), JSON_ARRAYAGG() for JSON operations
 * - No RETURNING clause (use LAST_INSERT_ID())
 * - No NULLS FIRST/LAST ordering
 * - ON DUPLICATE KEY UPDATE for upserts
 */
export class MySQLAdapter implements DatabaseAdapter {
  // ============================================================
  // NAMESPACE
  // ============================================================

  /**
   * The bound database, or `undefined` for the unqualified mode a
   * provider-configured MySQL2 client and every PlanetScale client keep. Under
   * Vitess the value is the keyspace qualifier submitted before routing rules
   * apply, not a proof of the routed backend.
   */
  declare readonly namespace: string | undefined;

  constructor(namespace?: string) {
    installAdapterNamespace(this, namespace, "mysql");
    // Reads the installed value, so it cannot be a field initializer: those run
    // before the constructor body.
    this.identifiers = createIdentifiers(quoteIdent, this.namespace);
    installGeoPointSql(this, this.geoPoint);
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

    // MySQL requires JSON values to be stringified
    json: (v: unknown): Sql => sql`${JSON.stringify(v)}`,

    dateTime: (iso: string): Sql => sql`${toMySqlDateTime(iso)}`,

    // The cast is load-bearing, not decoration. MySQL's comparison rules say
    // that when one side is a number and the other a string, BOTH are converted
    // to double and compared as floating point — so `amount = '0.1'` against a
    // `DECIMAL` column would silently answer at float precision on an otherwise
    // exact column. Casting the operand into the SAME `DECIMAL(p,s)` the DDL
    // emits keeps the whole comparison in MySQL's exact decimal domain, and
    // names one domain for the operand and the column instead of two.
    decimal: (canonical: string, descriptor: DecimalDescriptor): Sql =>
      sql`CAST(${encodePhysicalDecimal(canonical, descriptor, "text")} AS ${sql.raw(decimalColumnType("mysql", descriptor))})`,
  };

  // ============================================================
  // OPERATORS
  // ============================================================

  operators = {
    // Comparison
    ...createComparisonOperators(),

    // Pattern matching
    // Explicit ESCAPE '\' pairs with wildcard escaping in the where-builder.
    // The literal is doubled ('\\') because MySQL's default mode treats
    // backslash as a string-literal escape; under NO_BACKSLASH_ESCAPES it
    // fails loudly rather than silently matching wildcards.
    like: (column: Sql, pattern: Sql): Sql =>
      sql`${column} LIKE ${pattern} ESCAPE '\\\\'`,
    notLike: (column: Sql, pattern: Sql): Sql =>
      sql`${column} NOT LIKE ${pattern} ESCAPE '\\\\'`,
    ilike: (column: Sql, pattern: Sql): Sql =>
      sql`${asciiCaseFold(column)} LIKE ${asciiCaseFold(pattern)} ESCAPE '\\\\'`,
    notIlike: (column: Sql, pattern: Sql): Sql =>
      sql`${asciiCaseFold(column)} NOT LIKE ${asciiCaseFold(pattern)} ESCAPE '\\\\'`,
    containsText: (column: Sql, value: Sql): Sql =>
      sql`LOCATE(BINARY ${value}, BINARY ${column}) > 0`,
    startsWithText: (column: Sql, value: Sql): Sql =>
      sql`LEFT(BINARY ${column}, OCTET_LENGTH(${value})) = BINARY ${value}`,
    endsWithText: (column: Sql, value: Sql): Sql =>
      sql`RIGHT(BINARY ${column}, OCTET_LENGTH(${value})) = BINARY ${value}`,
    // Two conjuncts, because on MySQL no single predicate is both exact and
    // index-usable. The index stores the column's own collation's sort keys —
    // `utf8mb4_0900_ai_ci` on a default install, which is case- AND
    // accent-insensitive — so any comparison forced to BINARY cannot range on
    // it. Measured on MySQL 8 (Docker, 20k rows): `col LIKE 'x%'` is a `range`
    // over 111 rows, while both `col LIKE BINARY 'x%'` and the
    // `LEFT(BINARY col, …)` spelling above degrade to a full `index` scan of
    // all 19731 entries.
    //
    // So the collation-native LIKE goes first as an index accelerator, and the
    // BINARY predicate — byte-identical to `startsWithText` above — follows as
    // the semantics. The accelerator can never drop a row the BINARY conjunct
    // would keep: byte-equal strings compare equal under every collation, so a
    // binary prefix match implies the collation-native one. It is not a second
    // guard on the same invariant — it decides no row's membership, only which
    // rows the server has to look at.
    //
    // Parenthesized because this fragment gets composed into AND/OR chains.
    startsWithPrefix: (column: Sql, value: string): Sql =>
      sql`(${column} LIKE ${`${escapeLikeLiteral(value)}%`} ESCAPE '\\\\' AND LEFT(BINARY ${column}, OCTET_LENGTH(${value})) = BINARY ${value})`,

    // `startsWithPrefix`'s twin, for the same reason and in the same shape
    // (plan §10.2). `BINARY col` is a FUNCTION of the column, so MySQL cannot
    // range on it: measured on MySQL 8.4 over 20,000 rows in the collation
    // viborm's own DDL declares, `BINARY name = ?` planned `index` over 20,455
    // rows where `name = ?` planned `ref` over 1, and `BINARY name IN (…)`
    // planned `index` over 20,455 where `name IN (…)` planned `range` over 3.
    //
    // The collation-native conjunct is the accelerator and decides no row's
    // membership: byte-identical strings compare equal under every collation
    // of the charset, so the BINARY comparison IMPLIES it. On the tables
    // viborm creates (`utf8mb4_0900_bin`) the two conjuncts say the same
    // thing; on a table viborm did not create the BINARY one is what keeps the
    // case-sensitivity contract, and the same measurement shows the pair still
    // plans `ref` over 1 row there.
    //
    // `notIn` and `not` deliberately have no such pair. Their implication runs
    // the other way — `BINARY col NOT IN ('X')` KEEPS a row spelled `x` that
    // `col NOT IN ('X')` drops on a case-insensitive column, measured at
    // 20,000 rows against 19,999 — so a conjunct would remove rows. There is
    // also nothing to win: both spellings of `NOT IN` scan all 20,442 rows.
    //
    // Parenthesized because this fragment gets composed into AND/OR chains.
    exactTextEq: (column: Sql, value: Sql): Sql =>
      sql`(${column} = ${value} AND BINARY ${column} = ${value})`,
    exactTextIn: (column: Sql, values: Sql): Sql =>
      sql`(${column} IN ${values} AND BINARY ${column} IN ${values})`,

    // Set membership
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

    asciiCaseFold,
    caseSensitiveText: (expr: Sql): Sql => sql`BINARY ${expr}`,

    // String operations - MySQL uses CONCAT() function
    concat: (...parts: Sql[]): Sql => {
      if (parts.length === 0) return sql.raw`''`;
      if (parts.length === 1) return parts[0]!;
      return sql`CONCAT(${sql.join(parts, ", ")})`;
    },

    greatest: (...exprs: Sql[]): Sql => sql`GREATEST(${sql.join(exprs, ", ")})`,
    least: (...exprs: Sql[]): Sql => sql`LEAST(${sql.join(exprs, ", ")})`,

    decimalCast: (expr: Sql, descriptor: DecimalDescriptor): Sql =>
      decimalCast(expr, descriptor.precision, descriptor.scale),

    // MySQL type mappings - MySQL doesn't support TEXT in CAST
    cast: createCastExpression({
      text: "CHAR",
      integer: "SIGNED",
      boolean: "UNSIGNED",
      numeric: "DECIMAL",
    }),

    blobToHex: (expr: Sql): Sql => sql`LOWER(HEX(${expr}))`,
  };

  // ============================================================
  // AGGREGATES
  // ============================================================

  aggregates = {
    ...createAggregateFunctions(),

    decimalAvg: (column: Sql, descriptor: DecimalDescriptor): Sql =>
      mysqlDecimalAverage(column, descriptor),

    // MySQL's widest exact DECIMAL cast operand. SUM itself can return more
    // than 65 digits; this bound belongs to exact HAVING operand lowering.
    decimalSumOperandPrecision:
      createDecimalSumOperandPrecision(MYSQL_EXACT_DIGITS),
  };

  // ============================================================
  // JSON
  // ============================================================

  json = {
    boolean: (condition: Sql): Sql =>
      sql`JSON_EXTRACT(CASE WHEN ${condition} THEN 'true' ELSE 'false' END, '$')`,
    document: (expression: Sql): Sql => expression,

    object: (pairs: [string, Sql][]): Sql => {
      if (pairs.length === 0) return sql.raw`JSON_OBJECT()`;
      const args = pairs.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`JSON_OBJECT(${sql.join(args, ", ")})`;
    },

    array: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`JSON_ARRAY()`;
      return sql`JSON_ARRAY(${sql.join(items, ", ")})`;
    },

    emptyArray: (): Sql => sql.raw`JSON_ARRAY()`,

    agg: (expr: Sql): Sql =>
      sql`COALESCE(JSON_ARRAYAGG(${expr}), JSON_ARRAY())`,

    objectFromColumns: (columns: [string, Sql][]): Sql => {
      if (columns.length === 0) return sql.raw`JSON_OBJECT()`;
      const args = columns.flatMap(([key, value]) => [sql`${key}`, value]);
      return sql`JSON_OBJECT(${sql.join(args, ", ")})`;
    },

    // buildJsonPath quotes/escapes key segments and maps integer segments
    // to array indices; '$' alone extracts the document root
    extract: (column: Sql, path: string[]): Sql =>
      sql`JSON_EXTRACT(${column}, ${buildJsonPath(path)})`,

    extractText: (column: Sql, path: string[]): Sql =>
      sql`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${buildJsonPath(path)}))`,

    // JSON_TYPE spells numbers three ways depending on how the literal was
    // stored; anything else (including an absent path, where JSON_TYPE is
    // NULL) falls through the CASE to NULL
    numberAtPath: (column: Sql, path: string[]): Sql => {
      const jsonPath = buildJsonPath(path);
      return sql`(CASE WHEN JSON_TYPE(JSON_EXTRACT(${column}, ${jsonPath})) IN ('INTEGER', 'DOUBLE', 'DECIMAL') THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(${column}, ${jsonPath})) AS DOUBLE) END)`;
    },

    // CAST(... AS BINARY) yields VARBINARY, so < / > compare bytes instead of
    // the column's (case- and accent-insensitive by default) collation
    stringAtPath: (column: Sql, path: string[]): Sql => {
      const jsonPath = buildJsonPath(path);
      return sql`(CASE WHEN JSON_TYPE(JSON_EXTRACT(${column}, ${jsonPath})) = 'STRING' THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(${column}, ${jsonPath})) AS BINARY) END)`;
    },

    contains: (target: Sql, value: Sql): Sql =>
      sql`JSON_CONTAINS(${target}, ${value})`,

    lastElement: (target: Sql): Sql => sql`JSON_EXTRACT(${target}, '$[last]')`,

    // Comparing a JSON column to a plain string coerces the string to a JSON
    // string scalar (always-false for documents); CAST parses it as JSON
    value: (v: unknown): Sql => sql`CAST(${stringifyJson(v)} AS JSON)`,
  };

  // ============================================================
  // ARRAYS (JSON-based for MySQL)
  // ============================================================

  arrays = {
    // MySQL uses JSON arrays
    literal: (items: Sql[]): Sql => {
      if (items.length === 0) return sql.raw`JSON_ARRAY()`;
      return sql`JSON_ARRAY(${sql.join(items, ", ")})`;
    },

    value: (values: unknown[]): Sql =>
      sql`CAST(${stringifyJson(values)} AS JSON)`,

    // JSON_CONTAINS requires a JSON document as candidate; a bare string
    // parameter throws ER_INVALID_JSON_TEXT. JSON_ARRAY keeps the parameter's
    // type (strings quoted, numbers not): [x] ⊆ column ⟺ x ∈ column
    has: (column: Sql, value: Sql): Sql =>
      sql`JSON_CONTAINS(${column}, JSON_ARRAY(${value}))`,

    hasEvery: (column: Sql, values: Sql): Sql =>
      sql`JSON_CONTAINS(${column}, ${values})`,

    hasSome: (column: Sql, values: Sql): Sql =>
      sql`JSON_OVERLAPS(${column}, ${values})`,

    isEmpty: (column: Sql): Sql =>
      sql`(JSON_LENGTH(${column}) = 0 OR ${column} IS NULL)`,

    // The container as TEXT, so it reaches the decode as the exact bytes the
    // codec wrote: uncast, mysql2 parses a JSON column into a JavaScript
    // document and JSON_OBJECT nests it as a live array, and the coefficient
    // grammar would then be read off values a JSON parser already interpreted.
    decimalProjection: (column: Sql): Sql => sql`CAST(${column} AS CHAR)`,

    length: (column: Sql): Sql => sql`JSON_LENGTH(${column})`,

    get: (column: Sql, index: Sql): Sql =>
      sql`JSON_EXTRACT(${column}, CONCAT('$[', ${index}, ']'))`,

    push: (column: Sql, value: Sql): Sql =>
      sql`JSON_ARRAY_APPEND(${column}, '$', ${value})`,

    set: (column: Sql, index: Sql, value: Sql): Sql =>
      sql`JSON_SET(${column}, CONCAT('$[', ${index}, ']'), ${value})`,
  };

  // ============================================================
  // ORDER BY
  // ============================================================

  orderBy = {
    ...createDirectionOrderBy(),
    // MySQL doesn't support NULLS FIRST/LAST natively - emulated
    ...createEmulatedNullsOrderBy(),
  };

  // ============================================================
  // CLAUSES
  // ============================================================

  // mysql2's binary protocol binds JS numbers as DOUBLE, which MySQL rejects
  // in integer-only positions ("Incorrect arguments to mysqld_stmt_execute").
  // Inline integer LIMIT/OFFSET values instead of parameterizing them.
  clauses = {
    ...createStandardClauses(),
    limit: (count: Sql): Sql => sql`LIMIT ${inlineIntegerLiteral(count)}`,
    offset: (count: Sql): Sql => sql`OFFSET ${inlineIntegerLiteral(count)}`,
  };

  // ============================================================
  // SET (UPDATE operations)
  // ============================================================

  // JSON_MERGE_PRESERVE concatenates arrays element-wise; JSON_ARRAY_APPEND
  // would append the whole param as a single (stringified) element.
  set = {
    ...createNumericSetOperations(),

    increment: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? mysqlDecimalIncrement(column, by, target.decimal)
        : sql`${column} = ${column} + ${by}`,

    decrement: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? mysqlDecimalDecrement(column, by, target.decimal)
        : sql`${column} = ${column} - ${by}`,

    // A decimal target rounds the product back to the field's scale; every
    // other numeric column keeps MySQL's native multiplication.
    multiply: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql =>
      target?.decimal
        ? mysqlDecimalMultiply(column, by, target.decimal)
        : sql`${column} = ${column} * ${by}`,

    // MySQL `/` yields DECIMAL and rounds when assigned to an integer column.
    // Truncate explicitly so integer division matches PostgreSQL and SQLite.
    // A decimal target takes neither: `/` would round at
    // `div_precision_increment` digits, so the exact half-even quotient rule
    // decides the last digit instead.
    divide: (column: Sql, by: Sql, target?: ArithmeticTarget): Sql => {
      if (target?.decimal) {
        return mysqlDecimalDivide(column, by, target.decimal);
      }
      return target?.integer
        ? sql`${column} = TRUNCATE(${column} / ${by}, 0)`
        : sql`${column} = ${column} / ${by}`;
    },

    push: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = JSON_MERGE_PRESERVE(COALESCE(${column}, JSON_ARRAY()), CAST(${stringifyJson(values)} AS JSON))`,

    unshift: (column: Sql, values: unknown[]): Sql =>
      sql`${column} = JSON_MERGE_PRESERVE(CAST(${stringifyJson(values)} AS JSON), COALESCE(${column}, JSON_ARRAY()))`,
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

  // MySQL has no bare OFFSET; per the manual, use an all-ones LIMIT sentinel
  noLimitValue = sql.raw`18446744073709551615`;

  readonly #assemble = {
    select: (rawParts: QueryParts): Sql => {
      // Inline integer LIMIT/OFFSET (see clauses above for why)
      const parts: QueryParts = {
        ...rawParts,
        limit: rawParts.limit && inlineIntegerLiteral(rawParts.limit),
        offset: rawParts.offset && inlineIntegerLiteral(rawParts.offset),
      };

      // MySQL doesn't support DISTINCT ON natively
      // Simulate using ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)
      if (parts.distinct) {
        return assembleDistinctOnEmulation(
          parts,
          parts.distinct,
          this.identifiers.escape,
          this.noLimitValue
        );
      }

      return assembleSelectQuery(sql`SELECT ${parts.columns}`, parts, {
        forUpdate: "append",
        noLimitValue: this.noLimitValue,
      });
    },
  };

  // ============================================================
  // CTE (Common Table Expressions - MySQL 8.0+)
  // ============================================================

  cte = createCteBuilders(quoteIdent);

  // ============================================================
  // MUTATIONS
  // ============================================================

  mutations = {
    skipDuplicatesStrategy: "recoverableUniqueError" as const,
    insert: createInsertStatement(quoteIdent),
    insertDefault: (table: Sql): Sql => sql`INSERT INTO ${table} () VALUES ()`,

    ...createMutationCommands(),

    // MySQL doesn't support RETURNING - returns empty
    // Use LAST_INSERT_ID() or SELECT after mutation
    returning: (_columns: Sql): Sql => sql.empty,

    // This low-level MySQL primitive ignores `_target`: ON DUPLICATE KEY UPDATE
    // fires on any unique collision. Public non-returning upserts therefore do
    // not execute this primitive; the query engine uses a locked, target-aware
    // branch so an unrelated unique collision still throws on every database.
    onConflict: (_target: Sql | null, action: Sql, _targetWhere?: Sql): Sql => {
      return sql`ON DUPLICATE KEY UPDATE ${action}`;
    },

    // MySQL doesn't need UPDATE SET prefix - onConflict already includes UPDATE
    onConflictUpdate: (sets: Sql, _setWhere?: Sql): Sql => sets,

    // A self-assignment reacts only to duplicate-key conflicts. Unlike
    // INSERT IGNORE, unrelated constraint and conversion failures still abort.
    //
    // It stays the JUNCTION insert's clause on MySQL as well, because
    // `ON DUPLICATE KEY UPDATE` cannot name a target (`onConflict` above says
    // so) — correct for every junction whose PK is its sole unique constraint,
    // which is every ordinary pair table. A polymorphic member table with a
    // SINGULAR inverse also carries a target-side UNIQUE that this clause would
    // swallow; the seam for that case is documented at `junctionDuplicateSkip`
    // in `query-engine/builders/many-to-many-utils.ts`.
    skipDuplicates: (duplicateNoopColumn: string) => {
      const column = sql.raw`${quoteIdent(duplicateNoopColumn)}`;
      return {
        prefix: sql.empty,
        suffix: sql`ON DUPLICATE KEY UPDATE ${column} = ${column}`,
      };
    },
  };

  assertions = {
    exists: (query: Sql): Sql =>
      sql`SELECT CASE WHEN EXISTS (${query}) THEN 1 ELSE JSON_EXTRACT('x', '$') END AS \`__viborm_assert__\``,
    notExists: (query: Sql): Sql =>
      sql`SELECT CASE WHEN NOT EXISTS (${query}) THEN 1 ELSE JSON_EXTRACT('x', '$') END AS \`__viborm_assert__\``,
  };

  // ============================================================
  // JOINS
  // ============================================================

  joins = {
    ...createCoreJoins(),

    // MySQL doesn't support FULL OUTER JOIN (would need a UNION of LEFT and
    // RIGHT joins). Never silently downgrade to LEFT JOIN: that drops rows.
    // The query engine never calls this today.
    full: (_table: Sql, _condition: Sql): Sql => {
      throw new Error(
        "MySQL does not support FULL OUTER JOIN. Check adapter.capabilities.supportsFullOuterJoin before calling."
      );
    },

    // MySQL 8.0.14+ supports LATERAL
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
    supportsReturning: false,
    supportsCteWithMutations: false, // MySQL CTEs are read-only
    supportsFullOuterJoin: false,
    supportsLateralJoins: true, // MySQL 8.0.14+
    supportsVector: false,
    supportsUpsertWhere: false, // ON DUPLICATE KEY UPDATE doesn't support WHERE clauses
    // ON DUPLICATE KEY UPDATE carries no conflict target and fires on ANY unique
    // collision — see the `onConflict` note above. A targeted upsert cannot be
    // spelled here, so the ON CONFLICT fold never opens on MySQL.
    supportsTargetedUpsert: false,
    // ERROR 1093: UPDATE/DELETE can't select from the mutated table in a
    // subquery. The engine wraps relation-filter subqueries in a derived
    // table when this is false (requires MySQL 8.0.14+ for outer references
    // in derived tables).
    supportsMutationTargetInSubquery: false,
    // MySQL's single-table UPDATE/DELETE take a native LIMIT, which is also the
    // only portable spelling here: the PK-subquery form would re-read the
    // mutated table and trip the same ERROR 1093 as above.
    supportsMutationRowLimit: true,
  };

  lastInsertId = (): Sql => sql.raw`LAST_INSERT_ID()`;

  readonly #batchRefs = createMySqlBatchRefs({
    table: sql.raw`\`__viborm_batch_refs\``,
    batchIdColumn: sql.raw`\`batch_id\``,
    keyColumn: sql.raw`\`ref_key\``,
    valueColumn: sql.raw`\`ref_value\``,
    duplicateValue: sql.raw`VALUES(\`ref_value\`)`,
    createTable: sql.raw`CREATE TEMPORARY TABLE IF NOT EXISTS \`__viborm_batch_refs\` (\`batch_id\` VARCHAR(191) NOT NULL, \`ref_key\` VARCHAR(191) NOT NULL, \`ref_value\` TEXT, PRIMARY KEY (\`batch_id\`, \`ref_key\`))`,
    castValue: (valueSql) => sql`CAST((${valueSql}) AS CHAR)`,
    lastInsertId: () => this.lastInsertId(),
  });

  // ============================================================
  // VECTOR (not natively supported in MySQL)
  // ============================================================

  vector = unsupportedVector;

  // ============================================================
  // GEOPOINT (MySQL geographic POINT SRID 4326)
  // ============================================================

  readonly geoPoint: GeoPointSql = (() => {
    const longitude = (point: Sql): Sql => sql`ST_Longitude(${point})`;
    const latitude = (point: Sql): Sql => sql`ST_Latitude(${point})`;
    return {
      // EPSG:4326 is latitude-longitude in MySQL's SRS catalog. The explicit
      // WKT option makes the two bound coordinates longitude-latitude instead.
      value: (pointLongitude, pointLatitude) =>
        sql`ST_GeomFromText(CONCAT('POINT(', ${pointLongitude}, ' ', ${pointLatitude}, ')'), 4326, 'axis-order=long-lat')`,
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
                sql`MBRIntersects(${point}, ST_GeomFromGeoJSON(${polygon}, 1, 4326))`
            )
          );
        }
      ),
      withinPolygon: (point, polygon) => {
        const geography = sql`ST_GeomFromGeoJSON(${geoPolygonJson(
          polygon
        )}, 1, 4326)`;
        return sql`ST_Intersects(${geography}, ${point})`;
      },
      distance: (left, right) =>
        sql`ST_Distance_Sphere(${left}, ${right}, ${GEO_POINT_EARTH_RADIUS_METERS})`,
    };
  })();

  // ============================================================
  // RESULT PARSING
  // MySQL: normalize counts, booleans, and naive UTC datetimes.
  // Relation carriers decode at the query-engine boundary that knows their
  // value is JSON, so the adapter never sniffs ordinary strings.
  // ============================================================

  result: AdapterResultParser = {
    // A MySQL SCALAR decimal is `DECIMAL(p,s)` and answers with exact text, so
    // `decimalRepresentation` stays at its default. A decimal LIST is JSON,
    // which has no exact decimal at all, so its members are stored and returned
    // as unscaled coefficient strings (plan 6.1). This adapter is the reason
    // the two are separate declarations.
    decimalListRepresentation: "coefficient",

    parseResult: (
      raw: unknown,
      operation: import("../../../query-engine/types").Operation,
      next: (value?: unknown) => unknown
    ): unknown => {
      // Normalize raw count expressions to VibORM's private result carrier.
      if (operation === "count" || operation === "exist") {
        const normalized = normalizeCountResult(raw);
        if (normalized) {
          return next(normalized);
        }
      }
      return next();
    },

    parseRelation: (
      _value: unknown,
      next: (value?: unknown) => unknown
    ): unknown => next(),

    parseField: (
      value: unknown,
      scalarType: string,
      next: (value?: unknown) => unknown
    ): unknown => {
      // MySQL stores booleans as TINYINT(1) - 0/1
      if (scalarType === "boolean") {
        const parsed = parseIntegerBoolean(value);
        if (parsed !== undefined) {
          return next(parsed);
        }
      }
      // Datetime strings are naive UTC wall-clock; without this, the default
      // parser's new Date(str) would shift them by the process timezone
      if (scalarType === "datetime" && typeof value === "string") {
        const iso = naiveDateTimeToIso(value);
        if (iso !== undefined) {
          return next(iso);
        }
      }
      return next();
    },
  };
}

// Export singleton instance
export const mysqlAdapter = new MySQLAdapter();
