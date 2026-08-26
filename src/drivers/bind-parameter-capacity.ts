import { UnsupportedOperationError } from "@errors";
import type { Sql } from "@sql";

/** Normalize one driver's optional bind declaration into verified capacity. */
export function normalizedBindParameterLimit(
  limit: unknown
): number | undefined {
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0
    ? limit
    : undefined;
}

/** Refuse one materialized statement before it reaches provider I/O. */
export function assertStatementBindParameterCapacity(
  statement: Sql,
  driverName: string,
  limit: number | undefined,
  subject: string
): void {
  if (limit === undefined || statement.values.length <= limit) return;
  throw new UnsupportedOperationError(
    `Driver '${driverName}' cannot execute this ${subject} because one indivisible statement needs ${statement.values.length} bound values, above the verified limit of ${limit}.`
  );
}
