// Relation Schema Helpers
// Common utilities and type helpers for relation schemas
import type { RelationState } from "../relation";
import { AnyModel } from "@schema/model";
import v, { VibSchema } from "@validation";

type TargetModel<S extends RelationState> = S["getter"] extends () => infer T
  ? T extends AnyModel
    ? T
    : never
  : never;

/** Infer a specific schema type from the target model */
export type InferTargetSchema<
  S extends RelationState,
  K extends
    | "where"
    | "whereUnique"
    | "create"
    | "update"
    | "select"
    | "include"
    | "orderBy"
> = TargetModel<S>["~"]["schemas"][K];

const getTargetSchemas = <
  S extends RelationState,
  K extends
    | "where"
    | "whereUnique"
    | "create"
    | "update"
    | "select"
    | "include"
    | "orderBy"
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
  return () => {
    const targetModel = state.getter() as AnyModel;
    // scalarCreate is at _create.scalar in the schemas object
    return targetModel["~"].schemas._create.scalar;
  };
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

export const singleOrArray = <S extends VibSchema>(schema: S) => {
  return v.union([
    v.coerce(schema, (v: S[" vibInferred"]["0"]) => [v]),
    v.array(schema),
  ]);
};
