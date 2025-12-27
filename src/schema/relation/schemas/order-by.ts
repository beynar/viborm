// Relation OrderBy Schemas

import {
  object,
  optional,
  union,
  literal,
  type ObjectSchema,
  type OptionalSchema,
  type UnionSchema,
  type LiteralSchema,
} from "valibot";
import type { RelationState } from "../relation";
import { type InferTargetSchema, getTargetOrderBySchema } from "./helpers";
import v from "../../../validation";

// =============================================================================
// ORDER BY SCHEMA TYPES (exported for consumer use)
// =============================================================================

// =============================================================================
// ORDER BY FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one orderBy: nested orderBy from the related model's fields
 * e.g., orderBy: { author: { name: 'asc' } }
 */
export const toOneOrderByFactory = <S extends RelationState>(state: S) => {
  return getTargetOrderBySchema(state);
};

/**
 * To-many orderBy: can order by _count aggregate
 * e.g., orderBy: { posts: { _count: 'desc' } }
 */
export const toManyOrderByFactory = <S extends RelationState>(_state: S) => {
  return v.object({
    _count: v.enum(["asc", "desc"]),
  });
};
