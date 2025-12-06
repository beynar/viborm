// Mutation Schema Builders
// Builds runtime ArkType schemas for mutation operation arguments
// Note: Return types use Type without generic since these are runtime schemas

import { type, Type } from "arktype";
import type { Model } from "../model";
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
export const buildCreateArgsSchema = (model: Model<any>): Type => {
  const createSchema = buildCreateSchema(model);
  const selectSchema = buildSelectSchema(model);
  const includeSchema = buildIncludeSchema(model);

  const shape: Record<string, Type> = {
    data: createSchema,
    "select?": selectSchema,
    "include?": includeSchema,
  };

  return type(shape);
};

/**
 * Builds an update args schema
 */
export const buildUpdateArgsSchema = (model: Model<any>): Type => {
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

  return type(shape);
};

/**
 * Builds an updateMany args schema
 */
export const buildUpdateManyArgsSchema = (model: Model<any>): Type => {
  const whereSchema = buildWhereSchema(model);
  const updateSchema = buildUpdateSchema(model);

  const shape: Record<string, Type> = {
    "where?": whereSchema,
    data: updateSchema,
  };

  return type(shape);
};

/**
 * Builds a delete args schema
 */
export const buildDeleteArgsSchema = (model: Model<any>): Type => {
  const whereUniqueSchema = buildWhereUniqueSchema(model);
  const selectSchema = buildSelectSchema(model);
  const includeSchema = buildIncludeSchema(model);

  const shape: Record<string, Type> = {
    where: whereUniqueSchema,
    "select?": selectSchema,
    "include?": includeSchema,
  };

  return type(shape);
};

/**
 * Builds a deleteMany args schema
 */
export const buildDeleteManyArgsSchema = (model: Model<any>): Type => {
  const whereSchema = buildWhereSchema(model);

  const shape: Record<string, Type> = {
    "where?": whereSchema,
  };

  return type(shape);
};

/**
 * Builds an upsert args schema
 */
export const buildUpsertArgsSchema = (model: Model<any>): Type => {
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

  return type(shape);
};
