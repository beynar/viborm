// Relation Schemas
// ArkType schemas for relation filters and mutations
// Uses lazy evaluation (callbacks) to prevent circular dependency errors

import { type, Type } from "arktype";

// =============================================================================
// RELATION FILTER SCHEMAS
// =============================================================================

/**
 * Creates a relation filter schema for "to-many" relations
 * Used for filtering records based on related records (some, every, none)
 * Uses lazy evaluation to prevent circular dependencies
 */
export const makeToManyRelationFilter = (getWhereSchema: () => Type) =>
  type({
    some: getWhereSchema,
    every: getWhereSchema,
    none: getWhereSchema,
  }).partial();

/**
 * Creates a relation filter schema for "to-one" relations
 * Used for filtering records based on a single related record (is, isNot)
 * Uses lazy evaluation to prevent circular dependencies
 * @param getWhereSchema - Callback returning the where schema
 * @param getNullableWhereSchema - Callback returning the nullable where schema (for is/isNot)
 */
export const makeToOneRelationFilter = (
  getWhereSchema: () => Type,
  getNullableWhereSchema: () => Type
) =>
  type({
    is: getNullableWhereSchema,
    isNot: getNullableWhereSchema,
  }).partial();

// =============================================================================
// RELATION MUTATION SCHEMAS (CREATE)
// =============================================================================

/**
 * Creates a relation create schema for "to-one" relations
 * Supports: connect, create, connectOrCreate
 * Uses lazy evaluation to prevent circular dependencies
 */
export const makeToOneRelationCreate = (
  getCreateSchema: () => Type,
  getWhereUniqueSchema: () => Type
) =>
  type({
    connect: getWhereUniqueSchema,
    create: getCreateSchema,
    connectOrCreate: () =>
      type({
        where: getWhereUniqueSchema(),
        create: getCreateSchema(),
      }),
  }).partial();

/**
 * Creates a relation create schema for "to-many" relations
 * Supports: connect (array), create (array), connectOrCreate (array)
 * Uses lazy evaluation to prevent circular dependencies
 */
export const makeToManyRelationCreate = (
  getCreateSchema: () => Type,
  getWhereUniqueSchema: () => Type
) =>
  type({
    connect: () => getWhereUniqueSchema().array(),
    create: () => getCreateSchema().array(),
    connectOrCreate: () =>
      type({
        where: getWhereUniqueSchema(),
        create: getCreateSchema(),
      }).array(),
  }).partial();

// =============================================================================
// RELATION MUTATION SCHEMAS (UPDATE)
// =============================================================================

/**
 * Creates a relation update schema for "to-one" relations
 * Supports: connect, disconnect, create, update, upsert, delete
 * Uses lazy evaluation to prevent circular dependencies
 */
export const makeToOneRelationUpdate = (
  getCreateSchema: () => Type,
  getUpdateSchema: () => Type,
  getWhereUniqueSchema: () => Type
) =>
  type({
    connect: getWhereUniqueSchema,
    disconnect: "boolean",
    create: getCreateSchema,
    update: getUpdateSchema,
    upsert: () =>
      type({
        create: getCreateSchema(),
        update: getUpdateSchema(),
      }),
    delete: "boolean",
  }).partial();

/**
 * Creates a relation update schema for "to-many" relations
 * Supports: connect, disconnect, create, update, upsert, delete, set, updateMany, deleteMany
 * Uses lazy evaluation to prevent circular dependencies
 */
export const makeToManyRelationUpdate = (
  getCreateSchema: () => Type,
  getUpdateSchema: () => Type,
  getWhereSchema: () => Type,
  getWhereUniqueSchema: () => Type
) =>
  type({
    connect: () => getWhereUniqueSchema().array(),
    disconnect: () => getWhereUniqueSchema().array(),
    create: () => getCreateSchema().array(),
    set: () => getWhereUniqueSchema().array(),
    update: () =>
      type({
        where: getWhereUniqueSchema(),
        data: getUpdateSchema(),
      }).array(),
    updateMany: () =>
      type({
        where: getWhereSchema(),
        data: getUpdateSchema(),
      }).array(),
    upsert: () =>
      type({
        where: getWhereUniqueSchema(),
        create: getCreateSchema(),
        update: getUpdateSchema(),
      }).array(),
    delete: () => getWhereUniqueSchema().array(),
    deleteMany: () => getWhereSchema().array(),
  }).partial();

// =============================================================================
// RELATION INCLUDE SCHEMAS
// =============================================================================

/**
 * Creates an include schema for a "to-one" relation
 * Uses lazy evaluation to prevent circular dependencies
 */
export const makeToOneRelationInclude = (
  getSelectSchema: () => Type,
  getIncludeSchema: () => Type
) =>
  type({
    select: getSelectSchema,
    include: getIncludeSchema,
  })
    .partial()
    .or("boolean");

/**
 * Creates an include schema for a "to-many" relation
 * Includes pagination options
 * Uses lazy evaluation to prevent circular dependencies
 */
export const makeToManyRelationInclude = (
  getSelectSchema: () => Type,
  getIncludeSchema: () => Type,
  getWhereSchema: () => Type,
  getOrderBySchema: () => Type
) =>
  type({
    select: getSelectSchema,
    include: getIncludeSchema,
    where: getWhereSchema,
    orderBy: getOrderBySchema,
    take: "number",
    skip: "number",
  })
    .partial()
    .or("boolean");
