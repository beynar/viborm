// Nested relation-data projection — ONE owner, both levels.
//
// A nested payload never writes into the target model's own `core.create` /
// `core.update`: it writes into the projection of those schemas that the ENCLOSING
// relation leaves for the caller. Two edges answer "what does the enclosing step
// already own" differently — an ordinary inverse owns the target's foreign-key
// SCALARS, a polymorphic inverse owns the target's direct RELATION KEY — and until
// this module existed each answer had its own verb factories, its own createMany
// availability, and its own clearability scan.
//
// This is the one place that difference is decided. The verb factories
// (`toOne/toMany` × `create/update`) consume the projection blindly, so a surface
// that used to be a clone is now the same factory with a different projection.

import type { AnyModel } from "@schema/model";
import { getPolymorphicInverseBinding } from "@schema/relation/inverse";
import type { GetPolymorphicInverseBinding } from "@schema/relation/polymorphic";
import type {
  GetInverseRelationMap,
  RelationState,
} from "@schema/relation/types";
import { getInverseRelationMap } from "@schema/relation/types";
import type { ScalarSchemas } from "../model";
import {
  getNestedScalarCreateWithOmittedRequiredKeys,
  type NestedScalarCreateWithOmittedRequiredKeys,
} from "../model/core/create";
import { type V, v } from "../primitives/v";
import type {
  CreateManyDataSchema,
  CreateWithOmittedFk,
  UpdateWithOmittedFk,
} from "./create";
import type { GetTargetSchemas, SchemaGetter, TargetModel } from "./helpers";

// =============================================================================
// WHICH EDGE — the one dispatch
// =============================================================================

/**
 * Only two relation shapes can bind a polymorphic inverse: a `oneToMany`, and a
 * fields-LESS `oneToOne`. Every other shape holds a physical foreign key on one of
 * the two rows, and its projection is the ordinary one — asking the polymorphic
 * resolver about them would let a name-paired polymorphic edge shadow a real column.
 *
 * The runtime twin below is the same rule; the two are read together by
 * {@link NestedRelationDataProjection} and by `getRelationSchemas`.
 */
type CanBindPolymorphicInverse<S extends RelationState> = S["type"] extends
  | "manyToMany"
  | "oneToMany"
  ? S["type"] extends "oneToMany"
    ? true
    : false
  : S["type"] extends "oneToOne"
    ? S extends { fields: readonly string[] }
      ? false
      : true
    : false;

const canBindPolymorphicInverse = (state: RelationState): boolean =>
  state.type === "oneToMany" ||
  (state.type === "oneToOne" &&
    (state.fields === undefined || state.fields.length === 0));

type PolymorphicInverseBindingFor<
  S extends RelationState,
  Source extends AnyModel,
> = GetPolymorphicInverseBinding<TargetModel<S>, Source, S["name"]>;

type PolymorphicInverseRelationKey<
  S extends RelationState,
  Source extends AnyModel,
> = [PolymorphicInverseBindingFor<S, Source>] extends [never]
  ? never
  : PolymorphicInverseBindingFor<S, Source> extends {
        readonly relationKey: infer RelationKey;
      }
    ? Extract<
        RelationKey,
        string & keyof GetTargetSchemas<S>["core"]["create"]["entries"]
      >
    : never;

type HasExactPolymorphicInverse<
  S extends RelationState,
  Source extends AnyModel,
> = [PolymorphicInverseRelationKey<S, Source>] extends [never]
  ? false
  : string extends PolymorphicInverseRelationKey<S, Source>
    ? false
    : true;

type HasNamedTargetPolymorphicRelations<S extends RelationState> =
  string extends keyof TargetModel<S>["~"]["state"]["polymorphicRelations"]
    ? false
    : [keyof TargetModel<S>["~"]["state"]["polymorphicRelations"]] extends [
          never,
        ]
      ? false
      : true;

/** The ONE type-level question the projection asks. */
export type HasPolymorphicInverse<
  S extends RelationState,
  Source extends AnyModel,
> = CanBindPolymorphicInverse<S> extends true
  ? HasNamedTargetPolymorphicRelations<S> extends true
    ? HasExactPolymorphicInverse<S, Source>
    : false
  : false;

// =============================================================================
// THE POLYMORPHIC ARM
// =============================================================================

type PolymorphicInverseCreateTarget<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["create"],
  readonly [PolymorphicInverseRelationKey<S, Source>]
>;

type PolymorphicInverseUpdateTarget<
  S extends RelationState,
  Source extends AnyModel,
> = V.Omit<
  GetTargetSchemas<S>["core"]["update"],
  readonly [
    Extract<
      PolymorphicInverseRelationKey<S, Source>,
      keyof GetTargetSchemas<S>["core"]["update"]["entries"]
    >,
  ]
>;

/**
 * A polymorphic membership's `(type, id)` columns are PRIVATE — they are never in
 * `state.scalars` — so a bulk row omits no required scalar key. The enclosing edge
 * supplies the pair, which is also why the relation key is the createMany
 * availability owner's "satisfied" argument.
 */
type PolymorphicInverseCreateManyData<S extends RelationState> =
  NestedScalarCreateWithOmittedRequiredKeys<
    TargetModel<S>,
    ScalarSchemas<TargetModel<S>>,
    readonly []
  >;

type PolymorphicInverseRelationState<
  S extends RelationState,
  Source extends AnyModel,
> = PolymorphicInverseRelationKey<S, Source> extends infer RelationKey
  ? RelationKey extends keyof TargetModel<S>["~"]["state"]["polymorphicRelations"]
    ? TargetModel<S>["~"]["state"]["polymorphicRelations"][RelationKey]["~"]["state"]
    : never
  : never;

type PolymorphicMembershipCanBeCleared<
  S extends RelationState,
  Source extends AnyModel,
> = [PolymorphicInverseRelationState<S, Source>] extends [never]
  ? false
  : PolymorphicInverseRelationState<S, Source> extends { optional: true }
    ? true
    : false;

// =============================================================================
// THE ORDINARY ARM's clearability half
// =============================================================================

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

// =============================================================================
// THE PROJECTION — one alias, one instantiation per relation
// =============================================================================

/**
 * Every projected fact of one nesting context, computed ONCE per `<S, Source>`.
 *
 * Deliberately a single record rather than one conditional per verb: the
 * polymorphic-vs-ordinary question is the expensive one (it resolves the target
 * model's inverse binding through the schema graph), and a per-verb spelling would
 * instantiate it six times for every relation in the schema.
 */
export type NestedRelationDataProjection<
  S extends RelationState,
  Source extends AnyModel,
> = HasPolymorphicInverse<S, Source> extends true
  ? {
      create: PolymorphicInverseCreateTarget<S, Source>;
      update: PolymorphicInverseUpdateTarget<S, Source>;
      createManyData: PolymorphicInverseCreateManyData<S>;
      createUpsertUpdate: PolymorphicInverseUpdateTarget<S, Source>;
      satisfiedPolymorphicRelation: PolymorphicInverseRelationKey<S, Source>;
      membershipCanBeCleared: PolymorphicMembershipCanBeCleared<S, Source>;
    }
  : {
      create: CreateWithOmittedFk<S, Source>;
      update: UpdateWithOmittedFk<S, Source>;
      createManyData: CreateManyDataSchema<S, Source>;
      createUpsertUpdate: GetTargetSchemas<S>["core"]["update"];
      satisfiedPolymorphicRelation: never;
      membershipCanBeCleared: InverseMembershipCanBeCleared<S, Source>;
    };

/** The target schema a nested `create` payload writes into. */
export type ProjectedNestedCreate<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["create"];

/** The target schema nested UPDATE data writes into (Package N1's omission). */
export type ProjectedNestedUpdate<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["update"];

/** The scalar-only bulk row of a nested `createMany`. */
export type ProjectedCreateManyData<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["createManyData"];

/**
 * The `upsert.update` arm of a to-many payload under a CREATE root, and the one
 * place the two edges deliberately disagree: the ordinary edge keeps the target's
 * BARE `core.update` because the engine ABSORBS an agreeing owned foreign key there
 * (E5-U2, `RelationUpsertPart.withoutAgreeingOwnedFk`), while a polymorphic
 * membership has no spellable column to agree with and keeps the projection.
 * Neither direction may be "unified" into the other.
 */
export type ProjectedCreateUpsertUpdate<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["createUpsertUpdate"];

/** The polymorphic relation key the enclosing edge satisfies, if any. */
export type ProjectedSatisfiedPolymorphicRelation<
  S extends RelationState,
  Source extends AnyModel,
> = Extract<
  NestedRelationDataProjection<S, Source>["satisfiedPolymorphicRelation"],
  string
>;

/**
 * Can the membership this relation represents be CLEARED — the physical fact, not
 * the slot's public optionality. Ordinary: every inverse foreign-key scalar is
 * nullable. Polymorphic: the target's direct relation is optional (its private
 * columns are nullable by that same definition).
 */
export type ProjectedMembershipCanBeCleared<
  S extends RelationState,
  Source extends AnyModel,
> = NestedRelationDataProjection<S, Source>["membershipCanBeCleared"];

// =============================================================================
// RUNTIME
// =============================================================================

type AnyObjectSchema = V.Object<any, any>;

/** The runtime twin of {@link NestedRelationDataProjection}. */
export interface NestedRelationDataSchemas {
  /** `v.omit(core.create, <what the enclosing edge owns>)`. */
  readonly getCreateSchema: () => AnyObjectSchema;
  /** The same omission applied to nested UPDATE data, gated per edge. */
  readonly getUpdateSchema: () => AnyObjectSchema;
  readonly getCreateManyDataSchema: () => AnyObjectSchema;
  /** See {@link ProjectedCreateUpsertUpdate} — the E5-U2 asymmetry. */
  readonly getCreateUpsertUpdateSchema: () => AnyObjectSchema;
  readonly satisfiedPolymorphicRelation: string | undefined;
  readonly membershipCanBeCleared: boolean;
}

/**
 * Does the TARGET row hold this relation's foreign key? Only then is a spelled
 * column a SECOND provenance for the value the enclosing step's fold derives. The
 * type twin is `TargetHoldsInverseFk` ({@link file://./create.ts}); this is the one
 * runtime reading of it.
 */
export const targetHoldsInverseFk = (state: RelationState): boolean =>
  state.type !== "manyToMany" &&
  (state.fields === undefined || state.fields.length === 0);

/**
 * Build the projection for one nesting context.
 *
 * LAZINESS IS A NON-TERMINATION HAZARD, not a performance note. This function
 * resolves `state.getter()` — cheap, schema-layer state only — but every schema it
 * returns is a THUNK, because materializing the target model's `core.create` while
 * the enclosing model's schemas are still under construction never terminates for a
 * self-referential relation. Call it from inside a verb factory (each of which is
 * itself reached through `v.lazy`), never from `getRelationSchemas`: the pin is
 * `polymorphic.core.test.ts` "inverse topology stays lazy until create validation",
 * which counts ZERO target-getter invocations after `core.create` is merely READ.
 */
export const nestedRelationDataProjection = <
  S extends RelationState,
  Source extends AnyModel,
  T extends SchemaGetter<S>,
>(
  state: S,
  source: Source,
  targetSchemas: T
): NestedRelationDataSchemas => {
  const binding = canBindPolymorphicInverse(state)
    ? getPolymorphicInverseBinding(state.getter(), source, state.name)
    : undefined;

  if (binding) {
    const relationKey = binding.relationKey;
    const targetModel: AnyModel = state.getter();
    const getCreateSchema = () =>
      v.omit(targetSchemas().core.create as unknown as AnyObjectSchema, [
        relationKey,
      ]);
    // A polymorphic inverse is ALWAYS child-held, so the omission needs no gate.
    const getUpdateSchema = () =>
      v.omit(targetSchemas().core.update as unknown as AnyObjectSchema, [
        relationKey,
      ]);
    return {
      getCreateSchema,
      getUpdateSchema,
      getCreateManyDataSchema: () => {
        const target = targetSchemas();
        const noOmittedRequiredKeys: readonly [] = [];
        return getNestedScalarCreateWithOmittedRequiredKeys(
          targetModel,
          {
            scalars: target.scalars,
            relations: target.relations,
            polymorphic: target.polymorphic,
          } as unknown as ScalarSchemas<AnyModel>,
          noOmittedRequiredKeys
        ) as unknown as AnyObjectSchema;
      },
      getCreateUpsertUpdateSchema: getUpdateSchema,
      satisfiedPolymorphicRelation: relationKey,
      membershipCanBeCleared:
        targetModel["~"].state.polymorphicRelations[relationKey]?.["~"].state
          .optional === true,
    };
  }

  const getCreateSchema = () =>
    v.omit(
      targetSchemas().core.create as unknown as AnyObjectSchema,
      getInverseRelationMap(state, source) as unknown as
        | readonly string[]
        | undefined
    );
  const getUpdateSchema = () =>
    v.omit(
      targetSchemas().core.update as unknown as AnyObjectSchema,
      (targetHoldsInverseFk(state)
        ? getInverseRelationMap(state, source)
        : undefined) as unknown as readonly string[] | undefined
    );
  return {
    getCreateSchema,
    getUpdateSchema,
    getCreateManyDataSchema: () => {
      const target = targetSchemas();
      const fkFields = (getInverseRelationMap(state, source) ??
        []) as unknown as readonly string[];
      return getNestedScalarCreateWithOmittedRequiredKeys(
        state.getter() as AnyModel,
        {
          scalars: target.scalars,
          relations: target.relations,
          polymorphic: target.polymorphic,
        } as unknown as ScalarSchemas<AnyModel>,
        fkFields
      ) as unknown as AnyObjectSchema;
    },
    getCreateUpsertUpdateSchema: () =>
      targetSchemas().core.update as unknown as AnyObjectSchema,
    satisfiedPolymorphicRelation: undefined,
    membershipCanBeCleared: inverseMembershipCanBeCleared(state, source),
  };
};

/**
 * The ORDINARY arm's physical clearability: can every inverse foreign-key column be
 * set to NULL. The polymorphic arm answers the same question from the target
 * relation's optionality (its private `(type, id)` pair is nullable exactly then),
 * and the two stay two facts — the plan forbids a rule that they must agree.
 */
function inverseMembershipCanBeCleared(
  state: RelationState,
  source: AnyModel
): boolean {
  const inverseFields: unknown = getInverseRelationMap(state, source);
  if (!Array.isArray(inverseFields) || inverseFields.length === 0) return false;
  const targetModel = state.getter();
  return inverseFields.every(
    (field) =>
      typeof field === "string" &&
      targetModel["~"].state.scalars[field]?.["~"].state.nullable === true
  );
}
