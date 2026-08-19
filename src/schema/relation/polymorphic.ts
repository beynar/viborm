import type { AnyModel } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";
// Type-only by necessity: `junction-topology` imports this module's
// `PolymorphicThroughEntry` type, and the ONE runtime call site pairing the two
// modules lives in `@schema/validation/rules/polymorphic` — keeping both edges
// type-only is what keeps the pair cycle-free.
import type { ResolvedJunctionTopology } from "./junction-topology";
import type { Getter } from "./types";

export type PolymorphicTargetGetters = Readonly<Record<string, Getter>>;

/**
 * How many rows one polymorphic slot addresses.
 *
 * Declared by the factory the carrier is spelled with — `s.polymorphicToOne`
 * or `s.polymorphicToMany` — and read back through `polymorphicCardinality` in
 * `./cardinality`. Distinct from `PolymorphicInverseCardinality` below, which
 * describes the *inverse* slot on the target side, not the declared slot.
 */
export type PolymorphicCardinality = "one" | "many";

/**
 * A CONFIGURED carrier's state. `cardinality` is required — that is the gate.
 *
 * There is no cardinality-less state interface any more: the two factories are
 * the only public constructors and each stamps its own `cardinality`, so the
 * unconfigured shape is not spellable through the public surface. Hostile
 * JavaScript can still forge one past the terminal's constructor, which is what
 * P013 exists to eject (see `isPolymorphicRelation` below).
 *
 * `optional` stays declared here rather than only on the to-one arm so that the
 * `State["optional"]` indexings in the validation layer keep resolving —
 * `filter.ts:58`, `filter.ts:60`, `update.ts:124` in
 * `src/validation/relations/polymorphic/` and the requiredness test in
 * `src/validation/model/core/create.ts`. The to-many arm narrows it to `never`
 * (below). On the concrete states the chain produces (which never declare
 * `optional`), the indexing evaluates to `unknown`; on the bare
 * `PolymorphicToManyState` interface it evaluates to `undefined`. Neither
 * extends `true`, which is the only question those gates ask — so they answer
 * exactly as they do for a non-optional relation.
 */
export interface PolymorphicRelationState<
  Targets extends PolymorphicTargetGetters = PolymorphicTargetGetters,
  Values extends Readonly<Record<string, string>> = Readonly<
    Record<string, string>
  >,
> {
  readonly type: "polymorphic";
  readonly targets: Targets;
  readonly values: Values;
  readonly cardinality: PolymorphicCardinality;
  readonly name?: string;
  readonly optional?: true;
}

export interface PolymorphicToOneState<
  Targets extends PolymorphicTargetGetters = PolymorphicTargetGetters,
  Values extends Readonly<Record<string, string>> = Readonly<
    Record<string, string>
  >,
> extends PolymorphicRelationState<Targets, Values> {
  readonly cardinality: "one";
}

/**
 * `optional` is declared `never` rather than dropped: dropping it would leave the
 * inherited `optional?: true` spellable on a collection state, and a carrier
 * forced into a collection state could then carry a second reading of emptiness the
 * empty collection already gives. Declaring it keeps `State["optional"]` legal
 * for the shared indexings and makes `optional: true` unassignable.
 */
export interface PolymorphicToManyState<
  Targets extends PolymorphicTargetGetters = PolymorphicTargetGetters,
  Values extends Readonly<Record<string, string>> = Readonly<
    Record<string, string>
  >,
> extends PolymorphicRelationState<Targets, Values> {
  readonly cardinality: "many";
  readonly optional?: never;
  /** Explicit member-junction names, keyed by public variant — `.through()`. */
  readonly through?: Readonly<Record<string, PolymorphicThroughEntry>>;
}

export interface PolymorphicStorageMember {
  readonly storedType: string;
  readonly targetModel: AnyModel;
  readonly referencedField: string;
}

/**
 * One explicit `.through()` override for a collection member's junction names:
 * the member table and the two DIRECTED side naming tokens (the `.A()`/`.B()`
 * concept, but owner-side and variant-side rather than alphabetical).
 */
export interface PolymorphicThroughEntry {
  readonly table: string;
  readonly source: string;
  readonly target: string;
}

export interface PolymorphicStorageColumn {
  readonly name: string;
  readonly scalar: Scalar;
  readonly nullable: boolean;
}

export type PolymorphicInverseCardinality = "one" | "many";

/** The row-held `(type, id)` descriptor a validated to-one declaration builds. */
export interface PolymorphicToOneStorage {
  readonly kind: "toOne";
  readonly relationName: string;
  readonly ownerModel: AnyModel;
  readonly indexName: string;
  readonly typeColumn: PolymorphicStorageColumn;
  readonly idColumn: PolymorphicStorageColumn;
  /** Relation-wide BY DESIGN (plan §2.3): a to-one slot's inverses share one storage shape. */
  readonly inverseCardinality: PolymorphicInverseCardinality;
  readonly members: ReadonlyMap<string, PolymorphicStorageMember>;
}

/**
 * One collection member's complete junction facts: everything Package C's
 * engine bind needs, resolved ONCE at definition validation — C never reaches
 * back into a live relation and never repeats `resolvePolymorphicEdge`'s
 * synthetic-relation trick.
 */
export interface PolymorphicJunctionMember {
  readonly publicType: string;
  /**
   * Plan §5.1 spells this `storageValue`; the entire estate
   * (`PolymorphicStorageMember`, the snapshot member shapes,
   * `RuntimePolymorphicInverseCandidate`) spells the same fact `storedType`.
   * Kept as `storedType` — one fact, one name; the divergence from the plan's
   * spelling is deliberate and recorded here.
   */
  readonly storedType: string;
  readonly targetModel: AnyModel;
  /** MEMBER-local (plan §2.3): each variant's inverse chooses "one" or "many" independently; "many" is the shareable default (§2.4). */
  readonly inverseCardinality: "one" | "many";
  readonly junction: ResolvedJunctionTopology;
}

/** The member-junction descriptor a validated collection declaration builds. */
export interface PolymorphicToManyStorage {
  readonly kind: "toMany";
  readonly relationName: string;
  readonly ownerModel: AnyModel;
  /** Keyed by publicType, declaration order. */
  readonly members: ReadonlyMap<string, PolymorphicJunctionMember>;
}

export type PolymorphicStorage =
  | PolymorphicToOneStorage
  | PolymorphicToManyStorage;

export interface PolymorphicInverseBinding<
  RelationKey extends string = string,
  PublicType extends string = string,
  StoredType extends string = string,
> {
  readonly relationKey: RelationKey;
  readonly publicType: PublicType;
  readonly storedType: StoredType;
}

interface ModelWithPolymorphicRelations {
  readonly "~": {
    readonly state: {
      readonly polymorphicRelations: Readonly<
        Record<string, AnyPolymorphicRelation>
      >;
    };
  };
}

type StateContainsSource<
  State extends PolymorphicRelationState,
  SourceModel,
> = {
  [PublicType in keyof State["targets"]]: State["targets"][PublicType] extends () => SourceModel
    ? PublicType
    : never;
}[keyof State["targets"]] extends never
  ? false
  : true;

type RelationContainsSource<Relation, SourceModel> =
  PolymorphicStateOf<Relation> extends infer State extends
    PolymorphicRelationState
    ? [State] extends [never]
      ? false
      : StateContainsSource<State, SourceModel>
    : false;

type PolymorphicRelationKeys<TargetModel> =
  TargetModel extends ModelWithPolymorphicRelations
    ? Extract<keyof TargetModel["~"]["state"]["polymorphicRelations"], string>
    : never;

type RelationCarriesName<Relation, Name> =
  PolymorphicStateOf<Relation> extends infer State extends
    PolymorphicRelationState
    ? [State] extends [never]
      ? false
      : State["name"] extends Name
        ? true
        : false
    : false;

type NamedPolymorphicRelationKeys<TargetModel, Name> =
  TargetModel extends ModelWithPolymorphicRelations
    ? {
        [RelationKey in keyof TargetModel["~"]["state"]["polymorphicRelations"]]: RelationCarriesName<
          TargetModel["~"]["state"]["polymorphicRelations"][RelationKey],
          Name
        > extends true
          ? Extract<RelationKey, string>
          : never;
      }[keyof TargetModel["~"]["state"]["polymorphicRelations"]]
    : never;

type UnionToIntersection<Union> = (
  Union extends unknown
    ? (value: Union) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

type IsSingleMember<Union> = [Union] extends [never]
  ? false
  : [Union] extends [UnionToIntersection<Union>]
    ? true
    : false;

type SelectedRelationKey<TargetModel, Name> =
  IsSingleMember<PolymorphicRelationKeys<TargetModel>> extends true
    ? PolymorphicRelationKeys<TargetModel>
    : Name extends string
      ? IsSingleMember<
          NamedPolymorphicRelationKeys<TargetModel, Name>
        > extends true
        ? NamedPolymorphicRelationKeys<TargetModel, Name>
        : never
      : never;

type RelationKeyBinding<TargetModel, SourceModel, RelationKey> =
  TargetModel extends ModelWithPolymorphicRelations
    ? RelationKey extends keyof TargetModel["~"]["state"]["polymorphicRelations"]
      ? RelationContainsSource<
          TargetModel["~"]["state"]["polymorphicRelations"][RelationKey],
          SourceModel
        > extends true
        ? { readonly relationKey: Extract<RelationKey, string> }
        : never
      : never
    : never;

export type GetPolymorphicInverseBinding<TargetModel, SourceModel, Name> =
  RelationKeyBinding<
    TargetModel,
    SourceModel,
    SelectedRelationKey<TargetModel, Name>
  >;

export interface RuntimePolymorphicInverseCandidate
  extends PolymorphicInverseBinding {
  readonly pairingName: string | undefined;
}

export interface ResolvedPolymorphicTargetEntry {
  readonly publicType: string;
  readonly targetGetter: unknown;
  readonly targetModel: unknown;
  readonly storedType: unknown;
}

export function getPolymorphicInverseCandidates(
  targetModel: AnyModel,
  sourceModel: AnyModel
): RuntimePolymorphicInverseCandidate[] {
  const candidates: RuntimePolymorphicInverseCandidate[] = [];
  const relations: Readonly<Record<string, AnyPolymorphicRelation>> =
    targetModel["~"].state.polymorphicRelations;
  for (const [relationKey, relation] of Object.entries(relations)) {
    for (const {
      publicType,
      targetGetter,
      targetModel,
      storedType,
    } of relation["~"].targetEntries()) {
      if (typeof targetGetter !== "function") continue;
      if (targetModel !== sourceModel) continue;
      if (typeof storedType !== "string") continue;
      candidates.push({
        relationKey,
        publicType,
        storedType,
        pairingName: relation["~"].state.name,
      });
    }
  }
  return candidates;
}

// Both are deliberately UNCONSTRAINED. The factories' `Targets` also admits a
// bare `Getter` so that `TargetMapOnly` can refuse it with a useful message
// (below), and a `Targets extends PolymorphicTargetGetters` constraint here
// would force the call sites to spell `Targets & PolymorphicTargetGetters` —
// whose `keyof` is `string`, which silently drops the exact key set these two
// exist to carry.
type ValuesFor<Targets> = {
  readonly [Key in Extract<keyof Targets, string>]: string;
};

type DefaultValuesFor<Targets> = {
  readonly [Key in Extract<keyof Targets, string>]: Key;
};

type NoExtraKeys<Given, Allowed> = Record<
  Exclude<keyof Given, keyof Allowed>,
  never
>;

/**
 * The MAP-ONLY refusal, and the only thing that refuses a bare target thunk.
 *
 * Both factories widen their `Targets` constraint to admit a `Getter` on
 * purpose: a candidate refused by the constraint is silently replaced with the
 * constraint itself, and the diagnostic then names `Record<string, Getter>`
 * instead of what the caller should have written. Admitting the thunk into
 * inference and refusing it HERE is what puts the four ordinary factories in
 * the error text. The conditional return type strips the same case, so the
 * carrier a valid map produces is unchanged.
 *
 * Why refuse it at all: `s.polymorphicToOne(() => user)` reads like an ordinary
 * edge and would silently build a private `(type, id)` pair where the caller
 * expected a foreign key.
 */
type TargetMapOnly<Targets> = Targets extends (...args: never) => unknown
  ? {
      readonly "a polymorphic relation takes a MAP of named targets; for a single target model use s.oneToOne, s.manyToOne, s.oneToMany or s.manyToMany": never;
    }
  : unknown;

/** A carrier that addresses at most one row across its targets. */
export class PolymorphicToOneRelation<State extends PolymorphicToOneState> {
  private readonly state: State;
  private resolvedTargetEntries:
    | readonly ResolvedPolymorphicTargetEntry[]
    | undefined;

  constructor(state: State) {
    this.state = Object.freeze({
      ...state,
      targets: snapshotRecord(state.targets),
      values: snapshotRecord(state.values),
    });
  }

  name<const Name extends string>(name: Name) {
    return new PolymorphicToOneRelation<State & { readonly name: Name }>({
      ...this.state,
      name,
    });
  }

  optional() {
    return new PolymorphicToOneRelation<State & { readonly optional: true }>({
      ...this.state,
      optional: true,
    });
  }

  private internal:
    | {
        readonly state: State;
        readonly targetEntries: () => readonly ResolvedPolymorphicTargetEntry[];
      }
    | undefined;

  get "~"() {
    return (this.internal ??= {
      state: this.state,
      targetEntries: () =>
        (this.resolvedTargetEntries ??= resolveTargetEntries(this.state)),
    });
  }
}

/**
 * A carrier that addresses a collection across its targets.
 *
 * No `.optional()`: an empty collection is the empty case, so there is no
 * second reading of emptiness to declare.
 */
export class PolymorphicToManyRelation<State extends PolymorphicToManyState> {
  private readonly state: State;
  private resolvedTargetEntries:
    | readonly ResolvedPolymorphicTargetEntry[]
    | undefined;

  constructor(state: State) {
    this.state = Object.freeze({
      ...state,
      targets: snapshotRecord(state.targets),
      values: snapshotRecord(state.values),
      through: snapshotThroughMap(state.through),
    });
  }

  name<const Name extends string>(name: Name) {
    return new PolymorphicToManyRelation<State & { readonly name: Name }>({
      ...this.state,
      name,
    });
  }

  /**
   * Name every member junction explicitly. The map is EXACT in both directions
   * at the type level — every public variant must appear, no extra variant key
   * and no extra entry key is admitted, fresh or held in a variable (the same
   * structural instrument as the factories' options bag) — and P017 is the
   * runtime mirror of the same contract.
   */
  through<
    const Map extends {
      readonly [Key in Extract<
        keyof State["targets"],
        string
      >]: PolymorphicThroughEntry;
    },
  >(
    map: Map &
      NoExtraKeys<Map, State["targets"]> & {
        readonly [Key in keyof Map]: NoExtraKeys<
          Map[Key],
          PolymorphicThroughEntry
        >;
      }
  ) {
    return new PolymorphicToManyRelation<State & { readonly through: Map }>({
      ...this.state,
      through: map,
    });
  }

  private internal:
    | {
        readonly state: State;
        readonly targetEntries: () => readonly ResolvedPolymorphicTargetEntry[];
      }
    | undefined;

  get "~"() {
    return (this.internal ??= {
      state: this.state,
      targetEntries: () =>
        (this.resolvedTargetEntries ??= resolveTargetEntries(this.state)),
    });
  }
}

export type AnyPolymorphicRelation =
  | PolymorphicToOneRelation<PolymorphicToOneState>
  | PolymorphicToManyRelation<PolymorphicToManyState>;

/**
 * The ONE place both terminal classes are named together.
 *
 * Every type that used to match the single `PolymorphicRelation<infer State>`
 * class goes through here. A value that is not a configured carrier — an
 * ordinary relation, a scalar, or a forged carrier of some other shape —
 * resolves to `never`, which each caller must refuse explicitly: silently
 * widening the match collapses `GetPolymorphicInverseBinding` to `never`
 * everywhere with no compile error.
 */
export type PolymorphicStateOf<Relation> =
  Relation extends PolymorphicToOneRelation<infer OneState>
    ? OneState
    : Relation extends PolymorphicToManyRelation<infer ManyState>
      ? ManyState
      : never;

/**
 * Declare a carrier that addresses AT MOST ONE row across its targets.
 *
 * The target map's key is the public query/result discriminator and, by
 * default, the stored discriminator; pass the exact `{ values }` bag when
 * storage needs stable namespaced or versioned values. A single target model is
 * an ordinary relation — use `s.oneToOne`, `s.manyToOne`, `s.oneToMany` or
 * `s.manyToMany` — and a bare thunk here is refused by `TargetMapOnly`.
 */
export function polymorphicToOne<
  const Targets extends PolymorphicTargetGetters | Getter,
>(
  targets: Targets & TargetMapOnly<Targets>,
  options?: undefined
): Targets extends PolymorphicTargetGetters
  ? PolymorphicToOneRelation<{
      readonly type: "polymorphic";
      readonly cardinality: "one";
      readonly targets: Targets;
      readonly values: DefaultValuesFor<Targets>;
    }>
  : never;

export function polymorphicToOne<
  const Targets extends PolymorphicTargetGetters | Getter,
  const Values extends ValuesFor<Targets>,
  const Options extends { readonly values: Values },
>(
  targets: Targets & TargetMapOnly<Targets>,
  // The whole options bag is exact, not only `values`: a NON-FRESH bag with a
  // sibling key beside `values` sails through excess-property checking, so the
  // unknown keys are refused structurally — the same instrument as
  // `ExactOptions` in `@schema/model` (AGENTS.md, "Refuse structurally").
  options: Options & {
    readonly values: Values & NoExtraKeys<Values, ValuesFor<Targets>>;
  } & NoExtraKeys<Options, { values: unknown }>
): Targets extends PolymorphicTargetGetters
  ? PolymorphicToOneRelation<{
      readonly type: "polymorphic";
      readonly cardinality: "one";
      readonly targets: Targets;
      readonly values: Values;
    }>
  : never;

export function polymorphicToOne(
  targets: PolymorphicTargetGetters,
  options?: {
    readonly values: Readonly<Record<string, string>>;
  }
): PolymorphicToOneRelation<PolymorphicToOneState> {
  const state: PolymorphicToOneState = {
    type: "polymorphic",
    cardinality: "one",
    targets,
    values: options?.values ?? defaultStoredValues(targets),
  };
  return new PolymorphicToOneRelation(state);
}

/**
 * Declare a carrier that addresses a COLLECTION across its targets.
 *
 * Same target map and same exact `{ values }` bag as `polymorphicToOne`; the
 * membership lives in one fixed-target member junction per variant, which
 * `.through()` can name explicitly. No `.optional()`: an empty collection is
 * already the empty case.
 */
export function polymorphicToMany<
  const Targets extends PolymorphicTargetGetters | Getter,
>(
  targets: Targets & TargetMapOnly<Targets>,
  options?: undefined
): Targets extends PolymorphicTargetGetters
  ? PolymorphicToManyRelation<{
      readonly type: "polymorphic";
      readonly cardinality: "many";
      readonly targets: Targets;
      readonly values: DefaultValuesFor<Targets>;
    }>
  : never;

export function polymorphicToMany<
  const Targets extends PolymorphicTargetGetters | Getter,
  const Values extends ValuesFor<Targets>,
  const Options extends { readonly values: Values },
>(
  targets: Targets & TargetMapOnly<Targets>,
  options: Options & {
    readonly values: Values & NoExtraKeys<Values, ValuesFor<Targets>>;
  } & NoExtraKeys<Options, { values: unknown }>
): Targets extends PolymorphicTargetGetters
  ? PolymorphicToManyRelation<{
      readonly type: "polymorphic";
      readonly cardinality: "many";
      readonly targets: Targets;
      readonly values: Values;
    }>
  : never;

export function polymorphicToMany(
  targets: PolymorphicTargetGetters,
  options?: {
    readonly values: Readonly<Record<string, string>>;
  }
): PolymorphicToManyRelation<PolymorphicToManyState> {
  const state: PolymorphicToManyState = {
    type: "polymorphic",
    cardinality: "many",
    targets,
    values: options?.values ?? defaultStoredValues(targets),
  };
  return new PolymorphicToManyRelation(state);
}

function defaultStoredValues(
  targets: PolymorphicTargetGetters
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Reflect.ownKeys(targets)
      .filter((key): key is string => typeof key === "string")
      .map((key) => [key, key])
  );
}

/**
 * A DATA snapshot, not a descriptor copy: every own property is read exactly
 * once here and pinned as a plain value. A live accessor in a caller-supplied
 * `targets` or `values` map could otherwise answer definition validation with
 * one value and the storage builder with another — the measured dodge was a
 * getter returning a valid stored type on its second read only, giving zero
 * issues and a malformed stored discriminator. Reading the accessor's VALUE
 * does not invoke target thunks; they are stored as functions and stay lazy.
 */
function snapshotRecord<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null) return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor: PropertyDescriptor = Reflect.get(descriptors, key);
    Object.defineProperty(copy, key, {
      value: Reflect.get(value, key),
      enumerable: descriptor.enumerable === true,
    });
  }
  return Object.freeze(copy);
}

/**
 * The `.through()` map's snapshot is ONE LEVEL DEEPER than `snapshotRecord`:
 * the map's own properties are entry OBJECTS, and a live accessor on an entry
 * (`table` answering validation with one name and a later reader with another)
 * is the same dodge the data snapshot exists to close. The outer call pins the
 * entry references once; the inner call then pins each entry's own properties
 * once — every own property on both levels is read exactly once, at
 * construction.
 */
function snapshotThroughMap<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null) return value;
  const pinnedEntries = snapshotRecord(value);
  const copy = Object.create(Object.getPrototypeOf(pinnedEntries));
  for (const key of Reflect.ownKeys(pinnedEntries)) {
    const descriptor = Object.getOwnPropertyDescriptor(pinnedEntries, key);
    Object.defineProperty(copy, key, {
      value: snapshotRecord(Reflect.get(pinnedEntries, key)),
      enumerable: descriptor?.enumerable === true,
    });
  }
  return Object.freeze(copy);
}

function resolveTargetEntries(
  state: PolymorphicRelationState
): readonly ResolvedPolymorphicTargetEntry[] {
  if (typeof state.targets !== "object" || state.targets === null) return [];
  const values =
    typeof state.values === "object" && state.values !== null
      ? state.values
      : undefined;
  const entries: ResolvedPolymorphicTargetEntry[] = [];
  for (const publicType of Reflect.ownKeys(state.targets)) {
    if (typeof publicType !== "string") continue;
    const targetGetter = Reflect.get(state.targets, publicType);
    entries.push({
      publicType,
      targetGetter,
      targetModel:
        typeof targetGetter === "function" ? targetGetter() : undefined,
      storedType: values ? Reflect.get(values, publicType) : undefined,
    });
  }
  return Object.freeze(entries);
}

/**
 * Keyed on `state.type` alone, BY DESIGN — no `cardinality` test here.
 *
 * The public surface can no longer produce a cardinality-less carrier: each
 * factory stamps its own. Hostile JavaScript still can — a forged state handed
 * to a terminal's constructor — and such a carrier must still be extracted into
 * `ModelState.polymorphicRelations` so that `validatePolymorphicRelations` can
 * attribute P013 to it. Adding a cardinality test would make it disappear from
 * model extraction instead, which is silence, not refusal. The declared
 * predicate is therefore deliberately optimistic for hostile carriers, exactly
 * as it already is for malformed target maps.
 */
export function isPolymorphicRelation(
  value: unknown
): value is AnyPolymorphicRelation {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  const internal = Reflect.get(value, "~");
  if (typeof internal !== "object" || internal === null) return false;
  const state = Reflect.get(internal, "state");
  return (
    typeof state === "object" &&
    state !== null &&
    Reflect.get(state, "type") === "polymorphic"
  );
}
