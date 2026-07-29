/**
 * Decimal portability gate.
 *
 * A decimal is exact everywhere it is stored and read. It is exact everywhere
 * it is COMPARED FOR EQUALITY too, because values are canonicalized to a single
 * spelling before they are bound. What is not portable is ORDER and ARITHMETIC:
 * PostgreSQL's `numeric` and MySQL's `DECIMAL` do both exactly, and SQLite has
 * no exact decimal type to do either with — its `DECIMAL` is a spelling with
 * NUMERIC affinity, and any cast back out of the canonical TEXT column runs the
 * answer through an IEEE-754 double.
 *
 * So those operations are REFUSED on SQLite instead of being answered
 * approximately. A `gt` that quietly misses a row differing in the 20th digit
 * is worse than an error: the caller has no way to find out.
 *
 * The refusal has to sit at EVERY site that puts a decimal column into an
 * ORDER BY expression or into an ordered/derived aggregate, not just the
 * headline one — a gate present on `findMany({ orderBy })` but absent on
 * `findMany({ orderBy, take })` is worse than no gate, because it is the
 * paginated spelling that callers actually write.
 * `tests/query-engine/decimal-refusal-surface.test.ts` pins that by enumerating
 * the public SPELLINGS rather than the call sites: every one is asserted to
 * answer on PGlite and to refuse on SQLite3, so a new ordering path that skips
 * this gate fails there even though no call site was touched.
 */

import { UnsupportedOperationError } from "@errors";
import type { Model } from "@schema/model";
import type { QueryScope } from "../types";

/** True when `fieldName` is a non-list decimal scalar on the model. */
export function isDecimalScalar(model: Model<any>, fieldName: string): boolean {
  const state = model["~"].state.scalars[fieldName]?.["~"].state;
  return state?.type === "decimal" && state.array !== true;
}

/**
 * Refuse an ordered or derived decimal operation on a dialect with no exact
 * decimal type. Call it at the point that would otherwise emit the SQL.
 *
 * @param ctx - Query scope (its adapter declares `supportsExactDecimal`)
 * @param fieldName - The decimal field the operation targets
 * @param operation - What was asked for, spelled as the caller spelled it
 * @param fieldLabel - How to name the field back to the caller; defaults to
 *   `fieldName`, and carries the dotted path when the field is reached through
 *   a relation (`orderBy: { author: { fee: "asc" } }` names `author.fee`)
 */
export function assertExactDecimalOperation(
  ctx: QueryScope,
  fieldName: string,
  operation: string,
  fieldLabel: string = fieldName
): void {
  if (ctx.adapter.capabilities.supportsExactDecimal) return;
  if (!isDecimalScalar(ctx.model, fieldName)) return;
  throw new UnsupportedOperationError(
    `'${operation}' on decimal field '${fieldLabel}' is not supported on SQLite. ` +
      "SQLite has no exact decimal type, so ordering, aggregating or doing arithmetic " +
      "on a decimal would have to go through a 64-bit float and could answer wrongly " +
      "past ~15 significant digits — viborm refuses instead of answering approximately. " +
      "Reads, writes, and equality filters (equals/not/in/notIn) stay exact. " +
      "If approximate ordering is acceptable use s.float(); if you need exact ordered " +
      "money on SQLite, store scaled integers in an s.bigInt()."
  );
}

/**
 * The aggregates that need an exact decimal type to be exact.
 *
 * `_count` counts rows and is exact on any storage, so it is deliberately
 * absent: refusing it would be a false refusal.
 */
const ORDERED_AGGREGATE_KEYS = new Set(["_avg", "_sum", "_min", "_max"]);

/**
 * Refuse an aggregate over a decimal where the dialect has no exact decimal
 * type. `_count` passes; `_min`/`_max` are an ordering and `_sum`/`_avg` are
 * arithmetic, so all four are gated.
 *
 * @param ctx - Query scope (its adapter declares `supportsExactDecimal`)
 * @param fieldName - The field the aggregate is taken over
 * @param aggregateKey - The aggregate as the caller spelled it (`_sum`, …)
 */
export function assertExactDecimalAggregate(
  ctx: QueryScope,
  fieldName: string,
  aggregateKey: string
): void {
  if (!ORDERED_AGGREGATE_KEYS.has(aggregateKey)) return;
  assertExactDecimalOperation(ctx, fieldName, aggregateKey);
}
