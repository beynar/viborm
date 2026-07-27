// Relation Update Schemas

import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { getInverseRelationMap as getInverseRelationMapRuntime } from "@schema/relation/types";
import type { ScalarSchemas } from "../model";
import { getNestedScalarCreateWithOmittedRequiredKeys } from "../model/core/create";
import { createSchema, validateSchema } from "../primitives/helpers";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";
import type {
  CreateManyDataSchema,
  CreateWithOmittedFk,
  InverseRequiredKeys,
} from "./create";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";
import { isToOneUpdateWrapper } from "./to-one-update-form";

// =============================================================================
// UPDATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * The `{ where?, data }` wrapper spelling of a to-one nested `update` (Prisma 5).
 * `where` is a NON-unique `WhereInput` — a to-one has exactly one connected record,
 * so this filters that record rather than selecting among candidates.
 */
type ToOneUpdateWrapperSchema<S extends RelationState> = V.Object<
  {
    where: () => GetTargetSchemas<S>["core"]["where"];
    data: () => GetTargetSchemas<S>["core"]["update"];
  },
  { atLeast: ["data"] }
>;

/**
 * A to-one nested `update` payload: bare data OR the `{ where?, data }` wrapper.
 * Dispatch is DETERMINISTIC and structural — an object carrying a `data` key whose
 * value is an object is the wrapper, everything else is bare data — so a malformed
 * wrapper surfaces the wrapper's own error rather than a union-wide miss, and the
 * query engine can split the RAW payload it sees one level deeper by the identical
 * rule. See {@link file://./to-one-update-form.ts} for the rule and its documented
 * collision with a target model that owns a field named `data`.
 */
export type ToOneUpdateTargetSchema<S extends RelationState> = V.Union<
  readonly [ToOneUpdateWrapperSchema<S>, GetTargetSchemas<S>["core"]["update"]]
>;

const toOneUpdateTargetFactory = <
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  targetSchemas: T
): ToOneUpdateTargetSchema<S> => {
  const wrapper = v.object(
    {
      where: () => targetSchemas().core.where,
      data: () => targetSchemas().core.update,
    },
    { atLeast: ["data"] }
  );
  // The bare arm is reached through a thunk: building it here would resolve the
  // target model's schemas while this one is still under construction, which never
  // terminates for a self-referential relation.
  const bare = v.lazy(() => targetSchemas().core.update);
  const members: readonly VibSchema<unknown, unknown>[] = [
    wrapper as unknown as VibSchema<unknown, unknown>,
    bare as unknown as VibSchema<unknown, unknown>,
  ];
  const schema = createSchema<unknown, unknown>("union", (value) =>
    isToOneUpdateWrapper(value)
      ? validateSchema(wrapper, value)
      : validateSchema(bare, value)
  );
  // Mirror `v.union`'s introspection surface so JSON-schema conversion sees the
  // alternatives it expects (the same shape `toOneFilterFactory` publishes).
  (schema as { options?: unknown }).options = members;
  return schema as unknown as ToOneUpdateTargetSchema<S>;
};

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
  update: () => ToOneUpdateTargetSchema<S>;
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
    // W4-U3: bare data OR `{ where?, data }` — the wrapper's `where` filters the
    // currently connected record (see `toOneUpdateTargetFactory`).
    update: () => toOneUpdateTargetFactory<S, T>(targetSchemas),
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
