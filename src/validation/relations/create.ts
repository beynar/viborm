// Relation Create Schemas

import type { AnyModel } from "@schema/model";
import type {
  GetInverseRelationMap,
  IsSingleMember,
  RelationState,
} from "@schema/relation/types";
import type { ScalarSchemas } from "../model";
import {
  getNestedScalarCreateWithOmittedRequiredKeys,
  type NestedScalarCreateWithOmittedRequiredKeys,
} from "../model/core/create";
import { type V, v } from "../primitives/v";
import {
  applyCreateManyAvailability,
  type CreateManyAvailability,
} from "./create-many-availability";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";
import {
  type ToOneMutationSchema,
  toOneMutationSchema,
} from "./to-one-mutation-schema";

// =============================================================================
// CREATE SCHEMA TYPES (exported for consumer use)
// =============================================================================

/**
 * The keys of a target schema the ENCLOSING relation owns: the inverse relation's
 * foreign-key fields, narrowed to the keys that schema actually has.
 *
 * This module owns the omitted-FK lineage for BOTH nested contexts. `core.create` and
 * `core.update` carry the same relation-owned columns, and a nested payload may not name
 * them in either one, for one reason: the enclosing step DERIVES that column from the
 * record it acted on, so a spelled value is a second provenance for it. The polymorphic
 * edge states the same rule over its relation key
 * ({@link file://./index.ts} `PolymorphicInverseCreateTarget` /
 * `PolymorphicInverseUpdateTarget`).
 */
type OmittedInverseFkKeys<
  S extends RelationState,
  Source extends AnyModel,
  Entries,
> = Extract<GetInverseRelationMap<S, Source>, readonly (keyof Entries)[]>;

export type CreateWithOmittedFk<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["create"],
  OmittedInverseFkKeys<
    S,
    Source,
    GetTargetSchemas<S>["core"]["create"]["entries"]
  >
>;

/**
 * Does the TARGET row hold this relation's foreign key? Only then is a spelled column a
 * SECOND provenance for the value the enclosing step's fold derives.
 *
 * `getInverseRelationMap` answers two different questions under one name: for a to-one
 * with `.fields()` it returns THIS side's own fields, and for every other shape it scans
 * the TARGET for a to-one back-reference. Only the second answer names a column on the
 * row a nested payload writes.
 *
 * MEASURED, and deliberately NOT changed here: `CreateWithOmittedFk` applies the map
 * without this narrowing, so a nested CREATE over-omits in two shapes the engine has no
 * fold for — a `manyToMany` arm (the junction holds membership; the scan finds an
 * unrelated to-one back-reference, e.g. `post.tags.create` cannot spell `featuredPostId`)
 * and a SELF-REFERENTIAL parent-held to-one (`node.parent.create` cannot spell its own
 * `parentId`). Both refuse at HEAD, predate this package, and widening them is a
 * capability lift with its own measurement — recorded for the guard-ownership ledger,
 * not folded into N1, which may only make the parse agree with the engine.
 */
type TargetHoldsInverseFk<S extends RelationState> =
  S["type"] extends "manyToMany"
    ? false
    : S extends { fields: readonly [string, ...string[]] }
      ? false
      : true;

/** The runtime twin of {@link TargetHoldsInverseFk} — one rule, both levels. */
export const targetHoldsInverseFk = (state: RelationState): boolean =>
  state.type !== "manyToMany" &&
  (state.fields === undefined || state.fields.length === 0);

/**
 * The UPDATE-side application of the owner above (Package N1). Nested update data —
 * the to-one `update` and `upsert` arms, the to-many `update`, `updateMany` and `upsert`
 * arms — is built from this, so the relation-owned foreign key is not a key the caller
 * can spell there, exactly as it has never been spellable in a nested create.
 *
 * NOT applied to the to-many `upsert` arm of a CREATE context
 * ({@link ToManyCreateSchema}): the engine ABSORBS an agreeing spelling there
 * (`RelationUpsertPart.withoutAgreeingOwnedFk`, E5-U2), which is a capability, and only
 * a create root whose own key is spelled has a value to agree with.
 */
export type UpdateWithOmittedFk<
  S extends RelationState,
  Source extends AnyModel,
> = TargetHoldsInverseFk<S> extends true
  ? V.Omit<
      GetTargetSchemas<S>["core"]["update"],
      OmittedInverseFkKeys<
        S,
        Source,
        GetTargetSchemas<S>["core"]["update"]["entries"]
      >
    >
  : GetTargetSchemas<S>["core"]["update"];

type InverseRelationMap<
  S extends RelationState,
  Source extends AnyModel,
> = S extends {
  type: "manyToOne" | "oneToOne";
  fields: readonly (infer ScalarKey extends string)[];
}
  ? ScalarKey
  : S extends { name: infer RelationName extends string }
    ? ScalarsForRelationKey<TargetModel<S>, RelationName> extends never
      ? ScannedInverseRelationMap<S, Source>
      : ScalarsForRelationKey<TargetModel<S>, RelationName>
    : ScannedInverseRelationMap<S, Source>;

type ScalarsForRelationKey<
  M extends AnyModel,
  RelationName extends string,
> = RelationName extends keyof M["~"]["state"]["relations"]
  ? M["~"]["state"]["relations"][RelationName]["~"]["state"] extends {
      fields: readonly (infer ScalarKey extends string)[];
    }
    ? ScalarKey
    : never
  : never;

/**
 * The scan that resolves which columns a nested create/createMany must NOT ask the
 * caller for, because the enclosing relation owns them.
 *
 * TH — the relation name DISAMBIGUATES; it does not reject. This is the rule the one
 * candidate scan (`@schema/relation/inverse`) applies for every consumer, and
 * this twin used to apply it the rejecting way: on a schema whose SOLE back-reference
 * does not echo the source relation's `.name()`, the scan answered `never`, so
 * {@link CreateManyDataSchema} kept the foreign key REQUIRED while the runtime schema had
 * made it optional and the engine derives it. Measured at 620a171 through the public
 * client: `Property 'orgId' is missing in type '{ id: number; handle: string; }' but
 * required` on a call the runtime accepts.
 *
 * Candidates are counted by their RELATION KEY, never by the field names they carry — two
 * relations can name the same column, and counting names would fuse two candidates into
 * one and take the single-candidate branch for a genuinely ambiguous edge.
 */
type ScannedCandidateKeys<S extends RelationState, Source extends AnyModel> = {
  [K in KnownKeys<
    TargetModel<S>["~"]["state"]["relations"]
  >]: TargetModel<S>["~"]["state"]["relations"][K]["~"]["state"] extends {
    type: "manyToOne" | "oneToOne";
    getter: () => Source;
    fields: readonly string[];
  }
    ? // The aligned reading, in the SAME idiom as `InverseCandidateKeys`
      // (types.ts): only the known-empty tuple is excluded, so a widened
      // `string[]` stays a candidate exactly as the runtime keeps it.
      TargetModel<S>["~"]["state"]["relations"][K]["~"]["state"]["fields"] extends readonly []
      ? never
      : K
    : never;
}[KnownKeys<TargetModel<S>["~"]["state"]["relations"]>];

type NamedScannedCandidateKeys<
  S extends RelationState,
  Source extends AnyModel,
> = {
  [K in KnownKeys<
    TargetModel<S>["~"]["state"]["relations"]
  >]: TargetModel<S>["~"]["state"]["relations"][K]["~"]["state"] extends infer InverseState
    ? InverseState extends {
        type: "manyToOne" | "oneToOne";
        getter: () => Source;
        fields: readonly string[];
      }
      ? InverseState["fields"] extends readonly []
        ? never
        : S extends { name: infer RelationName extends string }
          ? InverseState extends { name: RelationName }
            ? K
            : never
          : K
      : never
    : never;
}[KnownKeys<TargetModel<S>["~"]["state"]["relations"]>];

type ScannedFieldsAt<S extends RelationState, K> = K extends KnownKeys<
  TargetModel<S>["~"]["state"]["relations"]
>
  ? TargetModel<S>["~"]["state"]["relations"][K]["~"]["state"] extends {
      fields: readonly (infer ScalarKey extends string)[];
    }
    ? ScalarKey
    : never
  : never;

type ScannedInverseRelationMap<
  S extends RelationState,
  Source extends AnyModel,
> = IsSingleMember<ScannedCandidateKeys<S, Source>> extends true
  ? ScannedFieldsAt<S, ScannedCandidateKeys<S, Source>>
  : ScannedFieldsAt<S, NamedScannedCandidateKeys<S, Source>>;

type KnownKeys<T> = {
  [K in keyof T]: string extends K ? never : number extends K ? never : K;
}[keyof T];

export type InverseRequiredKeys<
  S extends RelationState,
  Source extends AnyModel,
> = readonly InverseRelationMap<S, Source>[];

export type CreateManyDataSchema<
  S extends RelationState,
  Source extends AnyModel,
> = NestedScalarCreateWithOmittedRequiredKeys<
  TargetModel<S>,
  ScalarSchemas<TargetModel<S>>,
  InverseRequiredKeys<S, Source>
>;

type AvailableNestedCreateManySchema<
  S extends RelationState,
  Source extends AnyModel,
> = V.Object<
  {
    data: () => V.Array<CreateManyDataSchema<S, Source>>;
    skipDuplicates: V.Boolean<{ optional: true }>;
  },
  { atLeast: ["data"] }
>;

export type NestedCreateManySchema<
  S extends RelationState,
  Source extends AnyModel,
> = CreateManyAvailability<
  TargetModel<S>,
  AvailableNestedCreateManySchema<S, Source>
>;

// =============================================================================
// CREATE FACTORY IMPLEMENTATIONS
// =============================================================================

/**
 * To-one create: { create?, connect?, connectOrCreate? }
 */
type ToOneCreateEntries<S extends RelationState, Source extends AnyModel> = {
  create: () => CreateWithOmittedFk<S, Source>;
  connect: () => GetTargetSchemas<S>["core"]["whereUnique"];
  connectOrCreate: V.Object<
    {
      where: () => GetTargetSchemas<S>["core"]["whereUnique"];
      create: () => CreateWithOmittedFk<S, Source>;
    },
    { partial: false }
  >;
};

export type ToOneCreateSchema<
  S extends RelationState,
  Source extends AnyModel,
> = ToOneMutationSchema<ToOneCreateEntries<S, Source>, { optional: true }>;

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
    const fkFields = getInverseRelationMapRuntime(state, source);
    return v.omit(targetSchemas().core.create, fkFields);
  };

  return toOneMutationSchema(
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
    createMany: NestedCreateManySchema<S, Source>;
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
    // COMPATIBILITY NOTE (deliberate Prisma superset — query-engine-v2 PLAN
    // P−1.2 / ATOM §4): nested `upsert` under a top-level `create` is NOT a
    // Prisma create input. VibORM supports it with GLOBAL-LOOKUP,
    // ADOPT-AND-UPDATE semantics: the target is located by its own unique
    // `where` (no parent correlation is possible under a fresh parent), the
    // found branch adopts it (reparents) and applies `update`, and the missing
    // branch creates it under the new parent. This is the natural completion of
    // the adopt family that `connect`/`connectOrCreate` already provide here.
    // The difference is pinned in docs/content/docs/client/compatibility.mdx;
    // it is never silently divergent.
    upsert: () => V.SingleOrArray<
      V.Object<
        {
          where: () => GetTargetSchemas<S>["core"]["whereUnique"];
          create: () => CreateWithOmittedFk<S, Source>;
          update: () => GetTargetSchemas<S>["core"]["update"];
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

  return v.object(
    {
      create: () => v.singleOrArray(getCreateSchema()),
      // createMany only accepts scalar fields - no nested relation mutations
      createMany: createManySchema,
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
      // Deliberate Prisma superset (see the type above): global-lookup,
      // adopt-and-update. The engine (query-engine-v2 CreateOperation) owns the
      // adopt semantics; this schema only pins the accepted input surface.
      upsert: () =>
        v.singleOrArray(
          v.object(
            {
              where: () => targetSchemas().core.whereUnique,
              create: getCreateSchema,
              update: () => targetSchemas().core.update,
            },
            { partial: false }
          )
        ),
    },
    { optional: true }
  ) as unknown as ToManyCreateSchema<S, Source>;
};

// Helper to get FK fields at runtime (moved from helpers.ts inline usage)
import { getInverseRelationMap as getInverseRelationMapRuntime } from "@schema/relation/types";
