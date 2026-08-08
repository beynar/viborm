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
import type { Prettify } from "@validation";
import type { ModelCoreInput, ModelOperationInput } from "@validation/model";
import type { CacheDriver } from "../cache/driver";
import type { VibORMConfig } from "./client";
import type {
  AggregateResultType,
  BatchPayload,
  CountResultType,
  GroupByResultType,
  InferSelectInclude,
  NodeOmit,
  NodeSelect,
} from "./result-types";

export type { WaitUntilFn } from "../cache/cache-contract";

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
                                ? // Optional like the runtime (count
                                  // schema): exist() with no filter
                                  // reports whether any row exists.
                                    | {
                                        where?: ModelCoreInput<M, "where">;
                                      }
                                    | undefined
                                : never;

/**
 * IMPLICIT RETURNING (maintainer decision D-1: `createManyAndReturn` /
 * `updateManyAndReturn` are removed, not aliased). A bulk write returns
 * `{ count }` — UNLESS the call carries a `select`, in which case it returns the
 * affected rows projected by that select. The conditional stays zero-codegen:
 * `Args` is inferred from the call-site literal, and a call without `select`
 * simply has no such member.
 *
 * The rule covers `deleteMany` too, which has no Prisma counterpart at all: the
 * rows come back as they are removed, so a caller no longer has to read-then-
 * delete and hope nothing moved in between.
 *
 * The runtime discriminant is `args.select !== undefined` (routing.ts), so this
 * type discriminates on the VALUE too, not on key presence. Three cases:
 *
 *  - no `select` member, or one whose type is exactly `undefined` — the
 *    spread-an-optional idiom collapsed to a literal `undefined` — is
 *    `BatchPayload`;
 *  - a `select` that cannot be `undefined` is the projected rows;
 *  - a `select` that MAY be `undefined` (`select?: …`, or a variable typed
 *    `Sel | undefined`) is the honest UNION of both, because only the runtime
 *    value decides. Collapsing it to either arm would be a lie in one
 *    direction: it used to collapse to `BatchPayload`, so
 *    `updateMany({ …, select: maybeSelect })` type-checked as `{ count }` and
 *    then returned rows, with `result.count` silently `undefined`. A caller in
 *    this position narrows (`Array.isArray(result)`) — which is exactly the
 *    choice they deferred to runtime.
 */
type BulkWriteResult<S extends ModelState, Args> = "select" extends keyof Args
  ? [BulkSelect<Args>] extends [undefined]
    ? BatchPayload
    : undefined extends BulkSelect<Args>
      ? BatchPayload | BulkWriteRows<S, Exclude<BulkSelect<Args>, undefined>>
      : BulkWriteRows<S, BulkSelect<Args>>
  : "omit" extends keyof Args
    ? [BulkOmit<Args>] extends [undefined]
      ? BatchPayload
      : undefined extends BulkOmit<Args>
        ? BatchPayload | BulkOmitRows<S, Exclude<BulkOmit<Args>, undefined>>
        : BulkOmitRows<S, BulkOmit<Args>>
    : BatchPayload;

/**
 * `omit` is the OTHER spelling of the same discriminant. It is a projection —
 * "return every scalar except these" — so it selects the row-returning arm on
 * exactly the same `!== undefined` rule `select` uses (`returnsRows`,
 * @query-engine-v2/routing). Accepting it on the `{ count }` arm would be
 * accepting a projection and then throwing it away.
 *
 * `select` is checked FIRST because a payload carrying both is refused at the
 * parse boundary; the ordering only decides which arm an impossible payload
 * reports, and `select`'s is the more informative one.
 */
type BulkOmit<Args> = Args[Extract<"omit", keyof Args>];

type BulkOmitRows<S extends ModelState, O> = Prettify<
  InferSelectInclude<S, { omit: O }>
>[];

/**
 * The declared type of a bulk write's `select`, optional or not. Indexed access
 * rather than `Args extends { select?: infer Sel }`: inference to an OPTIONAL
 * pattern property strips `undefined` from the source, which would erase the
 * exact distinction this discriminant exists to make.
 */
type BulkSelect<Args> = Args[Extract<"select", keyof Args>];

/**
 * The row arm. `select` is the only key `InferSelectInclude` reads on a bulk
 * write (`include` is refused at the parse boundary), so re-wrapping the
 * narrowed selection is enough — and it keeps the `Sel | undefined` case from
 * inferring an empty row through `keyof (Sel | undefined)`.
 */
type BulkWriteRows<S extends ModelState, Sel> = Prettify<
  InferSelectInclude<S, { select: Sel }>
>[];

// =============================================================================
// CLIENT-LEVEL `omit`, AT THE TYPE LEVEL
// =============================================================================

/*
 * `createClient({ omit: { user: { passwordHash: true } } })` is a DEFAULT the
 * runtime folds into every projecting node's `omit` before validation
 * (`applyClientOmit`, ./omit.ts). The types below fold the SAME default into
 * the SAME key before result inference, so the two layers reduce the row
 * together.
 *
 * Threading it matters in one direction in particular: without it the runtime
 * drops the column while the type still promises a `string`, which is the lie
 * that survives review and reaches production.
 *
 * KNOWN GAP. Only the node the operation is called on is covered. The runtime
 * also applies the default to relation payloads reached through
 * `include`/`select`, but a relation resolves to a target MODEL, not to the
 * schema KEY the config is written against, and recovering the key would mean
 * comparing model types structurally — the one comparison that collapses
 * mutually-recursive model consts to `any` (see `RelationState.getter`). So a
 * globally-omitted field of an INCLUDED model still shows up in the type. It
 * is recorded in docs/content/docs/client/omit.mdx, not papered over.
 */

/** `config.omit` as written, or `undefined` when the config carries none. */
type ConfigOmit<C> = "omit" extends keyof C
  ? C[Extract<"omit", keyof C>]
  : undefined;

/**
 * Discard a record keyed by an INDEX SIGNATURE rather than by names.
 *
 * `VibORMConfig` declares `omit?: ClientOmitConfig<Schema>` over the loose
 * `Schema` alias, so a client typed from the INTERFACE rather than from a
 * config literal carries `{ [model: string]: { [field: string]: boolean } }`.
 * That names nothing. Reading it as "every field of every model might be
 * hidden" would make every key of every result optional — noise, not honesty —
 * so it is read as what it is: no default stated.
 */
type NamedOnly<O> = string extends keyof NonNullable<O> ? undefined : O;

/** The entry `config.omit` holds for one model key, `undefined` when none. */
type ModelOmitEntry<All, K extends PropertyKey> = [All] extends [undefined]
  ? undefined
  : K extends keyof NonNullable<All>
    ? undefined extends All
      ? NonNullable<All>[K] | undefined
      : NonNullable<All>[K]
    : undefined;

/**
 * A default the type cannot pin down degrades to MAYBE, never to "no": every
 * field it could name becomes a widened `boolean`, which `ApplyOmit` renders as
 * an OPTIONAL key — the same convention a widened query-level flag already
 * follows. Reading an uncertain default as "absent" would claim a field is
 * present exactly when the config that hides it is in play.
 */
type SoftenOmit<O> = [O] extends [undefined]
  ? undefined
  : undefined extends O
    ? { [F in keyof Exclude<O, undefined>]: boolean }
    : O;

/** What this client hides by default for one model of its schema. */
export type ClientDefaultOmit<
  C extends VibORMConfig,
  K extends keyof C["schema"],
> = NamedOnly<SoftenOmit<ModelOmitEntry<NamedOnly<ConfigOmit<C>>, K>>>;

/**
 * The client default with the CALLER's own `omit` layered on top, per field —
 * the type-level twin of `mergeOmit` (./omit.ts). `{ passwordHash: false }`
 * re-includes exactly one globally hidden column and leaves the rest hidden.
 *
 * A caller `omit` that MAY be `undefined` cannot decide anything on its own, so
 * the fields it names soften to `boolean` (optional) while the untouched
 * defaults stay definite.
 */
type MergeClientOmit<Default, Local> = [Local] extends [undefined]
  ? Default
  : undefined extends Local
    ? Prettify<
        Omit<Default, keyof Exclude<Local, undefined>> & {
          [F in keyof Exclude<Local, undefined>]: boolean;
        }
      >
    : Prettify<Omit<Default, keyof Local> & Local>;

/**
 * The args as the runtime will see them once the client default is folded in.
 *
 * A `select` that carries a VALUE states the projection positively and is left
 * alone — the same rule `rewriteNode` follows (`args.select !== undefined`), and
 * the reason injecting an `omit` here would turn a legal payload into the
 * `select` + `omit` refusal. A `select: undefined` is no projection at all, so
 * the default is folded in for it exactly as it is for a call with no `select`
 * key; skipping it there would promise a column the runtime hides.
 */
type WithClientOmit<Args, Default> = [Default] extends [undefined]
  ? Args
  : [NodeSelect<Args>] extends [undefined]
    ? Omit<Args, "omit"> & { omit: MergeClientOmit<Default, NodeOmit<Args>> }
    : undefined extends NodeSelect<Args>
      ? // The default applies in EXACTLY the world where the projection is
        // absent, so it is folded in as a maybe — `ApplyOmit` renders that as
        // optional keys, and `InferSelectInclude` still reaches the projection
        // arm. Injecting it definitely would collapse the projection world into
        // the `select` + `omit` refusal.
        Omit<Args, "omit"> & {
          omit: MergeClientOmit<Default, NodeOmit<Args>> | undefined;
        }
      : Args;

/**
 * A bulk write sees the client default only where the CALLER already wrote a
 * projection. `bulkWriteProjects` (./omit.ts) requires `args.omit !== undefined`
 * before it rewrites anything, precisely so a per-client default is never what
 * flips `{ count }` into rows — and the type has to make the same refusal, or
 * `updateMany({ data })` on a configured client would claim rows it will not
 * get.
 */
type WithBulkClientOmit<Args, Default> = [Default] extends [undefined]
  ? Args
  : "omit" extends keyof Args
    ? Omit<Args, "omit"> & { omit: MergeBulkOmit<Default, BulkOmit<Args>> }
    : Args;

/**
 * Like {@link MergeClientOmit}, but it must preserve the `undefined` arm rather
 * than resolve it: on a bulk write that arm is the `{ count }` return shape,
 * and `BulkWriteResult` is what decides between them.
 */
type MergeBulkOmit<Default, Local> = [Local] extends [undefined]
  ? undefined
  : undefined extends Local
    ? MergeClientOmit<Default, Exclude<Local, undefined>> | undefined
    : MergeClientOmit<Default, Local>;

/**
 * Operation result type - infers result shape based on select/include args
 * This provides full type safety for ORM operation results
 *
 * `DefaultOmit` is the client-level default for THIS model (`ClientDefaultOmit`);
 * it defaults to `undefined`, so calling this type with three arguments is the
 * unconfigured client and behaves exactly as it did before.
 */
export type OperationResult<
  O extends Operations,
  M extends Model<any>,
  Args,
  DefaultOmit = undefined,
  Merged = WithClientOmit<Args, DefaultOmit>,
> = M extends Model<infer S>
  ? O extends "findFirst" | "findUnique"
    ? Prettify<InferSelectInclude<S, Merged>> | null
    : O extends "findFirstOrThrow" | "findUniqueOrThrow"
      ? Prettify<InferSelectInclude<S, Merged>>
      : O extends "findMany"
        ? Prettify<InferSelectInclude<S, Merged>>[]
        : O extends "create" | "update" | "delete" | "upsert"
          ? Prettify<InferSelectInclude<S, Merged>>
          : O extends "createMany" | "updateMany" | "deleteMany"
            ? BulkWriteResult<S, WithBulkClientOmit<Args, DefaultOmit>>
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
 * Client type - provides fully typed access to all model operations
 * Each operation returns a Promise with the properly inferred result type
 */
export type Client<C extends VibORMConfig> = {
  [K in keyof C["schema"]]: {
    [O in Operations]: Operation<O, C["schema"][K], C, ClientDefaultOmit<C, K>>;
  };
};

type RemoveCacheKey<C extends VibORMConfig, T> = C["cache"] extends CacheDriver
  ? T
  : T extends { cache?: infer _ }
    ? Omit<T, "cache"> & {}
    : T;

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
 *  - `data` / `create` / `update` — NOT guarded. A write clause's payload is the
 *    recursive nested-write union, and reaching for its keys expands it: six
 *    estate sites turn `TS2589: Type instantiation is excessively deep`, and the
 *    type-check goes to 172s.
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

type PolymorphicVariantKeys<Relation> = Relation extends {
  readonly "~": {
    readonly state: { readonly targets: infer Targets };
  };
}
  ? keyof Targets
  : never;

type UsedPolymorphicFields<Clause, Relations> = Extract<
  SpelledClauseKeys<NonNullable<Clause>>,
  keyof Relations
>;

type PolymorphicVariantMapGuard<Projection, Relation> = Record<
  Exclude<
    SpelledClauseKeys<Exclude<Projection, boolean | null | undefined>>,
    PolymorphicVariantKeys<Relation>
  >,
  never
>;

type PolymorphicClauseGuard<Clause, Relations> = [
  UsedPolymorphicFields<Clause, Relations>,
] extends [never]
  ? unknown
  : {
      [RelationName in UsedPolymorphicFields<
        Clause,
        Relations
      >]?: PolymorphicVariantMapGuard<
        ValueAt<NonNullable<Clause>, RelationName>,
        Relations[RelationName]
      >;
    };

/**
 * Seal only the finite discriminator map at a direct polymorphic projection.
 * Looking inside one variant would resolve recursive target models during
 * generic inference and crosses the measured depth-three type-cost boundary.
 */
type DirectPolymorphicProjectionGuard<
  Arg,
  M extends Model<any>,
  Clause extends "select" | "include",
> = M extends Model<infer State>
  ? string extends keyof State["polymorphicRelations"]
    ? unknown
    : Clause extends keyof Arg
      ? {
          [Key in Clause]?: PolymorphicClauseGuard<
            Arg[Key],
            State["polymorphicRelations"]
          >;
        }
      : unknown
  : unknown;

type NoExtraOperationKeys<Arg, Payload, M extends Model<any>> = Arg &
  Record<Exclude<keyof Arg, keyof Payload>, never> &
  ClauseGuard<Arg, Payload, "where"> &
  ClauseGuard<Arg, Payload, "select"> &
  ClauseGuard<Arg, Payload, "include"> &
  ClauseGuard<Arg, Payload, "orderBy"> &
  ClauseGuard<Arg, Payload, "omit"> &
  DirectPolymorphicProjectionGuard<Arg, M, "select"> &
  DirectPolymorphicProjectionGuard<Arg, M, "include">;

/**
 * Operation type - returns PendingOperation which implements PromiseLike
 * This allows operations to be:
 * - Awaited directly: `await client.user.findMany()`
 * - Batched in transactions: `await client.$transaction([op1, op2])`
 */
type Operation<
  O extends Operations,
  M extends Model<any>,
  C extends VibORMConfig,
  DefaultOmit = undefined,
  Payload = OperationPayload<O, M>,
> = undefined extends Payload
  ? <Arg extends RemoveCacheKey<C, Payload>>(
      args?: NoExtraOperationKeys<
        Exclude<Arg, undefined>,
        Exclude<RemoveCacheKey<C, Payload>, undefined>,
        M
      >
    ) => PendingOperation<OperationResult<O, M, Arg, DefaultOmit>>
  : <Arg extends RemoveCacheKey<C, Payload>>(
      args: NoExtraOperationKeys<Arg, RemoveCacheKey<C, Payload>, M>
    ) => PendingOperation<OperationResult<O, M, Arg, DefaultOmit>>;

/**
 * Cached operation type - returns Promise directly (not batchable)
 */
type CachedOperation<
  O extends Operations,
  M extends Model<any>,
  DefaultOmit = undefined,
  Payload = OperationPayload<O, M>,
> = undefined extends Payload
  ? <Arg extends Payload>(
      args?: NoExtraOperationKeys<
        Exclude<Arg, undefined>,
        Exclude<Payload, undefined>,
        M
      >
    ) => Promise<OperationResult<O, M, Arg, DefaultOmit>>
  : <Arg extends Payload>(
      args: NoExtraOperationKeys<Arg, Payload, M>
    ) => Promise<OperationResult<O, M, Arg, DefaultOmit>>;

/**
 * Cached client type - provides typed access to only cacheable (read) operations
 * Returns Promises directly (not PendingOperation) - cache operations are not batchable
 *
 * Keyed by the CONFIG, not by the schema alone, because `$withCache` runs the
 * same `applyClientOmit` rewrite the plain client does (and keys the cache on
 * the rewritten payload) — a cached read of a configured model must not be
 * typed as if the default were off.
 */
export type CachedClient<C extends VibORMConfig> = {
  [K in keyof C["schema"]]: {
    [O in CacheableOperations]: CachedOperation<
      O,
      C["schema"][K],
      ClientDefaultOmit<C, K>
    >;
  };
};
