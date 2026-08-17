/**
 * Result Types for ORM Client
 *
 * Provides type inference for operation results based on select/include args.
 * Works directly with ModelState for full type context (including omit settings).
 */

import type { Model, ModelState } from "@schema/model";
import type { ModelShape } from "@schema/model/helper";
import type { AnyPolymorphicRelation, AnyRelation } from "@schema/relation";
import type { Scalar, ScalarState } from "@schema/scalars";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Prettify } from "@validation";
import type { EnumValues } from "@validation/primitives/enum";

// =============================================================================
// SCALAR OUTPUT TYPE MAPPING
// =============================================================================

/**
 * Maps VibORM scalar types to their DATABASE RESULT types.
 * This is what the ORM returns after querying the database.
 *
 * Key difference from validation schema output:
 * - datetime/date/time: returns Date (not ISO string)
 * - json: inferred from custom schema if present, otherwise unknown
 * - enum: inferred from schema values
 */
type ScalarResultTypeMap = {
  string: string;
  int: number;
  float: number;
  // A decimal reads back as its exact canonical spelling. A JS number could not
  // carry the value a `numeric` / `DECIMAL(65,30)` column actually holds.
  decimal: string;
  boolean: boolean;
  datetime: Date; // Database results are Date objects, not ISO strings
  date: Date;
  time: string; // Time-only value as "HH:MM:SS" string
  bigint: bigint;
  json: unknown;
  blob: Uint8Array;
  vector: number[];
  point: { x: number; y: number };
  enum: string;
};

/**
 * Extract the ScalarState from a Scalar using infer to preserve literal types.
 */
type ExtractScalarState<F> = F extends { "~": { state: infer S } }
  ? S extends ScalarState
    ? S
    : never
  : never;

/**
 * Get the base scalar type for a field, handling custom schemas.
 * For json/enum scalars with custom schemas, infer from the schema.
 * For datetime fields, always return Date (regardless of validation schema output).
 *
 * Note: Enum types return `string` when accessed through relations due to type widening.
 * See BUG_REPORT_RELATION_TYPES.md Bug 1 for details.
 */
type GetScalarResultType<F extends Scalar> =
  ExtractScalarState<F> extends infer S
    ? S extends ScalarState
      ? S["type"] extends "json"
        ? S["schema"] extends StandardSchemaV1<any, infer O>
          ? O
          : unknown
        : S["type"] extends "enum"
          ? EnumValues<S["base"]>[number]
          : ScalarResultTypeMap[S["type"]]
      : unknown
    : unknown;

/**
 * Apply nullable wrapper based on scalar state.
 * Uses non-distributive check to handle boolean literals correctly.
 */
type ApplyNullable<T, Nullable> = [Nullable] extends [true] ? T | null : T;

/**
 * Apply array wrapper based on scalar state.
 * Uses non-distributive check to handle boolean literals correctly.
 */
type ApplyArray<T, IsArray> = [IsArray] extends [true] ? T[] : T;

/**
 * Infer the DATABASE RESULT type for a scalar.
 *
 * This is the canonical helper for inferring output types from scalars.
 * It correctly handles:
 * - All scalar types with proper DB result mapping (datetime → Date)
 * - Custom schemas for json/enum scalars
 * - Nullable scalars
 * - Array scalars
 *
 * @example
 * // For s.dateTime().nullable() → Date | null
 * // For s.string().array() → string[]
 * // For s.json().schema(z.object({...})) → { ... }
 */

export type InferScalarOutput<F extends Scalar> =
  ExtractScalarState<F> extends infer S
    ? S extends ScalarState
      ? ApplyNullable<
          ApplyArray<GetScalarResultType<F>, S["array"]>,
          S["nullable"]
        >
      : never
    : never;

// =============================================================================
// BATCH PAYLOAD
// =============================================================================

/**
 * Result for batch operations (createMany, updateMany, deleteMany)
 */
export interface BatchPayload {
  count: number;
}

// =============================================================================
// COUNT RESULT
// =============================================================================

/**
 * Result type for count operations
 * Supports select for per-field counts like Prisma: count({ select: { _all: true, name: true } })
 */
export type CountResultType<Args> = Args extends { select: infer S }
  ? Prettify<{ [K in keyof S as S[K] extends true ? K : never]: number }>
  : number;

// =============================================================================
// MODEL STATE HELPERS
// =============================================================================

/**
 * The non-recursive part of a model that result inference can compare safely.
 *
 * Full `Model` equality walks relation getters and collapses mutually-recursive
 * model consts. These three key sets identify the usual case without touching
 * any scalar implementation, external schema, or relation target.
 */
export type ModelResultSurface<M extends Model<any>> =
  M extends Model<infer S>
    ? readonly [
        Extract<keyof S["scalars"], string>,
        Extract<keyof S["relations"], string>,
        Extract<keyof S["polymorphicRelations"], string>,
      ]
    : never;

type SameKeySet<Left, Right> = [Exclude<Left, Right>] extends [never]
  ? [Exclude<Right, Left>] extends [never]
    ? true
    : false
  : false;

type IsUsableModelResultSurface<Surface> = [Surface] extends [never]
  ? false
  : Surface extends readonly [infer Scalars, infer Relations, infer Polymorphic]
    ? string extends Scalars
      ? false
      : string extends Relations
        ? false
        : string extends Polymorphic
          ? false
          : true
    : false;

/** Exact equality for the three shallow key sets above. */
export type SameModelResultSurface<Left, Right> =
  IsUsableModelResultSurface<Left> extends true
    ? IsUsableModelResultSurface<Right> extends true
      ? Left extends readonly [infer LS, infer LR, infer LP]
        ? Right extends readonly [infer RS, infer RR, infer RP]
          ? SameKeySet<LS, RS> extends true
            ? SameKeySet<LR, RR> extends true
              ? SameKeySet<LP, RP>
              : false
            : false
          : false
        : false
      : false
    : false;

/** One configured model's compact, client-owned result default. */
export interface ClientResultOmitEntry<Surface, Omission, Unique> {
  readonly surface: Surface;
  readonly omission: Omission;
  readonly unique: Unique;
}

/** Named boundary so TypeScript can cache the carrier during result recursion. */
export interface ClientResultOmitContext<Entries> {
  readonly entries: Entries;
}

type EntrySurface<Entry> =
  Entry extends ClientResultOmitEntry<infer Surface, unknown, unknown>
    ? Surface
    : never;

type MatchingClientOmitEntries<
  M extends Model<any>,
  Context,
  Entries = Context extends ClientResultOmitContext<infer E> ? E : never,
> = M extends unknown
  ? Entries extends unknown
    ? true extends SameModelResultSurface<
        ModelResultSurface<M>,
        EntrySurface<Entries>
      >
      ? Entries
      : never
    : never
  : never;

type IsUnion<T, Whole = T> = T extends Whole
  ? [Whole] extends [T]
    ? false
    : true
  : never;

type HasMultipleModelResultSurfaces<
  M extends Model<any>,
  WholeSurface = ModelResultSurface<M>,
> = M extends unknown
  ? SameModelResultSurface<ModelResultSurface<M>, WholeSurface> extends true
    ? false
    : true
  : never;

type EntryOmission<Entry> =
  Entry extends ClientResultOmitEntry<unknown, infer Omission, unknown>
    ? Omission
    : never;

type EntryUnique<Entry> =
  Entry extends ClientResultOmitEntry<unknown, unknown, infer Unique>
    ? Unique
    : never;

type PossibleOmitKeys<Entry> = Entry extends unknown
  ? keyof Exclude<EntryOmission<Entry>, undefined>
  : never;

type SoftenedResolvedOmit<Keys extends PropertyKey> = [Keys] extends [never]
  ? undefined
  : { [K in Keys]: boolean };

/**
 * Resolve a nested target's client default without comparing model graphs.
 *
 * A unique shallow surface identifies the configured model exactly. When two
 * schema models have the same surface, the current public types contain no
 * nominal identity that can distinguish their runtime objects. In that case,
 * every possibly omitted field becomes a widened boolean; `ApplyOmit` renders
 * it optional, which is honest in both runtime worlds.
 */
type ResolveClientOmit<
  M extends Model<any>,
  Context,
  Matches = MatchingClientOmitEntries<M, Context>,
  AmbiguousKeys extends PropertyKey = PossibleOmitKeys<Matches>,
> = [Context] extends [never]
  ? undefined
  : [Matches] extends [never]
    ? undefined
    : true extends HasMultipleModelResultSurfaces<M>
      ? SoftenedResolvedOmit<AmbiguousKeys>
      : true extends IsUnion<EntryOmission<Matches>>
        ? SoftenedResolvedOmit<AmbiguousKeys>
        : false extends EntryUnique<Matches>
          ? SoftenedResolvedOmit<AmbiguousKeys>
          : EntryOmission<Matches>;

/** Get the target model itself without resolving its recursive state. */
type GetTargetModel<R extends AnyRelation> =
  R["~"]["state"]["getter"] extends () => infer Target
    ? Target extends Model<any>
      ? Target
      : never
    : never;

/**
 * Get the target model's state from a relation
 */
export type GetTargetModelState<R extends AnyRelation> =
  GetTargetModel<R> extends infer T
    ? T extends Model<infer S>
      ? S extends ModelState
        ? S
        : never
      : never
    : never;

/**
 * Infer the output type for a model, respecting omit settings.
 * Uses InferScalarOutput for correct DB result types (e.g., Date for datetime).
 */
export type InferModelOutput<S extends ModelState> =
  S["omit"] extends Record<string, true>
    ? Omit<
        {
          [K in keyof S["scalars"]]: S["scalars"][K] extends Scalar
            ? InferScalarOutput<S["scalars"][K]>
            : never;
        },
        keyof S["omit"]
      >
    : {
        [K in keyof S["scalars"]]: S["scalars"][K] extends Scalar
          ? InferScalarOutput<S["scalars"][K]>
          : never;
      };

// =============================================================================
// OMIT
// =============================================================================

/**
 * `omit` at the TYPE level.
 *
 * Three cases, mirroring what the runtime can and cannot know:
 *  - `true` — the key is gone;
 *  - `false` (or absent) — the key stays;
 *  - a widened `boolean` (a variable, a spread, `cond ? true : false`) — only
 *    the runtime decides, so the key becomes OPTIONAL rather than being guessed
 *    into one arm. Claiming it is present would be a lie exactly when the flag
 *    is `true`, which is the case a caller writes this for.
 *
 * Model-level `.omit()` never appears here: those fields are absent from
 * `InferModelOutput` already, and the `omit` schema has no key to name them
 * with (see `src/validation/model/core/projection.ts`).
 */
type DefinitelyOmittedKeys<O> = {
  [K in keyof O]: [O[K]] extends [true] ? K : never;
}[keyof O];

type MaybeOmittedKeys<O> = {
  [K in keyof O]: [O[K]] extends [true]
    ? never
    : [O[K]] extends [false]
      ? never
      : boolean extends O[K]
        ? K
        : never;
}[keyof O];

type ReduceOmit<T, O> = Omit<
  T,
  Extract<DefinitelyOmittedKeys<O> | MaybeOmittedKeys<O>, keyof T>
> &
  Partial<Pick<T, Extract<MaybeOmittedKeys<O>, keyof T>>>;

/**
 * An `omit` that MAY be absent decides nothing on its own, so every key it
 * names softens to a widened `boolean` — which {@link ReduceOmit} renders as an
 * OPTIONAL key, the same convention a widened flag already follows. It is the
 * spread idiom's other half: `{ ...(cond && { omit: { title: true } }) }` types
 * `omit` as optional, and promising `title` outright would be a lie exactly
 * when `cond` holds.
 */
type SoftenNodeOmit<O> = { [F in keyof O]: boolean };

export type ApplyOmit<T, O> = [O] extends [undefined]
  ? T
  : undefined extends O
    ? ReduceOmit<T, SoftenNodeOmit<Exclude<O, undefined>>>
    : ReduceOmit<T, O>;

/**
 * Layer a query-local omission over a configured client default, per field.
 * A local `false` restores one configured field; an optional local omission
 * softens only the fields whose runtime value remains undecided.
 */
export type MergeClientOmit<Default, Local> = [Default] extends [undefined]
  ? Local
  : [Local] extends [undefined]
    ? Default
    : undefined extends Local
      ? Prettify<
          Omit<Default, keyof Exclude<Local, undefined>> & {
            [F in keyof Exclude<Local, undefined>]: boolean;
          }
        >
      : Prettify<Omit<Default, keyof Local> & Local>;

/**
 * The value a node STATES under one projection key, or `undefined` when it
 * states none.
 *
 * INDEXED ACCESS, not `Node extends { omit: infer O }`: a conditional matches a
 * REQUIRED property, so it reads an OPTIONAL one — the exact shape TypeScript
 * gives the spread idiom, `{ ...(cond && { select: sel }) }` -> `{ select?: Sel }`
 * — as "no such key", and the key would silently decide nothing. Indexed access
 * reports it as `Sel | undefined`, which is the truth: only the runtime knows.
 *
 * An object with a string INDEX SIGNATURE states nothing, for the same reason
 * `NoExtraClauseKeys` (./types.ts) refuses to police one: it declares no spelled
 * key, and reading `Record<string, unknown>["select"]` as a projection would
 * turn every dynamically-built payload into the ambiguous arm.
 */
type NodeKey<Node, Key extends string> = string extends keyof Node
  ? undefined
  : Key extends keyof Node
    ? Node[Extract<Key, keyof Node>]
    : undefined;

/**
 * Exported so the client layer can keep this query-local value distinct from
 * its configured default: selected worlds apply only this value, while
 * unselected worlds merge both before reducing the result.
 */
export type NodeOmit<Node> = NodeKey<Node, "omit">;

/**
 * The parse boundary treats an explicitly-`undefined` key as an ABSENT key
 * (`src/validation/primitives/object.ts`), which is what makes the
 * spread-an-optional idiom work; so `{ select: undefined }` and `{}` are the
 * same payload, and this helper reports them the same way.
 */
export type NodeSelect<Node> = NodeKey<Node, "select">;

export type NodeInclude<Node> = NodeKey<Node, "include">;

/**
 * Get relation type (oneToMany, manyToMany, oneToOne, manyToOne)
 */
export type GetRelationType<R extends AnyRelation> = R["~"]["state"]["type"];

/**
 * Check if a relation is optional
 */
export type GetRelationOptional<R extends AnyRelation> =
  R["~"]["state"]["optional"];

/** The configured target model at one public discriminator. */
type GetPolymorphicTarget<
  R extends AnyPolymorphicRelation,
  PublicType extends PropertyKey,
> = PublicType extends keyof R["~"]["state"]["targets"]
  ? R["~"]["state"]["targets"][PublicType] extends () => infer Target
    ? Target extends Model<any>
      ? Target
      : never
    : never
  : never;

type PolymorphicPublicTypes<R extends AnyPolymorphicRelation> = Extract<
  keyof R["~"]["state"]["targets"],
  string
>;

// =============================================================================
// RELATION RESULT
// =============================================================================

/**
 * Result for a relation when included
 * - To-many relations return arrays
 * - To-one relations return single objects (nullable if optional)
 */
/**
 * The relation's cardinality wrapper, applied to an already-built element type:
 * to-many is an array, an optional to-one is nullable, a required to-one is the
 * bare object. Factored out so the omit-aware node inference below wraps the
 * SAME way the three original helpers do.
 */
type WrapRelation<R extends AnyRelation, T> = [GetRelationType<R>] extends [
  "oneToMany" | "manyToMany",
]
  ? T[]
  : [GetRelationOptional<R>] extends [true]
    ? T | null
    : T;

type WrapRelationNode<R extends AnyRelation, T> = [T] extends [never]
  ? never
  : WrapRelation<R, T>;

export type InferRelationResult<
  R extends AnyRelation,
  ClientDefaults = never,
> = WrapRelation<
  R,
  ApplyOmit<
    InferModelOutput<GetTargetModelState<R>>,
    ResolveClientOmit<GetTargetModel<R>, ClientDefaults>
  >
>;

type InferPolymorphicTargetVariant<
  Target extends Model<any>,
  Override,
  ClientDefaults,
> = Target extends Model<infer TargetState>
  ? TargetState extends ModelState
    ? Override extends true
      ? ApplyOmit<
          InferModelOutput<TargetState>,
          ResolveClientOmit<Target, ClientDefaults>
        >
      : Override extends object
        ? InferSelectInclude<
            TargetState,
            Override,
            NodeSelect<Override>,
            MergeClientOmit<
              ResolveClientOmit<Target, ClientDefaults>,
              NodeOmit<Override>
            >,
            ClientDefaults
          >
        : ApplyOmit<
            InferModelOutput<TargetState>,
            ResolveClientOmit<Target, ClientDefaults>
          >
    : never
  : never;

/**
 * One configured polymorphic target. A missing projection key does not filter
 * that discriminator; it keeps the target model's default scalar output.
 */
type InferPolymorphicVariant<
  R extends AnyPolymorphicRelation,
  PublicType extends PolymorphicPublicTypes<R>,
  Override,
  ClientDefaults,
> = GetPolymorphicTarget<R, PublicType> extends infer Target
  ? Target extends Model<any>
    ? InferPolymorphicTargetVariant<Target, Override, ClientDefaults>
    : never
  : never;

type PolymorphicProjectionAt<
  Projection,
  PublicType extends PropertyKey,
> = PublicType extends keyof Projection ? Projection[PublicType] : undefined;

/**
 * Exhaustive direct polymorphic result. Projection objects override individual
 * targets; omitted targets remain in the union with their default projection.
 */
type PolymorphicVariants<
  R extends AnyPolymorphicRelation,
  Projection = undefined,
  ClientDefaults = never,
> = {
  [PublicType in PolymorphicPublicTypes<R>]: {
    readonly type: PublicType;
    readonly data: InferPolymorphicVariant<
      R,
      PublicType,
      PolymorphicProjectionAt<Projection, PublicType>,
      ClientDefaults
    >;
  };
}[PolymorphicPublicTypes<R>];

export type InferPolymorphicResult<
  R extends AnyPolymorphicRelation,
  Projection = undefined,
  ClientDefaults = never,
> = R["~"]["state"]["optional"] extends true
  ? PolymorphicVariants<R, Projection, ClientDefaults> | null
  : PolymorphicVariants<R, Projection, ClientDefaults>;

// =============================================================================
// SELECT/INCLUDE RESULT INFERENCE
// =============================================================================

/**
 * Infer result from select/include args
 * - select: ONLY returns selected fields
 * - include: returns base model + included relations
 * - neither: returns base model output
 *
 * The dispatch is on the select VALUE, not on key presence. `{ select: undefined }`
 * is the spread-an-optional idiom collapsed to a literal `undefined`, and the
 * parse boundary hands the engine a payload with no projection at all — so it
 * returns the full default row, exactly like `{}`. Reading it as "a selection of
 * nothing" typed that call `{}`, and `rows[0].id` stopped compiling on a call
 * that returns `id` at runtime.
 *
 * `select` + `include` is refused only when both keys carry values. `omit`
 * composes with either projection mode: in the selected world it subtracts
 * from the selected shape; in the unselected world it subtracts from the
 * default scalar shape.
 */
export type InferSelectInclude<
  S extends ModelState,
  Args,
  Selection = NodeSelect<Args>,
  UnselectedOmit = NodeOmit<Args>,
  ClientDefaults = never,
> = [Selection] extends [undefined]
  ? InferUnselectedRow<S, Args, UnselectedOmit, ClientDefaults>
  : undefined extends Selection
    ? // Only the runtime value decides, so the result is the honest UNION of
      // both worlds — the same ambiguous arm `BulkWriteResult` takes for
      // `updateMany({ select: maybeSelect })`. Collapsing it to the full row
      // (which is what reading the key's PRESENCE did) claimed every column on a
      // call that returns one; collapsing it to the projection would claim the
      // opposite. A caller in this position narrows, which is exactly the choice
      // they deferred to runtime.
        | InferUnselectedRow<S, Args, UnselectedOmit, ClientDefaults>
        | InferSelectedRow<
            S,
            Args,
            Exclude<Selection, undefined>,
            ClientDefaults
          >
    : InferSelectedRow<S, Args, Selection, ClientDefaults>;

/**
 * The row a node returns in the world where its `select` carries a value.
 *
 * `select` is exclusive with `include`, so a definite include makes this world
 * impossible. A local `omit` is different: it subtracts from the selected
 * result. Keys outside the selected shape have no effect.
 */
type InferSelectedRow<
  S extends ModelState,
  Args,
  Selection,
  ClientDefaults,
> = undefined extends NodeInclude<Args>
  ? InferSelectResult<S, Selection, NodeOmit<Args>, ClientDefaults>
  : never;

/**
 * The row a node returns when it states no `select`: the model's own output,
 * plus whatever `include` adds, reduced by the node's `omit`.
 *
 * An `include` that MAY be absent is read as ABSENT — the common ground of both
 * worlds — while a MAYBE `omit` softens instead (`ApplyOmit`). The asymmetry is
 * the direction of the lie: `include` only ADDS keys, so promising the smaller
 * row promises nothing that is missing at runtime, and the caller who wants the
 * relation spells the `include` definitely; `omit` REMOVES them, so reading a
 * maybe-omit as absent would promise a column the runtime may have dropped.
 */
type InferUnselectedRow<
  S extends ModelState,
  Args,
  Omission = NodeOmit<Args>,
  ClientDefaults = never,
> = undefined extends NodeInclude<Args>
  ? ApplyOmit<InferModelOutput<S>, Omission>
  : ApplyOmit<
      InferIncludeResult<S, NodeInclude<Args>, ClientDefaults>,
      Omission
    >;

/**
 * Result when select is provided - ONLY selected fields are returned
 */
export type InferSelectResult<
  S extends ModelState,
  Selection,
  Omission = undefined,
  ClientDefaults = never,
> = Prettify<
  ApplyOmit<
    InferSelectedFields<S, Selection, ClientDefaults> &
      InferSelectedPolymorphicFields<S, Selection, ClientDefaults> &
      InferRelationCountSelection<S, Selection>,
    Omission
  > &
    InferVectorDistanceSelection<S, Selection, Omission>
>;

type InferSelectedFields<S extends ModelState, Selection, ClientDefaults> = {
  [K in keyof Selection & keyof S["shape"] as S["shape"][K] extends Scalar
    ? Selection[K] extends true
      ? K
      : never
    : S["shape"][K] extends AnyRelation
      ? Selection[K] extends true | object
        ? K
        : never
      : never]: S["shape"][K] extends Scalar
    ? InferScalarOutput<S["shape"][K]>
    : S["shape"][K] extends AnyRelation
      ? Selection[K] extends true
        ? InferRelationResult<S["shape"][K], ClientDefaults>
        : Selection[K] extends object
          ? InferRelationNodeResult<S["shape"][K], Selection[K], ClientDefaults>
          : never
      : never;
};

type InferSelectedPolymorphicFields<
  S extends ModelState,
  Selection,
  ClientDefaults,
> = string extends keyof S["polymorphicRelations"]
  ? unknown
  : keyof S["polymorphicRelations"] extends never
    ? unknown
    : {
        [K in keyof Selection &
          keyof S["polymorphicRelations"] as Selection[K] extends true | object
          ? K
          : never]: S["polymorphicRelations"][K] extends AnyPolymorphicRelation
          ? Selection[K] extends true
            ? InferPolymorphicResult<
                S["polymorphicRelations"][K],
                undefined,
                ClientDefaults
              >
            : Selection[K] extends object
              ? InferPolymorphicResult<
                  S["polymorphicRelations"][K],
                  Selection[K],
                  ClientDefaults
                >
              : never
          : never;
      };

type VectorScalarFieldKeys<S extends ModelState> = {
  [K in keyof S["shape"]]: S["shape"][K] extends Scalar
    ? [ExtractScalarState<S["shape"][K]>] extends [ScalarState<"vector">]
      ? K
      : never
    : never;
}[keyof S["shape"]];

type SelectedVectorDistanceKeys<S extends ModelState, Selection> = {
  [K in keyof Selection & VectorScalarFieldKeys<S>]: Selection[K] extends {
    _distance: unknown;
  }
    ? K
    : never;
}[keyof Selection & VectorScalarFieldKeys<S>];

type SelectedVectorDistanceSources<S extends ModelState, Selection> = {
  [K in SelectedVectorDistanceKeys<S, Selection>]: true;
};

type RemainingVectorDistanceSources<
  S extends ModelState,
  Selection,
  Omission,
> = ApplyOmit<SelectedVectorDistanceSources<S, Selection>, Omission>;

type RequiredKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K;
}[keyof T];

type InferVectorDistanceSelection<
  S extends ModelState,
  Selection,
  Omission = undefined,
  Remaining = RemainingVectorDistanceSources<S, Selection, Omission>,
> = [keyof Remaining] extends [never]
  ? Record<never, never>
  : [RequiredKeys<Remaining>] extends [never]
    ? { _distance?: number }
    : { _distance: number };

/**
 * To-many (list) relation keys — the exact set Prisma's `_count: true`
 * shorthand expands to (`<Model>CountOutputType` holds only list relations).
 */
type ToManyRelationKeys<S extends ModelState> = {
  [K in keyof S["relations"]]: S["relations"][K] extends AnyRelation
    ? [GetRelationType<S["relations"][K]>] extends ["oneToMany" | "manyToMany"]
      ? K
      : never
    : never;
}[keyof S["relations"]];

type InferRelationCountSelection<
  S extends ModelState,
  Selection,
> = Selection extends { _count: { select: infer CountSelection } }
  ? {
      _count: {
        [K in keyof CountSelection &
          keyof S["relations"] as CountSelection[K] extends true | object
          ? K
          : never]: number;
      };
    }
  : Selection extends { _count: true }
    ? { _count: { [K in ToManyRelationKeys<S>]: number } }
    : Record<never, never>;

/**
 * Result when include is provided - base result + included relations
 */
export type InferIncludeResult<
  S extends ModelState,
  Include,
  ClientDefaults = never,
> = Prettify<
  InferModelOutput<S> & {
    [K in keyof Include & keyof S["relations"] as Include[K] extends
      | true
      | object
      ? K
      : never]: S["relations"][K] extends AnyRelation
      ? Include[K] extends true
        ? InferRelationResult<S["relations"][K], ClientDefaults>
        : Include[K] extends object
          ? InferRelationNodeResult<
              S["relations"][K],
              Include[K],
              ClientDefaults
            >
          : never
      : never;
  } & InferIncludedPolymorphicFields<S, Include, ClientDefaults> &
    InferRelationCountSelection<S, Include>
>;

type InferIncludedPolymorphicFields<
  S extends ModelState,
  Include,
  ClientDefaults,
> = string extends keyof S["polymorphicRelations"]
  ? unknown
  : keyof S["polymorphicRelations"] extends never
    ? unknown
    : {
        [K in keyof Include &
          keyof S["polymorphicRelations"] as Include[K] extends true | object
          ? K
          : never]: S["polymorphicRelations"][K] extends AnyPolymorphicRelation
          ? Include[K] extends true
            ? InferPolymorphicResult<
                S["polymorphicRelations"][K],
                undefined,
                ClientDefaults
              >
            : Include[K] extends object
              ? InferPolymorphicResult<
                  S["polymorphicRelations"][K],
                  Include[K],
                  ClientDefaults
                >
              : never
          : never;
      };

/**
 * Nested select result for a relation
 */
export type InferNestedSelectResult<R extends AnyRelation, NS> = WrapRelation<
  R,
  InferSelectResult<GetTargetModelState<R>, NS>
>;

/**
 * Nested include result for a relation
 */
export type InferNestedIncludeResult<R extends AnyRelation, NI> = WrapRelation<
  R,
  InferIncludeResult<GetTargetModelState<R>, NI>
>;

/**
 * A relation node in `select`/`include` position: `{ select }`, `{ include }`,
 * `{ omit }`, pagination-only (`{ where, take, … }`), or any combination the
 * parse boundary accepts. A selected node applies its local omit after the
 * selection. An unselected node applies it to the default/include shape.
 * Pagination-only nodes fall through to the full relation payload.
 */
type InferRelationNodeResult<
  R extends AnyRelation,
  Node,
  ClientDefaults = never,
> = WrapRelationNode<
  R,
  InferSelectInclude<
    GetTargetModelState<R>,
    Node,
    NodeSelect<Node>,
    MergeClientOmit<
      ResolveClientOmit<GetTargetModel<R>, ClientDefaults>,
      NodeOmit<Node>
    >,
    ClientDefaults
  >
>;

// =============================================================================
// AGGREGATE RESULT TYPES
// =============================================================================

/**
 * Extract scalar keys from a ModelShape
 */
type ScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar ? K : never;
}[keyof T];

/**
 * Infer base type from a scalar for aggregates.
 * Uses InferScalarOutput for correct DB result types.
 */
type InferScalarBase<F> = F extends Scalar ? InferScalarOutput<F> : never;

/** True when the scalar is a decimal, whose aggregates stay exact strings. */
type IsDecimalScalar<F> =
  ExtractScalarState<F> extends { type: "decimal" } ? true : false;

/**
 * Result type for aggregate operations
 * Dynamically typed based on which aggregates are requested
 *
 * THE RULE, and it is the RESULT PARSER's rule, not a guess:
 * `result-aggregate-parser.ts` marks `_sum` / `_min` / `_max` as `typed` and
 * decodes them through the FIELD'S OWN scalar decoder, so those three come back
 * spelled exactly like the column — `_sum` of an `s.bigInt()` is a `bigint`,
 * `_sum` of an `s.decimal()` is an exact string. Only `_avg` takes the
 * widen-to-number path, and even it stays a string for a decimal, because an
 * average of decimals is still a decimal the database computed exactly.
 *
 * `_sum` used to be typed `number` for everything but a decimal, which made
 * `agg._sum.big * 2` type-check and then throw "Cannot mix BigInt and other
 * types" — and, worse, `agg._sum.big === 150` silently false. The decoder is the
 * half that is pinned behaviorally (tests/drivers/scalar-roundtrip-behavior.ts),
 * so the type follows it.
 */
export type AggregateResultType<T extends ModelShape, Args> = Prettify<{
  [K in keyof Args as K extends `_${string}` ? K : never]: K extends "_count"
    ? Args[K] extends true
      ? number
      : Args[K] extends object
        ? { [F in keyof Args[K]]: number }
        : never
    : K extends "_sum"
      ? Args[K] extends object
        ? {
            // Decoded through the field's own scalar: bigint -> bigint,
            // decimal -> string, int/float -> number.
            [F in keyof Args[K]]:
              | (F extends ScalarKeys<T> ? InferScalarBase<T[F]> : number)
              | null;
          }
        : never
      : K extends "_avg"
        ? Args[K] extends object
          ? {
              // An average OF decimals is still a decimal; every other numeric
              // widens to a JS number, bigint included.
              [F in keyof Args[K]]:
                | (F extends ScalarKeys<T>
                    ? IsDecimalScalar<T[F]> extends true
                      ? string
                      : number
                    : number)
                | null;
            }
          : never
        : K extends "_min" | "_max"
          ? Args[K] extends object
            ? {
                [F in keyof Args[K]]: F extends ScalarKeys<T>
                  ? InferScalarBase<T[F]> | null
                  : never;
              }
            : never
          : never;
}>;

// =============================================================================
// GROUPBY RESULT TYPES
// =============================================================================

/**
 * Result type for groupBy operations
 * Includes the grouped-by fields plus any requested aggregates
 */
export type GroupByResultType<T extends ModelShape, Args> = Args extends {
  by: infer B;
}
  ? Prettify<
      // Grouped-by fields
      (B extends readonly (infer K)[]
        ? K extends ScalarKeys<T> & keyof T
          ? { [F in K]: InferScalarBase<T[F]> }
          : never
        : B extends ScalarKeys<T> & keyof T
          ? { [F in B]: InferScalarBase<T[F]> }
          : never) &
        // Aggregate fields
        AggregateResultType<T, Args>
    >
  : never;
