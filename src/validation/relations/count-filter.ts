// Count Filter Schema
// Schema for _count filtering - accepts true or { where: ... }

import type { RelationState } from "@schema/relation/types";
import v, { type V } from "@validation";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

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
      where: () => GetTargetSchemas<S>["core"]["where"];
    }>,
  ]
>;
export const countFilterFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  targetSchemas: T
): CountFilterSchema<S> => {
  return v.union([
    v.literal(true),
    v.object({
      where: () => targetSchemas().core.where,
    }),
  ]);
};
