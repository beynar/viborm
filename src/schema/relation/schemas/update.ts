// Relation Update Schemas

import v, { type V } from "@validation";
import type { RelationState } from "../types";
import {
  getTargetCreateSchema,
  getTargetUpdateSchema,
  getTargetWhereSchema,
  getTargetWhereUniqueSchema,
  type InferTargetSchema,
  singleOrArray,
} from "./helpers";

// =============================================================================
// UPDATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one update: { create?, connect?, connectOrCreate?, update?, upsert?, disconnect?, delete? }
 * disconnect and delete only available for optional relations
 */

type ToOneUpdateSchemaBase<S extends RelationState> = V.Object<{
  create: () => InferTargetSchema<S, "create">;
  connect: () => InferTargetSchema<S, "whereUnique">;
  connectOrCreate: V.Object<{
    where: () => InferTargetSchema<S, "whereUnique">;
    create: () => InferTargetSchema<S, "create">;
  }>;
}>;
type ToOneUpdateSchemaOptional<S extends RelationState> = V.Object<{
  disconnect: V.Boolean;
  delete: V.Boolean;
}>;

type ToOneUpdateSchema<S extends RelationState> = S["optional"] extends true
  ? V.Object<
      ToOneUpdateSchemaOptional<S>["entries"] &
        ToOneUpdateSchemaBase<S>["entries"]
    >
  : ToOneUpdateSchemaBase<S>;

export const toOneUpdateFactory = <S extends RelationState>(
  state: S
): ToOneUpdateSchema<S> => {
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

type ToManyUpdateSchema<S extends RelationState> = V.Object<{
  create: () => V.SingleOrArray<InferTargetSchema<S, "create">>;
  connect: () => V.SingleOrArray<InferTargetSchema<S, "whereUnique">>;
  disconnect: () => V.Union<
    readonly [V.Boolean, V.SingleOrArray<InferTargetSchema<S, "whereUnique">>]
  >;
  delete: () => V.SingleOrArray<InferTargetSchema<S, "whereUnique">>;
  connectOrCreate: V.SingleOrArray<
    V.Object<{
      where: () => InferTargetSchema<S, "whereUnique">;
      create: () => InferTargetSchema<S, "create">;
    }>
  >;
  set: () => V.SingleOrArray<InferTargetSchema<S, "whereUnique">>;
  update: V.SingleOrArray<
    V.Object<{
      where: () => InferTargetSchema<S, "where">;
      data: () => InferTargetSchema<S, "update">;
    }>
  >;
  updateMany: V.SingleOrArray<
    V.Object<{
      where: () => InferTargetSchema<S, "where">;
      data: () => InferTargetSchema<S, "update">;
    }>
  >;
  deleteMany: () => V.SingleOrArray<InferTargetSchema<S, "where">>;
  upsert: V.SingleOrArray<
    V.Object<{
      where: () => InferTargetSchema<S, "whereUnique">;
      create: () => InferTargetSchema<S, "create">;
      update: () => InferTargetSchema<S, "update">;
    }>
  >;
}>;
export const toManyUpdateFactory = <S extends RelationState>(
  state: S
): ToManyUpdateSchema<S> => {
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
