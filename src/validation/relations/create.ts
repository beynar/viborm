// Relation Create Schemas

import type { AnyModel } from "@schema/model";
import type {
  GetInverseRelationFields,
  RelationState,
} from "@schema/relation/types";
import { type V, v } from "@validation";
import {
  getNestedScalarCreateWithOmittedRequiredKeys,
  type NestedScalarCreateWithOmittedRequiredKeys,
} from "../model/core/create";
import type { FieldSchemas } from "../model";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";

// =============================================================================
// CREATE SCHEMA TYPES (exported for consumer use)
// =============================================================================

export type CreateWithOmittedFk<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["create"],
  Extract<
    GetInverseRelationFields<S, Source>,
    readonly (keyof GetTargetSchemas<S>["core"]["create"]["entries"])[]
  >
>;

type InverseRelationFields<
  S extends RelationState,
  Source extends AnyModel,
> = S extends { type: "manyToOne" | "oneToOne" }
  ? S extends { fields: readonly (infer FieldKey extends string)[] }
    ? FieldKey
    : never
  : S extends { name: infer RelationName extends string }
    ? FieldsForRelationKey<TargetModel<S>, RelationName> extends never
      ? ScannedInverseRelationFields<S, Source>
      : FieldsForRelationKey<TargetModel<S>, RelationName>
    : ScannedInverseRelationFields<S, Source>;

type FieldsForRelationKey<
  M extends AnyModel,
  RelationName extends string,
> = RelationName extends keyof M["~"]["state"]["relations"]
  ? M["~"]["state"]["relations"][RelationName]["~"]["state"] extends {
      fields: readonly (infer FieldKey extends string)[];
    }
    ? FieldKey
    : never
  : never;

type ScannedInverseRelationFields<
  S extends RelationState,
  Source extends AnyModel,
> = {
      [K in KnownKeys<TargetModel<S>["~"]["state"]["relations"]>]: TargetModel<S>["~"]["state"]["relations"][K]["~"]["state"] extends infer InverseState
        ? InverseState extends {
            type: "manyToOne" | "oneToOne";
            getter: () => Source;
            fields: readonly (infer FieldKey extends string)[];
          }
          ? S extends { name: infer RelationName extends string }
            ? InverseState extends { name: RelationName }
              ? FieldKey
              : never
            : FieldKey
          : never
        : never;
    }[KnownKeys<TargetModel<S>["~"]["state"]["relations"]>];

type KnownKeys<T> = {
  [K in keyof T]: string extends K ? never : number extends K ? never : K;
}[keyof T];

export type InverseRequiredKeys<
  S extends RelationState,
  Source extends AnyModel,
> = readonly InverseRelationFields<S, Source>[];

export type CreateManyDataSchema<
  S extends RelationState,
  Source extends AnyModel,
> = NestedScalarCreateWithOmittedRequiredKeys<
  TargetModel<S>,
  FieldSchemas<TargetModel<S>>,
  InverseRequiredKeys<S, Source>
>;

// =============================================================================
// CREATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
export type ToOneCreateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  {
    create: () => CreateWithOmittedFk<S, Source>;
    connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
    connectOrCreate: V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUnique"];
        create: () => CreateWithOmittedFk<S, Source>;
      },
      { partial: false }
    >;
  },
  { optional: true }
>;

export const toOneCreateFactory = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToOneCreateSchema<S, Source> => {
  const getCreateSchema = () => {
    const fkFields = getInverseRelationFieldsRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  return v.object(
    {
      create: getCreateSchema,
      connect: () => targetSchemas().core.whereUnique,
      connectOrCreate: v.object(
        {
          where: () => targetSchemas().core.whereUnique,
          create: getCreateSchema,
        },
        { partial: false }
      ),
    },
    { optional: true }
  ) as unknown as ToOneCreateSchema<S, Source>;
};

/**
 * To-many create: { create?, createMany?, connect?, connectOrCreate? }
 * All accept single or array, normalized to array
 * Uses thunks for lazy evaluation to avoid circular reference issues
 *
 * Note: createMany uses scalarCreate (no nested relations) because
 * nested creates within createMany are not supported.
 */

export type ToManyCreateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  {
    create: () => V.SingleOrArray<CreateWithOmittedFk<S, Source>>;
    createMany: V.Object<
      {
        data: () => V.Array<CreateManyDataSchema<S, Source>>;
        skipDuplicates: V.Boolean<{ optional: true }>;
      },
      { atLeast: ["data"] }
    >;
    connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
    connectOrCreate: () => V.SingleOrArray<
      V.Object<
        {
          where: () => GetTargetSchemas<S>["core"]["whereUnique"];
          create: () => CreateWithOmittedFk<S, Source>;
        },
        { partial: false }
      >
    >;
  },
  { optional: true }
>;

export const toManyCreateFactory = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): ToManyCreateSchema<S, Source> => {
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

  return v.object(
    {
      create: () => v.singleOrArray(getCreateSchema()),
      // createMany only accepts scalar fields - no nested relation mutations
      createMany: v.object(
        {
          data: () => v.array(getCreateManyDataSchema()),
          skipDuplicates: v.boolean({ optional: true }),
        },
        { atLeast: ["data"] }
      ),
      connect: () => v.singleOrArray(targetSchemas().core.whereUnique),
      connectOrCreate: () =>
        v.singleOrArray(
          v.object(
            {
              where: () => targetSchemas().core.whereUnique,
              create: getCreateSchema,
            },
            { partial: false }
          )
        ),
    },
    { optional: true }
  ) as unknown as ToManyCreateSchema<S, Source>;
};

// Helper to get FK fields at runtime (moved from helpers.ts inline usage)
import { getInverseRelationFields as getInverseRelationFieldsRuntime } from "@schema/relation/types";
