import { createSchema, fail } from "../../primitives/helpers";
import { validateInteger } from "../../primitives/number";
import v, { type V } from "../../primitives/v";

export type PaginationTakeSchema = V.Integer;
export type PaginationSkipSchema = V.Schema<number, number>;

export const paginationTake = (): PaginationTakeSchema => v.integer();

function nonNegativeInteger(message: string): V.Schema<number, number> {
  return createSchema<number, number>("integer", (value) => {
    const result = validateInteger(value);
    if (result.issues) return result;
    return result.value < 0 ? fail(message) : result;
  });
}

export const paginationSkip = (): PaginationSkipSchema =>
  nonNegativeInteger("skip must be greater than or equal to 0");

export type BulkWriteLimitSchema = V.Schema<number, number>;

/**
 * `limit` on `updateMany` / `deleteMany` (Prisma 6.x): a cap on how MANY rows
 * the bulk write may affect. Non-negative — unlike `take`, a negative value has
 * no "from the other end" meaning here, because a bulk write has no `orderBy`
 * and therefore no ends. `0` is legal and means "affect nothing".
 */
export const bulkWriteLimit = (): BulkWriteLimitSchema =>
  nonNegativeInteger("limit must be greater than or equal to 0");
