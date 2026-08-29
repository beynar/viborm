/**
 * The ONE round-half-to-even rule, spelled in each dialect's exact integer
 * vocabulary.
 *
 * Multiply, divide and average are the only operations that can create digits
 * beyond a decimal field's scale, so they are the only ones that round — and
 * they round the same way everywhere, because a rounding mode that came from
 * the provider would make the same query answer differently per database.
 * Nothing here consults a provider default: quotient, remainder and parity are
 * exact integer facts, and the arms are composed from them.
 *
 * WHY A QUOTIENT RULE AND NOT A ROUNDING FUNCTION. `ROUND()` is half-up on
 * MySQL, half-even-ish on PostgreSQL numerics, and absent on SQLite; every one
 * of them would have to be trusted at the exact tie this rule exists to decide.
 * Quotient/remainder/parity are the same three integers on all three.
 *
 * NO PATH CASTS THROUGH REAL. Every operand below is an integer or an exact
 * decimal, and every operator applied to them is exact in its dialect.
 */

import { type Sql, sql } from "@sql";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";

/**
 * How one dialect spells EXACT truncated division and its remainder.
 *
 * `quotient(n, d)` truncates toward zero and `remainder(n, d)` carries the sign
 * of `n`, which is C semantics and what all three dialects already do — but
 * they spell it three ways, and one of the three (`n / d`) is only integer
 * division when both operands are integers. Each adapter declares its own pair
 * so this file never asks which database it is running against.
 */
export interface ExactIntegerArithmetic {
  /** `n / d` truncated toward zero. `d` is never zero unless `n` is NULL. */
  readonly quotient: (n: Sql, d: Sql) => Sql;
  /** `n - quotient(n, d) * d`; sign follows `n`. */
  readonly remainder: (n: Sql, d: Sql) => Sql;
}

/** `10^scale`, the factor between a logical value and its coefficient. */
export const scaleFactorSql = (scale: number): Sql =>
  sql.raw(`1${"0".repeat(scale)}`);

/**
 * `10^-scale`: one unit in the last place of the field's domain, as an exact
 * decimal literal. Multiplying a coefficient by it is exact on PostgreSQL and
 * MySQL (scales add); DIVIDING by `10^scale` is not — MySQL computes a quotient
 * to `div_precision_increment` extra digits and rounds there, which would put a
 * provider default back in charge of the last digit.
 */
export const scaleUnitSql = (scale: number): Sql =>
  sql.raw(scale === 0 ? "1" : `0.${"0".repeat(scale - 1)}1`);

/**
 * `n / d` rounded half to even, for `d > 0` and any sign of `n`.
 *
 * The three facts: `q` is the truncated quotient, `r` the remainder, and the
 * decision compares `|r|` against `d - |r|` — below is down, above is away from
 * zero, and EQUAL is the tie, resolved by `q`'s parity so the even neighbour
 * wins.
 *
 * WHY `|r| vs d - |r|` AND NOT `2|r| vs d`. They decide identically (`|r| >
 * d - |r|` is `2|r| > d` rearranged), but the doubled form is the only one that
 * can leave the dialect's exact domain: `|r| < d`, so `d - |r|` is bounded by
 * the divisor while `2|r|` needs one digit MORE than it. That extra digit is
 * the whole domain on the two dialects with a finite one — a 65-digit MySQL
 * divisor doubles to 66, and an int64 count doubles past int64 — so the
 * comparison is written in the form that never widens.
 *
 * The sign of the step reads `r`, not `n`: the step is taken only when `r <> 0`
 * (`|r| > d - |r| >= 0`, or `|r| = d - |r|` which needs `r <> 0` for a non-zero
 * `d`), and a non-zero remainder has exactly the sign of the dividend. Reading
 * `r` keeps one fewer copy of `n` in the emitted statement.
 *
 * `d` MUST be positive. A negative divisor would flip which neighbour is
 * "away", so the callers below normalize the sign onto the numerator instead.
 */
export const halfEvenQuotient = (
  integers: ExactIntegerArithmetic,
  n: Sql,
  d: Sql
): Sql => {
  const q = integers.quotient(n, d);
  const r = integers.remainder(n, d);
  const parity = integers.remainder(q, sql.raw`2`);
  return sql`(${q} + (CASE WHEN ABS(${r}) > ${d} - ABS(${r}) OR (ABS(${r}) = ${d} - ABS(${r}) AND ${parity} <> 0) THEN (CASE WHEN ${r} < 0 THEN -1 ELSE 1 END) ELSE 0 END))`;
};

/**
 * `n` with the divisor's sign folded in, so the half-even rule always sees a
 * positive divisor. `n x sign(d)` and `|d|` name the same quotient as `n / d`.
 */
export const signedNumerator = (n: Sql, d: Sql): Sql =>
  sql`(CASE WHEN ${d} < 0 THEN -${n} ELSE ${n} END)`;

/**
 * `column = halfEven(column x by)` where the column holds the LOGICAL decimal
 * in a dialect whose exact decimal domain is UNBOUNDED — PostgreSQL's
 * `NUMERIC`, which computes an expression at whatever width the value needs.
 *
 * The rule is stated on the COEFFICIENT, so the product is scaled up by `10^s`
 * — leaving a value whose integer part is the answer's coefficient and whose
 * fraction is what has to be rounded away — rounded to an integer against a
 * divisor of one, and scaled back by one exact multiplication.
 *
 * The widest intermediate is `column x by x 10^s`, which needs `2p + s` digits.
 * That is why MySQL does NOT use this form: its exact domain stops at 65
 * digits, and past it MySQL rounds an over-scaled product to 30 fractional
 * digits or answers ZERO without a warning. MySQL spells the same rule in its
 * own bounded, coefficient-space form (`mysql-adapter.ts`); this one is
 * PostgreSQL's, where no such ceiling exists.
 */
export const logicalDecimalMultiply = (
  integers: ExactIntegerArithmetic,
  column: Sql,
  by: Sql,
  descriptor: DecimalDescriptor
): Sql => {
  const scaled = sql`(${column} * ${by} * ${scaleFactorSql(descriptor.scale)})`;
  const coefficient = halfEvenQuotient(integers, scaled, sql.raw`1`);
  return sql`${column} = ${coefficient} * ${scaleUnitSql(descriptor.scale)}`;
};

/**
 * `column = halfEven(column / by)` where the column holds the LOGICAL decimal
 * in an unbounded exact domain ({@link logicalDecimalMultiply}'s PostgreSQL).
 *
 * The quotient is never computed by the dialect's `/`: the answer's coefficient
 * is `halfEven((column x 10^s) / by)`, which is a quotient of an exact integer
 * by an exact decimal, so remainder and parity decide the last digit instead of
 * `div_precision_increment` or a numeric division's chosen scale.
 *
 * `by` is non-zero: division by canonical zero is refused before I/O, where the
 * operand's canonical text is still in hand (`set-builder.ts`).
 */
export const logicalDecimalDivide = (
  integers: ExactIntegerArithmetic,
  column: Sql,
  by: Sql,
  descriptor: DecimalDescriptor
): Sql => {
  const coefficient = halfEvenQuotient(
    integers,
    signedNumerator(sql`(${column} * ${scaleFactorSql(descriptor.scale)})`, by),
    sql`ABS(${by})`
  );
  return sql`${column} = ${coefficient} * ${scaleUnitSql(descriptor.scale)}`;
};

/**
 * The exact decimal average of a LOGICAL decimal column in an unbounded exact
 * domain ({@link logicalDecimalMultiply}'s PostgreSQL): the exact `SUM` over
 * `COUNT(column)`, quantized to the field's scale half to even.
 *
 * `COUNT(column)` counts NON-NULL values, which is what makes the empty and
 * all-null cases answer NULL rather than divide by zero: `SUM` of no non-null
 * rows is NULL, every operator below is null-strict, and the zero divisor is
 * therefore never reached with a non-null numerator.
 *
 * `AVG()` is deliberately unused. It is a double on SQLite, and on the other
 * two its result scale is the provider's choice rather than the field's.
 */
export const logicalDecimalAverage = (
  integers: ExactIntegerArithmetic,
  column: Sql,
  descriptor: DecimalDescriptor
): Sql => {
  const coefficient = halfEvenQuotient(
    integers,
    sql`(SUM(${column}) * ${scaleFactorSql(descriptor.scale)})`,
    sql`COUNT(${column})`
  );
  return sql`(${coefficient} * ${scaleUnitSql(descriptor.scale)})`;
};
