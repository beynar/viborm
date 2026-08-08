// Relation Update Schemas

import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation/types";
import { getInverseRelationMap as getInverseRelationMapRuntime } from "@schema/relation/types";
import type { ScalarSchemas } from "../model";
import { getNestedScalarCreateWithOmittedRequiredKeys } from "../model/core/create";
import { createSchema, fail, ok, validateSchema } from "../primitives/helpers";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";
import type {
  CreateManyDataSchema,
  CreateWithOmittedFk,
  InverseRequiredKeys,
  NestedCreateManySchema,
} from "./create";
import { applyCreateManyAvailability } from "./create-many-availability";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";
import {
  AMBIGUOUS_TO_ONE_UPDATE,
  readToOneUpdateForm,
  toOneUpdateEnvelope,
} from "./to-one-update-form";

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
 * Dispatch is DETERMINISTIC and structural — never try-this-then-that — so a
 * malformed wrapper surfaces the wrapper's own error rather than a union-wide miss,
 * and the form a payload takes never depends on the values inside it.
 *
 * This is the ONE place the rule is applied, because it is the only place that sees
 * the USER's payload: both arms emit the same canonical `{ data, where? }` envelope,
 * so no later reader (the update root, a target one level deeper, the nested-target
 * delegation) ever has to tell the spellings apart from an output that already
 * rewrote scalar shorthands. See {@link file://./to-one-update-form.ts} for the rule,
 * and for the collision it REFUSES: on a target that owns a field named `data`, the
 * envelope's shape is also how bare data spells that field, and only the caller can
 * say which was meant.
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
  // Does the TARGET own an update key named `data`? Answered from the target's own
  // update schema (its entries are one key per updatable field and relation), and
  // only ONCE — but not before the first parse, because resolving the target's
  // schemas here would not terminate for a self-referential relation. An update
  // schema whose entries cannot be read is treated as owning the key: the
  // ambiguous spelling is then REFUSED rather than guessed.
  let ownsDataKey: boolean | undefined;
  const targetOwnsDataField = (): boolean => {
    if (ownsDataKey === undefined) {
      ownsDataKey = Object.hasOwn(targetSchemas().core.update.entries, "data");
    }
    return ownsDataKey;
  };
  const schema = createSchema<unknown, unknown>("union", (value) => {
    const ownsData = targetOwnsDataField();
    const form = readToOneUpdateForm(value, ownsData);
    if (form === "ambiguous") return fail(AMBIGUOUS_TO_ONE_UPDATE);
    if (form === "envelope") return validateSchema(wrapper, value);
    // The bare arm is CANONICALIZED into the same envelope the wrapper arm emits.
    // Without it, `core.update`'s scalar-shorthand rewrite makes the bare output of
    // a model owning a `data` field indistinguishable from a wrapper, and every
    // reader downstream of this parse would resolve the form differently than the
    // user wrote it.
    const parsed = validateSchema(bare, value);
    return parsed.issues
      ? parsed
      : ok(toOneUpdateEnvelope(parsed.value, ownsData));
  });
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
  createMany: NestedCreateManySchema<S, Source>;
  connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  disconnect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  delete: () => V.SingleOrArray<
    GetTargetSchemas<S>["core"]["whereUniqueExtended"]
  >;
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
        where: () => GetTargetSchemas<S>["core"]["whereUniqueExtended"];
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
        where: () => GetTargetSchemas<S>["core"]["whereUniqueExtended"];
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
        polymorphic: schemas.polymorphic,
      },
      fkFields
    );
  };

  const createManySchema = applyCreateManyAvailability(
    state.getter() as TargetModel<S>,
    v.object(
      {
        data: () => v.array(getCreateManyDataSchema()),
        skipDuplicates: v.boolean({ optional: true }),
      },
      { atLeast: ["data"] }
    )
  );

  const connectOrCreateSchema = v.object(
    {
      where: () => targetSchemas().core.whereUnique,
      create: getCreateSchema,
    },
    { partial: false }
  );

  const updateSchema = v.object(
    {
      where: () => targetSchemas().core.whereUniqueExtended,
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
      where: () => targetSchemas().core.whereUniqueExtended,
      create: getCreateSchema,
      update: () => targetSchemas().core.update,
    },
    { partial: false }
  );

  return v.object({
    create: () => v.singleOrArray(getCreateSchema()),
    createMany: createManySchema,
    connect: () => v.singleOrArray(targetSchemas().core.whereUnique),
    // Prisma parity: boolean disconnect is a to-one concept; on to-many it
    // would silently wipe every association, so it is rejected here.
    disconnect: () => v.singleOrArray(targetSchemas().core.whereUnique),
    delete: () => v.singleOrArray(targetSchemas().core.whereUniqueExtended),
    connectOrCreate: v.singleOrArray(connectOrCreateSchema),
    set: () => v.singleOrArray(targetSchemas().core.whereUnique),
    update: v.singleOrArray(updateSchema),
    updateMany: v.singleOrArray(updateManySchema),
    upsert: v.singleOrArray(upsertSchema),
    deleteMany: () => v.singleOrArray(targetSchemas().core.where),
  }) as unknown as ToManyUpdateSchema<S, Source>;
};
