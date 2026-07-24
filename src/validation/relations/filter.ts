// Relation Filter Schemas

import type { RelationState } from "@schema/relation/types";
import { type V, v } from "../primitives/v";
import { createSchema, fail, ok } from "../primitives/helpers";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

/**
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null, and the bare `null`
 * shorthand normalizes to `{ is: null }` (Prisma parity)
 * Uses thunks for lazy evaluation to avoid circular reference issues
 */

type NullToIsNull = V.Schema<null, { is: null }>;
const nullToIsNull: NullToIsNull = createSchema("object", (value) =>
  value === null ? ok({ is: null }) : fail("Expected object")
);

type ToOneFilterObjectSchema<S extends RelationState> = V.Object<{
  is: () => V.MaybeNullable<
    GetTargetSchemas<S>["core"]["where"],
    S["optional"] extends true ? true : false
  >;
  isNot: () => V.MaybeNullable<
    GetTargetSchemas<S>["core"]["where"],
    S["optional"] extends true ? true : false
  >;
}>;

export type ToOneFilterSchema<S extends RelationState> =
  S["optional"] extends true
    ? V.Union<readonly [NullToIsNull, ToOneFilterObjectSchema<S>]>
    : ToOneFilterObjectSchema<S>;

export const toOneFilterFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  targetSchemas: T
): ToOneFilterSchema<S> => {
  const filterObject = v.object({
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
  return (
    state.optional ? v.union([nullToIsNull, filterObject]) : filterObject
  ) as ToOneFilterSchema<S>;
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
  _state: S,
  targetSchemas: T
): ToManyFilterSchema<S> => {
  return v.object({
    some: () => targetSchemas().core.where,
    every: () => targetSchemas().core.where,
    none: () => targetSchemas().core.where,
  });
};
