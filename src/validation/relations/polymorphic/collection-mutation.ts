import type { PolymorphicRelationState } from "@schema/relation";
import v from "@validation/primitives/v";
import type { VibSchema } from "@validation/types";
import type {
  CoreInputAt,
  CoreOutputAt,
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicTargetSchemaGetters,
} from "./types";
import { polymorphicPublicTypes } from "./types";

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

type TaggedWhere<Getters, CoreKey extends PropertyKey> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreInputAt<Getters, PublicType, CoreKey>;
  };
}[Extract<keyof Getters, string>];

type TaggedWhereOutput<Getters, CoreKey extends PropertyKey> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreOutputAt<Getters, PublicType, CoreKey>;
  };
}[Extract<keyof Getters, string>];

type TaggedCreateInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly data: CoreInputAt<Getters, PublicType, "create">;
  };
}[Extract<keyof Getters, string>];

type TaggedCreateOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly data: CoreOutputAt<Getters, PublicType, "create">;
  };
}[Extract<keyof Getters, string>];

type TaggedConnectOrCreateInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreInputAt<Getters, PublicType, "whereUnique">;
    readonly create: CoreInputAt<Getters, PublicType, "create">;
  };
}[Extract<keyof Getters, string>];

type TaggedConnectOrCreateOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreOutputAt<Getters, PublicType, "whereUnique">;
    readonly create: CoreOutputAt<Getters, PublicType, "create">;
  };
}[Extract<keyof Getters, string>];

type TaggedUpdateInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreInputAt<Getters, PublicType, "whereUniqueExtended">;
    readonly data: CoreInputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type TaggedUpdateOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreOutputAt<Getters, PublicType, "whereUniqueExtended">;
    readonly data: CoreOutputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type TaggedUpdateManyInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where?: CoreInputAt<Getters, PublicType, "where">;
    readonly data: CoreInputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type TaggedUpdateManyOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where?: CoreOutputAt<Getters, PublicType, "where">;
    readonly data: CoreOutputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type TaggedUpsertInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreInputAt<Getters, PublicType, "whereUniqueExtended">;
    readonly create: CoreInputAt<Getters, PublicType, "create">;
    readonly update: CoreInputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type TaggedUpsertOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly where: CoreOutputAt<Getters, PublicType, "whereUniqueExtended">;
    readonly create: CoreOutputAt<Getters, PublicType, "create">;
    readonly update: CoreOutputAt<Getters, PublicType, "update">;
  };
}[Extract<keyof Getters, string>];

type TaggedCreateManyInput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly data: readonly CoreInputAt<Getters, PublicType, "create">[];
    readonly skipDuplicates?: boolean;
  };
}[Extract<keyof Getters, string>];

type TaggedCreateManyOutput<Getters> = {
  [PublicType in Extract<keyof Getters, string>]: {
    readonly type: PublicType;
    readonly data: readonly CoreOutputAt<Getters, PublicType, "create">[];
    readonly skipDuplicates?: boolean;
  };
}[Extract<keyof Getters, string>];

/** Every verb accepts one tagged item or a list of them, and normalizes to a list. */
type Many<Value> = Value | readonly Value[];

/** The four supply verbs a FRESH owner can name. Declaration order is message order. */
export interface PolymorphicCollectionCreateInput<Getters> {
  readonly create?: Many<TaggedCreateInput<Getters>>;
  readonly createMany?: Many<TaggedCreateManyInput<Getters>>;
  readonly connect?: Many<TaggedWhere<Getters, "whereUnique">>;
  readonly connectOrCreate?: Many<TaggedConnectOrCreateInput<Getters>>;
}

export interface PolymorphicCollectionCreateOutput<Getters> {
  readonly create?: readonly TaggedCreateOutput<Getters>[];
  readonly createMany?: readonly TaggedCreateManyOutput<Getters>[];
  readonly connect?: readonly TaggedWhereOutput<Getters, "whereUnique">[];
  readonly connectOrCreate?: readonly TaggedConnectOrCreateOutput<Getters>[];
}

/** All eleven §9.1 verbs, on a LOCATED owner. */
export interface PolymorphicCollectionUpdateInput<Getters> {
  readonly create?: Many<TaggedCreateInput<Getters>>;
  readonly createMany?: Many<TaggedCreateManyInput<Getters>>;
  readonly connect?: Many<TaggedWhere<Getters, "whereUnique">>;
  readonly connectOrCreate?: Many<TaggedConnectOrCreateInput<Getters>>;
  readonly set?: Many<TaggedWhere<Getters, "whereUnique">>;
  readonly disconnect?: Many<TaggedWhere<Getters, "whereUnique">>;
  readonly delete?: Many<TaggedWhere<Getters, "whereUniqueExtended">>;
  readonly deleteMany?: Many<TaggedWhere<Getters, "where">>;
  readonly update?: Many<TaggedUpdateInput<Getters>>;
  readonly updateMany?: Many<TaggedUpdateManyInput<Getters>>;
  readonly upsert?: Many<TaggedUpsertInput<Getters>>;
}

export interface PolymorphicCollectionUpdateOutput<Getters> {
  readonly create?: readonly TaggedCreateOutput<Getters>[];
  readonly createMany?: readonly TaggedCreateManyOutput<Getters>[];
  readonly connect?: readonly TaggedWhereOutput<Getters, "whereUnique">[];
  readonly connectOrCreate?: readonly TaggedConnectOrCreateOutput<Getters>[];
  readonly set?: readonly TaggedWhereOutput<Getters, "whereUnique">[];
  readonly disconnect?: readonly TaggedWhereOutput<Getters, "whereUnique">[];
  readonly delete?: readonly TaggedWhereOutput<
    Getters,
    "whereUniqueExtended"
  >[];
  readonly deleteMany?: readonly TaggedWhereOutput<Getters, "where">[];
  readonly update?: readonly TaggedUpdateOutput<Getters>[];
  readonly updateMany?: readonly TaggedUpdateManyOutput<Getters>[];
  readonly upsert?: readonly TaggedUpsertOutput<Getters>[];
}

export type PolymorphicCollectionCreateSchema<Getters> = VibSchema<
  PolymorphicCollectionCreateInput<Getters> | undefined,
  PolymorphicCollectionCreateOutput<Getters> | undefined
>;

export type PolymorphicCollectionUpdateSchema<Getters> = VibSchema<
  PolymorphicCollectionUpdateInput<Getters>,
  PolymorphicCollectionUpdateOutput<Getters>
>;

/**
 * One verb's tagged union, built the way the to-one families build theirs: one
 * `v.object` per configured public type, discriminated by a `type` literal.
 */
type TaggedVerbOptions = { partial: false } | { atLeast: string[] };

function taggedVerb<State extends PolymorphicRelationState>(
  publicTypes: readonly Extract<keyof State["targets"], string>[],
  fields: (
    publicType: Extract<keyof State["targets"], string>
  ) => Record<string, unknown>,
  options: TaggedVerbOptions
): VibSchema {
  return v.singleOrArray(
    v.union(
      publicTypes.map((publicType) =>
        v.object(
          {
            type: v.literal(publicType),
            ...fields(publicType),
          },
          options
        )
      )
    )
  ) as unknown as VibSchema;
}

interface CollectionVerbs {
  readonly create: VibSchema;
  readonly createMany: VibSchema;
  readonly connect: VibSchema;
  readonly connectOrCreate: VibSchema;
  readonly set: VibSchema;
  readonly disconnect: VibSchema;
  readonly delete: VibSchema;
  readonly deleteMany: VibSchema;
  readonly update: VibSchema;
  readonly updateMany: VibSchema;
  readonly upsert: VibSchema;
}

/** THE ELEVEN VERB BUILDERS — one owner, read by both context bags. */
function collectionVerbs<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  state: State,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): CollectionVerbs {
  const schemaGetters: PolymorphicTargetSchemaGetters<State> = targetSchemas;
  const publicTypes = polymorphicPublicTypes(state);
  const tagged = (
    fields: (
      publicType: Extract<keyof State["targets"], string>
    ) => Record<string, unknown>,
    options: TaggedVerbOptions = { partial: false }
  ) => taggedVerb<State>(publicTypes, fields, options);

  return {
    create: tagged((publicType) => ({
      data: () => schemaGetters[publicType]().core.create,
    })),
    // The GROUP shape §9.1 pins — a `{data: [...], skipDuplicates?}` envelope —
    // carried per variant, several groups per call.
    createMany: tagged(
      (publicType) => ({
        data: () => v.array(schemaGetters[publicType]().core.create),
        skipDuplicates: v.boolean({ optional: true }),
      }),
      { atLeast: ["type", "data"] }
    ),
    connect: tagged((publicType) => ({
      where: () => schemaGetters[publicType]().core.whereUnique,
    })),
    connectOrCreate: tagged((publicType) => ({
      where: () => schemaGetters[publicType]().core.whereUnique,
      create: () => schemaGetters[publicType]().core.create,
    })),
    set: tagged((publicType) => ({
      where: () => schemaGetters[publicType]().core.whereUnique,
    })),
    // UNCONDITIONAL: a member junction row always clears.
    disconnect: tagged((publicType) => ({
      where: () => schemaGetters[publicType]().core.whereUnique,
    })),
    delete: tagged((publicType) => ({
      where: () => schemaGetters[publicType]().core.whereUniqueExtended,
    })),
    deleteMany: tagged((publicType) => ({
      where: () => schemaGetters[publicType]().core.where,
    })),
    // `where` is MANDATORY and EXTENDED — exactly where the ordinary to-many
    // `update` addresses its member, and deliberately NOT the to-one polymorphic
    // reading where `where` merely filters the one connected record.
    update: tagged(
      (publicType) => ({
        where: () => schemaGetters[publicType]().core.whereUniqueExtended,
        data: () => schemaGetters[publicType]().core.update,
      }),
      { atLeast: ["type", "where", "data"] }
    ),
    updateMany: tagged(
      (publicType) => ({
        where: () => schemaGetters[publicType]().core.where,
        data: () => schemaGetters[publicType]().core.update,
      }),
      { atLeast: ["type", "data"] }
    ),
    upsert: tagged((publicType) => ({
      where: () => schemaGetters[publicType]().core.whereUniqueExtended,
      create: () => schemaGetters[publicType]().core.create,
      update: () => schemaGetters[publicType]().core.update,
    })),
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
  State extends PolymorphicRelationState,
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
  State extends PolymorphicRelationState,
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
