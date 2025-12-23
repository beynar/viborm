// Relation Filter Schemas

import {
  object,
  optional,
  partial,
  nullable,
  type ObjectSchema,
  type OptionalSchema,
  type NullableSchema,
} from "valibot";
import type { RelationState } from "../relation";
import { type InferTargetSchema, getTargetWhereSchema } from "./helpers";
import { AnySchema } from "@schema/fields/common";

// =============================================================================
// FILTER SCHEMA TYPES (exported for consumer use)
// =============================================================================

type MaybeNullableSchema<
  T extends AnySchema,
  S extends RelationState
> = S["optional"] extends true ? NullableSchema<T, undefined> : T;

export type ToOneFilterSchema<S extends RelationState> = ObjectSchema<
  {
    is: OptionalSchema<
      MaybeNullableSchema<InferTargetSchema<S, "where">, S>,
      undefined
    >;
    isNot: OptionalSchema<InferTargetSchema<S, "where">, undefined>;
  },
  undefined
>;

// =============================================================================
// FILTER FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null
 */
export const toOneFilterFactory = <S extends RelationState>(state: S) => {
  const whereSchema = getTargetWhereSchema(state);

  const schema = partial(
    object({
      is: state.optional
        ? optional(nullable(whereSchema))
        : optional(whereSchema),
      isNot: optional(whereSchema),
    })
  );

  return schema as ToOneFilterSchema<S>;
};

/**
 * To-many filter: { some?, every?, none? }
 */
export const toManyFilterFactory = <S extends RelationState>(state: S) => {
  const whereSchema = getTargetWhereSchema(state);

  // Type flows through from getTargetWhereSchema
  return partial(
    object({
      some: optional(whereSchema),
      every: optional(whereSchema),
      none: optional(whereSchema),
    })
  );
};
