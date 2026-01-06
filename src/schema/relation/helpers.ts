// Relation Helpers
// Junction table utility functions for many-to-many relations

import type { ManyToManyRelationState, RelationState } from "./types";

// =============================================================================
// JUNCTION TABLE HELPERS
// =============================================================================

/** Any object with ["~"].state matching RelationState */
type RelationLike = { "~": { state: RelationState } };

/**
 * Generate a junction table name from two model names
 * Names are sorted alphabetically and joined with underscore
 *
 * @example
 * generateJunctionTableName("post", "tag") // "post_tag"
 * generateJunctionTableName("user", "role") // "role_user"
 */
export function generateJunctionTableName(
  model1: string,
  model2: string
): string {
  const names = [model1.toLowerCase(), model2.toLowerCase()].sort();
  return `${names[0]}_${names[1]}`;
}

/**
 * Generate a junction field name from a model name
 *
 * @example
 * generateJunctionFieldName("post") // "postId"
 * generateJunctionFieldName("User") // "userId"
 */
export function generateJunctionFieldName(modelName: string): string {
  return `${modelName.toLowerCase()}Id`;
}

/**
 * Get the junction table name for a many-to-many relation
 * Uses explicit .through() value if set, otherwise generates from model names
 */
export function getJunctionTableName(
  relation: RelationLike,
  sourceModelName: string,
  targetModelName: string
): string {
  const state = relation["~"].state;
  if (state.type === "manyToMany" && state.through) {
    return state.through;
  }
  return generateJunctionTableName(sourceModelName, targetModelName);
}

/**
 * Get the junction field names for a many-to-many relation
 * Returns [sourceFieldName, targetFieldName]
 * Uses explicit .A()/.B() values if set, otherwise generates from model names
 */
export function getJunctionFieldNames(
  relation: RelationLike,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  const state = relation["~"].state as ManyToManyRelationState;
  const sourceFieldName = state.A || generateJunctionFieldName(sourceModelName);
  const targetFieldName = state.B || generateJunctionFieldName(targetModelName);
  return [sourceFieldName, targetFieldName];
}
