/**
 * Client Types
 *
 * Provides the typed Client interface for ORM operations.
 * All input types are inferred from schema validation.
 * All result types are inferred from result-types.ts.
 */

import type { PendingOperation } from "@query-engine/pending-operation";
import type { Model, ModelState } from "@schema/model";
import type { ModelShape } from "@schema/model/helper";
import type {
  Cardinality,
  TargetKind,
  VariantEntries,
} from "@schema/relation/static-membership";
import type { ScalarState } from "@schema/scalars";
import type { Prettify } from "@validation";
import type {
  ModelArgsSchemas,
  ModelOperationInput,
  ModelOperationOutput,
} from "@validation/model";
import type { DecimalUpdateOperationKeys } from "@validation/scalars";
import type { CacheInvalidationOptions } from "../cache/schema";
import type { VibORMConfig } from "./client";
import type {
  AggregateResultType,
  BatchPayload,
  ClientResultOmitContext,
  ClientResultOmitEntry,
  CountResultType,
  GroupByResultType,
  InferSelectInclude,
  MergeClientOmit,
  ModelResultSurface,
  NodeOmit,
  NodeSelect,
  SameModelResultSurface,
} from "./result-types";

export type Schema = Record<string, Model<any>>;

export type Operations =
  | "findFirst"
  | "findMany"
  | "findUnique"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "delete"
  | "deleteMany"
  | "findUniqueOrThrow"
  | "findFirstOrThrow"
  | "count"
  | "aggregate"
  | "groupBy"
  | "upsert"
  | "exist";

/**
 * Operations that can be cached (read-only operations)
 */
export type CacheableOperations =
  | "findFirst"
  | "findMany"
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirstOrThrow"
  | "count"
  | "aggregate"
  | "groupBy"
  | "exist";

/**
 * Operations that mutate data (not cacheable)
 */
export type MutationOperations =
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "delete"
  | "deleteMany"
  | "upsert";

/**
 * Extract shape from a Model - works with Model<any>
 */
type ExtractFields<M> =
  M extends Model<infer S>
    ? S extends { shape: infer F }
      ? F extends ModelShape
        ? F
        : ModelShape
      : ModelShape
    : ModelShape;

/**
 * Operation payload type - passes Model directly to args types
 * Each args type extracts what it needs internally from schema inference
 */
export type OperationPayload<
  O extends Operations,
  M extends Model<any>,
> = O extends "findMany"
  ? ModelOperationInput<M, "findMany">
  : O extends "findUnique"
    ? ModelOperationInput<M, "findUnique">
    : O extends "findFirst"
      ? ModelOperationInput<M, "findFirst">
      : O extends "create"
        ? ModelOperationInput<M, "create">
        : O extends "update"
          ? ModelOperationInput<M, "update">
          : O extends "delete"
            ? ModelOperationInput<M, "delete">
            : O extends "deleteMany"
              ? ModelOperationInput<M, "deleteMany">
              : O extends "upsert"
                ? ModelOperationInput<M, "upsert">
                : O extends "findUniqueOrThrow"
                  ? ModelOperationInput<M, "findUnique">
                  : O extends "findFirstOrThrow"
                    ? ModelOperationInput<M, "findFirst">
                    : O extends "count"
                      ? ModelOperationInput<M, "count">
                      : O extends "aggregate"
                        ? ModelOperationInput<M, "aggregate">
                        : O extends "groupBy"
                          ? ModelOperationInput<M, "groupBy">
                          : O extends "createMany"
                            ? ModelOperationInput<M, "createMany">
                            : O extends "updateMany"
                              ? ModelOperationInput<M, "updateMany">
                              : O extends "exist"
                                ? ModelOperationInput<M, "exist">
                                : never;

type OperationSchemaName<O extends Operations> = O extends "findUniqueOrThrow"
  ? "findUnique"
  : O extends "findFirstOrThrow"
    ? "findFirst"
    : O;

/** The normalized value produced by an operation payload schema. */
export type ValidatedOperationPayload<
  O extends Operations,
  M extends Model<any>,
> = Exclude<
  ModelOperationOutput<
    M,
    Extract<OperationSchemaName<O>, keyof ModelArgsSchemas<M>>
  >,
  undefined
>;

/**
 * IMPLICIT RETURNING (maintainer decision D-1: `createManyAndReturn` /
 * `updateManyAndReturn` are removed, not aliased). A bulk write returns
 * `{ count }` unless the call carries a `select` or `omit`, in which case it
 * returns projected rows. The conditional stays zero-codegen: `Args` is
 * inferred from the call-site literal.
 *
 * The rule covers `deleteMany` too, which has no Prisma counterpart at all: the
 * rows come back as they are removed, so a caller no longer has to read-then-
 * delete and hope nothing moved in between.
 *
 * The runtime discriminant is
 * `args.select !== undefined || args.omit !== undefined` (routing.ts), so this
 * type discriminates on values, not key presence. The naked conditionals keep
 * every runtime world when either value may be `undefined`.
 */
type BulkWriteResult<
  S extends ModelState,
  Args,
  DefaultOmit = undefined,
  Selection = NodeSelect<Args>,
  Omission = NodeOmit<Args>,
> = Selection extends undefined
  ? Omission extends undefined
    ? BatchPayload
    : BulkProjectionRows<S, undefined, MergeClientOmit<DefaultOmit, Omission>>
  : BulkProjectionRows<S, Selection, Omission>;

/** One row-returning bulk world, after both projection values are known. */
type BulkProjectionRows<S extends ModelState, Selection, Omission> = Prettify<
  InferSelectInclude<S, { select: Selection; omit: Omission }>
>[];

// =============================================================================
// CLIENT-LEVEL `omit`, AT THE TYPE LEVEL
// =============================================================================

/*
 * `defaultOmit()({ user: { passwordHash: true } })` is a DEFAULT the runtime
 * folds into an unselected node's `omit` before validation
 * (`applyClientOmit`, ./omit.ts). The types below apply that default only in
 * the same unselected result world; an explicit select uses the caller's local
 * omit alone.
 *
 * Threading it matters in one direction in particular: without it the runtime
 * drops the column while the type still promises a `string`, which is the lie
 * that survives review and reaches production.
 *
 * Nested results use a compact client-owned carrier made only from scalar,
 * relation, and polymorphic-relation key sets. It avoids the full structural
 * model comparison that collapses mutually-recursive consts. A unique surface
 * resolves exactly; an indistinguishable surface softens possibly omitted
 * fields to optional because the public model types carry no nominal identity.
 */

/** The private default-omit carrier, or `undefined` when the client has none. */
type ConfigOmit<C> = C extends unknown
  ? "omit" extends keyof C
    ? C[Extract<"omit", keyof C>]
    : undefined
  : never;

/**
 * Discard a record keyed by an INDEX SIGNATURE rather than by names.
 *
 * A schema-generic derived client may widen the private carrier to
 * `{ [model: string]: { [field: string]: boolean } }`. That names nothing.
 * Reading it as "every field of every model might be hidden" would make every
 * result key optional, so it is read as no default stated.
 */
type NamedOnly<O> = O extends unknown
  ? string extends keyof NonNullable<O>
    ? undefined
    : O
  : never;

/** The private carrier entry for one model key, `undefined` when none. */
type ModelOmitEntry<All, K extends PropertyKey> = All extends unknown
  ? [All] extends [undefined]
    ? undefined
    : K extends keyof All
      ? All[K]
      : undefined
  : never;

type PossibleOmitFieldKeys<O> = O extends unknown
  ? [O] extends [undefined]
    ? never
    : keyof O
  : never;

type PossibleOmitFieldValue<O, K extends PropertyKey> = O extends unknown
  ? [O] extends [undefined]
    ? false
    : K extends keyof O
      ? O[K]
      : false
  : never;

type NormalizePossibleOmit<O> = {
  [K in PossibleOmitFieldKeys<O>]: [PossibleOmitFieldValue<O, K>] extends [true]
    ? true
    : [PossibleOmitFieldValue<O, K>] extends [false]
      ? false
      : boolean;
};

/**
 * A default the type cannot pin down degrades to MAYBE, never to "no": every
 * field it could name becomes a widened `boolean`, which `ApplyOmit` renders as
 * an OPTIONAL key — the same convention a widened query-level flag already
 * follows. Reading an uncertain default as "absent" would claim a field is
 * present exactly when the config that hides it is in play.
 */
type SoftenOmit<O> = [O] extends [undefined]
  ? undefined
  : NormalizePossibleOmit<O>;

/** What this client hides by default for one model of its schema. */
export type ClientDefaultOmit<
  C extends VibORMConfig,
  K extends keyof C["schema"],
> = NamedOnly<SoftenOmit<ModelOmitEntry<NamedOnly<ConfigOmit<C>>, K>>>;

type ConfiguredOmitRecordKeys<O> = O extends unknown
  ? [O] extends [undefined]
    ? never
    : keyof O
  : never;

type ConfiguredOmitModelKeys<C extends VibORMConfig> = Extract<
  ConfiguredOmitRecordKeys<NamedOnly<ConfigOmit<C>>>,
  keyof C["schema"]
>;

type ModelsWithResultSurface<
  C extends VibORMConfig,
  K extends keyof C["schema"],
> = {
  [Candidate in keyof C["schema"]]: SameModelResultSurface<
    ModelResultSurface<C["schema"][K]>,
    ModelResultSurface<C["schema"][Candidate]>
  > extends true
    ? Candidate
    : never;
}[keyof C["schema"]];

type HasUniqueResultSurface<
  C extends VibORMConfig,
  K extends keyof C["schema"],
> = SameModelResultSurface<
  ModelResultSurface<C["schema"][K]>,
  ModelResultSurface<C["schema"][K]>
> extends true
  ? [Exclude<ModelsWithResultSurface<C, K>, K>] extends [never]
    ? true
    : false
  : false;

type ClientRelationOmitEntries<C extends VibORMConfig> = {
  [K in ConfiguredOmitModelKeys<C>]: ClientResultOmitEntry<
    ModelResultSurface<C["schema"][K]>,
    ClientDefaultOmit<C, K>,
    HasUniqueResultSurface<C, K>
  >;
}[ConfiguredOmitModelKeys<C>];

type ClientRelationOmitContext<C extends VibORMConfig> = [
  ConfiguredOmitModelKeys<C>,
] extends [never]
  ? never
  : ClientResultOmitContext<ClientRelationOmitEntries<C>>;

declare const defaultOperationResultArgs: unique symbol;
type DefaultOperationResultArgs = typeof defaultOperationResultArgs;

type ResolvedOperationResultArgs<Args, Merged> =
  Merged extends DefaultOperationResultArgs ? Args : Merged;

type ResolvedOperationResultOmit<Args, DefaultOmit, Merged> =
  Merged extends DefaultOperationResultArgs
    ? MergeClientOmit<DefaultOmit, NodeOmit<Args>>
    : NodeOmit<Merged>;

/**
 * Operation result type - infers result shape based on select/include args
 * This provides full type safety for ORM operation results
 *
 * `DefaultOmit` is the client-level default for THIS model (`ClientDefaultOmit`);
 * it defaults to `undefined`, so calling this type with three arguments is the
 * unconfigured client and behaves exactly as it did before. It is merged only
 * into the unselected result world. A selected world ignores the client
 * default but still applies the query's own `omit`, matching `rewriteNode`.
 * `Merged` remains the public full-args override that predates client-level
 * omit; its private marker default lets the implementation distinguish an
 * omitted fifth argument from an explicit effective args type.
 */
type OperationResultWithClientDefaults<
  O extends Operations,
  M extends Model<any>,
  Args,
  DefaultOmit,
  ClientDefaults,
  Merged = DefaultOperationResultArgs,
  ResultArgs = ResolvedOperationResultArgs<Args, Merged>,
  UnselectedOmit = ResolvedOperationResultOmit<Args, DefaultOmit, Merged>,
> = M extends Model<infer S>
  ? O extends "findFirst" | "findUnique"
    ? Prettify<
        InferSelectInclude<
          S,
          ResultArgs,
          NodeSelect<ResultArgs>,
          UnselectedOmit,
          ClientDefaults
        >
      > | null
    : O extends "findFirstOrThrow" | "findUniqueOrThrow"
      ? Prettify<
          InferSelectInclude<
            S,
            ResultArgs,
            NodeSelect<ResultArgs>,
            UnselectedOmit,
            ClientDefaults
          >
        >
      : O extends "findMany"
        ? Prettify<
            InferSelectInclude<
              S,
              ResultArgs,
              NodeSelect<ResultArgs>,
              UnselectedOmit,
              ClientDefaults
            >
          >[]
        : O extends "create" | "update" | "delete" | "upsert"
          ? Prettify<
              InferSelectInclude<
                S,
                ResultArgs,
                NodeSelect<ResultArgs>,
                UnselectedOmit,
                ClientDefaults
              >
            >
          : O extends "createMany" | "updateMany" | "deleteMany"
            ? BulkWriteResult<S, Args, DefaultOmit>
            : O extends "count"
              ? CountResultType<Args>
              : O extends "exist"
                ? boolean
                : O extends "aggregate"
                  ? AggregateResultType<ExtractFields<M>, Args>
                  : O extends "groupBy"
                    ? GroupByResultType<ExtractFields<M>, Args>[]
                    : never
  : never;

/**
 * Public operation result helper. Its fifth generic remains the historical
 * complete effective-args override; nested client defaults are internal to a
 * concrete `Client<C>` and do not change this standalone contract.
 */
export type OperationResult<
  O extends Operations,
  M extends Model<any>,
  Args,
  DefaultOmit = undefined,
  Merged = DefaultOperationResultArgs,
  ResultArgs = ResolvedOperationResultArgs<Args, Merged>,
  UnselectedOmit = ResolvedOperationResultOmit<Args, DefaultOmit, Merged>,
> = OperationResultWithClientDefaults<
  O,
  M,
  Args,
  DefaultOmit,
  never,
  Merged,
  ResultArgs,
  UnselectedOmit
>;

/** One concrete client's result, including its top-level and relation defaults. */
export type ClientOperationResult<
  C extends VibORMConfig,
  ModelName extends keyof C["schema"],
  O extends Operations,
  Args,
> = OperationResultWithClientDefaults<
  O,
  C["schema"][ModelName],
  Args,
  ClientDefaultOmit<C, ModelName>,
  ClientRelationOmitContext<C>
>;

/**
 * Client type - provides fully typed access to all model operations
 * Each operation returns a Promise with the properly inferred result type
 */
export type Client<
  C extends VibORMConfig,
  ClientDefaults = ClientRelationOmitContext<C>,
  ExtensionCache extends boolean = false,
> = {
  [K in keyof C["schema"]]: {
    [O in Operations]: Operation<
      O,
      C["schema"][K],
      ClientDefaultOmit<C, K>,
      ClientDefaults,
      ExtensionCache
    >;
  };
};

export type ClientRelationDefaults<C extends VibORMConfig> =
  ClientRelationOmitContext<C>;

type WithoutCacheKey<T> = T extends { cache?: infer _ }
  ? Omit<T, "cache"> & {}
  : T;

type IsClientCacheEnabled<ExtensionCache extends boolean> = [
  ExtensionCache,
] extends [true]
  ? true
  : false;

type ClientOperationPayload<
  O extends Operations,
  T,
  ExtensionCache extends boolean,
> = O extends MutationOperations
  ? IsClientCacheEnabled<ExtensionCache> extends true
    ? T extends object
      ? Omit<T, "cache"> & { cache?: CacheInvalidationOptions }
      : T
    : WithoutCacheKey<T>
  : WithoutCacheKey<T>;

/**
 * Every key ONE clause accepts, taking the union across a union-typed clause
 * rather than `keyof` of the union — `keyof (A | B)` is the keys A and B SHARE,
 * which would refuse `cursor: { email }` on a model whose unique variants are a
 * union. A key any member accepts is accepted.
 */
type ClauseKeys<Allowed> = Allowed extends unknown ? keyof Allowed : never;

/**
 * The keys a caller SPELLED on one value — `never` for anything with no spelled
 * key to misspell:
 *  - an ARRAY, because `keyof` a tuple is its indices;
 *  - an object with a string INDEX SIGNATURE (`Record<string, unknown>`, the
 *    shape a helper that forwards a dynamically-built clause has), because it
 *    declares no spelled key and a key nobody spelled cannot be misspelled —
 *    this rule is about literal surfaces;
 *  - a primitive.
 *
 * Distributive, so a union of element types contributes every member's keys.
 */
type SpelledClauseKeys<Given> = Given extends object
  ? Given extends readonly unknown[]
    ? never
    : string extends keyof Given
      ? never
      : keyof Given
  : never;

/**
 * The keys spelled inside an ARRAY clause that no element of the payload
 * accepts — the array spelling's equivalent of the `Exclude` below.
 */
type UnknownArrayClauseKeys<
  Given extends readonly unknown[],
  Allowed,
> = Exclude<SpelledClauseKeys<Given[number]>, ClauseKeys<NonNullable<Allowed>>>;

/**
 * What the ARRAY spelling of a clause is refused WITH. The key cannot be
 * reported on itself there (see `NoExtraClauseKeys`), so the clause as a whole
 * is refused and this type carries the offending key into the message:
 * `… is not assignable to type '… & UnknownClauseKey<"ttitle">'`.
 */
type UnknownClauseKey<K> = { readonly __unknownKeyInClause: K };

/**
 * The unknown keys of one clause value (`where`, `select`, `orderBy`, …).
 *
 * An ARRAY — `orderBy: [{ title: "asc" }, { pages: "desc" }]`, Prisma's standard
 * multi-key spelling — is checked at its ELEMENTS, and refused as a WHOLE when
 * any element spells a key the payload does not accept. Both halves of that are
 * measured, not chosen:
 *
 *  - `keyof` the array itself cannot be subtracted: a tuple's `keyof` includes
 *    its indices while an unbounded array's does not, so the subtraction would
 *    demand `never` at index 0 and refuse `orderBy: [{ title: "asc" }]` outright.
 *    That is why the element type is what gets the key set.
 *  - the per-KEY form the object spelling uses does not survive on an element.
 *    Stated as `readonly Partial<Record<extra, never>>[]`, tsc 5.8.3 reports the
 *    CORRECT key and one more: on `[{ title: "asc", ttitle: "asc" }]` both
 *    `title` and `ttitle` came back "not assignable to never", because that
 *    element type becomes the literal's contextual type and comes back through
 *    the same inference. Worse, it also declares the typo a KNOWN property, so
 *    `orderBy: [{ ttitle: "asc" }]` — refused today by excess-property checking —
 *    started compiling. Refusing the clause loses the caret on the key and keeps
 *    both of those from happening; `UnknownClauseKey` puts the key in the message
 *    instead.
 *
 * `unknown` — no refusal — for an index-signature object and for a primitive,
 * for the reasons on `SpelledClauseKeys`.
 *
 * `Given` arrives with `undefined`/`null` already stripped (see `ClauseGuard`).
 */
type NoExtraClauseKeys<Given, Allowed> = Given extends readonly unknown[]
  ? [UnknownArrayClauseKeys<Given, Allowed>] extends [never]
    ? unknown
    : UnknownClauseKey<UnknownArrayClauseKeys<Given, Allowed>>
  : string extends keyof Given
    ? unknown
    : Given extends object
      ? Record<Exclude<keyof Given, ClauseKeys<NonNullable<Allowed>>>, never>
      : unknown;

/**
 * The typo'd keys of an operation's args, at the operation's OWN level and at
 * each clause inside it.
 *
 * The clause level is not decoration. `Arg` is inferred FROM the literal, so
 * every key the caller wrote is "known" to `Arg` by construction and
 * excess-property checking has nothing to say at any depth; and `Arg extends
 * Payload` does not refuse a typo either, because a clause payload is a weak
 * type (all-optional) and an object with extra keys is structurally assignable
 * to it. What DID refuse `where: { ttitle: "x" }` was TypeScript's weak-type
 * detection — an object sharing NO property with a weak type is an error — and
 * that stops the moment one real key sits beside the typo:
 * `where: { title: "x", ttitle: "x" }` compiled and filtered on `title` alone.
 * A probe with the typo alone therefore measures weak-type detection, not this
 * surface.
 *
 * The clause value has its `undefined`/`null` STRIPPED before it is keyed, and
 * that is not a nicety: `NoExtraClauseKeys` is a conditional on a naked `Given`,
 * so it distributes, and the `undefined` member is not an array, has no index
 * signature and is not `object` — it fell through to `unknown`, and
 * `X | unknown` is `unknown`. One optional clause value therefore switched the
 * guard off entirely, for exactly the spelling real code uses
 * (`where: userId ? { userId } : undefined`, or a helper forwarding an optional
 * property). Stripping it keys the shape the caller can actually pass; the
 * clause property stays OPTIONAL, so `where: undefined` itself is still legal —
 * that is the parse-boundary rule (`{ f: undefined }` behaves as `{}`) the whole
 * client surface follows.
 *
 * The clause list is EXPLICIT, and it is explicit because the general form does
 * not survive. Mapping over `keyof Arg` — guarding every clause — crashes
 * tsc 5.8.3 outright (`TypeError: Cannot read properties of undefined (reading
 * 'kind')` inside `getModifierFlagsWorker`). Naming the clauses instead, the
 * measured ceiling is:
 *
 *  - `where` / `select` / `include` / `orderBy` / `omit` — guarded, in all three
 *    spellings a caller writes them: a fresh literal, a value that may be
 *    `undefined`, and (for `orderBy`) an array. Their key sets are the model's
 *    scalars and relation NAMES, a finite set TypeScript already computes.
 *    Estate type-check 34s → 45s when the guard landed; adding the other two
 *    spellings cost nothing measurable (same tree, back-to-back runs: 83.3s vs
 *    78.1s user, the difference inside the noise of a loaded machine).
 *  - `data` / `create` / `update` — NOT generally guarded. A write clause's
 *    payload is the recursive nested-write union, and reaching for its keys
 *    expands it: six estate sites turn `TS2589: Type instantiation is
 *    excessively deep`, and the type-check goes to 172s. The one narrow
 *    exception is a DIRECT decimal update leaf below: its operation keys come
 *    from the scalar's exact-one owner and it never walks a relation input.
 *  - `cursor` / `having` / `cache` — NOT guarded. Three more TS2589 sites, on
 *    compound-unique and aggregate payloads.
 *
 * Depth 3 is out of reach for the same reason: `where.title.contians` or
 * `select.books.select` means walking INTO a relation, which resolves the target
 * model mid-inference — exactly what `RelationState.getter: any` exists to
 * prevent. Every unguarded level is pinned as a compiling misspelling in
 * `tests/client/contextual-typing-gate.test.ts`, so the boundary is a measured
 * fact rather than an assumption, and a future TypeScript that can carry more
 * turns those pins red.
 */
type ClauseGuard<Arg, Payload, K extends string> = K extends keyof Arg
  ? K extends keyof Payload
    ? { [P in K]?: NoExtraClauseKeys<NonNullable<Arg[K]>, Payload[K]> }
    : unknown
  : unknown;

type ValueAt<Container, Key extends PropertyKey> = Container extends unknown
  ? Key extends keyof Container
    ? Container[Key]
    : never
  : never;

type PolymorphicVariantKeys<Relation> = keyof VariantEntries<Relation>;

/**
 * The VARIANT-target keys of the one relation map — the only members whose
 * projection is a discriminator map or a collection envelope rather than an
 * ordinary relation node. Reading target kind here is what replaces the second
 * model-level map the guard used to be handed.
 */
type VariantRelationKeys<Relations> = {
  [Key in keyof Relations]: TargetKind<Relations[Key]> extends "variants"
    ? Key
    : never;
}[keyof Relations];

type UsedPolymorphicFields<Clause, Relations> = Extract<
  SpelledClauseKeys<NonNullable<Clause>>,
  VariantRelationKeys<Relations>
>;

type PolymorphicVariantMapGuard<Projection, Relation> = Record<
  Exclude<
    SpelledClauseKeys<Exclude<Projection, boolean | null | undefined>>,
    PolymorphicVariantKeys<Relation>
  >,
  never
>;

/**
 * A COLLECTION projection is an envelope, not a discriminator map, so the key
 * set to seal against is `only` / `variants` — sealing against the VARIANT
 * names would resolve both of them to `never` and refuse every legal payload.
 *
 * The guard stops HERE, at depth two. Descending into `variants` to seal one
 * arm's key set is depth three, the measured cost frontier documented above:
 * it walks INTO a target model mid-inference, which is exactly what
 * `RelationState.getter: any` exists to prevent. A misspelling inside
 * `variants` therefore compiles and is refused at runtime by the strict
 * envelope — pinned as such in `contextual-typing-gate.core.types.ts`, so the
 * boundary stays a measured fact rather than an assumption.
 */
type PolymorphicCollectionEnvelopeGuard<Projection> = Record<
  Exclude<
    SpelledClauseKeys<Exclude<Projection, boolean | null | undefined>>,
    "only" | "variants"
  >,
  never
>;

/** ONE dispatch on cardinality, through the shared reader. */
type PolymorphicProjectionNodeGuard<Projection, Relation> =
  Cardinality<Relation> extends "many"
    ? PolymorphicCollectionEnvelopeGuard<Projection>
    : PolymorphicVariantMapGuard<Projection, Relation>;

type PolymorphicClauseGuard<Clause, Relations> = [
  UsedPolymorphicFields<Clause, Relations>,
] extends [never]
  ? unknown
  : {
      [RelationName in UsedPolymorphicFields<
        Clause,
        Relations
      >]?: PolymorphicProjectionNodeGuard<
        ValueAt<NonNullable<Clause>, RelationName>,
        Relations[RelationName]
      >;
    };

/**
 * Seal the finite key set at a direct polymorphic projection — the
 * discriminator map for a to-one slot, the `only` / `variants` envelope for a
 * collection. Looking inside either (one variant, or one arm under `variants`)
 * would resolve recursive target models during generic inference and crosses
 * the measured depth-three type-cost boundary.
 */
type DirectPolymorphicProjectionGuard<
  Arg,
  M extends Model<any>,
  Clause extends "select" | "include",
> = M extends Model<infer State>
  ? string extends keyof State["relations"]
    ? unknown
    : Clause extends keyof Arg
      ? {
          [Key in Clause]?: PolymorphicClauseGuard<
            Arg[Key],
            State["relations"]
          >;
        }
      : unknown
  : unknown;

type DecimalStateOf<Field> = Field extends {
  readonly "~": {
    readonly state: infer State extends ScalarState<"decimal">;
  };
}
  ? State
  : never;

type DirectDecimalScalarKeys<State extends ModelState> = {
  [Key in keyof State["scalars"]]: [
    DecimalStateOf<State["scalars"][Key]>,
  ] extends [never]
    ? never
    : Key;
}[keyof State["scalars"]];

/**
 * Refuse only keys the caller spelled BESIDE a real decimal operation.
 *
 * The recognized-key condition leaves scalar shorthand values alone and the
 * array condition keeps a list shorthand's own `.push()` method from looking
 * like the list-update operation. A broad index signature names no misspelled
 * key (`Extract<string, "set">` is `never`) and therefore stays under the
 * operation schema's ordinary structural contract. Keys are collected across
 * every union arm before ONE refusal record is built, so a legal shorthand,
 * null, or undefined arm cannot erase a bad operation-object arm.
 */
type SpelledDecimalUpdateObjectKeys<
  Given,
  OperationKeys extends PropertyKey,
> = Given extends readonly unknown[]
  ? never
  : Given extends object
    ? string extends keyof Given
      ? never
      : [Extract<keyof Given, OperationKeys>] extends [never]
        ? never
        : keyof Given
    : never;

type NoExtraDecimalUpdateLeafKeys<
  Given,
  State extends ScalarState<"decimal">,
  OperationKeys extends PropertyKey = DecimalUpdateOperationKeys<State>,
> = Record<
  Exclude<SpelledDecimalUpdateObjectKeys<Given, OperationKeys>, OperationKeys>,
  never
>;

type UsedDirectDecimalFields<Given, State extends ModelState> = Extract<
  SpelledClauseKeys<Given>,
  DirectDecimalScalarKeys<State>
>;

/** One direct-field map after union branches have contributed their keys. */
type DirectDecimalUpdateObjectGuard<
  Given,
  M extends Model<any>,
> = M extends Model<infer State>
  ? {
      [Key in UsedDirectDecimalFields<
        Given,
        State
      >]?: NoExtraDecimalUpdateLeafKeys<
        ValueAt<Given, Key>,
        DecimalStateOf<State["scalars"][Key]>
      >;
    }
  : unknown;

type DirectDecimalUpdateClauseGuard<
  Arg,
  M extends Model<any>,
  Clause extends "data" | "update",
> = Clause extends keyof Arg
  ? {
      [Key in Clause]?: DirectDecimalUpdateObjectGuard<
        NonNullable<Arg[Key]>,
        M
      >;
    }
  : unknown;

type DirectDecimalUpdateGuard<
  O extends Operations,
  Arg,
  M extends Model<any>,
> = O extends "update" | "updateMany"
  ? DirectDecimalUpdateClauseGuard<Arg, M, "data">
  : O extends "upsert"
    ? DirectDecimalUpdateClauseGuard<Arg, M, "update">
    : unknown;

type NoExtraOperationKeys<
  O extends Operations,
  Arg,
  Payload,
  M extends Model<any>,
> = Arg &
  Record<Exclude<keyof Arg, keyof Payload>, never> &
  ClauseGuard<Arg, Payload, "where"> &
  ClauseGuard<Arg, Payload, "select"> &
  ClauseGuard<Arg, Payload, "include"> &
  ClauseGuard<Arg, Payload, "orderBy"> &
  ClauseGuard<Arg, Payload, "omit"> &
  ClauseGuard<Arg, Payload, "cache"> &
  DirectPolymorphicProjectionGuard<Arg, M, "select"> &
  DirectPolymorphicProjectionGuard<Arg, M, "include"> &
  DirectDecimalUpdateGuard<O, Arg, M>;

/**
 * Operation type - returns PendingOperation which implements PromiseLike
 * This allows operations to be:
 * - Awaited directly: `await client.user.findMany()`
 * - Batched in transactions: `await client.$transaction([op1, op2])`
 */
type Operation<
  O extends Operations,
  M extends Model<any>,
  DefaultOmit = undefined,
  ClientDefaults = never,
  ExtensionCache extends boolean = false,
  Payload = OperationPayload<O, M>,
  ClientPayload = ClientOperationPayload<O, Payload, ExtensionCache>,
> = undefined extends ClientPayload
  ? <Arg extends ClientPayload>(
      args?: NoExtraOperationKeys<
        O,
        Exclude<Arg, undefined>,
        Exclude<ClientPayload, undefined>,
        M
      >
    ) => PendingOperation<
      OperationResultWithClientDefaults<O, M, Arg, DefaultOmit, ClientDefaults>
    >
  : <Arg extends ClientPayload>(
      args: NoExtraOperationKeys<O, Arg, ClientPayload, M>
    ) => PendingOperation<
      OperationResultWithClientDefaults<O, M, Arg, DefaultOmit, ClientDefaults>
    >;

/**
 * Cached operation type - returns Promise directly (not batchable)
 */
type CachedOperation<
  O extends Operations,
  M extends Model<any>,
  DefaultOmit = undefined,
  ClientDefaults = never,
  Payload = OperationPayload<O, M>,
> = undefined extends Payload
  ? <Arg extends Payload>(
      args?: NoExtraOperationKeys<
        O,
        Exclude<Arg, undefined>,
        Exclude<Payload, undefined>,
        M
      >
    ) => Promise<
      OperationResultWithClientDefaults<O, M, Arg, DefaultOmit, ClientDefaults>
    >
  : <Arg extends Payload>(
      args: NoExtraOperationKeys<O, Arg, Payload, M>
    ) => Promise<
      OperationResultWithClientDefaults<O, M, Arg, DefaultOmit, ClientDefaults>
    >;

/**
 * Cached client type - provides typed access to only cacheable (read) operations
 * Returns Promises directly (not PendingOperation) - cache operations are not batchable
 *
 * Keyed by the CONFIG, not by the schema alone, because `$withCache` runs the
 * same `applyClientOmit` rewrite the plain client does (and keys the cache on
 * the rewritten payload) — a cached read of a configured model must not be
 * typed as if the default were off.
 */
export type CachedClient<
  C extends VibORMConfig,
  ClientDefaults = ClientRelationOmitContext<C>,
> = {
  [K in keyof C["schema"]]: {
    [O in CacheableOperations]: CachedOperation<
      O,
      C["schema"][K],
      ClientDefaultOmit<C, K>,
      ClientDefaults
    >;
  };
};
