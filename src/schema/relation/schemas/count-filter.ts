// Count Filter Schema
// Schema for _count filtering - accepts true or { where: ... }

import type { RelationState } from "../relation";
import { getTargetWhereSchema } from "./helpers";
import v from "../../../validation";

/**
 * Count filter schema: true or { where: <filter> }
 *
 * Used in _count select to filter which related records to count.
 * - true: count all related records
 * - { where: ... }: count related records matching the filter
 */
export const countFilterFactory = <S extends RelationState>(state: S) => {
  return v.union([
    v.literal(true),
    v.object({
      where: getTargetWhereSchema(state),
    }),
  ]);
};
