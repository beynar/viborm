import v, { type V } from "../../primitives/v";

export type PaginationTakeSchema = V.Integer;
export type PaginationSkipSchema = V.Schema<number, number>;

export const paginationTake = (): PaginationTakeSchema => v.integer();

export const paginationSkip = (): PaginationSkipSchema =>
  v.pipe(
    v.integer(),
    v.transformAction<number, number>((skip) => {
      if (skip < 0) {
        throw new Error("skip must be greater than or equal to 0");
      }
      return skip;
    })
  );

export type BulkWriteLimitSchema = V.Schema<number, number>;

/**
 * `limit` on `updateMany` / `deleteMany` (Prisma 6.x): a cap on how MANY rows
 * the bulk write may affect. Non-negative — unlike `take`, a negative value has
 * no "from the other end" meaning here, because a bulk write has no `orderBy`
 * and therefore no ends. `0` is legal and means "affect nothing".
 */
export const bulkWriteLimit = (): BulkWriteLimitSchema =>
  v.pipe(
    v.integer(),
    v.transformAction<number, number>((limit) => {
      if (limit < 0) {
        throw new Error("limit must be greater than or equal to 0");
      }
      return limit;
    })
  );
