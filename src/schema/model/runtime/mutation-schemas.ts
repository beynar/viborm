// Mutation Schema Builders
// Builds runtime ArkType schemas for mutation operation arguments

import { type, Type } from "arktype";
import type { Model } from "../model";
import type {
  FieldRecord,
  ModelCreateArgs,
  ModelUpdateArgs,
  ModelUpdateManyArgs,
  ModelDeleteArgs,
  ModelDeleteManyArgs,
  ModelUpsertArgs,
} from "../types";
import {
  buildWhereSchema,
  buildWhereUniqueSchema,
  buildCreateSchema,
  buildUpdateSchema,
  buildSelectSchema,
  buildIncludeSchema,
} from "./core-schemas";

// =============================================================================
// MUTATION OPERATION SCHEMA BUILDERS
// =============================================================================

/**
 * Builds a create args schema
 */
export const buildCreateArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelCreateArgs<TFields>> => {
  const createSchema = buildCreateSchema(model);
  const selectSchema = buildSelectSchema(model);
  const includeSchema = buildIncludeSchema(model);

  const shape: Record<string, Type> = {
    data: createSchema,
    "select?": selectSchema,
    "include?": includeSchema,
  };

  return type(shape) as unknown as Type<ModelCreateArgs<TFields>>;
};

/**
 * Builds an update args schema
 */
export const buildUpdateArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelUpdateArgs<TFields>> => {
  const whereUniqueSchema = buildWhereUniqueSchema(model);
  const updateSchema = buildUpdateSchema(model);
  const selectSchema = buildSelectSchema(model);
  const includeSchema = buildIncludeSchema(model);

  const shape: Record<string, Type> = {
    where: whereUniqueSchema,
    data: updateSchema,
    "select?": selectSchema,
    "include?": includeSchema,
  };

  return type(shape) as unknown as Type<ModelUpdateArgs<TFields>>;
};

/**
 * Builds an updateMany args schema
 */
export const buildUpdateManyArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelUpdateManyArgs<TFields>> => {
  const whereSchema = buildWhereSchema(model);
  const updateSchema = buildUpdateSchema(model);

  const shape: Record<string, Type> = {
    "where?": whereSchema,
    data: updateSchema,
  };

  return type(shape) as unknown as Type<ModelUpdateManyArgs<TFields>>;
};

/**
 * Builds a delete args schema
 */
export const buildDeleteArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelDeleteArgs<TFields>> => {
  const whereUniqueSchema = buildWhereUniqueSchema(model);
  const selectSchema = buildSelectSchema(model);
  const includeSchema = buildIncludeSchema(model);

  const shape: Record<string, Type> = {
    where: whereUniqueSchema,
    "select?": selectSchema,
    "include?": includeSchema,
  };

  return type(shape) as unknown as Type<ModelDeleteArgs<TFields>>;
};

/**
 * Builds a deleteMany args schema
 */
export const buildDeleteManyArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelDeleteManyArgs<TFields>> => {
  const whereSchema = buildWhereSchema(model);

  const shape: Record<string, Type> = {
    "where?": whereSchema,
  };

  return type(shape) as unknown as Type<ModelDeleteManyArgs<TFields>>;
};

/**
 * Builds an upsert args schema
 */
export const buildUpsertArgsSchema = <TFields extends FieldRecord>(
  model: Model<TFields>
): Type<ModelUpsertArgs<TFields>> => {
  const whereUniqueSchema = buildWhereUniqueSchema(model);
  const createSchema = buildCreateSchema(model);
  const updateSchema = buildUpdateSchema(model);
  const selectSchema = buildSelectSchema(model);
  const includeSchema = buildIncludeSchema(model);

  const shape: Record<string, Type> = {
    where: whereUniqueSchema,
    create: createSchema,
    update: updateSchema,
    "select?": selectSchema,
    "include?": includeSchema,
  };

  return type(shape) as unknown as Type<ModelUpsertArgs<TFields>>;
};

