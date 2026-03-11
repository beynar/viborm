// Relation Filter Schemas

import type { RelationState } from "@schema/relation/types";
import { type V, v } from "@validation";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

/**
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null
 * Uses thunks for lazy evaluation to avoid circular reference issues
 */

export type ToOneFilterSchema<S extends RelationState> = V.Object<{
  is: () => V.MaybeNullable<
    GetTargetSchemas<S>["core"]["where"],
    S["optional"] extends true ? true : false
  >;
  isNot: () => V.MaybeNullable<
    GetTargetSchemas<S>["core"]["where"],
    S["optional"] extends true ? true : false
  >;
}>;
export const toOneFilterFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  targetSchemas: T
): ToOneFilterSchema<S> => {
  return v.object({
    is: () =>
      v.maybeNullable(
        targetSchemas().core.where,
        state.optional as S["optional"] extends true ? true : false
      ),
    isNot: () =>
      v.maybeNullable(
        targetSchemas().core.where,
        state.optional as S["optional"] extends true ? true : false
      ),
  });
};

/**
 * To-many filter: { some?, every?, none? }
 * Uses thunks for lazy evaluation - getTargetWhereSchema already returns thunk
 */

export type ToManyFilterSchema<S extends RelationState> = V.Object<{
  some: () => GetTargetSchemas<S>["core"]["where"];
  every: () => GetTargetSchemas<S>["core"]["where"];
  none: () => GetTargetSchemas<S>["core"]["where"];
}>;

export const toManyFilterFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  targetSchemas: T
): ToManyFilterSchema<S> => {
  return v.object({
    some: () => targetSchemas().core.where,
    every: () => targetSchemas().core.where,
    none: () => targetSchemas().core.where,
  });
};
