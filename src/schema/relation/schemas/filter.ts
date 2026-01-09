// Relation Filter Schemas

import { type V, v } from "@validation";
import type { RelationState } from "../types";
import { getTargetWhereSchema, type InferTargetSchema } from "./helpers";

/**
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null
 * Uses thunks for lazy evaluation to avoid circular reference issues
 */

export type ToOneFilterSchema<S extends RelationState> = V.Object<{
  is: () => V.MaybeNullable<
    InferTargetSchema<S, "where">,
    S["optional"] extends true ? true : false
  >;
  isNot: () => V.MaybeNullable<
    InferTargetSchema<S, "where">,
    S["optional"] extends true ? true : false
  >;
}>;
export const toOneFilterFactory = <S extends RelationState>(
  state: S
): ToOneFilterSchema<S> => {
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

export type ToManyFilterSchema<S extends RelationState> = V.Object<{
  some: () => V.MaybeNullable<
    InferTargetSchema<S, "where">,
    S["optional"] extends true ? true : false
  >;
  every: () => V.MaybeNullable<
    InferTargetSchema<S, "where">,
    S["optional"] extends true ? true : false
  >;
  none: () => V.MaybeNullable<
    InferTargetSchema<S, "where">,
    S["optional"] extends true ? true : false
  >;
}>;

export const toManyFilterFactory = <S extends RelationState>(
  state: S
): ToManyFilterSchema<S> => {
  // getTargetWhereSchema returns a thunk, so we return it directly as the entry value
  return v.object({
    some: getTargetWhereSchema(state),
    every: getTargetWhereSchema(state),
    none: getTargetWhereSchema(state),
  });
};
