// Relation Update Schemas

import {
  object,
  optional,
  boolean,
  partial,
} from "valibot";
import type { RelationState } from "../relation";
import {
  type AnyRelationSchema,
  getTargetCreateSchema,
  getTargetUpdateSchema,
  getTargetWhereSchema,
  getTargetWhereUniqueSchema,
  singleOrArray,
} from "./helpers";

// =============================================================================
// UPDATE SCHEMAS
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

/**
 * To-many update: { create?, connect?, disconnect?, set?, delete?, update?, updateMany?, deleteMany?, upsert? }
 * Most operations accept single or array
 */
export const toManyUpdateFactory = <S extends RelationState>(
  state: S
): AnyRelationSchema => {
  const createSchema = getTargetCreateSchema(state);
  const updateSchema = getTargetUpdateSchema(state);
  const whereSchema = getTargetWhereSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

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

  return partial(
    object({
      // All operations accept single or array, normalized to array
      create: optional(singleOrArray(createSchema)),
      connect: optional(singleOrArray(whereUniqueSchema)),
      disconnect: optional(singleOrArray(whereUniqueSchema)),
      delete: optional(singleOrArray(whereUniqueSchema)),
      connectOrCreate: optional(singleOrArray(connectOrCreateSchema)),
      set: optional(singleOrArray(whereUniqueSchema)),
      update: optional(singleOrArray(updateWithWhereSchema)),
      updateMany: optional(singleOrArray(updateManyWithWhereSchema)),
      deleteMany: optional(singleOrArray(whereSchema)),
      upsert: optional(singleOrArray(upsertSchema)),
    })
  );
};

