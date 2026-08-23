// The ONE compile-time projection of the relation graph (plan §8.1).
//
// The runtime topology index is the definition authority. TypeScript cannot
// execute it, so this module derives the minimum LOCAL projection the editor
// needs — nullability, nested-omission, clearability — and nothing else. It
// stores no topology, exports no runtime resolver, and every consumer that
// needs an inverse fact at the type level imports it from here rather than
// keeping a local candidate scan.
//
// It mirrors ONLY the graph predicate it can prove, in §8.1's seven steps:
//
//   1. retain the exact source-model and asking-field identity;
//   2. read the target model's ONE relation map and exclude the asking slot,
//      so a self-relation cannot select its own declaration;
//   3. collect ordinary slots and variant members that target the source model;
//   4. keep candidates whose literal `.name(...)` claim exactly matches the
//      asking slot's, unnamed-to-unnamed included;
//   5. require exactly one candidate AND prove that candidate's own candidate
//      set is exactly the asking slot — the mutual degree-one rule the runtime
//      resolver applies;
//   6. derive owner/carrier identity, the ordered foreign-key tuple and its
//      nullable subset, and clearability only after that proof;
//   7. otherwise answer `unknown`: omit nothing, expose no disconnect form,
//      and infer nullable wherever requiredness is unproven.
//
// A widened or dynamic declaration is therefore conservatively sound rather
// than guessed: the projection may retain a foreign-key input the runtime can
// derive, or admit a `null` the runtime rules out, but it never omits a
// possibly required field, claims non-nullability without proof, or exposes an
// unsafe mutation verb. A model reached through `.extends()` is one such case:
// its relations' getters name the BASE model, so nothing pairs with the derived
// model and every slot answers `unknown`.

import type { Scalar } from "@schema/scalars/base";
import type { ForeignKeyDeclaration, RelationCardinality } from "./types";

// =============================================================================
// THE CLOSED PROJECTION UNION
// =============================================================================

/**
 * A stored row reference, seen from one end. `owner` says which end stores it,
 * and the two tuples are the OWNER's local columns in declaration order.
 */
export interface StaticForeignKeyMembership<
  Owner extends "asking" | "inverse" = "asking" | "inverse",
  Fields extends readonly string[] = readonly string[],
  NullableFields extends readonly string[] = readonly string[],
> {
  readonly kind: "foreignKey";
  readonly owner: Owner;
  readonly foreignFields: Fields;
  readonly nullableForeignFields: NullableFields;
}

/** A junction row holds the membership; no column on either row records it. */
export interface StaticJunctionMembership {
  readonly kind: "junction";
}

/**
 * The asking slot is the public inverse of a variant carrier. `carrierField` is
 * the carrier's exact literal key — the key a nested payload may not spell,
 * because the enclosing step derives it.
 */
export interface StaticVariantInverseMembership<
  CarrierField extends string = string,
  CanBeCleared extends boolean = boolean,
> {
  readonly kind: "variantInverse";
  readonly carrierField: CarrierField;
  readonly membershipCanBeCleared: CanBeCleared;
}

/**
 * The fail-closed answer. It grants no omission and no mutation verb; full
 * schema validation reports the invalid or ambiguous graph.
 */
export interface StaticUnknownMembership {
  readonly kind: "unknown";
}

/** The closed union §8.1 fixes. Nothing else may leak out of the projection. */
export type StaticMembership =
  | StaticForeignKeyMembership
  | StaticJunctionMembership
  | StaticVariantInverseMembership
  | StaticUnknownMembership;

// =============================================================================
// DECLARATION READERS
// =============================================================================

/**
 * Every reader below accepts EITHER a relation terminal or the bare
 * `RelationState` it carries. The validation layer holds states, the client
 * layer holds terminals, and one reader family serving both is what keeps a
 * single answer per question instead of two aliases that can drift.
 */
type StateOf<R> = R extends { readonly "~": { readonly state: infer State } }
  ? State
  : R;

export type Cardinality<R> =
  StateOf<R> extends {
    readonly cardinality: infer Value extends RelationCardinality;
  }
    ? Value
    : never;

export type TargetKind<R> =
  StateOf<R> extends { readonly target: { readonly kind: infer Kind } }
    ? Kind
    : never;

/** The lazy getter of a MODEL target; `never` for a variant target. */
export type TargetGetter<R> =
  StateOf<R> extends {
    readonly target: { readonly kind: "model"; readonly getter: infer G };
  }
    ? G
    : never;

/** The normalized entry map of a VARIANT target; `never` for a model target. */
export type VariantEntries<R> =
  StateOf<R> extends {
    readonly target: { readonly kind: "variants"; readonly entries: infer E };
  }
    ? E
    : never;

/** `.optional()` exists only on a variant singular slot (§5.1). */
export type HasOptionalModifier<R> =
  StateOf<R> extends { readonly optional: true } ? true : false;

type RelationName<R> =
  StateOf<R> extends { readonly name: infer Name extends string }
    ? Name
    : undefined;

type ForeignKeyOf<R> =
  StateOf<R> extends {
    readonly foreignKey: infer ForeignKey extends ForeignKeyDeclaration;
  }
    ? ForeignKey
    : undefined;

type ModelStateOf<M> = M extends { readonly "~": { readonly state: infer S } }
  ? S
  : never;

/** The one canonical relation map, holding both target domains. */
export type RelationsOf<M> =
  ModelStateOf<M> extends { readonly relations: infer Relations }
    ? Relations
    : never;

type ScalarsOf<M> =
  ModelStateOf<M> extends { readonly scalars: infer Scalars } ? Scalars : never;

export type TargetModelOf<R> =
  TargetGetter<R> extends () => infer M ? M : never;

// =============================================================================
// STEPS 2-5 — THE MUTUAL DEGREE-ONE PROOF
// =============================================================================

type UnionToIntersection<Union> = (
  Union extends unknown
    ? (value: Union) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

/** Exactly one member, and not `never`. */
type IsSingleKey<Union> = [Union] extends [never]
  ? false
  : [Union] extends [UnionToIntersection<Union>]
    ? true
    : false;

/** Only omission or one literal label is evidence for static pairing. */
type IsProvableRelationName<Name> = [Name] extends [undefined]
  ? true
  : [Name] extends [string]
    ? string extends Name
      ? false
      : IsSingleKey<Name>
    : false;

type IsExactly<Union, Value> = [Union] extends [Value]
  ? [Value] extends [Union]
    ? true
    : false
  : false;

/** Type IDENTITY, the strictest test TypeScript exposes to a conditional. */
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;

type IsSameModel<Left, Right> = Equal<Left, Right>;

/**
 * Does `R`'s target domain NAME `Source`? A model target names one getter; a
 * variant target names it when any member's getter does.
 *
 * Identity, never assignability. A model whose shape is a strict SUPERSET of
 * another's is assignable to it, so `() => user extends () => tag` can be true
 * for two unrelated models — which made an unrelated slot a pairing candidate
 * and collapsed a provable junction into `unknown`.
 */
type PointsAt<R, Source> =
  TargetKind<R> extends "model"
    ? NamesModel<TargetGetter<R>, Source>
    : VariantPointsAt<VariantEntries<R>, Source>;

type NamesModel<G, Source> = G extends () => infer M ? Equal<M, Source> : false;

/**
 * ANY member, deliberately — not "exactly one".
 *
 * A carrier that genuinely names one target model TWICE is refused at the gate
 * (R009: a carrier-wide label cannot choose one MEMBER of that same carrier),
 * so counting members here would only change the answer for a schema that
 * cannot reach a client. What it WOULD change is the answer for two DISTINCT
 * targets whose shapes happen to be identical: TypeScript cannot tell those
 * apart, so a member count would read "two" and silently withdraw the omission
 * and the disconnect verb from a perfectly legal schema. The over-promise is
 * unreachable; the under-promise would not be.
 */
type VariantPointsAt<Entries, Source> = true extends {
  [Key in keyof Entries]: Entries[Key] extends { readonly getter: infer G }
    ? NamesModel<G, Source>
    : false;
}[keyof Entries]
  ? true
  : false;

/**
 * Steps 2-4. The keys of `Relations` that point at `Source`, carry the same
 * relation-name claim as the asker (an unnamed slot pairs only with an unnamed
 * candidate), and are not the excluded slot.
 */
type CandidateKeys<Relations, Source, AskingName, ExcludedKey> = {
  [Key in keyof Relations]: IsProvableRelationName<AskingName> extends true
    ? Key extends ExcludedKey
      ? never
      : PointsAt<Relations[Key], Source> extends true
        ? IsProvableRelationName<RelationName<Relations[Key]>> extends true
          ? IsExactly<RelationName<Relations[Key]>, AskingName> extends true
            ? Key
            : never
          : never
        : never
    : never;
}[keyof Relations];

type ForwardCandidates<SourceModel, FieldKey, R> = CandidateKeys<
  RelationsOf<TargetModelOf<R>>,
  SourceModel,
  RelationName<R>,
  IsSameModel<TargetModelOf<R>, SourceModel> extends true ? FieldKey : never
>;

/**
 * Step 5's reverse half, asked from the source model.
 *
 * The candidate is addressed by its KEY, never by its value. Step 4 already
 * proved its name claim is exactly the asker's, so `AskingName` is the same
 * name — and on a SELF pair the two slots can be type-IDENTICAL (two unnamed
 * `toMany` halves of a self junction are one type), which makes the key the
 * only thing that tells the candidate apart from the asking slot. Recovering
 * the key from the value would answer BOTH keys there, exclude both, and
 * collapse a provable self junction into `unknown`.
 */
type ReverseCandidates<SourceModel, TargetModel, CandidateKey, AskingName> =
  CandidateKeys<
    RelationsOf<SourceModel>,
    TargetModel,
    AskingName,
    IsSameModel<TargetModel, SourceModel> extends true ? CandidateKey : never
  >;

/**
 * Steps 5-6. The single forward candidate whose own candidate set is exactly
 * the asking slot, or `never` when the graph is unproven. The partner VALUE is
 * derived from this one key so the proof is computed once.
 */
type ProvenPartnerKey<SourceModel, FieldKey, R> =
  ForwardCandidates<SourceModel, FieldKey, R> extends infer Candidate
    ? [Candidate] extends [keyof RelationsOf<TargetModelOf<R>>]
      ? IsSingleKey<Candidate> extends true
        ? IsExactly<
            ReverseCandidates<
              SourceModel,
              TargetModelOf<R>,
              Candidate,
              RelationName<R>
            >,
            FieldKey
          > extends true
          ? Candidate
          : never
        : never
      : never
    : never;

type ProvenPartner<SourceModel, FieldKey, R> =
  ProvenPartnerKey<SourceModel, FieldKey, R> extends infer Key
    ? [Key] extends [keyof RelationsOf<TargetModelOf<R>>]
      ? RelationsOf<TargetModelOf<R>>[Key]
      : never
    : never;

// =============================================================================
// LOCAL SCALAR NULLABILITY (§8.1 `AnyNullableMember`, §8.4 nullable subset)
// =============================================================================

/**
 * Is one named local scalar PROVEN to accept NULL?
 *
 * `[nullable] extends [true]`, not `nullable extends true`, because a fresh
 * scalar state carries a WIDENED `boolean` here — `.nullable()` is the only
 * call that narrows it to `true`. That is the same reading the shipped scalar
 * output types already use (`ApplyNullable`, `InferBaseType`), so a relation's
 * derived nullability and its columns' declared nullability cannot disagree.
 * A key that is not a scalar on this model at all stays unproven.
 */
type ScalarNullability<M, Key> = Key extends keyof ScalarsOf<M>
  ? ScalarsOf<M>[Key] extends Scalar
    ? [ScalarsOf<M>[Key]["~"]["state"]["nullable"]] extends [true]
      ? true
      : false
    : unknown
  : unknown;

/**
 * The exact ordered subset of `Fields` whose local scalar is proven nullable,
 * or the literal `"unproven"` when any member's nullability is widened or its
 * scalar is not on the model. §8.4's disconnect writes exactly this subset and
 * retains the required context members.
 */
type NullableSubset<M, Fields> = Fields extends readonly [
  infer Head,
  ...infer Tail,
]
  ? NullableSubset<M, Tail> extends infer Rest
    ? [Rest] extends [readonly string[]]
      ? ScalarNullability<M, Head> extends true
        ? readonly [Head, ...Rest]
        : ScalarNullability<M, Head> extends false
          ? Rest
          : "unproven"
      : "unproven"
    : never
  : readonly [];

/** The proven subset, widened to the honest `readonly string[]` when unproven. */
export type NullableForeignFields<M, Fields> =
  NullableSubset<M, Fields> extends infer Subset
    ? [Subset] extends [readonly string[]]
      ? Subset
      : readonly string[]
    : never;

/**
 * Is ANY member of a stored tuple nullable — i.e. can the whole membership be
 * absent? Proven-none is `false`, at least one proven-nullable is `true`, and a
 * widened or statically unknown tuple is `boolean`. Every reader treats
 * anything except a proven `false` as nullable.
 */
export type AnyNullableMember<M, Fields> = Fields extends readonly string[]
  ? string extends Fields[number]
    ? boolean
    : NullableSubset<M, Fields> extends infer Subset
      ? [Subset] extends [readonly string[]]
        ? Subset extends readonly []
          ? false
          : true
        : boolean
      : never
  : boolean;

// =============================================================================
// THE PROJECTION
// =============================================================================

/**
 * The membership of ONE contextual slot: the model that asks, the exact field
 * key it asks under, and that field's relation.
 *
 * The asking identity is carried, never dropped: a model-to-relation mapped
 * type that projects only the relation value cannot exclude the asking slot,
 * and a self-relation would then select its own declaration as its inverse.
 */
export type StaticResolvedMembership<SourceModel, FieldKey, R> =
  TargetKind<R> extends "variants"
    ? StaticUnknownMembership
    : ForeignKeyOf<R> extends ForeignKeyDeclaration
      ? // The asking slot completed `.fields(...).references(...)`, so it owns
        // the row reference — but the pairing still has to hold, or there is no
        // edge to describe.
        [ProvenPartner<SourceModel, FieldKey, R>] extends [never]
        ? StaticUnknownMembership
        : StaticForeignKeyMembership<
            "asking",
            ForeignKeyOf<R>["fields"],
            NullableForeignFields<SourceModel, ForeignKeyOf<R>["fields"]>
          >
      : ProvenPartner<SourceModel, FieldKey, R> extends infer Partner
        ? [Partner] extends [never]
          ? StaticUnknownMembership
          : TargetKind<Partner> extends "variants"
            ? StaticVariantInverseMembership<
                ProvenPartnerKey<SourceModel, FieldKey, R> & string,
                // A member junction clears by deleting its membership row,
                // whatever the inverse cardinality; a row-held member clears
                // only when its carrier is optional (§8.4, §11.3.14).
                Cardinality<Partner> extends "many"
                  ? true
                  : HasOptionalModifier<Partner>
              >
            : ForeignKeyOf<Partner> extends ForeignKeyDeclaration
              ? StaticForeignKeyMembership<
                  "inverse",
                  ForeignKeyOf<Partner>["fields"],
                  NullableForeignFields<
                    TargetModelOf<R>,
                    ForeignKeyOf<Partner>["fields"]
                  >
                >
              : Cardinality<R> extends "many"
                ? Cardinality<Partner> extends "many"
                  ? StaticJunctionMembership
                  : StaticUnknownMembership
                : StaticUnknownMembership
        : never;

/**
 * May this slot be empty? A to-many ALWAYS — an empty collection is `[]`, and
 * a junction membership is always removable; a variant singular slot exactly
 * when it is `.optional()`; a foreign-key OWNER when any local member accepts
 * NULL; every non-owner and every unproven graph conservatively yes.
 */
export type SlotMayBeEmpty<SourceModel, FieldKey, R> =
  Cardinality<R> extends "many"
    ? true
    : TargetKind<R> extends "variants"
      ? HasOptionalModifier<R>
      : StaticResolvedMembership<SourceModel, FieldKey, R> extends {
            readonly kind: "foreignKey";
            readonly owner: "asking";
            readonly foreignFields: infer Fields;
          }
        ? AnyNullableMember<SourceModel, Fields>
        : true;

/**
 * Can the membership be cleared without deleting either record? A junction
 * membership always, a stored reference when its nullable subset is non-empty,
 * a variant inverse per its carrier's own proven clearability, and an unproven
 * graph never — a disconnect verb the graph cannot justify is exactly the
 * unsafe form §8.1 refuses to expose.
 */
export type MembershipCanBeCleared<SourceModel, FieldKey, R> =
  StaticResolvedMembership<SourceModel, FieldKey, R> extends infer Membership
    ? Membership extends StaticJunctionMembership
      ? true
      : Membership extends {
            readonly kind: "foreignKey";
            readonly foreignFields: infer Fields;
            readonly owner: infer Owner;
          }
        ? Owner extends "asking"
          ? AnyNullableMember<SourceModel, Fields>
          : AnyNullableMember<TargetModelOf<R>, Fields>
        : Membership extends {
              readonly kind: "variantInverse";
              readonly membershipCanBeCleared: infer CanBeCleared;
            }
          ? CanBeCleared
          : false
    : never;

/**
 * The exact target-schema keys a nested payload may NOT spell, because the
 * enclosing step derives them from the record it acted on: the INVERSE-held
 * foreign-key columns for a stored reference, and the carrier relation key for
 * a variant inverse. An asking-held foreign key names columns on the SOURCE
 * row, which a nested target payload could not spell anyway.
 */
export type DerivedNestedKeys<SourceModel, FieldKey, R> =
  StaticResolvedMembership<SourceModel, FieldKey, R> extends infer Membership
    ? Membership extends {
        readonly kind: "foreignKey";
        readonly owner: "inverse";
        readonly foreignFields: infer Fields extends readonly string[];
      }
      ? Fields[number]
      : Membership extends {
            readonly kind: "variantInverse";
            readonly carrierField: infer Carrier extends string;
          }
        ? Carrier
        : never
    : never;

/**
 * The membership view of one model, with every asking key preserved. A
 * `GetRelationsSchemas`-style projection that drops the key is not sufficient
 * (§8.1): the key IS step 2's exclusion input.
 */
export type ModelRelationMemberships<M> = {
  readonly [Key in keyof RelationsOf<M>]: StaticResolvedMembership<
    M,
    Key,
    RelationsOf<M>[Key]
  >;
};
