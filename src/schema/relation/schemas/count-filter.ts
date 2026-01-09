// Count Filter Schema
// Schema for _count filtering - accepts true or { where: ... }

import v, { type V } from "@validation";
import type { RelationState } from "../types";
import { getTargetWhereSchema, type InferTargetSchema } from "./helpers";

/**
 * Count filter schema: true or { where: <filter> }
 *
 * Used in _count select to filter which related records to count.
 * - true: count all related records
 * - { where: ... }: count related records matching the filter
 */
export type CountFilterSchema<S extends RelationState> = V.Union<
  readonly [
    V.Literal<true>,
    V.Object<{
      where: () => InferTargetSchema<S, "where">;
    }>,
  ]
>;
export const countFilterFactory = <S extends RelationState>(
  state: S
): CountFilterSchema<S> => {
  return v.union([
    v.literal(true),
    v.object({
      where: getTargetWhereSchema(state),
    }),
  ]);
};
