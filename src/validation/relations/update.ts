// Relation Update Schemas

import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { getInverseRelationFields as getInverseRelationFieldsRuntime } from "@schema/relation/types";
import v, { type V } from "@validation";
import {
  type CreateManyDataSchema,
  type CreateWithOmittedFk,
  type InverseRequiredKeys,
} from "./create";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";
import type { FieldSchemas } from "../model";
import { getNestedScalarCreateWithOmittedRequiredKeys } from "../model/core/create";

// =============================================================================
// UPDATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one update: { create?, connect?, connectOrCreate?, disconnect?, delete? }
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
  const connectOrCreateSchema = v.object(
    {
      where: () => targetSchemas().core.whereUnique,
      create: getCreateSchema,
    },
    { partial: false }
  );

  const baseEntries = v.object({
    create: getCreateSchema,
    connect: () => targetSchemas().core.whereUnique,
    connectOrCreate: connectOrCreateSchema,
  });

  const optionalEntries = baseEntries.extend({
    disconnect: v.boolean(),
    delete: v.boolean(),
  });

  return (state.optional ? optionalEntries : baseEntries) as unknown as ToOneUpdateSchema<
    S,
    Source
  >;
};

/**
 * To-many update: { create?, createMany?, connect?, disconnect?, delete?, connectOrCreate?, set? }
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
  disconnect: () => V.Union<
    readonly [
      V.Boolean,
      V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>,
    ]
  >;
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

  const getCreateManyDataSchema = (): CreateManyDataSchema<S, Source> => {
    const targetModel = state.getter() as TargetModel<S>;
    const fkFields = (getInverseRelationFieldsRuntime(state, source) ??
      []) as InverseRequiredKeys<S, Source>;
    const schemas = targetSchemas();
    return getNestedScalarCreateWithOmittedRequiredKeys<
      TargetModel<S>,
      FieldSchemas<TargetModel<S>>,
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
    disconnect: () =>
      v.union([v.boolean(), v.singleOrArray(targetSchemas().core.whereUnique)]),
    delete: () => v.singleOrArray(targetSchemas().core.whereUnique),
    connectOrCreate: v.singleOrArray(connectOrCreateSchema),
    set: () => v.singleOrArray(targetSchemas().core.whereUnique),
  }) as unknown as ToManyUpdateSchema<S, Source>;
};
