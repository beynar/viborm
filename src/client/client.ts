import type { WithCacheOptions } from "@cache/schema";
import { ASYNC_DISPOSE, type AsyncDisposeMember } from "@drivers/async-dispose";
import { CLIENT_DIAGNOSTICS } from "@drivers/execution-context";
import type { AnyDriver } from "@drivers/exports";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import { ClientInitializationError, isVibORMError } from "@errors";
import type { ResolvedExtensionChain } from "@extensions/chain";
import type {
  AnyFacts,
  ConfiguredBy,
  EmptyFacts,
  Extension,
  Facts,
  StampedFields,
  Target,
} from "@extensions/contract";
import { railOf } from "@extensions/coordination";
import { isAppliedExtension } from "@extensions/extension";
import type {
  AccumulatedExtensionState,
  DelegateState,
  EmptyClientExtensionState,
  ExtensionCacheState,
  ExtensionContributionState,
  ExtensionMethods,
  ExtensionModelClient,
  ExtensionStateConstraint,
  HasExtensionCache,
  MergeModelMethods,
} from "@extensions/methods";
import { SCOPE } from "@extensions/origin";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { enableFindUniqueBatching } from "@query-engine/find-unique-batch";
import type {
  PendingOperation,
  PrepareOperationInput,
  PrepareWriteOutcomeRegistration,
} from "@query-engine/pending-operation";
import { QueryEngine } from "@query-engine/query-engine";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { renderers } from "@query-engine/raptor3/shared/insert-value";
import {
  isWriteOperation,
  ROUTED_OPERATIONS,
} from "@query-engine/routed-operations";
import type { TransactionOperation } from "@query-engine/transaction-operation";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Scalar } from "@schema/scalars/base";
import {
  describeDecimalProviderLimitRefusal,
  findDecimalProviderLimitRefusal,
} from "@schema/scalars/decimal/provider-limits";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import {
  resolveCheckedSchemaOrThrow,
  resolveSchemaOrThrow,
} from "@schema/validation/validator";
import { createResolvedSchemaRegistry } from "@validation/builder";
import { executeArrayTransaction } from "./array-transaction";
import {
  applyClientOmit,
  type ClientOmitResolver,
  createClientOmitResolver,
} from "./omit";
import type {
  DeclaresEvidence,
  DelegateCallArgs,
  DelegateProjectedArgs,
  DelegateProjectedResult,
  GatedConfig,
  ProjectedModelOperations,
} from "./projected-types";
import {
  createRawSurface,
  createRowsFragment,
  RAW_METHOD_NAMES,
  type RawOperation,
  type RawSurface,
} from "./raw";
import type { ClientSchema, LinkedClientConfig } from "./schema-links";
import type {
  CachedClient,
  Client,
  ClientRowsContext,
  ComputedOperation,
  ComputedResultContext,
  ContextualOperationResult,
  OperationPayload,
  Operations,
  Schema,
  WithComputedResult,
} from "./types";

export type {
  ClientSchema,
  FlatSchema,
  Linked,
  LinkedClientConfig,
  Links,
  RelationLinks,
} from "./schema-links";

import { assertNonEmptyUniqueWhere } from "./unique-where-guard";

/** The schema-bind refusal for an adapter with no physical GeoPoint protocol. */
function refuseGeoPointFields(schema: Schema): void {
  for (const [modelName, model] of Object.entries(schema)) {
    const scalars: Record<string, Scalar> = model["~"].state.scalars;
    for (const [fieldName, scalar] of Object.entries(scalars)) {
      if (scalar["~"].state.type !== "point") continue;
      throw new ClientInitializationError(
        `GeoPoint field '${modelName}.${fieldName}' cannot be stored by this driver because its adapter has no GeoPoint protocol.`
      );
    }
  }
}

/**
 * Create a recursive proxy for model operations
 * Operations return the result of createOperation (PendingOperation or Promise)
 */
function createModelProxy<S extends Schema, R>(
  schema: S,
  createOperation: (opts: {
    modelName: keyof S;
    operation: Operations;
    args: unknown;
  }) => R,
  modelMethods?: ExtensionMethods["model"],
  /** A model's core members beside its operations: `$rows(alias)`, and `$sql` where no alias is given. */
  rowsOf?: (model: keyof S, alias?: unknown) => unknown,
  path: string[] = []
): unknown {
  // A model's own methods, read (and their factories invoked) only once the
  // model itself is.
  const methods = path.length === 1 ? modelMethods?.(path[0]!) : undefined;
  const members = new Set(
    path.length === 0
      ? Object.keys(schema)
      : path.length === 1
        ? [
            ...ROUTED_OPERATIONS,
            ...(rowsOf ? ["$rows", "$sql"] : []),
            ...Object.keys(methods ?? {}),
          ]
        : []
  );
  const children = new Map<string, unknown>();
  const readMember = (key: string | symbol): unknown => {
    if (typeof key !== "string" || key === "then" || !members.has(key))
      return undefined;
    if (methods !== undefined && Object.hasOwn(methods, key)) {
      return methods[key];
    }
    if (key === "$sql" && rowsOf) return rowsOf(path[0]!);
    let child = children.get(key);
    if (child === undefined) {
      child =
        key === "$rows" && rowsOf
          ? (alias: unknown) => rowsOf(path[0]!, alias)
          : createModelProxy(schema, createOperation, modelMethods, rowsOf, [
              ...path,
              key,
            ]);
      children.set(key, child);
    }
    return child;
  };
  return new Proxy(path.length === 2 ? () => undefined : {}, {
    get: (target, key) =>
      Object.hasOwn(target, key) ? Reflect.get(target, key) : readMember(key),
    has: (target, key) =>
      Object.hasOwn(target, key) ||
      (typeof key === "string" && members.has(key)),
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...members])],
    getOwnPropertyDescriptor: (target, key) =>
      Reflect.getOwnPropertyDescriptor(target, key) ??
      (typeof key === "string" && members.has(key)
        ? {
            configurable: true,
            enumerable: true,
            writable: true,
            value: readMember(key),
          }
        : undefined),
    apply(_target, _thisArg, [args]) {
      const modelName = path[0] as keyof S;
      const operation = path[1] as Operations;
      return createOperation({ modelName, operation, args });
    },
  });
}

type BatchTransactionOperation<T = unknown> =
  | PendingOperation<T>
  | RawOperation<T>;

/** What any view's `$transaction` accepts: a callback or an operation array. */
type TransactionInput<C extends VibORMConfig> =
  | ((
      tx: TransactionClient<C, ExtensionStateConstraint>
    ) => PromiseLike<unknown>)
  | TransactionOperation<unknown>[];

/** The four raw methods the client and its transaction clients answer. */
function isRawMethodName(prop: string | symbol): prop is keyof RawSurface {
  return typeof prop === "string" && Object.hasOwn(RAW_METHOD_NAMES, prop);
}

/**
 * VibORM Configuration
 */
export interface VibORMConfig<S extends Schema = Schema> {
  schema: S;
  driver: AnyDriver;
  /**
   * Skip the schema checks every client otherwise runs when it is created, for
   * a schema `viborm check` validates (in a build or CI step). The client still
   * resolves relations, which it needs to run queries; it trusts identifiers,
   * table and selector names, and the absence of required-relation cycles.
   */
  skipSchemaValidation?: boolean;
  /**
   * Answer the `findUnique` calls issued in the same tick with one read over
   * their keys (Prisma's dataloader), instead of one read each. Off by
   * default: the shared read runs in the first call's async context, so a
   * driver that picks its database by `AsyncLocalStorage`, or a trace per
   * request, sees that call's context for every call of the batch.
   */
  findUniqueBatching?: boolean;
}

export interface DriverConfig<S extends Schema = Schema>
  extends Omit<VibORMConfig<S>, "driver"> {}

/**
 * A contribution whose model slot also carries the projected overloads of a
 * declared key (K5), typed against the client as this step leaves it.
 */
export interface ProjectedContribution<
  Contribution extends ExtensionStateConstraint,
  Projected extends object,
> extends ExtensionStateConstraint {
  readonly client: Contribution["client"];
  readonly models: MergeModelMethods<Contribution["models"], Projected>;
  readonly cache: Contribution["cache"];
  readonly resultConsumer: Contribution["resultConsumer"];
  readonly controls: Contribution["controls"];
  readonly rows: Contribution["rows"];
  readonly data: Contribution["data"];
  readonly result: Contribution["result"];
}

/**
 * What a rule's `gate` and `facts` add, in the form the projected types read
 * a definition: nothing when it adds neither.
 */
type VerbsDefinition<F extends AnyFacts> = [keyof F["verbs"]] extends [never]
  ? unknown
  : { readonly rows: { readonly verbs: F["verbs"] } };

/** An extension's facts as the chain's state accumulates them. */
type ContributionOf<F extends AnyFacts> = ExtensionContributionState<
  F["client"],
  F["models"],
  F["controls"],
  F["rows"],
  F["data"],
  F["consumer"] extends true ? "result-consuming" : "result-independent",
  F["result"],
  F["cache"] extends true ? ExtensionCacheState : undefined
>;

/** The config a client has once an extension with facts `F` is applied. */
export type AppliedClientConfig<
  C extends VibORMConfig,
  F extends AnyFacts,
> = GatedConfig<ConfiguredBy<C, F>, VerbsDefinition<F>>;

type ProjectedStateOf<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  F extends AnyFacts,
  Contribution extends ExtensionStateConstraint = ContributionOf<F>,
> = DeclaresEvidence<C, VerbsDefinition<F>> extends false
  ? Contribution
  : ProjectedContribution<
      Contribution,
      ProjectedModelOperations<
        AppliedClientConfig<C, F>,
        ClientRowsContext<
          AppliedClientConfig<C, F>,
          X["rows"] | Contribution["rows"]
        >,
        X["controls"] & Contribution["controls"],
        VerbsDefinition<F>
      >
    >;

/** The extension state a client has once an extension with facts `F` is applied. */
export type AppliedExtensionState<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  F extends AnyFacts,
> = NoFacts<F> extends true
  ? // Nothing contributed (hooks, units, a plain call): the client's own
    // state, so the client keeps its very type.
    X
  : AccumulatedExtensionState<X, ProjectedStateOf<C, X, F>>;

/**
 * The order rule: after a part typed against a result, a rule that hides
 * rows or a default that omits a field would make that type lie. And one
 * cache per chain: a second one's `$withCache` would replace the first's. A
 * constraint on the facts, not a conditional beside the extension: a
 * parameter type that depends on the facts being inferred gives the parts
 * no client to be typed against.
 */
type AdmittedFacts<X extends ExtensionStateConstraint> = Facts<
  object,
  object,
  object,
  [X["resultConsumer"]] extends [undefined] ? string : never,
  unknown,
  object,
  [X["resultConsumer"]] extends [undefined]
    ? object
    : { readonly [model: string]: never },
  boolean,
  HasExtensionCache<X> extends true ? false : boolean,
  object
>;

type DataModels<D> = D extends StampedFields<infer M, PropertyKey> ? M : never;

/** Literal model names only: `string` is every model, or names the types cannot read. */
type Literal<K> = K extends string ? (string extends K ? never : K) : never;

/**
 * Every model an extension's facts name. Rows hidden, methods, omissions,
 * projections and computed fields on `string` concern every model (a policy
 * governs them all) or names only the runtime can check: none is named. A
 * field written on create is the exception: written on `string`, it would be
 * optional on every model, so `string` is named, and refused.
 */
type NamedModels<F extends AnyFacts> =
  | Literal<
      | F["rows"]
      | keyof F["omit"]
      | keyof F["models"]
      | keyof F["verbs"]
      | Exclude<keyof F["result"], "$allModels">
    >
  | DataModels<F["data"]>;

/**
 * The models the extension names that this client does not have. A part
 * typed against the client refuses one where it is written; one written
 * apart from any client (a recipe taking model names, `tenancy(["post"])`)
 * is checked here, where it meets the client. A list of names the types
 * cannot read (a `string[]`) names `string`, which no schema has.
 */
type KnownModels<Models, F extends AnyFacts> = [
  Exclude<NamedModels<F>, Models>,
] extends [never]
  ? unknown
  : {
      readonly "names models this client does not have": Exclude<
        NamedModels<F>,
        Models
      >;
    };

/**
 * The keys a proposed config names that the surface does not have: the typos.
 *
 * `createClient` infers `Config` FROM the literal, so the literal's own keys are
 * by construction "known" to the parameter type and excess-property checking has
 * nothing to complain about — `decimel: "number"` recorded a setting nobody reads
 * and compiled. (Excess-property checking would not have been enough anyway: it
 * needs a fresh object literal, so a config held in a variable — the shape every
 * "share one config across two clients" snippet uses — sails through it.)
 *
 * Demanding `never` for the unknown keys refuses structurally instead, whatever
 * the argument's freshness, and a `never` the caller cannot produce is a compile
 * error at the offending key. Same instrument as the model builder's
 * `UnknownOmitKeys`.
 */
export type NoExtraConfigKeys<Given, Allowed> = Record<
  Exclude<keyof Given, keyof Allowed>,
  never
>;

/**
 * The driver-package flavour: a wrapper's literal may also carry that driver's
 * own options (`dataDir`, `pool`, `authToken`, …), so the accepted set is the
 * union of those and the shared client config.
 */
export type NoExtraDriverConfigKeys<Given, Options, S extends Schema> = Record<
  Exclude<keyof Given, keyof Options | keyof DriverConfig<S>>,
  never
>;

/**
 * The client an interactive `$transaction(async (tx) => ...)` callback gets:
 * every model operation, the raw SQL surface bound to the OPEN transaction,
 * and nested `$transaction` (savepoints).
 */
export type TransactionClient<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint = EmptyClientExtensionState,
> = ExtensionModelClient<C, X> &
  RawSurface & {
    readonly $schema: ClientSchema<C>;
    $transaction: TransactionMethod<C, X>;
  } & X["client"];

/**
 * The interactive transaction client of `Client`, a client `createClient`,
 * `$extends` or a view such as `$as(actor)` returned: what code that takes
 * "a client or a transaction" names for its transaction half.
 *
 * @example
 * ```ts
 * type Tx = TransactionClientOf<typeof db>;
 * const rename = (tx: typeof db | Tx, id: string) =>
 *   tx.page.update({ where: { id }, data: { title: "x" } });
 * ```
 */
export type TransactionClientOf<Client> =
  typeof clientTypeState extends keyof Client
    ? Client extends ClientTypeState<
        infer C,
        infer X extends ExtensionStateConstraint
      >
      ? TransactionClient<C, X>
      : never
    : never;

/** `$transaction`'s two forms: an interactive callback, or a batch array. */
type TransactionMethod<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = {
  // Overload 1: Dynamic transaction (callback)
  <T>(
    fn: (tx: TransactionClient<C, X>) => PromiseLike<T>,
    options?: TransactionOptions
  ): Promise<T>;
  // Overload 2: Batch of independent operations (Prisma-style)
  <T extends BatchTransactionOperation<unknown>[]>(
    operations: [...T],
    options?: BatchTransactionOptions
  ): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
};

declare const clientTypeState: unique symbol;

/**
 * Declaration-only inference metadata; no property is installed at runtime.
 * The optional opaque arm preserves structural client assignability. The
 * conditional exposes the tuple for inference without making C or X invariant.
 * Result helpers check key presence and the full client surface: this metadata
 * guides inference, but does not prove that a client has the declared methods.
 */
export type ClientTypeState<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = [C] extends [unknown] ? ClientTypeStateMember<C, X> : never;

/**
 * The metadata's one member. An interface, so an inferred client's
 * declaration names it rather than spelling its symbol-keyed member, which a
 * declaration file cannot name.
 */
export interface ClientTypeStateMember<C, X> {
  readonly [clientTypeState]?: readonly [C, X] | object;
}

/**
 * Extended client type with utility methods
 */
export type VibORMClient<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint = EmptyClientExtensionState,
> = ClientTypeState<C, X> &
  ExtensionModelClient<C, X> &
  RawSurface &
  X["client"] &
  // `await using client = createClient({ ... })` disposes through the same
  // close path as `$disconnect()`. Carried by `AsyncDisposeMember` so it is the
  // empty object — not a compile error — for a consumer whose `lib`/`@types`
  // never declared `Symbol.asyncDispose`. The interactive `tx` client is
  // deliberately NOT disposable: `$transaction` owns that driver's lifetime.
  AsyncDisposeMember &
  VibORMClientMembers<C, X> &
  Omit<
    {
      /** Create a client with cache - only read operations available */
      $withCache: (
        config?: WithCacheOptions
      ) => CachedClient<
        C,
        ClientRowsContext<C, X["rows"]>,
        X["controls"],
        X["models"]
      >;
      /** Invalidate cache entries by keys or patterns (use * suffix for prefix matching) */
      $invalidate: (...keys: string[]) => Promise<void>;
    },
    HasExtensionCache<X> extends true ? "never" : "$withCache" | "$invalidate"
  >;

/**
 * The client members no extension state removes. An interface outside the
 * `Omit` above, so a body generic over the extension state still reaches them.
 */
export interface VibORMClientMembers<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> {
  /** Access the underlying driver */
  $driver: AnyDriver;
  /** Access the schema (models) */
  $schema: ClientSchema<C>;
  /**
   * Run operations in a transaction or batch
   *
   * @example Dynamic transaction (callback) - operations can depend on each other
   * ```ts
   * await client.$transaction(async (tx) => {
   *   const user = await tx.user.create({ data: { name: "Alice" } });
   *   await tx.post.create({ data: { title: "Hello", authorId: user.id } });
   * });
   * ```
   *
   * @example Batch (array) - independent operations, atomic execution
   * ```ts
   * const [users, posts] = await client.$transaction([
   *   client.user.findMany(),
   *   client.post.findMany(),
   * ]);
   * ```
   *
   * @example Options - honored or refused, never ignored
   * ```ts
   * await client.$transaction(async (tx) => { ... }, {
   *   isolationLevel: "Serializable",
   *   timeout: 10_000,
   *   maxWait: 2000,
   * });
   * ```
   *
   * Each option is honored where the driver can honor it and rejected with
   * a typed `UnsupportedOperationError` (V8003) where it cannot — see
   * [Transactions](/docs/client/transactions) for the per-driver contract.
   * The array form takes `isolationLevel` only: a preplanned array has no
   * interactive window for `timeout` or `maxWait` to bound.
   */
  $transaction: TransactionMethod<C, X>;
  /** Connect to the database */
  $connect: () => Promise<void>;
  /** Disconnect from the database */
  $disconnect: () => Promise<void>;
  /**
   * Apply an extension: `client.$extends(extension(name, ...parts))`, or an
   * official one (`client.$extends(softDelete({ … }))`). Each handler of the
   * extension is typed against this client. The extension is appended to an
   * immutable chain; this client is unchanged.
   */
  $extends<F extends AdmittedFacts<X>>(
    // The check reads the model names only: two clients of one schema and
    // different drivers stay assignable.
    extension: Extension<Target<LinkedConfigOf<C>, X, EmptyFacts>, F> &
      KnownModels<keyof C["schema"], F>
  ): VibORMClient<AppliedClientConfig<C, F>, AppliedExtensionState<C, X, F>>;
}

/**
 * The config a client's parts are typed against: the linked snapshot
 * `createClient` makes. A client type written with its plain config
 * (`VibORMClient<{ schema: S; driver: D }>`) reads the same target as the
 * client `createClient` returned, so the two stay assignable.
 */
export type LinkedConfigOf<C extends VibORMConfig> = AnyDriverOf<
  " vibLinks" extends keyof C ? C : LinkedClientConfig<C>
>;

/**
 * The driver is no part's concern: two clients of one schema on two drivers
 * read one target, so a client type names either.
 */
type AnyDriverOf<C> = {
  [K in keyof C]: K extends "driver" ? AnyDriver : C[K];
};

/**
 * Whether `F` contributes nothing. Both ways: an empty fact (`never` rows,
 * `{}` methods) is assignable to any fact of its kind, and any methods
 * object to `{}`.
 */
type NoFacts<F extends AnyFacts> = [F] extends [EmptyFacts]
  ? [EmptyFacts] extends [F]
    ? true
    : false
  : false;

type FactsOf<E> = E extends Extension<never, infer F> ? F : never;

type ApplyClientExtensions<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  Extensions extends readonly unknown[],
> = Extensions extends readonly []
  ? VibORMClient<C, X>
  : Extensions extends readonly [infer First, ...infer Rest]
    ? FactsOf<First> extends infer F extends AdmittedFacts<X>
      ? unknown extends KnownModels<keyof C["schema"], F>
        ? ApplyClientExtensions<
            AppliedClientConfig<C, F>,
            AppliedExtensionState<C, X, F>,
            Rest
          >
        : never
      : never
    : never;

/**
 * The exact client surface produced by applying an ordered tuple of
 * extension values.
 *
 * @example
 * ```ts
 * type AppClient = ExtendedClient<
 *   typeof db,
 *   readonly [typeof tenancy, typeof cached, typeof tools]
 * >;
 * ```
 */
export type ExtendedClient<
  Base,
  Extensions extends readonly unknown[],
> = number extends Extensions["length"]
  ? never
  : typeof clientTypeState extends keyof Base
    ? Base extends ClientTypeState<infer C, infer X>
      ? Base extends VibORMClient<C, X>
        ? ApplyClientExtensions<C, X, Extensions>
        : never
      : never
    : never;

/** The extension type-state a derived client carries. */
export type ExtensionState = ExtensionStateConstraint;

/**
 * One operation's result on a derived client, as that client's own delegate
 * types it: its `defaultOmit` applied to `Args`, and a to-one relation whose
 * target the chain's `rows` can hide typed `| null`. Index the client with
 * `M[K & keyof M]` in a plugin generic over it.
 */
export type ExtendedOperationResult<
  Client,
  ModelName,
  O extends Operations,
  Args,
> = typeof clientTypeState extends keyof Client
  ? Client extends ClientTypeState<infer C, infer X>
    ? Client extends VibORMClient<C, X>
      ? ContextualOperationResult<
          C,
          ModelName & keyof ClientSchema<C>,
          O,
          Args,
          ClientRowsContext<C, X["rows"]>
        >
      : never
    : never
  : never;

/**
 * The config of the client the model delegate `Delegate` belongs to: what a
 * model method written apart from any client reads its model from, so its
 * arguments are that client's, not its extension's own target's. `Fallback`
 * where the delegate carries no chain.
 */
export type DelegateConfig<
  Delegate,
  Fallback extends VibORMConfig = never,
> = Delegate extends DelegateState<
  infer C extends VibORMConfig,
  unknown,
  unknown,
  unknown
>
  ? C
  : Fallback;

/**
 * One operation's own arguments on the model delegate `Delegate`, read from
 * the client that delegate belongs to: what a model method written apart
 * from any client (an official extension's, its target unknown) takes.
 * `Fallback` where the delegate carries no chain.
 */
export type DelegateOperationPayload<
  Delegate,
  O extends Operations,
  Fallback = never,
> = Delegate extends DelegateState<
  infer C extends VibORMConfig,
  unknown,
  unknown,
  infer K
>
  ? OperationPayload<O, ClientSchema<C>[K & keyof ClientSchema<C>]>
  : Fallback;

/**
 * One operation's arguments on the model delegate `Delegate` it would run on:
 * `Payload`, whose `select` and `include` admit the keys that delegate's chain
 * projects (`$access`), as the operation's own projected overloads admit
 * them. A model method constrains its arguments with it beside
 * `DelegateOperationResult`: `restore<Self, A extends
 * DelegateOperationArgs<Self, RestoreArgs>>(this: Self, args: A)`.
 */
export type DelegateOperationArgs<Delegate, Payload> =
  Delegate extends DelegateState<unknown, unknown, unknown, infer K>
    ? DelegateProjectedArgs<Delegate, Payload, K>
    : Payload;

/**
 * One operation's result on the model delegate `Delegate` it would run on,
 * as `ExtendedOperationResult` types it for that delegate's client. A model
 * method declared with a `this` parameter types its result with it, so the
 * result follows every extension applied after the method's own:
 * `restore<Self, A>(this: Self, args: A): PendingOperation<
 * DelegateOperationResult<Self, "update", A>>`.
 */
export type DelegateOperationResult<
  Delegate,
  O extends Operations,
  Args,
> = Delegate extends DelegateState<
  infer C extends VibORMConfig,
  infer Rows extends string,
  infer Result extends object,
  infer K
>
  ? // A key the chain projects (`$access`) reads as the operation's own
    // projected overload reads it.
    DelegateProjectedResult<
      Delegate,
      O,
      K,
      Args,
      DelegateComputedRow<
        C,
        Rows,
        Result,
        K,
        O,
        DelegateCallArgs<Delegate, Args>
      >
    >
  : // Called off a delegate (a destructured method): nothing to read the
    // result from, and `unknown` makes using it a type error.
    unknown;
type DelegateComputedRow<
  C extends VibORMConfig,
  Rows extends string,
  Result extends object,
  K,
  O extends Operations,
  Args,
> = [keyof Result] extends [never]
  ? DelegateRow<C, Rows, K & keyof ClientSchema<C>, O, Args>
  : // Computed fields reach the rows an operation returns, nothing else.
    O extends Exclude<Operations, ComputedOperation>
    ? DelegateRow<C, Rows, K & keyof ClientSchema<C>, O, Args>
    : WithComputedResult<
        DelegateRow<C, Rows, K & keyof ClientSchema<C>, O, Args>,
        ClientSchema<C>[K & keyof ClientSchema<C>],
        Args,
        ComputedResultContext<Result, ClientSchema<C>, K>
      >;
type DelegateRow<
  C extends VibORMConfig,
  Rows extends string,
  K extends keyof ClientSchema<C>,
  O extends Operations,
  Args,
> = ContextualOperationResult<C, K, O, Args, ClientRowsContext<C, Rows>>;

/**
 * VibORM Client
 */
export class VibORM<C extends VibORMConfig> {
  readonly #schema: ClientSchema<C>;
  readonly #engine: QueryEngine;
  readonly #relations: ResolvedRelationIndex;
  /** The schema's validation schemas, which also admit `rows` predicates. */
  readonly #registry: PreparedSchema["schemaRegistry"];
  /** One resolved declarative omit per authenticated capability on this client. */
  #extensionOmitResolvers:
    | WeakMap<object, Readonly<{ resolver: ClientOmitResolver | undefined }>>
    | undefined;

  /**
   * @param prepared - the ONE resolved topology index the static factory's
   *   gate produced, and the registries over it, passed in by identity. The
   *   registry, an official default-omit resolver, and every query scope share
   *   this exact object; nothing here resolves a second time and nothing
   *   copies it (§10E.10, §11.4.10).
   */
  constructor(config: C, { relations, schemaRegistry }: PreparedSchema) {
    this.#schema = config.schema as ClientSchema<C>;
    this.#relations = relations;
    this.#registry = schemaRegistry;

    // The Raptor 3 route is the ONE operation owner (C-01). The two resolved
    // views above travel to it by identity, so the route's engine hydrates,
    // validates and registers nothing a second time (B-3).
    this.#engine = new QueryEngine(
      config.driver,
      createCommandEngine({
        schema: this.#schema,
        driver: config.driver,
        resolved: { index: relations, registry: schemaRegistry },
      })
    );
    if (config.findUniqueBatching === true)
      enableFindUniqueBatching(this.#engine.route);
  }

  /**
   * Create the client with model proxies and utility methods
   * Model operations return PendingOperation for deferred execution
   */
  #createClient(
    engine: QueryEngine,
    modelMethods: ExtensionMethods["model"] | undefined,
    clientOmit: ClientOmitResolver | undefined
  ): Client<C> {
    return createModelProxy(
      this.#schema,
      ({ modelName, operation, args }) =>
        this.#prepareModelOperation(
          engine,
          modelName,
          operation,
          args,
          clientOmit
        ),
      modelMethods,
      (modelName, ...alias) =>
        alias.length === 0
          ? renderers
              .get(this.#schema)!
              .get(engine.driver.adapter)!
              .spelling(this.#schema[modelName]!, engine.driver.dialect)
          : createRowsFragment(engine, this.#schema[modelName]!, alias[0])
    ) as Client<C>;
  }

  /** Build one model operation through the common lazy client preparation path. */
  #prepareModelOperation(
    engine: QueryEngine,
    modelName: keyof ClientSchema<C>,
    operation: Operations,
    args: unknown,
    clientOmit: ClientOmitResolver | undefined
  ): PendingOperation<unknown> {
    const modelNameStr = String(modelName);
    const model = this.#schema[modelName];
    if (!model) {
      throw new ClientInitializationError(
        `Model "${modelNameStr}" not found in schema`,
        { meta: { model: modelNameStr, operation: String(operation) } }
      );
    }

    const rawArgs = (args ?? {}) as Record<string, unknown>;
    const isWrite = isWriteOperation(operation);
    const chain = engine.extensionChain;

    const request = chain?.request;
    const requestHandlers = request?.handlers(modelNameStr, operation);
    const hasOperationObservers = chain?.observation !== undefined;
    const hasPlacedControls =
      (chain?.controls?.placed(modelNameStr, operation).length ?? 0) > 0;
    let operationArgs: Record<string, unknown> = rawArgs;
    let prepareInput: PrepareOperationInput | undefined;
    const resultFields = chain?.result;
    let finishResult: ((value: unknown) => unknown) | undefined;
    const written = isWrite ? chain?.written : undefined;
    /** The call's arguments as what watches its writes is told them. */
    let callArgs: Record<string, unknown> | undefined;
    /** What watches the call's writes is told late that they settled: the call's value runs it and waits. */
    let settle: (() => Promise<void>) | undefined;
    // Apply the client omit, then refuse an empty unique where, then plan
    // the chain's computed fields.
    const finish = (requestArgs: Record<string, unknown>) => {
      const omittedArgs = clientOmit
        ? applyClientOmit(model, operation, requestArgs, clientOmit)
        : requestArgs;
      assertNonEmptyUniqueWhere(modelNameStr, operation, omittedArgs);
      callArgs = omittedArgs;
      if (resultFields === undefined) return omittedArgs;
      const fields = resultFields.plan(
        this.#relations,
        model,
        operation,
        omittedArgs
      );
      finishResult = fields?.finish;
      return fields?.args ?? omittedArgs;
    };

    if (
      requestHandlers === undefined &&
      !hasPlacedControls &&
      !hasOperationObservers
    ) {
      operationArgs = finish(rawArgs);
    } else {
      // Request code stays behind PendingOperation's first preparation
      // boundary. That boundary memoizes both this callback's value and its
      // failure when several lifecycle entry points observe the same
      // operation, and hands it the arguments with their controls removed.
      prepareInput = (controlFreeArgs, controls, call) => {
        const transformed =
          request === undefined || requestHandlers === undefined
            ? controlFreeArgs
            : request.apply(
                operation,
                controlFreeArgs,
                requestHandlers,
                call,
                modelNameStr,
                chain?.controls,
                controls
              );
        return finish(transformed);
      };
    }

    const prepareWriteOutcomeRegistration:
      | PrepareWriteOutcomeRegistration
      | undefined =
      written === undefined
        ? undefined
        : (context, controls, call) =>
            written.watch(
              { model: modelNameStr, operation, args: callArgs!, call },
              controls,
              context,
              (late) => {
                settle = late;
              }
            );

    // Engine handles OrThrow suffix internally. Routing to the V2 operation is
    // decided lazily — before any I/O — for the whole payload.
    return engine.prepare(
      model,
      operation,
      operationArgs,
      resultFields === undefined && written === undefined
        ? undefined
        : {
            finishResult(value) {
              const finished =
                finishResult === undefined ? value : finishResult(value);
              const late = settle;
              settle = undefined;
              return late ? late().then(() => finished) : finished;
            },
          },
      prepareInput,
      prepareWriteOutcomeRegistration
    );
  }

  /** Resolve one authenticated declarative omit once for this client schema. */
  #resolveClientOmit(
    chain: ResolvedExtensionChain
  ): ClientOmitResolver | undefined {
    const capability = chain.omit;
    if (capability === undefined) return undefined;
    const resolvers =
      this.#extensionOmitResolvers ??
      (this.#extensionOmitResolvers = new WeakMap());
    const existing = resolvers.get(capability);
    if (existing !== undefined) return existing.resolver;
    const resolver = createClientOmitResolver(
      this.#schema,
      capability.config,
      this.#relations
    );
    resolvers.set(capability, Object.freeze({ resolver }));
    return resolver;
  }

  /**
   * The one get-trap ladder of every concrete view: the root client, an
   * interactive transaction's `tx`, and the scope each extension factory sees.
   * Every utility member is `$`-named or a symbol and a model name never is, so
   * model access is answered first. `extra` adds the root-only utilities, or
   * a scope's `$bind`. No client method takes a core name, so client methods
   * (and their factories) are read only for a member core does not answer.
   */
  #createViewProxy<V>(
    engine: QueryEngine,
    clientOmit: ClientOmitResolver | undefined,
    transaction: CallableFunction,
    methods: ExtensionMethods | undefined,
    extra?: (prop: string | symbol) => unknown
  ): V {
    // Raw SQL rides this view's engine: inside an interactive transaction it
    // shares the transaction's connection and rolls back with it. The surface
    // is built on first `$queryRaw`-family access.
    let rawSurface: RawSurface | undefined;
    return new Proxy(this.#createClient(engine, methods?.model, clientOmit), {
      get: (target, prop) => {
        if (typeof prop === "string" && !prop.startsWith("$")) {
          return Reflect.get(target, prop);
        }
        if (prop === "$schema") return this.#schema;
        if (prop === "$transaction") return transaction;
        if (isRawMethodName(prop)) {
          rawSurface ??= createRawSurface({ engine });
          return rawSurface[prop];
        }
        const member = extra?.(prop);
        if (member !== undefined || typeof prop !== "string") return member;
        const client = methods?.client();
        if (client !== undefined && Object.hasOwn(client, prop)) {
          return client[prop];
        }
        // A `$`-named model is still reachable; anything else is absent.
        return Object.hasOwn(this.#schema, prop)
          ? Reflect.get(target, prop)
          : undefined;
      },
    }) as V;
  }

  /**
   * Build one concrete view over one engine scope and its extension chain.
   * Each factory scope's `$bind` returns `rebuild` of this engine with the
   * values bound: a view of this view's kind. `eager` invokes every factory
   * now; otherwise each runs when a method it returns is first read.
   */
  #createView<V>(
    engine: QueryEngine,
    clientOmit: ClientOmitResolver | undefined,
    rebuild: ((engine: QueryEngine) => unknown) | undefined,
    eager: boolean,
    extra?: (prop: string | symbol) => unknown
  ): V {
    const transaction = (
      input: TransactionInput<C>,
      options?: TransactionOptions | BatchTransactionOptions
    ) => this.#transact(engine, clientOmit, input, options);
    const chain = engine.extensionChain;
    const declared = chain?.methods;
    const methods =
      declared === undefined
        ? undefined
        : declared.bind((prior, extension) =>
            this.#createViewProxy<object>(
              engine,
              clientOmit,
              transaction,
              prior,
              (prop) =>
                prop === "$bind"
                  ? (values: Readonly<Record<string, unknown>>) =>
                      rebuild!(
                        engine.withBound(
                          (chain?.controls?.bind ?? declared.bindNone)(
                            extension,
                            values,
                            engine.bound
                          )
                        )
                      )
                  : // What the words on a method's scope read of its view
                    // (`database`, `settled`).
                    prop === SCOPE
                    ? { engine, extension }
                    : undefined
            )
          );
    if (eager) methods?.force();
    return this.#createViewProxy<V>(
      engine,
      clientOmit,
      transaction,
      methods,
      extra
    );
  }

  /**
   * The one `$transaction` of every view. Inside an interactive transaction
   * the engine is transaction-bound, so a nested call is a SAVEPOINT.
   */
  #transact(
    engine: QueryEngine,
    clientOmit: ClientOmitResolver | undefined,
    input: TransactionInput<C>,
    options: TransactionOptions | BatchTransactionOptions | undefined
  ): Promise<unknown> {
    try {
      const isArray = Array.isArray(input);
      // Refuse before dispatching, so that a path which never reaches a driver
      // entry point (an empty array) still rejects an option it could not
      // honor. A savepoint's option contract differs from the outermost one,
      // and the transaction-bound driver declares that difference.
      engine.driver.assertTransactionOptionsSupported(
        options,
        isArray ? "batch" : "callback"
      );
      const chain = engine.extensionChain;
      const context = createOperationExecutionContext(
        "$transaction",
        isArray ? "$transaction([...])" : "$transaction(callback)",
        chain
      );
      if (isArray) {
        return executeArrayTransaction(input, engine, options, context);
      }
      // A chain with the write rail collects write outcomes per scope: the
      // root publishes them, a savepoint promotes them into its parent's.
      const rail = railOf(chain);
      const outcomes = rail?.outcomes();
      const view = (
        bound: QueryEngine
      ): TransactionClient<C, ExtensionStateConstraint> =>
        this.#createView(bound, clientOmit, view, false);
      const body = async (txDriver: AnyDriver) =>
        input(view(engine.bind(txDriver, chain, outcomes, true)));
      return rail && outcomes
        ? rail.runTransaction(
            engine.driver,
            outcomes,
            engine.transactionWriteOutcomes,
            options as TransactionOptions | undefined,
            context,
            body
          )
        : engine.driver.withTransaction(
            body,
            options as TransactionOptions | undefined,
            context
          );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Create one root view: the shared ladder plus the root-only utilities. */
  #createRootView<
    X extends ExtensionStateConstraint,
    ViewConfig extends VibORMConfig = C,
  >(engine: QueryEngine, eager = true): VibORMClient<ViewConfig, X> {
    const chain = engine.extensionChain;
    const clientOmit =
      chain === undefined ? undefined : this.#resolveClientOmit(chain);
    // One close path behind two doors: `$disconnect()` and, where the platform
    // has the protocol, `await using`. They are the same function object.
    const disconnect = () =>
      engine.driver._disconnect(
        createOperationExecutionContext("$connection", "$disconnect", chain)
      );

    // A root view `$extends` returns invokes every factory, where an
    // extension's faults belong; a view `$bind` derives, only those it uses.
    // Only a chain's factory scopes can `$bind`.
    const rebind =
      chain && ((bound: QueryEngine) => this.#createRootView(bound, false));
    const view = this.#createView<VibORMClient<ViewConfig, X>>(
      engine,
      clientOmit,
      rebind,
      eager,
      (prop) => {
        if (prop === "$driver") return engine.driver;
        if (prop === CLIENT_DIAGNOSTICS) return chain?.disclosure;
        if (prop === "$extends") {
          return (extension: unknown) => {
            if (!isAppliedExtension(extension))
              throw new ClientInitializationError(
                "client.$extends takes an extension: client.$extends(extension(name, ...parts))."
              );
            const extensionChain = extension.append(
              chain,
              this.#schema,
              this.#registry
            );
            return this.#createRootView(
              engine.bind(engine.driver, extensionChain)
            );
          };
        }
        if (prop === "$connect") {
          return () =>
            engine.driver._connect(
              createOperationExecutionContext("$connection", "$connect", chain)
            );
        }
        // `await using client = createClient({ ... })`. On an engine without the
        // protocol `ASYNC_DISPOSE` is undefined, which no property key equals, so
        // the property is absent — what missing disposal support looks like.
        return prop === "$disconnect" || prop === ASYNC_DISPOSE
          ? disconnect
          : undefined;
      }
    );
    return view;
  }

  /**
   * Create the full client with all utility methods
   */
  static create<
    C extends VibORMConfig,
    ViewConfig extends VibORMConfig = LinkedClientConfig<C>,
  >(config: C): VibORMClient<ViewConfig> {
    if (!config.driver) {
      throw new ClientInitializationError(
        "Driver is required to create a client. Pass a driver in createClient options."
      );
    }

    // PostgreSQL always qualifies, so an adapter with no namespace would send
    // this client's SQL wherever the connection's search_path points while
    // migrations altered another schema. Only `PostgresAdapter` owns the
    // `public` default; a custom adapter is refused rather than defaulted.
    if (
      config.driver.dialect === "postgresql" &&
      config.driver.adapter.namespace === undefined
    ) {
      throw new ClientInitializationError(
        "A PostgreSQL driver must supply an adapter with a namespace. Construct PostgresAdapter, or set `namespace` on a custom adapter."
      );
    }

    // Hydrate schema names (tsName, sqlName) for all models, scalars, and relations.
    // Construction faults (a malformed schema, an invalid identifier) surface as a typed
    // ClientInitializationError instead of a bare Error; already-typed failures pass through
    // unchanged so their own code survives.
    const orm = assertConstructed(() => {
      const checked = config.skipSchemaValidation === true;
      const reused = reusablePreparation(config.schema, checked);
      if (!reused) hydrateSchemaNames(config.schema, checked);
      // The selected adapter's physical capability, asked once here and before
      // any provider I/O (plan §3.1). A decimal domain no dialect could store is
      // a definition error, and the caller learns it at the line that bound the
      // schema rather than at the first UPDATE that could not compute inside it.
      // On SQLite the refusal is load-bearing: past 18 digits its range CHECK
      // stops being exact (see the SQLite adapter's arithmetic guards).
      const decimalRefusal =
        config.driver.dialect === "surrealql" ||
        reused?.fittingDialects.has(config.driver.dialect)
          ? undefined
          : findDecimalProviderLimitRefusal(
              config.schema,
              config.driver.dialect
            );
      if (decimalRefusal !== undefined) {
        throw new ClientInitializationError(
          describeDecimalProviderLimitRefusal(decimalRefusal)
        );
      }
      if (config.driver.adapter.geoPoint === undefined) {
        refuseGeoPointFields(config.schema);
      }
      // ONE resolution for the whole client lifecycle: the gate's index goes
      // straight into the constructor, so the registry and query scopes are
      // composed over the same object (§11.4.10).
      const prepared = reused ?? prepareSchema(config.schema, checked);
      prepared.fittingDialects.add(config.driver.dialect);
      return new VibORM<C>(config, prepared);
    });

    return orm.#createRootView<EmptyClientExtensionState, ViewConfig>(
      orm.#engine
    );
  }
}

/** The driver-independent construction a client derives from its schema. */
interface PreparedSchema {
  readonly entries: readonly (readonly [string, unknown])[];
  readonly relations: ResolvedRelationIndex;
  readonly schemaRegistry: ReturnType<typeof createResolvedSchemaRegistry>;
  /** Dialects whose decimal storage limits this schema already fits. */
  readonly fittingDialects: Set<string>;
  /** Whether the full client validation ran, not only relation resolution. */
  readonly validated: boolean;
}

/**
 * Clients over the same schema object share its validated, resolved views:
 * they derive from the models alone, so a client created per request (one per
 * Worker invocation) skips re-validating and rebuilding them. The entries are
 * compared on reuse, so a schema object that gained or swapped a model since
 * is prepared again.
 */
const preparedSchemas = new WeakMap<object, PreparedSchema>();

function reusablePreparation(
  schema: Schema,
  checked: boolean
): PreparedSchema | undefined {
  const prepared = preparedSchemas.get(schema);
  // A validating client never reuses a preparation that skipped validation.
  if (!(prepared && (prepared.validated || checked))) return;
  const keys = Object.keys(schema);
  if (keys.length !== prepared.entries.length) return;
  for (const [index, [key, model]] of prepared.entries.entries()) {
    if (keys[index] !== key || schema[key] !== model) return;
  }
  return prepared;
}

function prepareSchema(schema: Schema, checked: boolean): PreparedSchema {
  const relations = checked
    ? resolveCheckedSchemaOrThrow(schema)
    : resolveSchemaOrThrow(schema);
  const schemaRegistry = createResolvedSchemaRegistry(schema, relations);
  const prepared: PreparedSchema = {
    entries: Object.entries(schema),
    relations,
    schemaRegistry,
    fittingDialects: new Set(),
    validated: !checked,
  };
  preparedSchemas.set(schema, prepared);
  return prepared;
}

/**
 * Run a client-construction step, re-typing bare failures as ClientInitializationError.
 *
 * Typed VibORM errors (a ValidationError from schema validation, for instance) keep their own
 * class and code — only untyped construction faults are re-typed, and their message is kept
 * verbatim so existing diagnostics still read the same.
 */
function assertConstructed<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (isVibORMError(error)) {
      throw error;
    }
    const cause = error instanceof Error ? error : undefined;
    throw new ClientInitializationError(
      cause?.message ?? "Failed to create the VibORM client",
      cause ? { cause } : undefined
    );
  }
}

/**
 * Create a VibORM client
 *
 * @example
 * ```ts
 * import { PGlite } from "@electric-sql/pglite";
 * import { PGliteDriver } from "viborm/pglite";
 * import { createClient } from "viborm";
 *
 * const db = new PGlite();
 * const driver = new PGliteDriver({ client: db });
 * const client = createClient({ driver, schema: { user, post } });
 *
 * // Query
 * const users = await client.user.findMany({ where: { name: "Alice" } });
 *
 * // Transaction
 * await client.$transaction(async (tx) => {
 *   const user = await tx.user.create({ data: { name: "Bob" } });
 *   await tx.post.create({ data: { title: "Hello", authorId: user.id } });
 * });
 *
 * // Raw query
 * const result = await client.$executeRaw(sql`SELECT * FROM users`);
 *
 * // Disconnect
 * await client.$disconnect();
 * ```
 */
export const createClient = <S extends Schema, Config extends VibORMConfig<S>>(
  // `Config` captures the whole literal for the result types. The structural
  // refusal rejects unknown keys for fresh and held configuration values.
  config: Config & VibORMConfig<S> & NoExtraConfigKeys<Config, VibORMConfig<S>>
): VibORMClient<{
  [P in keyof LinkedClientConfig<Config>]: LinkedClientConfig<Config>[P];
}> => {
  // Explicit `Config`: the parameter's refusal members (`NoExtraConfigKeys`) are
  // there to reject typo'd keys, not to be threaded into the client's result
  // types — inferring `C` from the intersection would carry them along.
  return VibORM.create<
    Config,
    { [P in keyof LinkedClientConfig<Config>]: LinkedClientConfig<Config>[P] }
  >(config);
};

/**
 * The one driver-wrapper seam. It reads only core client properties, so removed
 * or driver-specific configuration getters are never copied into the core.
 */
export const createClientFromDriverConfig = <
  S extends Schema,
  C extends DriverConfig<S>,
  D extends AnyDriver,
>(
  config: C,
  driver: D
): VibORMClient<{
  [P in keyof LinkedClientConfig<C & { driver: D }>]: LinkedClientConfig<
    C & { driver: D }
  >[P];
}> => {
  const { schema, skipSchemaValidation, findUniqueBatching } = config;
  const coreConfig = {
    schema,
    driver,
    ...(skipSchemaValidation === undefined ? {} : { skipSchemaValidation }),
    ...(findUniqueBatching === undefined ? {} : { findUniqueBatching }),
  };
  return VibORM.create<
    typeof coreConfig,
    {
      [P in keyof LinkedClientConfig<C & { driver: D }>]: LinkedClientConfig<
        C & { driver: D }
      >[P];
    }
  >(coreConfig);
};
