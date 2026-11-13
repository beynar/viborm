import type { VariantRelationState } from "@schema/relation";
import { refusingUndefinedOnlyWhere } from "@validation/model/args/bulk-write-where";
import { refuseDefaultOnlySkipDuplicates } from "@validation/model/args/mutation";
import v from "@validation/primitives/v";
import type { VibSchema } from "@validation/types";
import {
  type CoreInputAt,
  type CoreOutputAt,
  type ExactPolymorphicTargetSchemaGetters,
  type PolymorphicTargetSchemaGetters,
  type Side,
  type Tagged,
  type TaggedFields,
  taggedVerbs,
} from "./types";

/**
 * THE DIRECT POLYMORPHIC COLLECTION WRITE GRAMMAR (plan §9.1).
 *
 * Every verb value is a UNION over the configured public types, and the
 * discriminator/payload correlation is a free property of that union — the same
 * idiom the two to-one families use (`polymorphic/create.ts`), for the same
 * reason: a direct payload carries its discriminator INSIDE each verb, so no
 * projection the enclosing edge applies can say what a variant's `where` or
 * `data` means.
 *
 * THREE DELIBERATE DIVERGENCES, each recorded where it is spelled:
 *
 * 1. **`singleOrArray` on EVERY verb, `createMany` included.** §9.1's "`createMany`
 *    remains a group" constrains the INNER shape (a `{data, skipDuplicates}`
 *    envelope), not the arity: a mixed-variant call needs several groups, one per
 *    variant, and the plan's own example spells `createMany: [ {type,data,…} ]`.
 *    The ordinary nested `createMany` is a BARE object (`create.ts` /
 *    `update.ts`); this one is not, and that is the divergence.
 *
 * 2. **The bags are plain `v.object`s, never `toOneMutationSchema`.** Reaching for
 *    the to-one envelope would import `enforceCompositionLattice`'s `exactlyOne`
 *    rule, which refuses BOTH zero active keys and two — and a collection is
 *    exactly the shape where several verbs legitimately coexist (`disconnect` some,
 *    `create` others) and where an empty bag is inert rather than malformed.
 *
 * 3. **No `upsert` in the CREATE bag** — see {@link polymorphicCollectionCreateFactory}.
 *
 * `disconnect` is UNCONDITIONAL, unlike the ordinary to-many factory's
 * clearability-gated entry: a member junction row always clears, because the row
 * goes and no column is nulled. There is no `disconnect: true` spelling at all —
 * §9.2 gives `set: []` that meaning, so the junction estate's
 * `m2mDisconnectRequiresSelector` refusal stays unreachable from this grammar.
 */

/**
 * The item each of the eleven §9.1 verbs takes. Declaration order is message
 * order. `createMany` is the one verb whose fields are not bare `core` schemas.
 */
interface CollectionItems<Getters, Direction extends Side> {
  create: Tagged<Getters, { data: "create" }, Direction>;
  createMany: {
    [PublicType in Extract<keyof Getters, string>]: {
      readonly type: PublicType;
      readonly data: readonly (Direction extends "input"
        ? CoreInputAt<Getters, PublicType, "create">
        : CoreOutputAt<Getters, PublicType, "create">)[];
      readonly skipDuplicates?: boolean;
    };
  }[Extract<keyof Getters, string>];
  connect: Tagged<Getters, { where: "whereUnique" }, Direction>;
  connectOrCreate: Tagged<
    Getters,
    { where: "whereUnique"; create: "create" },
    Direction
  >;
  set: Tagged<Getters, { where: "whereUnique" }, Direction>;
  disconnect: Tagged<Getters, { where: "whereUnique" }, Direction>;
  delete: Tagged<Getters, { where: "whereUniqueExtended" }, Direction>;
  deleteMany: Tagged<Getters, { where: "where" }, Direction>;
  update: Tagged<
    Getters,
    { where: "whereUniqueExtended"; data: "update" },
    Direction
  >;
  updateMany: Tagged<
    Getters,
    { where: "where"; data: "update" },
    Direction,
    "data"
  >;
  upsert: Tagged<
    Getters,
    { where: "whereUniqueExtended"; create: "create"; update: "update" },
    Direction
  >;
}

type CollectionVerb = keyof CollectionItems<unknown, Side>;

/** The four supply verbs a FRESH owner can name. */
type CollectionSupplyVerb =
  | "create"
  | "createMany"
  | "connect"
  | "connectOrCreate";

/** Every verb accepts one tagged item or a list of them, and normalizes to a list. */
type CollectionInput<Getters, Verb extends CollectionVerb> = {
  readonly [Key in Verb]?:
    | CollectionItems<Getters, "input">[Key]
    | readonly CollectionItems<Getters, "input">[Key][];
};

type CollectionOutput<Getters, Verb extends CollectionVerb> = {
  readonly [Key in Verb]?: readonly CollectionItems<Getters, "output">[Key][];
};

export type PolymorphicCollectionCreateInput<Getters> = CollectionInput<
  Getters,
  CollectionSupplyVerb
>;

export type PolymorphicCollectionCreateOutput<Getters> = CollectionOutput<
  Getters,
  CollectionSupplyVerb
>;

/** All eleven §9.1 verbs, on a LOCATED owner. */
export type PolymorphicCollectionUpdateInput<Getters> = CollectionInput<
  Getters,
  CollectionVerb
>;

export type PolymorphicCollectionUpdateOutput<Getters> = CollectionOutput<
  Getters,
  CollectionVerb
>;

export type PolymorphicCollectionCreateSchema<Getters> = VibSchema<
  PolymorphicCollectionCreateInput<Getters> | undefined,
  PolymorphicCollectionCreateOutput<Getters> | undefined
>;

export type PolymorphicCollectionUpdateSchema<Getters> = VibSchema<
  PolymorphicCollectionUpdateInput<Getters>,
  PolymorphicCollectionUpdateOutput<Getters>
>;

/** THE ELEVEN VERB BUILDERS — one owner, read by both context bags. */
function collectionVerbs<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): Record<CollectionVerb, VibSchema> {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const tagged = taggedVerbs<State, Getters>(state, targetSchemas);
  const many = (
    fields: TaggedFields,
    atLeast?: string[]
  ): VibSchema<unknown, unknown> =>
    v.singleOrArray(tagged.core(fields, atLeast)) as unknown as VibSchema;

  return {
    create: many({ data: "create" }),
    // The GROUP shape §9.1 pins — a `{data: [...], skipDuplicates?}` envelope —
    // carried per variant, several groups per call.
    createMany: v.singleOrArray(
      tagged.custom(
        (publicType) => ({
          data: () => v.array(schemaGetters[publicType]().core.create),
          skipDuplicates: v.boolean({ optional: true }),
        }),
        // The same admission fact the root and nested `createMany` arms ask
        // ({@link refuseDefaultOnlySkipDuplicates}): this group is the third
        // place the verb is spelled, and a default-only row has no conflict
        // target to suppress on here either.
        { atLeast: ["type", "data"], refuse: refuseDefaultOnlySkipDuplicates }
      )
    ) as unknown as VibSchema,
    connect: many({ where: "whereUnique" }),
    connectOrCreate: many({ where: "whereUnique", create: "create" }),
    set: many({ where: "whereUnique" }),
    // UNCONDITIONAL: a member junction row always clears.
    disconnect: many({ where: "whereUnique" }),
    delete: many({ where: "whereUniqueExtended" }),
    deleteMany: refusingUndefinedOnlyWhere(
      many({ where: "where" }),
      "deleteMany",
      true,
      "where"
    ),
    // `where` is MANDATORY and EXTENDED — exactly where the ordinary to-many
    // `update` addresses its member, and deliberately NOT the to-one polymorphic
    // reading where `where` merely filters the one connected record.
    update: many({ where: "whereUniqueExtended", data: "update" }, [
      "where",
      "data",
    ]),
    updateMany: refusingUndefinedOnlyWhere(
      many({ where: "where", data: "update" }, ["data"]),
      "updateMany",
      true,
      "where"
    ),
    upsert: many({
      where: "whereUniqueExtended",
      create: "create",
      update: "update",
    }),
  };
}

/**
 * The CREATE-context bag: four supply verbs, and **no `upsert`**.
 *
 * The ordinary `ToManyCreateSchema` carries a Prisma-superset `upsert` with
 * global-lookup / adopt-and-update semantics. The collection omits it, and the
 * asymmetry is deliberate: §9.2 gives the collection `upsert` UPDATE-context
 * semantics — the found arm is scoped to THIS owner's membership — and a fresh
 * owner has no membership to scope to. The only two readings left would be a
 * silent global adopt (a different verb wearing this name) or a refusal at
 * compile time in the engine (a grammar that accepts what it cannot execute).
 * Omitting the key says the same thing once, at the boundary.
 */
export function polymorphicCollectionCreateFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCollectionCreateSchema<Getters> {
  const verbs = collectionVerbs(state, targetSchemas);
  return v.object(
    {
      create: verbs.create,
      createMany: verbs.createMany,
      connect: verbs.connect,
      connectOrCreate: verbs.connectOrCreate,
    },
    { optional: true }
  ) as unknown as PolymorphicCollectionCreateSchema<Getters>;
}

/** The UPDATE-context bag: all eleven §9.1 verbs, every one of them optional. */
export function polymorphicCollectionUpdateFactory<
  State extends VariantRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCollectionUpdateSchema<Getters> {
  const verbs = collectionVerbs(state, targetSchemas);
  return v.object({
    create: verbs.create,
    createMany: verbs.createMany,
    connect: verbs.connect,
    connectOrCreate: verbs.connectOrCreate,
    set: verbs.set,
    disconnect: verbs.disconnect,
    delete: verbs.delete,
    deleteMany: verbs.deleteMany,
    update: verbs.update,
    updateMany: verbs.updateMany,
    upsert: verbs.upsert,
  }) as unknown as PolymorphicCollectionUpdateSchema<Getters>;
}
