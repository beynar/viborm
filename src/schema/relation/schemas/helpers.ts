// Relation Schema Helpers
// Common utilities and type helpers for relation schemas

import type { AnyModel } from "@schema/model";
import type { ModelSchemas } from "@schema/model/schemas/model-schemas";
import v, { type V, type VibSchema } from "@validation";
import type { RelationState } from "../types";

type TargetModel<S extends RelationState> = S["getter"] extends () => infer T
  ? T extends AnyModel
    ? T
    : never
  : never;

/** Infer a specific schema type from the target model */
export type InferTargetSchema<
  S extends RelationState,
  K extends keyof ModelSchemas<TargetModel<S>>,
> = TargetModel<S>["~"]["schemas"][K];

const getTargetSchemas = <
  S extends RelationState,
  K extends keyof ModelSchemas<TargetModel<S>>,
>(
  state: S,
  key: K
) => {
  return () => {
    const targetModel = state.getter() as AnyModel;
    return targetModel["~"].schemas[key] as InferTargetSchema<S, K>;
  };
};

// =============================================================================
// HELPER: Get target model schemas lazily
// =============================================================================

/**
 * Get the target model's where schema lazily
 */
export const getTargetWhereSchema = <S extends RelationState>(state: S) => {
  return getTargetSchemas(state, "where");
};

/**
 * Get the target model's whereUnique schema lazily
 */
export const getTargetWhereUniqueSchema = <S extends RelationState>(
  state: S
) => {
  return getTargetSchemas(state, "whereUnique");
};

/**
 * Get the target model's create schema lazily
 */
export const getTargetCreateSchema = <S extends RelationState>(state: S) => {
  return getTargetSchemas(state, "create");
};

/**
 * Get the target model's scalarCreate schema lazily (for createMany - no nested relations)
 */
export const getTargetScalarCreateSchema = <S extends RelationState>(
  state: S
) => {
  return getTargetSchemas(state, "scalarCreate");
};

/**
 * Get the target model's nestedScalarCreate schema lazily (for nested createMany - FK fields optional)
 */
export const getTargetNestedScalarCreateSchema = <S extends RelationState>(
  state: S
) => {
  return getTargetSchemas(state, "nestedScalarCreate");
};

/**
 * Get the target model's update schema lazily
 */
export const getTargetUpdateSchema = <S extends RelationState>(state: S) => {
  return getTargetSchemas(state, "update");
};

/**
 * Get the target model's select schema lazily
 */
export const getTargetSelectSchema = <S extends RelationState>(state: S) => {
  return getTargetSchemas(state, "select");
};

/**
 * Get the target model's include schema lazily
 */
export const getTargetIncludeSchema = <S extends RelationState>(state: S) => {
  return getTargetSchemas(state, "include");
};

/**
 * Get the target model's orderBy schema lazily
 */
export const getTargetOrderBySchema = <S extends RelationState>(state: S) => {
  return getTargetSchemas(state, "orderBy");
};

// =============================================================================
// HELPER: Normalize single value to array
// =============================================================================

export const singleOrArray = <S extends VibSchema>(
  schema: S
): V.SingleOrArray<S> => {
  return v.union([
    v.coerce(schema, (v: S[" vibInferred"]["1"]) => [v]),
    v.array(schema),
  ]);
};
