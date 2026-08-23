// The canonical relation declaration representation.
//
// A declaration states exactly two independent facts: the SLOT CARDINALITY the
// factory was spelled with (`toOne` / `toMany`) and the TARGET DOMAIN its
// argument names (one model, or named variants). Everything else about an edge —
// which endpoint owns the foreign key, whether storage is a row FK or a
// junction, whether the pair is one-to-one or many-to-many, whether a
// model-target singular slot may be empty — is DERIVED by the full-schema
// topology owner and is deliberately absent from this union.

import type { AnyModel } from "@schema/model";

/** Workaround to allow circular dependencies */
export type Getter = () => any;

/** Referential action for foreign key constraints */
export type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction";

/**
 * `setNull` is absent because every junction side is a non-null membership-key
 * member: the action would null a column that carries the membership itself.
 */
export type JunctionReferentialAction = Exclude<ReferentialAction, "setNull">;

/**
 * Last-call-wins at the type level: every modifier returns a new value whose
 * state REPLACES its own fact rather than intersecting with the prior one, so
 * repeating `.name(...)` keeps the last literal instead of collapsing to
 * `never`.
 */
export type Replace<State, Patch> = Omit<State, keyof Patch> & Patch;

/**
 * The getter overload's phantom refusal — the counterpart of
 * `VariantMapGuard`. It uniquely owns "not a map at all and not a getter": the
 * map overload is tried first, so without this guard a direct model object or a
 * malformed map reaching the getter overload would answer `never`, and `never`
 * is assignable to a model shape, which makes the refusal vanish.
 */
export type GetterOnly<G> = G extends Getter
  ? unknown
  : {
      readonly "a relation target is either `() => model` or a map of named `() => model` getters": never;
    };

/** How many rows one slot addresses. */
export type RelationCardinality = "one" | "many";

// =============================================================================
// TARGET DOMAIN
// =============================================================================

export type ModelTarget<G = any> = {
  readonly kind: "model";
  readonly getter: G;
};

/** One member junction's table and its two DIRECTED side naming tokens. */
export type VariantJunctionOverride = {
  readonly table: string;
  readonly source: string;
  readonly target: string;
};

/**
 * One normalized variant. The public map key stays the query/result/mutation
 * discriminator; `storedValue` is the string written to storage. They are two
 * facts, and a renamed public key with a preserved stored value is
 * metadata-only.
 */
export type VariantEntry<G = any> = {
  readonly getter: G;
  readonly storedValue: string;
};

export type VariantOneEntry<G = any> = VariantEntry<G> & {
  readonly junction?: never;
};

export type VariantManyEntry<G = any> = VariantEntry<G> & {
  readonly junction?: VariantJunctionOverride;
};

export type VariantTarget<
  Entries extends Readonly<Record<string, VariantEntry<any>>>,
> = {
  readonly kind: "variants";
  readonly entries: Entries;
};

// =============================================================================
// FOREIGN KEY AND JUNCTION CONFIGURATION
// =============================================================================

export type NonEmptyFieldTuple = readonly [string, ...string[]];

/**
 * The complete result of `.fields(...).references(...)`, plus the referential
 * actions that are only meaningful once that complete reference exists. A
 * partial foreign key is never a value of this type: the transient references
 * stage holds the local tuple until `.references(...)` completes the pair.
 */
export type ForeignKeyDeclaration<
  Fields extends NonEmptyFieldTuple = NonEmptyFieldTuple,
  References extends NonEmptyFieldTuple = NonEmptyFieldTuple,
> = {
  readonly fields: Fields;
  readonly references: References;
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
};

type AtLeastOne<Value> = {
  [Key in keyof Value]-?: Required<Pick<Value, Key>> &
    Partial<Omit<Value, Key>>;
}[keyof Value];

/**
 * Any subset of the canonical junction defaults, but never the empty object:
 * trusted state stores an override only when an override was declared.
 */
export type OrdinaryJunctionOverrides = AtLeastOne<{
  readonly table?: string;
  readonly source?: string;
  readonly target?: string;
  readonly onDelete?: JunctionReferentialAction;
  readonly onUpdate?: JunctionReferentialAction;
}>;

// =============================================================================
// THE CLOSED STATE UNION
// =============================================================================

/**
 * The broad state arms deliberately use `any` for the getter, not `G extends
 * Getter`: constraining a function-typed member forces TypeScript to resolve
 * recursive getter returns, and that resolution is circular in mutually
 * recursive schemas and silently collapses both model consts to `any`.
 * Comparing against `any` short-circuits without touching the return type.
 * Concrete factory states retain the exact getter or getter-map generic.
 */
export type ModelToOneState<
  G = any,
  ForeignKey extends ForeignKeyDeclaration | undefined =
    | ForeignKeyDeclaration
    | undefined,
> = {
  readonly kind: "relation";
  readonly cardinality: "one";
  readonly target: ModelTarget<G>;
  readonly name?: string;
  readonly junction?: never;
  readonly optional?: never;
} & (ForeignKey extends ForeignKeyDeclaration
  ? { readonly foreignKey: ForeignKey }
  : { readonly foreignKey?: never });

export type ModelToManyState<G = any> = {
  readonly kind: "relation";
  readonly cardinality: "many";
  readonly target: ModelTarget<G>;
  readonly name?: string;
  readonly junction?: OrdinaryJunctionOverrides;
  readonly foreignKey?: never;
  readonly optional?: never;
};

export type VariantToOneState<
  Entries extends Readonly<Record<string, VariantOneEntry<any>>> = Readonly<
    Record<string, VariantOneEntry<any>>
  >,
> = {
  readonly kind: "relation";
  readonly cardinality: "one";
  readonly target: VariantTarget<Entries>;
  readonly name?: string;
  readonly optional?: true;
  readonly foreignKey?: never;
  readonly junction?: never;
};

export type VariantToManyState<
  Entries extends Readonly<Record<string, VariantManyEntry<any>>> = Readonly<
    Record<string, VariantManyEntry<any>>
  >,
> = {
  readonly kind: "relation";
  readonly cardinality: "many";
  readonly target: VariantTarget<Entries>;
  readonly name?: string;
  readonly foreignKey?: never;
  readonly junction?: never;
  readonly optional?: never;
};

/**
 * Optional properties use one canonical representation: the property is absent,
 * or it holds the one normalized value. Trusted state never stores explicit
 * `undefined`, `false`, an empty override object, or a partial foreign key. The
 * `?: never` exclusions make illegal cross-arm configuration fail under
 * structural assignment too, so the algebra does not rely on excess-property
 * checking or factory etiquette.
 */
export type RelationState =
  | ModelToOneState
  | ModelToManyState
  | VariantToOneState
  | VariantToManyState;

/**
 * The two arms of one TARGET DOMAIN, named because the derived views split on
 * that axis before they split on anything else (§8.2): a variant target has a
 * discriminated element union, a discriminated projection envelope, and its own
 * family key set, whatever its cardinality.
 */
export type VariantRelationState = VariantToOneState | VariantToManyState;

/**
 * The predicate for {@link VariantRelationState} — one declared property read,
 * spelled once so both halves of a target-domain partition ask it the same way.
 * It classifies a declaration; it resolves nothing.
 */
export const isVariantRelationState = (
  state: RelationState
): state is VariantRelationState => state.target.kind === "variants";

// =============================================================================
// INTERNAL ACCESSOR
// =============================================================================

/**
 * The internal accessor every terminal exposes under `"~"`.
 *
 * `settleTarget` is the source-independent lazy once-cell required by the
 * declaration algebra: the first caller settles a target's raw getter return OR
 * one normalized `Error`, and every later consumer — in this schema graph or
 * another one reusing the same immutable terminal — observes that same outcome.
 * It is derived cache state, not a declaration fact; the resolver decides
 * whether a settled return is a registered model and owns the contextual
 * diagnostic, so nothing model-specific is cached here.
 */
export type RelationInternal<State> = {
  readonly state: State;
  /** Variant key for a variant target; omitted for a model target. */
  readonly settleTarget: (variantKey?: string) => unknown;
};

/** Any relation terminal, matched by its internal brand. */
export type AnyRelation = { readonly "~": RelationInternal<RelationState> };

/**
 * The identity of a contextual relation reference.
 *
 * A relation object does not store its source model: `.extends()` may reuse one
 * terminal under more than one model or key, so the source model plus the field
 * key is the whole identity and the declaration is read from that model's
 * canonical relation map rather than copied into the identity.
 */
export type RelationSlot = {
  readonly source: AnyModel;
  readonly field: string;
};
