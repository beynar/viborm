// Relation Update Schemas

import type { RelationState } from "../relation";
import {
  getTargetCreateSchema,
  getTargetUpdateSchema,
  getTargetWhereSchema,
  getTargetWhereUniqueSchema,
  singleOrArray,
} from "./helpers";
import v from "@validation";

// =============================================================================
// UPDATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one update: { create?, connect?, connectOrCreate?, update?, upsert?, disconnect?, delete? }
 * disconnect and delete only available for optional relations
 */
export const toOneUpdateFactory = <S extends RelationState>(state: S) => {
  const createSchema = getTargetCreateSchema(state);
  const updateSchema = getTargetUpdateSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  // connectOrCreate schema for connecting or creating if not exists
  const connectOrCreateSchema = v.object({
    where: whereUniqueSchema,
    create: createSchema,
  });

  const baseEntries = v.object({
    create: createSchema,
    connect: whereUniqueSchema,
    connectOrCreate: connectOrCreateSchema,
    update: updateSchema,
    upsert: v.object({
      create: createSchema,
      update: updateSchema,
    }),
  });

  const optionalEntries = baseEntries.extend({
    disconnect: v.boolean(),
    delete: v.boolean(),
  });

  return (
    state.optional ? optionalEntries : baseEntries
  ) as S["optional"] extends true ? typeof optionalEntries : typeof baseEntries;
};

/**
 * To-many update: { create?, connect?, disconnect?, set?, delete?, update?, updateMany?, deleteMany?, upsert? }
 * Most operations accept single or array
 */
export const toManyUpdateFactory = <S extends RelationState>(state: S) => {
  const createSchema = getTargetCreateSchema(state);
  const updateSchema = getTargetUpdateSchema(state);
  const whereSchema = getTargetWhereSchema(state);
  const whereUniqueSchema = getTargetWhereUniqueSchema(state);

  const updateWithWhereSchema = v.object({
    where: whereUniqueSchema,
    data: updateSchema,
  });

  const updateManyWithWhereSchema = v.object({
    where: whereSchema,
    data: updateSchema,
  });

  const upsertSchema = v.object({
    where: whereUniqueSchema,
    create: createSchema,
    update: updateSchema,
  });

  const connectOrCreateSchema = v.object({
    where: whereUniqueSchema,
    create: createSchema,
  });

  return v.object({
    create: () => singleOrArray(createSchema()),
    connect: () => singleOrArray(whereUniqueSchema()),
    disconnect: () =>
      v.union([v.boolean(), singleOrArray(whereUniqueSchema())]),
    delete: () => singleOrArray(whereUniqueSchema()),
    connectOrCreate: singleOrArray(connectOrCreateSchema),
    set: () => singleOrArray(whereUniqueSchema()),
    update: singleOrArray(updateWithWhereSchema),
    updateMany: singleOrArray(updateManyWithWhereSchema),
    deleteMany: () => singleOrArray(whereSchema()),
    upsert: singleOrArray(upsertSchema),
  });
};
