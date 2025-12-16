// To-One relation schemas (oneToOne, manyToOne)

import { object, optional, boolean, union, partial, nullable } from "valibot";
import type { RelationState } from "../relation";
import type { AnyRelationSchema, RelationSchemas } from "./types";
import {
  getTargetWhereSchema,
  getTargetWhereUniqueSchema,
  getTargetCreateSchema,
  getTargetUpdateSchema,
  getTargetSelectSchema,
  getTargetIncludeSchema,
  selectSchema,
} from "./common";

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/**
 * To-one include: true or { select?, include? }
 */
export const toOneIncludeFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  return union([
    boolean(),
    partial(
      object({
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
 * To-one filter: { is?, isNot? }
 * For optional relations, `is` can also be null
 */
export const toOneFilterFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const whereSchema = getTargetWhereSchema(state);

  return partial(
    object({
      is: state.optional
        ? optional(nullable(whereSchema))
        : optional(whereSchema),
      isNot: optional(whereSchema),
    })
  );
};

// =============================================================================
// CREATE SCHEMA
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
export const toOneCreateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  return partial(
    object({
      create: optional(createSchema),
      connect: optional(whereUniqueSchema),
      connectOrCreate: optional(
        object({
          where: whereUniqueSchema,
          create: createSchema,
        })
      ),
    })
  );
};

// =============================================================================
// UPDATE SCHEMA
// =============================================================================

/**
 * To-one update: { create?, connect?, update?, upsert?, disconnect?, delete? }
 * disconnect and delete only available for optional relations
 */
export const toOneUpdateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const updateSchema = getTargetUpdateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  const baseEntries = {
    create: optional(createSchema),
    connect: optional(whereUniqueSchema),
    update: optional(updateSchema),
    upsert: optional(
      object({
        create: createSchema,
        update: updateSchema,
      })
    ),
  };

  // Optional relations can disconnect/delete
  if (state.optional) {
    return partial(
      object({
        ...baseEntries,
        disconnect: optional(boolean()),
        delete: optional(boolean()),
      })
    );
  }

  return partial(object(baseEntries));
};

// =============================================================================
// SCHEMA BUNDLE
// =============================================================================

/**
 * Get all schemas for a to-one relation
 */
export const toOneSchemas = <S extends RelationState>(
  state: S
): RelationSchemas => {
  return {
    filter: toOneFilterFactory(state),
    create: toOneCreateFactory(state),
    update: toOneUpdateFactory(state),
    select: selectSchema(state),
    include: toOneIncludeFactory(state),
  };
};
