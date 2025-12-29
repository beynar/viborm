// Relation Schema Helpers
// Common utilities and type helpers for relation schemas

import {
  lazy,
  array,
  union,
  pipe,
  transform,
  type BaseSchema,
  type UnionSchema,
  type ArraySchema,
  type SchemaWithPipe,
  type ObjectSchema,
  type OptionalSchema,
  type NumberSchema,
  type StringSchema,
  type TransformAction,
  type BooleanSchema,
  LazySchema,
} from "valibot";
import type { RelationState } from "../relation";
import { AnyModel } from "@schema/model";
import v, { VibSchema } from "../../../validation";

// =============================================================================
// BASE TYPE HELPERS
// =============================================================================

export type AnyRelationSchema = BaseSchema<any, any, any>;

// =============================================================================
// TARGET MODEL TYPE INFERENCE
// =============================================================================

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

// =============================================================================
// SHARED FIELD TYPES (DRY)
// =============================================================================

/** Common fields for to-many operations: where, orderBy, take, skip */
export type ToManyBaseFields<S extends RelationState> = {
  where: OptionalSchema<InferTargetSchema<S, "where">, undefined>;
  orderBy: OptionalSchema<InferTargetSchema<S, "orderBy">, undefined>;
  take: OptionalSchema<NumberSchema<undefined>, undefined>;
  skip: OptionalSchema<NumberSchema<undefined>, undefined>;
};

/** Extended to-many fields including cursor for pagination */
export type ToManyPaginationFields<S extends RelationState> =
  ToManyBaseFields<S> & {
    cursor: OptionalSchema<StringSchema<undefined>, undefined>;
  };

/** Select/include fields for nested operations */
export type SelectIncludeFields<S extends RelationState> = {
  select: OptionalSchema<InferTargetSchema<S, "select">, undefined>;
  include: OptionalSchema<InferTargetSchema<S, "include">, undefined>;
};

/** Boolean to select transform pipe type */
export type BooleanToSelectPipe = SchemaWithPipe<
  readonly [BooleanSchema<undefined>, TransformAction<boolean, any>]
>;

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

/**
 * Type for schema that accepts single or array, normalizes to array
 */
export type SingleOrArraySchema<S extends AnyRelationSchema> = SchemaWithPipe<
  readonly [UnionSchema<[S, ArraySchema<S, undefined>], undefined>, ...any[]]
>;

export const singleOrArray = <S extends VibSchema>(schema: S) => {
  return v.union([
    v.coerce(schema, (v: S[" vibInferred"]["0"]) => [v]),
    v.array(schema),
  ]);
};
