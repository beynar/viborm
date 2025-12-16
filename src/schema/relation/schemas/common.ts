// Common utilities for relation schemas

import { lazy, union, array, pipe, transform, boolean } from "valibot";
import type { RelationState } from "../relation";
import type { AnyRelationSchema } from "./types";

// =============================================================================
// TARGET MODEL SCHEMA GETTERS
// =============================================================================

/**
 * Get the target model's where schema lazily
 */
export const getTargetWhereSchema = (
  state: RelationState
): AnyRelationSchema => {
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
export const getTargetCreateSchema = (
  state: RelationState
): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.create;
  });
};

/**
 * Get the target model's update schema lazily
 */
export const getTargetUpdateSchema = (
  state: RelationState
): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.update;
  });
};

/**
 * Get the target model's scalar-only create schema lazily (for createMany)
 */
export const getTargetScalarCreateSchema = (
  state: RelationState
): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?._create?.scalar;
  });
};

/**
 * Get the target model's select schema lazily
 */
export const getTargetSelectSchema = (
  state: RelationState
): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.select;
  });
};

/**
 * Get the target model's include schema lazily
 */
export const getTargetIncludeSchema = (
  state: RelationState
): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.include;
  });
};

/**
 * Get the target model's orderBy schema lazily
 */
export const getTargetOrderBySchema = (
  state: RelationState
): AnyRelationSchema => {
  return lazy(() => {
    const targetModel = state.getter();
    return targetModel["~"].schemas?.orderBy;
  });
};

// =============================================================================
// ARRAY NORMALIZATION UTILITIES
// =============================================================================

/**
 * Ensure value is an array
 */
export const ensureArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

/**
 * Schema that accepts single or array, normalizes to array
 */
export const singleOrArray = (schema: AnyRelationSchema): AnyRelationSchema => {
  return pipe(union([schema, array(schema)]), transform(ensureArray));
};

// =============================================================================
// SHARED SELECT SCHEMA
// =============================================================================

/**
 * Select schema - simple boolean for both to-one and to-many
 */
export const selectSchema = <S extends RelationState>(
  _state: S
): AnyRelationSchema => {
  return boolean();
};
