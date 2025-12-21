// Relation OrderBy Schemas

import {
  lazy,
  object,
  optional,
  union,
  literal,
} from "valibot";
import type { RelationState } from "../relation";
import { type AnyRelationSchema } from "./helpers";

// =============================================================================
// ORDER BY SCHEMAS
// =============================================================================

/**
 * To-one orderBy: nested orderBy from the related model's fields
 * e.g., orderBy: { author: { name: 'asc' } }
 */
export const toOneOrderByFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return lazy(() => state.getter()["~"].schemas?.orderBy);
};

/**
 * To-many orderBy: can order by _count aggregate
 * e.g., orderBy: { posts: { _count: 'desc' } }
 */
export const toManyOrderByFactory = <S extends RelationState>(
  _state: S
): AnyRelationSchema => {
  return object({
    _count: optional(union([literal("asc"), literal("desc")])),
  });
};

