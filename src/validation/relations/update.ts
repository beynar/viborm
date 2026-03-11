// Relation Update Schemas

import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { getInverseRelationFields as getInverseRelationFieldsRuntime } from "@schema/relation/types";
import v, { type V } from "@validation";
import type { CreateWithOmittedFk } from "./create";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";

// =============================================================================
// UPDATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one update: { create?, connect?, connectOrCreate?, update?, upsert?, disconnect?, delete? }
 * disconnect and delete only available for optional relations
 */

type ToOneUpdateSchemaBase<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<{
  create: () => CreateWithOmittedFk<S, Source>;
  connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
  connectOrCreate: V.Object<{
    where: () => GetTargetSchemas<S>["core"]["whereUnique"];
    create: () => CreateWithOmittedFk<S, Source>;
  }>;
  upsert: V.Object<{
    create: () => CreateWithOmittedFk<S, Source>;
    update: () => GetTargetSchemas<S>["core"]["update"];
  }>;
}>;

type ToOneUpdateSchemaOptional = V.Object<{
  disconnect: V.Boolean;
  delete: V.Boolean;
}>;

export type ToOneUpdateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = S["optional"] extends true
  ? V.Object<
      ToOneUpdateSchemaOptional["entries"] &
        ToOneUpdateSchemaBase<S, Source>["entries"]
    >
  : ToOneUpdateSchemaBase<S, Source>;

export const toOneUpdateFactory = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToOneUpdateSchema<S, Source> => {
  const getCreateSchema = () => {
    const fkFields = getInverseRelationFieldsRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  // connectOrCreate schema for connecting or creating if not exists
  const connectOrCreateSchema = v.object({
    where: () => targetSchemas().core.whereUnique,
    create: getCreateSchema,
  });

  const baseEntries = v.object({
    create: getCreateSchema,
    connect: () => targetSchemas().core.whereUnique,
    connectOrCreate: connectOrCreateSchema,
    update: () => targetSchemas().core.update,
    upsert: v.object({
      create: getCreateSchema,
      update: () => targetSchemas().core.update,
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

export type ToManyUpdateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<{
  create: () => V.SingleOrArray<CreateWithOmittedFk<S, Source>>;
  connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  disconnect: () => V.Union<
    readonly [
      V.Boolean,
      V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>,
    ]
  >;
  delete: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  connectOrCreate: V.SingleOrArray<
    V.Object<{
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => CreateWithOmittedFk<S, Source>;
    }>
  >;
  set: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  update: V.SingleOrArray<
    V.Object<{
      where: () => GetTargetSchemas<S>["core"]["where"];
      data: () => GetTargetSchemas<S>["core"]["update"];
    }>
  >;
  updateMany: V.SingleOrArray<
    V.Object<{
      where: () => GetTargetSchemas<S>["core"]["where"];
      data: () => GetTargetSchemas<S>["core"]["update"];
    }>
  >;
  deleteMany: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["where"]>;
  upsert: V.SingleOrArray<
    V.Object<{
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => CreateWithOmittedFk<S, Source>;
      update: () => GetTargetSchemas<S>["core"]["update"];
    }>
  >;
}>;

export const toManyUpdateFactory = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToManyUpdateSchema<S, Source> => {
  const getCreateSchema = () => {
    const fkFields = getInverseRelationFieldsRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  const updateWithWhereSchema = v.object({
    where: () => targetSchemas().core.whereUnique,
    data: () => targetSchemas().core.update,
  });

  const updateManyWithWhereSchema = v.object({
    where: () => targetSchemas().core.where,
    data: () => targetSchemas().core.update,
  });

  const upsertSchema = v.object({
    where: () => targetSchemas().core.whereUnique,
    create: getCreateSchema,
    update: () => targetSchemas().core.update,
  });

  const connectOrCreateSchema = v.object({
    where: () => targetSchemas().core.whereUnique,
    create: getCreateSchema,
  });

  return v.object({
    create: () => v.singleOrArray(getCreateSchema()),
    connect: () => v.singleOrArray(targetSchemas().core.whereUnique),
    disconnect: () =>
      v.union([v.boolean(), v.singleOrArray(targetSchemas().core.whereUnique)]),
    delete: () => v.singleOrArray(targetSchemas().core.whereUnique),
    connectOrCreate: v.singleOrArray(connectOrCreateSchema),
    set: () => v.singleOrArray(targetSchemas().core.whereUnique),
    update: v.singleOrArray(updateWithWhereSchema),
    updateMany: v.singleOrArray(updateManyWithWhereSchema),
    deleteMany: () => v.singleOrArray(targetSchemas().core.where),
    upsert: v.singleOrArray(upsertSchema),
  });
};
