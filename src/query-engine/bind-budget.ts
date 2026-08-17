import type { Sql } from "@sql";

export interface CompiledBindBudgetChunk {
  /** Inclusive semantic-item offset. */
  readonly start: number;
  /** Exclusive semantic-item offset. */
  readonly end: number;
  readonly statement: Sql;
}

/** Normalize one driver's optional bind declaration into verified capacity. */
export function normalizedBindParameterLimit(
  limit: unknown
): number | undefined {
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0
    ? limit
    : undefined;
}

/**
 * Compile the largest contiguous semantic-item ranges that fit a verified bind
 * budget. The compiled SQL is the meter; callers do not estimate binds from
 * item count or shape. `compile` must be monotonic for a growing prefix, as
 * INSERT value tuples and exact-key predicate lists are.
 *
 * Unknown capacity preserves the original one-statement shape. One item that
 * exceeds a known budget stays indivisible so the executor's final capacity
 * check can refuse it before I/O.
 */
export function compileBindBudgetChunks(
  itemCount: number,
  maxBindParametersPerStatement: number | undefined,
  compile: (start: number, end: number) => Sql
): CompiledBindBudgetChunk[] {
  if (itemCount === 0) return [];
  const whole = compile(0, itemCount);
  if (
    maxBindParametersPerStatement === undefined ||
    whole.values.length <= maxBindParametersPerStatement ||
    itemCount === 1
  ) {
    return [{ start: 0, end: itemCount, statement: whole }];
  }

  const chunks: CompiledBindBudgetChunk[] = [];
  let start = 0;
  while (start < itemCount) {
    let lower = start + 1;
    let upper = itemCount;
    let largest: CompiledBindBudgetChunk | undefined;
    while (lower <= upper) {
      const end = lower + Math.floor((upper - lower) / 2);
      const statement = compile(start, end);
      if (statement.values.length <= maxBindParametersPerStatement) {
        largest = { start, end, statement };
        lower = end + 1;
      } else {
        upper = end - 1;
      }
    }
    const chunk = largest ?? {
      start,
      end: start + 1,
      statement: compile(start, start + 1),
    };
    chunks.push(chunk);
    start = chunk.end;
  }
  return chunks;
}
