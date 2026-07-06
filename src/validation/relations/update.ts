// Relation Update Schemas

import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { getInverseRelationMap as getInverseRelationMapRuntime } from "@schema/relation/types";
import v, { type V } from "../primitives/v";
import type { ScalarSchemas } from "../model";
import { getNestedScalarCreateWithOmittedRequiredKeys } from "../model/core/create";
import type {
  CreateManyDataSchema,
  CreateWithOmittedFk,
  InverseRequiredKeys,
} from "./create";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";

// =============================================================================
// UPDATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one update: { create?, connect?, connectOrCreate?, update?, upsert?, disconnect?, delete? }
 * disconnect and delete only available for optional relations.
 */

type ToOneUpdateSchemaBase<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<{
  create: () => CreateWithOmittedFk<S, Source>;
  connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
  connectOrCreate: V.Object<
    {
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => CreateWithOmittedFk<S, Source>;
    },
    { partial: false }
  >;
  update: () => GetTargetSchemas<S>["core"]["update"];
  upsert: V.Object<
    {
      create: () => CreateWithOmittedFk<S, Source>;
      update: () => GetTargetSchemas<S>["core"]["update"];
    },
    { partial: false }
  >;
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
    const fkFields = getInverseRelationMapRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  const connectOrCreateSchema = v.object(
    {
      where: () => targetSchemas().core.whereUnique,
      create: getCreateSchema,
    },
    { partial: false }
  );

  const upsertSchema = v.object(
    {
      create: getCreateSchema,
      update: () => targetSchemas().core.update,
    },
    { partial: false }
  );

  const baseEntries = v.object({
    create: getCreateSchema,
    connect: () => targetSchemas().core.whereUnique,
    connectOrCreate: connectOrCreateSchema,
    update: () => targetSchemas().core.update,
    upsert: upsertSchema,
  });

  const optionalEntries = baseEntries.extend({
    disconnect: v.boolean(),
    delete: v.boolean(),
  });

  return (state.optional
    ? optionalEntries
    : baseEntries) as unknown as ToOneUpdateSchema<S, Source>;
};

/**
 * To-many update: {
 *   create?, createMany?, connect?, disconnect?, delete?,
 *   connectOrCreate?, set?, update?, updateMany?, upsert?, deleteMany?
 * }
 * Most operations accept single or array.
 */

export type ToManyUpdateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<{
  create: () => V.SingleOrArray<CreateWithOmittedFk<S, Source>>;
  createMany: V.Object<
    {
      data: () => V.Array<CreateManyDataSchema<S, Source>>;
      skipDuplicates: V.Boolean<{ optional: true }>;
    },
    { atLeast: ["data"] }
  >;
  connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  disconnect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  delete: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  connectOrCreate: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUnique"];
        create: () => CreateWithOmittedFk<S, Source>;
      },
      { partial: false }
    >
  >;
  set: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  update: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUnique"];
        data: () => GetTargetSchemas<S>["core"]["update"];
      },
      { atLeast: ["where", "data"] }
    >
  >;
  updateMany: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["where"];
        data: () => GetTargetSchemas<S>["core"]["update"];
      },
      { atLeast: ["data"] }
    >
  >;
  upsert: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUnique"];
        create: () => CreateWithOmittedFk<S, Source>;
        update: () => GetTargetSchemas<S>["core"]["update"];
      },
      { partial: false }
    >
  >;
  deleteMany: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["where"]>;
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
    const fkFields = getInverseRelationMapRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  const getCreateManyDataSchema = (): CreateManyDataSchema<S, Source> => {
    const targetModel = state.getter() as TargetModel<S>;
    const fkFields = (getInverseRelationMapRuntime(state, source) ??
      []) as InverseRequiredKeys<S, Source>;
    const schemas = targetSchemas();
    return getNestedScalarCreateWithOmittedRequiredKeys<
      TargetModel<S>,
      ScalarSchemas<TargetModel<S>>,
      InverseRequiredKeys<S, Source>
    >(
      targetModel,
      {
        scalars: schemas.scalars,
        relations: schemas.relations,
      },
      fkFields
    );
  };

  const connectOrCreateSchema = v.object(
    {
      where: () => targetSchemas().core.whereUnique,
      create: getCreateSchema,
    },
    { partial: false }
  );

  const updateSchema = v.object(
    {
      where: () => targetSchemas().core.whereUnique,
      data: () => targetSchemas().core.update,
    },
    { atLeast: ["where", "data"] }
  );

  const updateManySchema = v.object(
    {
      where: () => targetSchemas().core.where,
      data: () => targetSchemas().core.update,
    },
    { atLeast: ["data"] }
  );

  const upsertSchema = v.object(
    {
      where: () => targetSchemas().core.whereUnique,
      create: getCreateSchema,
      update: () => targetSchemas().core.update,
    },
    { partial: false }
  );

  return v.object({
    create: () => v.singleOrArray(getCreateSchema()),
    createMany: v.object(
      {
        data: () => v.array(getCreateManyDataSchema()),
        skipDuplicates: v.boolean({ optional: true }),
      },
      { atLeast: ["data"] }
    ),
    connect: () => v.singleOrArray(targetSchemas().core.whereUnique),
    // Prisma parity: boolean disconnect is a to-one concept; on to-many it
    // would silently wipe every association, so it is rejected here.
    disconnect: () => v.singleOrArray(targetSchemas().core.whereUnique),
    delete: () => v.singleOrArray(targetSchemas().core.whereUnique),
    connectOrCreate: v.singleOrArray(connectOrCreateSchema),
    set: () => v.singleOrArray(targetSchemas().core.whereUnique),
    update: v.singleOrArray(updateSchema),
    updateMany: v.singleOrArray(updateManySchema),
    upsert: v.singleOrArray(upsertSchema),
    deleteMany: () => v.singleOrArray(targetSchemas().core.where),
  }) as unknown as ToManyUpdateSchema<S, Source>;
};
