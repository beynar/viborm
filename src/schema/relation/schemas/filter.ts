// Relation Filter Schemas

import { v } from "@validation";
import type { RelationState } from "../types";
import { getTargetWhereSchema } from "./helpers";

/**
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null
 * Uses thunks for lazy evaluation to avoid circular reference issues
 */
export const toOneFilterFactory = <S extends RelationState>(state: S) => {
  return v.object({
    is: () =>
      v.maybeNullable(
        getTargetWhereSchema(state)(),
        state.optional as S["optional"] extends true ? true : false
      ),
    isNot: () =>
      v.maybeNullable(
        getTargetWhereSchema(state)(),
        state.optional as S["optional"] extends true ? true : false
      ),
  });
};

/**
 * To-many filter: { some?, every?, none? }
 * Uses thunks for lazy evaluation - getTargetWhereSchema already returns thunk
 */
export const toManyFilterFactory = <S extends RelationState>(state: S) => {
  // getTargetWhereSchema returns a thunk, so we return it directly as the entry value
  return v.object({
    some: getTargetWhereSchema(state),
    every: getTargetWhereSchema(state),
    none: getTargetWhereSchema(state),
  });
};
