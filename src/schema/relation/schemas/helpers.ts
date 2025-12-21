// Relation Schema Helpers
// Common utilities and type helpers for relation schemas

import {
  lazy,
  array,
  union,
  pipe,
  transform,
  type BaseSchema,
} from "valibot";
import type { RelationState } from "../relation";

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type AnyRelationSchema = BaseSchema<any, any, any>;

export interface RelationSchemas {
  filter: AnyRelationSchema;
  create: AnyRelationSchema;
  update: AnyRelationSchema;
  select: AnyRelationSchema;
  include: AnyRelationSchema;
  orderBy: AnyRelationSchema;
}

// =============================================================================
// HELPER: Get target model schemas lazily
// =============================================================================

/**
 * Get the target model's where schema lazily
 */
export const getTargetWhereSchema = (state: RelationState): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.where;
  });
};

/**
 * Get the target model's whereUnique schema lazily
 */
export const getTargetWhereUniqueSchema = (
  state: RelationState
): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.whereUnique;
  });
};

/**
 * Get the target model's create schema lazily
 */
export const getTargetCreateSchema = (state: RelationState): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.create;
  });
};

/**
 * Get the target model's update schema lazily
 */
export const getTargetUpdateSchema = (state: RelationState): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.update;
  });
};

// =============================================================================
// HELPER: Normalize single value to array
// =============================================================================

const ensureArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/**
 * Schema that accepts single or array, normalizes to array
 */
export const singleOrArray = (schema: AnyRelationSchema): AnyRelationSchema => {
  return pipe(union([schema, array(schema)]), transform(ensureArray));
};

