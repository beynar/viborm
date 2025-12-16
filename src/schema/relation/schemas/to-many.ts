// To-Many relation schemas (oneToMany, manyToMany)

import {
  object,
  optional,
  boolean,
  union,
  partial,
  array,
  number,
} from "valibot";
import type { RelationState } from "../relation";
import type { AnyRelationSchema, RelationSchemas } from "./types";
import {
  getTargetWhereSchema,
  getTargetWhereUniqueSchema,
  getTargetCreateSchema,
  getTargetUpdateSchema,
  getTargetScalarCreateSchema,
  getTargetSelectSchema,
  getTargetIncludeSchema,
  getTargetOrderBySchema,
  singleOrArray,
  selectSchema,
} from "./common";

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/**
 * To-many include: true or { where?, orderBy?, take?, skip?, cursor?, select?, include? }
 */
export const toManyIncludeFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    boolean(),
    partial(
      object({
        where: optional(getTargetWhereSchema(state)),
        orderBy: optional(getTargetOrderBySchema(state)),
        take: optional(number()),
        skip: optional(number()),
        cursor: optional(getTargetWhereUniqueSchema(state)),
        select: optional(getTargetSelectSchema(state)),
        include: optional(getTargetIncludeSchema(state)),
      })
    ),
  ]);
};

// =============================================================================
// FILTER SCHEMA
// =============================================================================

/**
 * To-many filter: { some?, every?, none? }
 */
export const toManyFilterFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const whereSchema = getTargetWhereSchema(state);

  return partial(
    object({
      some: optional(whereSchema),
      every: optional(whereSchema),
      none: optional(whereSchema),
    })
  );
};

// =============================================================================
// CREATE SCHEMA
// =============================================================================

/**
 * To-many create: { create?, createMany?, connect?, connectOrCreate? }
 * All accept single or array, normalized to array
 */
export const toManyCreateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);
  const scalarCreateSchema = getTargetScalarCreateSchema(state);

  const connectOrCreateSchema = object({
    where: whereUniqueSchema,
    create: createSchema,
  });

  // createMany uses scalar-only data (no nested relations)
  const createManySchema = object({
    data: array(scalarCreateSchema),
    skipDuplicates: optional(boolean()),
  });

  return partial(
    object({
      create: optional(singleOrArray(createSchema)),
      createMany: optional(createManySchema),
      connect: optional(singleOrArray(whereUniqueSchema)),
      connectOrCreate: optional(singleOrArray(connectOrCreateSchema)),
    })
  );
};

// =============================================================================
// UPDATE SCHEMA
// =============================================================================

/**
 * To-many update: { create?, createMany?, connect?, disconnect?, set?, delete?, update?, updateMany?, deleteMany?, upsert?, connectOrCreate? }
 * Most operations accept single or array
 */
export const toManyUpdateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const updateSchema = getTargetUpdateSchema(state);
  const whereSchema = getTargetWhereSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);
  const scalarCreateSchema = getTargetScalarCreateSchema(state);

  const updateWithWhereSchema = object({
    where: whereUniqueSchema,
    data: updateSchema,
  });

  const updateManyWithWhereSchema = object({
    where: whereSchema,
    data: updateSchema,
  });

  const upsertSchema = object({
    where: whereUniqueSchema,
    create: createSchema,
    update: updateSchema,
  });

  const connectOrCreateSchema = object({
    where: whereUniqueSchema,
    create: createSchema,
  });

  // createMany uses scalar-only data (no nested relations)
  const createManySchema = object({
    data: array(scalarCreateSchema),
    skipDuplicates: optional(boolean()),
  });

  return partial(
    object({
      // Single or array operations
      create: optional(singleOrArray(createSchema)),
      createMany: optional(createManySchema),
      connect: optional(singleOrArray(whereUniqueSchema)),
      disconnect: optional(singleOrArray(whereUniqueSchema)),
      delete: optional(singleOrArray(whereUniqueSchema)),
      connectOrCreate: optional(singleOrArray(connectOrCreateSchema)),
      update: optional(singleOrArray(updateWithWhereSchema)),
      updateMany: optional(singleOrArray(updateManyWithWhereSchema)),
      deleteMany: optional(singleOrArray(whereSchema)),
      upsert: optional(singleOrArray(upsertSchema)),
      // Array-only operation
      set: optional(array(whereUniqueSchema)),
    })
  );
};

// =============================================================================
// SCHEMA BUNDLE
// =============================================================================

/**
 * Get all schemas for a to-many relation
 */
export const toManySchemas = <S extends RelationState>(
  state: S
): RelationSchemas => {
  return {
    filter: toManyFilterFactory(state),
    create: toManyCreateFactory(state),
    update: toManyUpdateFactory(state),
    select: selectSchema(state),
    include: toManyIncludeFactory(state),
  };
};
