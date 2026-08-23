// Relation Update Schemas

import type { AnyModel } from "@schema/model";
import {
  membershipCanBeCleared,
  slotMayBeEmpty,
} from "@schema/relation/clearability";
import type {
  MembershipCanBeCleared,
  SlotMayBeEmpty,
} from "@schema/relation/static-membership";
import type {
  ForeignKeyDeclaration,
  RelationState,
} from "@schema/relation/types";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import { createSchema, fail, ok, validateSchema } from "../primitives/helpers";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";
import type { NestedCreateManySchema } from "./create";
import type { GetTargetSchemas, SchemaGetter } from "./helpers";
import {
  nestedRelationDataProjection,
  type ProjectedNestedCreate,
  type ProjectedNestedUpdate,
  type ProjectedSelectedUpsertUpdate,
} from "./nested-data-projection";
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
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = ToOneUpdateTargetWithDataSchema<S, ProjectedNestedUpdate<Source, Key, S>>;

/**
 * `getUpdateSchema` is REQUIRED — nested update data is always built from the
 * relation's nested-data projection ({@link ProjectedNestedUpdate}: the omitted-FK
 * schema for an ordinary edge, the omitted-relation-key one for a polymorphic
 * inverse). The optional parameter this used to take defaulted to the target's bare
 * `core.update`, which is precisely the schema that let a caller spell the enclosing
 * relation's foreign key (N1).
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
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = {
  create: () => ProjectedNestedCreate<Source, Key, S>;
  connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
  connectOrCreate: V.Object<
    {
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => ProjectedNestedCreate<Source, Key, S>;
    },
    { partial: false }
  >;
  update: () => ToOneUpdateTargetSchema<Source, Key, S>;
  upsert: V.Object<
    {
      create: () => ProjectedNestedCreate<Source, Key, S>;
      update: () => ProjectedNestedUpdate<Source, Key, S>;
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

/** A structural prohibition that survives generic public operation arguments. */
type ToOneUpdateSchemaNoDisconnect = {
  disconnect: never;
};

/**
 * Does the OTHER row hold this membership? A slot that completed
 * `.fields(...).references(...)` stores it itself; everything else — an
 * inverse, a junction side, a variant inverse — reads it from elsewhere, which
 * is what the to-one mutation envelope needs to know about its own row.
 */
type IsChildHeldToOne<S extends RelationState> = S extends {
  readonly foreignKey: ForeignKeyDeclaration;
}
  ? false
  : true;

/**
 * The two facts, read as the two availability rules they are: `delete` follows the
 * SLOT (this branch is only reached when it may be empty), `disconnect` follows the
 * MEMBERSHIP. They coincide on every shape except one — a slot whose membership
 * lives on storage that cannot be emptied, where the record can still be deleted
 * but the connection cannot be cut.
 */
type OptionalToOneUpdateEntries<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = ToOneUpdateSchemaDelete["entries"] &
  (MembershipCanBeCleared<Source, Key, S> extends true
    ? ToOneUpdateSchemaDisconnect["entries"]
    : ToOneUpdateSchemaNoDisconnect);

export type ToOneUpdateSchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = SlotMayBeEmpty<Source, Key, S> extends false
  ? ToOneMutationSchema<
      ToOneUpdateEntriesBase<Source, Key, S>,
      undefined,
      IsChildHeldToOne<S>
    >
  : ToOneMutationSchema<
      OptionalToOneUpdateEntries<Source, Key, S> &
        ToOneUpdateEntriesBase<Source, Key, S>,
      undefined,
      IsChildHeldToOne<S>
    >;

export const toOneUpdateFactory = <
  Source extends AnyModel,
  Key,
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  state: S,
  resolved: ResolvedSlot,
  targetSchemas: T
): ToOneUpdateSchema<Source, Key, S> => {
  const projection = nestedRelationDataProjection<S, T>(
    resolved,
    targetSchemas
  );
  const getCreateSchema = projection.getCreateSchema;
  // The same owner, applied to nested UPDATE data. See
  // {@link ProjectedNestedUpdate} for why the two contexts share one rule.
  //
  // This omission is the SINGLE owner of the spelled-owned-FK refusal on every
  // schema. The engine guard that once backed it up
  // (`assertOwnedFkAbsentFromUpdateData`, guard-ledger site 11) is deleted: its
  // only route was a zero-argument `.fields()` one scanner read as truthy while
  // the engine read length, and both readings now come from the ONE resolved
  // edge, so the divergent payload refuses here, as `Unknown key`, like every
  // other schema's.
  const getUpdateSchema = projection.getUpdateSchema;

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
    // Bare data OR `{ where?, data }` — the wrapper's `where` filters the
    // currently connected record (see `toOneUpdateTargetFactory`).
    update: () =>
      toOneUpdateTargetFactory<S, T, ReturnType<typeof getUpdateSchema>>(
        targetSchemas,
        getUpdateSchema
      ),
    upsert: upsertSchema,
  };
  // The DIRECTION, read from the declaration: a slot that completed
  // `.fields(...).references(...)` carries the membership on its own row.
  const isChildHeld = state.foreignKey === undefined;

  // The SLOT fact: a relation that must hold a record owns neither removal verb.
  if (!slotMayBeEmpty(resolved)) {
    return toOneMutationSchema(
      baseEntries,
      undefined,
      isChildHeld
    ) as unknown as ToOneUpdateSchema<Source, Key, S>;
  }

  // The MEMBERSHIP fact, asked from the same resolved edge: an empty slot does not
  // imply a clearable membership. An inverse whose stored reference has no nullable
  // member can lose its record but cannot cut the connection, so it publishes
  // `delete` without `disconnect`.
  return (membershipCanBeCleared(resolved)
    ? toOneMutationSchema(
        {
          ...baseEntries,
          disconnect: v.boolean(),
          delete: v.boolean(),
        },
        undefined,
        isChildHeld
      )
    : toOneMutationSchema(
        { ...baseEntries, delete: v.boolean() },
        undefined,
        isChildHeld
      )) as unknown as ToOneUpdateSchema<Source, Key, S>;
};

/**
 * To-many update: {
 *   create?, createMany?, connect?, disconnect?, delete?,
 *   connectOrCreate?, set?, update?, updateMany?, upsert?, deleteMany?
 * }
 * Most operations accept single or array.
 */

type ToManyUpdateEntries<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = {
  create: () => V.SingleOrArray<ProjectedNestedCreate<Source, Key, S>>;
  createMany: NestedCreateManySchema<Source, Key, S>;
  connect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  delete: () => V.SingleOrArray<
    GetTargetSchemas<S>["core"]["whereUniqueExtended"]
  >;
  connectOrCreate: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUnique"];
        create: () => ProjectedNestedCreate<Source, Key, S>;
      },
      { partial: false }
    >
  >;
  set: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
  update: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUniqueExtended"];
        data: () => ProjectedNestedUpdate<Source, Key, S>;
      },
      { atLeast: ["where", "data"] }
    >
  >;
  updateMany: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["where"];
        data: () => ProjectedNestedUpdate<Source, Key, S>;
      },
      { atLeast: ["data"] }
    >
  >;
  upsert: V.SingleOrArray<
    V.Object<
      {
        where: () => GetTargetSchemas<S>["core"]["whereUniqueExtended"];
        create: () => ProjectedNestedCreate<Source, Key, S>;
        update: () => ProjectedSelectedUpsertUpdate<Source, Key, S>;
      },
      { partial: false }
    >
  >;
  deleteMany: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["where"]>;
};

type ToManyDisconnectEntry<S extends RelationState> = {
  disconnect: () => V.SingleOrArray<GetTargetSchemas<S>["core"]["whereUnique"]>;
};

type ToManyNoDisconnectEntry = {
  disconnect: never;
};

export type ToManyUpdateSchema<
  Source extends AnyModel,
  Key,
  S extends RelationState,
> = V.Object<
  ToManyUpdateEntries<Source, Key, S> &
    (MembershipCanBeCleared<Source, Key, S> extends true
      ? ToManyDisconnectEntry<S>
      : ToManyNoDisconnectEntry)
>;

export const toManyUpdateFactory = <
  Source extends AnyModel,
  Key,
  S extends RelationState,
  T extends SchemaGetter<S>,
>(
  resolved: ResolvedSlot,
  targetSchemas: T
): ToManyUpdateSchema<Source, Key, S> => {
  const projection = nestedRelationDataProjection<S, T>(
    resolved,
    targetSchemas
  );
  const getCreateSchema = projection.getCreateSchema;
  // N1 — see the to-one factory above and {@link ProjectedNestedUpdate}.
  const getUpdateSchema = projection.getUpdateSchema;
  const getSelectedUpsertUpdateSchema =
    projection.getSelectedUpsertUpdateSchema;

  const createManySchema = v.object(
    {
      data: () => v.array(getCreateSchema()),
      skipDuplicates: v.boolean({ optional: true }),
    },
    { atLeast: ["data"] }
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
      update: getSelectedUpsertUpdateSchema,
    },
    { partial: false }
  );

  // ONE expression, one owner. A junction membership always clears — the junction
  // row goes and no column on either row is nulled — and that is the answer the
  // clearability owner gives for an ordinary junction, for a member junction, and
  // for a PLURAL variant collection inverse alike (§9.5). A to-many slot whose
  // partner holds a stored reference clears exactly when that reference has a
  // nullable member. There is no second cardinality test here any more.
  const disconnectEntry = membershipCanBeCleared(resolved)
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
  }) as unknown as ToManyUpdateSchema<Source, Key, S>;
};
