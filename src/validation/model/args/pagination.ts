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
