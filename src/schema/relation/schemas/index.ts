// Relation Schema Factories
// Main entry point for relation schema generation

import type { RelationState } from "../relation";
import type { RelationSchemas } from "./types";
import { toOneSchemas } from "./to-one";
import { toManySchemas } from "./to-many";

// Re-export types
export type {
  AnyRelationSchema,
  RelationSchemas,
  ToOneSchemas,
  ToManySchemas,
  InferRelationSchemas,
  InferRelationInput,
} from "./types";

// Re-export common utilities (if needed externally)
export {
  getTargetWhereSchema,
  getTargetWhereUniqueSchema,
  getTargetCreateSchema,
  getTargetUpdateSchema,
  getTargetScalarCreateSchema,
  getTargetSelectSchema,
  getTargetIncludeSchema,
  getTargetOrderBySchema,
  ensureArray,
  singleOrArray,
  selectSchema,
} from "./common";

// Re-export to-one factories
export {
  toOneSchemas,
  toOneFilterFactory,
  toOneCreateFactory,
  toOneUpdateFactory,
  toOneIncludeFactory,
} from "./to-one";

// Re-export to-many factories
export {
  toManySchemas,
  toManyFilterFactory,
  toManyCreateFactory,
  toManyUpdateFactory,
  toManyIncludeFactory,
} from "./to-many";

/**
 * Get all schemas for a relation based on its type.
 * Automatically selects toOne or toMany factories based on relation type.
 */
export const getRelationSchemas = <S extends RelationState>(
  state: S
): RelationSchemas => {
  const isToMany = state.type === "manyToMany" || state.type === "oneToMany";
  return isToMany ? toManySchemas(state) : toOneSchemas(state);
};
