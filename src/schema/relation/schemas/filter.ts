// Relation Filter Schemas

import {
  object,
  optional,
  partial,
  nullable,
} from "valibot";
import type { RelationState } from "../relation";
import {
  type AnyRelationSchema,
  getTargetWhereSchema,
} from "./helpers";

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

/**
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null
 */
export const toOneFilterFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const whereSchema = getTargetWhereSchema(state);

  return partial(
    object({
      is: state.optional
        ? optional(nullable(whereSchema))
        : optional(whereSchema),
      isNot: optional(whereSchema),
    })
  );
};

/**
 * To-many filter: { some?, every?, none? }
 */
export const toManyFilterFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const whereSchema = getTargetWhereSchema(state);

  return partial(
    object({
      some: optional(whereSchema),
      every: optional(whereSchema),
      none: optional(whereSchema),
    })
  );
};

