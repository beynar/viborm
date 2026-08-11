// Relation Update Schemas

import type { AnyModel } from "@schema/model";
import type {
  GetInverseRelationMap,
  RelationState,
} from "@schema/relation/types";
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
  UpdateWithOmittedFk,
} from "./create";
import { targetHoldsInverseFk } from "./create";
import { applyCreateManyAvailability } from "./create-many-availability";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";
import {
  type ToOneMutationSchema,
  toOneMutationSchema,
} from "./to-one-mutation-schema";
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
type ToOneUpdateWrapperSchema<
  S extends RelationState,
  UpdateSchema extends V.Object<any, any>,
> = V.Object<
  {
    where: () => GetTargetSchemas<S>["core"]["where"];
    data: () => UpdateSchema;
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
export type ToOneUpdateTargetWithDataSchema<
  S extends RelationState,
  UpdateSchema extends V.Object<any, any>,
> = V.Union<readonly [ToOneUpdateWrapperSchema<S, UpdateSchema>, UpdateSchema]>;

export type ToOneUpdateTargetSchema<
  S extends RelationState,
  Source extends AnyModel,
> = ToOneUpdateTargetWithDataSchema<S, UpdateWithOmittedFk<S, Source>>;

/**
 * `getUpdateSchema` is REQUIRED — nested update data is always built from the
 * relation's omitted-FK owner ({@link UpdateWithOmittedFk} for an ordinary edge,
 * `PolymorphicInverseUpdateTarget` for a polymorphic one). The optional parameter this
 * used to take defaulted to the target's bare `core.update`, which is precisely the
 * schema that let a caller spell the enclosing relation's foreign key (N1).
 */
export function toOneUpdateTargetFactory<
  S extends RelationState,
  T extends SchemaGetter<S>,
  UpdateSchema extends V.Object<any, any>,
>(
  targetSchemas: T,
  getUpdateSchema: () => UpdateSchema
): ToOneUpdateTargetWithDataSchema<S, UpdateSchema> {
  const updateSchema = getUpdateSchema;
  const wrapper = v.object(
    {
      where: () => targetSchemas().core.where,
      data: updateSchema,
    },
    { atLeast: ["data"] }
  );
  // The bare arm is reached through a thunk: building it here would resolve the
  // target model's schemas while this one is still under construction, which never
  // terminates for a self-referential relation.
  const bare = v.lazy(updateSchema);
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
      ownsDataKey = Object.hasOwn(updateSchema().entries, "data");
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
      : ok(
          toOneUpdateEnvelope(parsed.value as Record<string, unknown>, ownsData)
        );
  });
  // Mirror `v.union`'s introspection surface so JSON-schema conversion sees the
  // alternatives it expects (the same shape `toOneFilterFactory` publishes).
  (schema as { options?: unknown }).options = members;
  return schema as unknown as ToOneUpdateTargetWithDataSchema<S, UpdateSchema>;
}

/**
 * To-one update: { create?, connect?, connectOrCreate?, update?, upsert?, disconnect?, delete? }
 * disconnect and delete only available for optional relations.
 */

type ToOneUpdateEntriesBase<
  S extends RelationState,
  Source extends AnyModel,
> = {
  create: () => CreateWithOmittedFk<S, Source>;
  connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
  connectOrCreate: V.Object<
    {
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => CreateWithOmittedFk<S, Source>;
    },
    { partial: false }
  >;
  update: () => ToOneUpdateTargetSchema<S, Source>;
  upsert: V.Object<
    {
      create: () => CreateWithOmittedFk<S, Source>;
      update: () => UpdateWithOmittedFk<S, Source>;
    },
    { partial: false }
  >;
};

type ToOneUpdateSchemaDisconnect = V.Object<{
  disconnect: V.Boolean;
}>;

type ToOneUpdateSchemaDelete = V.Object<{
  delete: V.Boolean;
}>;

type NullableScalarKeys<Model extends AnyModel> = {
  [Key in keyof Model["~"]["state"]["scalars"]]: Model["~"]["state"]["scalars"][Key]["~"]["state"] extends {
    nullable: true;
  }
    ? Key
    : never;
}[keyof Model["~"]["state"]["scalars"]];

type InverseMembershipCanBeCleared<
  S extends RelationState,
  Source extends AnyModel,
> = Extract<
  GetInverseRelationMap<S, Source>,
  readonly string[]
> extends infer Fields
  ? [Fields] extends [never]
    ? false
    : Fields extends readonly string[]
      ? [Fields[number]] extends [never]
        ? false
        : Exclude<
              Fields[number],
              NullableScalarKeys<TargetModel<S>>
            > extends never
          ? true
          : false
      : false
  : false;

function inverseMembershipCanBeCleared(
  state: RelationState,
  source: AnyModel
): boolean {
  const inverseFields: unknown = getInverseRelationMapRuntime(state, source);
  if (!Array.isArray(inverseFields) || inverseFields.length === 0) return false;
  const targetModel = state.getter();
  return inverseFields.every(
    (field) =>
      typeof field === "string" &&
      targetModel["~"].state.scalars[field]?.["~"].state.nullable === true
  );
}

type IsFieldsLessInverseOneToOne<S extends RelationState> =
  S["type"] extends "oneToOne"
    ? S extends { fields: readonly [string, ...string[]] }
      ? false
      : true
    : false;

type IsChildHeldToOne<S extends RelationState> = S extends {
  fields: readonly [string, ...string[]];
}
  ? false
  : true;

type OptionalToOneUpdateEntries<
  S extends RelationState,
  Source extends AnyModel,
> = IsFieldsLessInverseOneToOne<S> extends true
  ? ToOneUpdateSchemaDelete["entries"] &
      (InverseMembershipCanBeCleared<S, Source> extends true
        ? ToOneUpdateSchemaDisconnect["entries"]
        : Record<never, never>)
  : ToOneUpdateSchemaDisconnect["entries"] & ToOneUpdateSchemaDelete["entries"];

export type ToOneUpdateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = S["optional"] extends true
  ? ToOneMutationSchema<
      OptionalToOneUpdateEntries<S, Source> & ToOneUpdateEntriesBase<S, Source>,
      undefined,
      IsChildHeldToOne<S>
    >
  : ToOneMutationSchema<
      ToOneUpdateEntriesBase<S, Source>,
      undefined,
      IsChildHeldToOne<S>
    >;

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
  // N1 — the same owner, applied to nested UPDATE data. See
  // {@link UpdateWithOmittedFk} for why the two contexts share one rule.
  //
  // This omission is the SINGLE owner of the spelled-owned-FK refusal on every
  // schema. The engine guard that once backed it up
  // (`assertOwnedFkAbsentFromUpdateData`, guard-ledger site 11) is deleted: its
  // only route was a zero-argument `.fields()` this scanner read as truthy while
  // the engine read length, and the Phase 2 alignment gave both readings to one
  // resolver (`@schema/relation/inverse`), so the divergent payload now refuses
  // here, as `Unknown key`, like every other schema's.
  const getUpdateSchema = () => {
    const fkFields = targetHoldsInverseFk(state)
      ? getInverseRelationMapRuntime(state, source)
      : undefined;
    return v.omit(targetSchemas().core.update, fkFields);
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
      update: getUpdateSchema,
    },
    { partial: false }
  );

  const baseEntries = {
    create: getCreateSchema,
    connect: () => targetSchemas().core.whereUnique,
    connectOrCreate: connectOrCreateSchema,
    // W4-U3: bare data OR `{ where?, data }` — the wrapper's `where` filters the
    // currently connected record (see `toOneUpdateTargetFactory`).
    update: () =>
      toOneUpdateTargetFactory<S, T, ReturnType<typeof getUpdateSchema>>(
        targetSchemas,
        getUpdateSchema
      ),
    upsert: upsertSchema,
  };
  const isChildHeld = state.fields === undefined || state.fields.length === 0;

  if (state.optional !== true) {
    return toOneMutationSchema(
      baseEntries,
      undefined,
      isChildHeld
    ) as unknown as ToOneUpdateSchema<S, Source>;
  }

  const isFieldsLessInverse =
    state.type === "oneToOne" &&
    (state.fields === undefined || state.fields.length === 0);
  if (!isFieldsLessInverse) {
    return toOneMutationSchema(
      {
        ...baseEntries,
        disconnect: v.boolean(),
        delete: v.boolean(),
      },
      undefined,
      isChildHeld
    ) as unknown as ToOneUpdateSchema<S, Source>;
  }

  const membershipCanBeCleared = inverseMembershipCanBeCleared(state, source);
  return (membershipCanBeCleared
    ? toOneMutationSchema(
        {
          ...baseEntries,
          disconnect: v.boolean(),
          delete: v.boolean(),
        },
        undefined,
        true
      )
    : toOneMutationSchema(
        {
          ...baseEntries,
          delete: v.boolean(),
        },
        undefined,
        true
      )) as unknown as ToOneUpdateSchema<S, Source>;
};

/**
 * To-many update: {
 *   create?, createMany?, connect?, disconnect?, delete?,
 *   connectOrCreate?, set?, update?, updateMany?, upsert?, deleteMany?
 * }
 * Most operations accept single or array.
 */

type ToManyUpdateEntries<S extends RelationState, Source extends AnyModel> = {
  create: () => V.SingleOrArray<CreateWithOmittedFk<S, Source>>;
  createMany: NestedCreateManySchema<S, Source>;
  connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
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
        data: () => UpdateWithOmittedFk<S, Source>;
      },
      { atLeast: ["where", "data"] }
    >
  >;
  updateMany: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["where"];
        data: () => UpdateWithOmittedFk<S, Source>;
      },
      { atLeast: ["data"] }
    >
  >;
  upsert: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUniqueExtended"];
        create: () => CreateWithOmittedFk<S, Source>;
        update: () => UpdateWithOmittedFk<S, Source>;
      },
      { partial: false }
    >
  >;
  deleteMany: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["where"]>;
};

type ToManyDisconnectEntry<S extends RelationState> = {
  disconnect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
};

export type ToManyUpdateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  ToManyUpdateEntries<S, Source> &
    (S["type"] extends "manyToMany"
      ? ToManyDisconnectEntry<S>
      : InverseMembershipCanBeCleared<S, Source> extends true
        ? ToManyDisconnectEntry<S>
        : Record<never, never>)
>;

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
  // N1 — see the to-one factory above and {@link UpdateWithOmittedFk}.
  const getUpdateSchema = () => {
    const fkFields = targetHoldsInverseFk(state)
      ? getInverseRelationMapRuntime(state, source)
      : undefined;
    return v.omit(targetSchemas().core.update, fkFields);
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
      data: getUpdateSchema,
    },
    { atLeast: ["where", "data"] }
  );

  const updateManySchema = v.object(
    {
      where: () => targetSchemas().core.where,
      data: getUpdateSchema,
    },
    { atLeast: ["data"] }
  );

  const upsertSchema = v.object(
    {
      where: () => targetSchemas().core.whereUniqueExtended,
      create: getCreateSchema,
      update: getUpdateSchema,
    },
    { partial: false }
  );

  const canDisconnect =
    state.type === "manyToMany" || inverseMembershipCanBeCleared(state, source);
  const disconnectEntry = canDisconnect
    ? {
        disconnect: () => v.singleOrArray(targetSchemas().core.whereUnique),
      }
    : {};

  return v.object({
    create: () => v.singleOrArray(getCreateSchema()),
    createMany: createManySchema,
    connect: () => v.singleOrArray(targetSchemas().core.whereUnique),
    ...disconnectEntry,
    delete: () => v.singleOrArray(targetSchemas().core.whereUniqueExtended),
    connectOrCreate: v.singleOrArray(connectOrCreateSchema),
    set: () => v.singleOrArray(targetSchemas().core.whereUnique),
    update: v.singleOrArray(updateSchema),
    updateMany: v.singleOrArray(updateManySchema),
    upsert: v.singleOrArray(upsertSchema),
    deleteMany: () => v.singleOrArray(targetSchemas().core.where),
  }) as unknown as ToManyUpdateSchema<S, Source>;
};
