import {
  bindOfficialCacheChain,
  getOfficialCacheChainCapability,
  type OfficialCacheExtension,
  type OfficialCacheQueryContribution,
  officialCacheRuntime,
} from "@cache/capability";
import type { CacheExecutionOptions } from "@cache/driver";
import type { WithCacheOptions } from "@cache/schema";
import { ASYNC_DISPOSE, type AsyncDisposeMember } from "@drivers/async-dispose";
import { readDriverIdentity } from "@drivers/driver-identity";
import type { AnyDriver } from "@drivers/exports";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import { ClientInitializationError, isVibORMError } from "@errors";
import {
  appendResolvedExtension,
  lookupPlacedControls,
  lookupResolvedExtensionHandlers,
  type ResolvedExtensionChain,
} from "@extensions/chain";
import type {
  ClientExtension,
  ContextualExtensionDefinition,
  ExactExtensionDefinition,
  HasNamedClientOmit,
  SchemaBoundExtensionAdmission,
} from "@extensions/definition";
import {
  type AccumulatedExtensionState,
  type BoundExtensionMethods,
  bindExtensionMethods,
  type EmptyClientExtensionState,
  type EnableExtensionCache,
  type ExtensionModelClient,
  type ExtensionStateConstraint,
  type ExtensionStateContributionOf,
  type HasExtensionCache,
  type HasResultConsumingExtension,
} from "@extensions/methods";
import { TransactionWriteOutcomes } from "@extensions/query";
import { applyRequestTransforms } from "@extensions/request";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import {
  attachPendingCacheExecution,
  type PendingOperation,
  type PrepareOperationInput,
  type PrepareWriteOutcomeRegistration,
  readPendingCacheResult,
} from "@query-engine/pending-operation";
import { QueryEngine } from "@query-engine/query-engine";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import {
  isWriteOperation,
  ROUTED_OPERATIONS,
} from "@query-engine/routed-operations";
import type { TransactionOperation } from "@query-engine/transaction-operation";
import { hydrateSchemaNames } from "@schema/hydration";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import {
  resolveCheckedSchemaOrThrow,
  resolveSchemaOrThrow,
} from "@schema/validation/validator";
import { createResolvedSchemaRegistry } from "@validation/builder";
import {
  executeArrayTransaction,
  runOutcomeTransaction,
} from "./array-transaction";
import { assertDecimalDomainsFitProvider } from "./decimal-provider-limits";
import {
  getOfficialDefaultOmitChainCapability,
  type OfficialDefaultOmitExtension,
  type OfficialDefaultOmitRequestContribution,
} from "./default-omit-extension";
import { assertGeoPointFieldsFitAdapter } from "./geo-point-provider-limit";
import {
  applyClientOmit,
  type ClientOmitResolver,
  createClientOmitResolver,
} from "./omit";
import {
  createRawSurface,
  RAW_METHOD_NAMES,
  type RawOperation,
  type RawSurface,
} from "./raw";
import type { ClientSchema, LinkedClientConfig } from "./schema-links";
import type {
  CachedClient,
  Client,
  ClientRowsContext,
  ContextualOperationResult,
  Operations,
  Schema,
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

interface OfficialReadCache {
  readonly capability: NonNullable<
    ReturnType<typeof getOfficialCacheChainCapability>
  >;
  readonly options: CacheExecutionOptions;
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
  modelMethods?: Readonly<
    Record<string, Readonly<Record<string, CallableFunction>>>
  >,
  path: string[] = []
): unknown {
  const members = new Set(
    path.length === 0
      ? Object.keys(schema)
      : path.length === 1
        ? [...ROUTED_OPERATIONS, ...Object.keys(modelMethods?.[path[0]!] ?? {})]
        : []
  );
  const children = new Map<string, unknown>();
  const readMember = (key: string | symbol): unknown => {
    if (typeof key !== "string" || key === "then" || !members.has(key))
      return undefined;
    if (path.length === 1) {
      const method = modelMethods?.[path[0]!]?.[key];
      if (method) return method;
    }
    let child = children.get(key);
    if (child === undefined) {
      child = createModelProxy(schema, createOperation, modelMethods, [
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
}

export interface DriverConfig<S extends Schema = Schema>
  extends Omit<VibORMConfig<S>, "driver"> {}

type OrdinaryOfficialExtensionGuard<Definition> = Definition extends {
  readonly name: "viborm.cache";
}
  ? { readonly name: never }
  : Definition extends {
        readonly query: OfficialCacheQueryContribution;
      }
    ? { readonly query: never }
    : Definition extends { readonly name: "viborm.defaultOmit" }
      ? { readonly name: never }
      : Definition extends {
            readonly request: OfficialDefaultOmitRequestContribution<object>;
          }
        ? { readonly request: never }
        : unknown;

type OfficialAwareDefinition<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  Self = unknown,
> =
  | ContextualExtensionDefinition<C, X, Self>
  | OfficialCacheExtension
  | OfficialDefaultOmitExtension;

type OfficialCacheAdmission<
  Definition,
  X extends ExtensionStateConstraint,
> = Record<Exclude<keyof Definition, keyof OfficialCacheExtension>, never> &
  (HasExtensionCache<X> extends true ? { readonly name: never } : unknown);

type OfficialDefaultOmitAdmission<
  Definition,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = Record<
  Exclude<keyof Definition, keyof OfficialDefaultOmitExtension>,
  never
> &
  (HasNamedClientOmit<C> extends true
    ? { readonly name: never }
    : HasResultConsumingExtension<X> extends true
      ? { readonly name: never }
      : unknown);

type ExtensionAdmission<
  Definition,
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
> = Definition extends OfficialCacheExtension
  ? OfficialCacheAdmission<Definition, X>
  : Definition extends OfficialDefaultOmitExtension
    ? OfficialDefaultOmitAdmission<Definition, C, X>
    : Definition extends ContextualExtensionDefinition<C, X, Definition>
      ? ExactExtensionDefinition<Definition, C, X> &
          OrdinaryOfficialExtensionGuard<Definition> &
          SchemaBoundExtensionAdmission<Definition, C>
      : never;

type WithDefaultOmit<C extends VibORMConfig, OmitConfig> = Omit<C, "omit"> & {
  readonly omit: OmitConfig;
};

type AppliedClientConfig<
  C extends VibORMConfig,
  Definition,
> = Definition extends OfficialDefaultOmitExtension<infer OmitConfig>
  ? WithDefaultOmit<C, OmitConfig>
  : C;

type AppliedExtensionState<
  X extends ExtensionStateConstraint,
  Definition,
> = Definition extends OfficialCacheExtension
  ? EnableExtensionCache<X>
  : Definition extends OfficialDefaultOmitExtension
    ? X
    : AccumulatedExtensionState<X, ExtensionStateContributionOf<Definition>>;

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
    $transaction: {
      <T>(
        fn: (tx: TransactionClient<C, X>) => PromiseLike<T>,
        options?: TransactionOptions
      ): Promise<T>;
      <T extends BatchTransactionOperation<unknown>[]>(
        operations: [...T],
        options?: BatchTransactionOptions
      ): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
    };
  } & X["client"];

/**
 * Extended client type with utility methods
 */
export type VibORMClient<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint = EmptyClientExtensionState,
> = ExtensionModelClient<C, X> &
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
      ) => CachedClient<C, ClientRowsContext<C, X["rows"]>, X["controls"]>;
      /** Invalidate cache entries by keys or patterns (use * suffix for prefix matching) */
      $invalidate: (...keys: string[]) => Promise<void>;
    },
    HasExtensionCache<X> extends true ? "never" : "$withCache" | "$invalidate"
  >;

/**
 * The client members no extension state removes. An interface outside the
 * `Omit` above, so a body generic over the extension state still reaches them.
 */
interface VibORMClientMembers<
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
  $transaction: {
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
  /** Connect to the database */
  $connect: () => Promise<void>;
  /** Disconnect from the database */
  $disconnect: () => Promise<void>;
  /**
   * Return an immutable client view with one more named extension. The
   * bound is F-bounded: the definition's own model keys are checked.
   */
  $extends: <
    const Definition extends OfficialAwareDefinition<C, X, Definition>,
  >(
    extension: Definition & ExtensionAdmission<Definition, C, X>
  ) => VibORMClient<
    AppliedClientConfig<C, Definition>,
    AppliedExtensionState<X, Definition>
  >;
}

type ApplyClientExtensions<
  C extends VibORMConfig,
  X extends ExtensionStateConstraint,
  Definitions extends readonly unknown[],
> = Definitions extends readonly []
  ? VibORMClient<C, X>
  : Definitions extends readonly [
        infer Definition,
        ...infer RemainingDefinitions,
      ]
    ? Definition extends OfficialAwareDefinition<C, X>
      ? Definition extends ExtensionAdmission<Definition, C, X>
        ? ApplyClientExtensions<
            AppliedClientConfig<C, Definition>,
            AppliedExtensionState<X, Definition>,
            RemainingDefinitions
          >
        : never
      : never
    : never;

/**
 * The exact client surface produced by applying an ordered extension tuple.
 *
 * @example
 * ```ts
 * type AppClient = ExtendedClient<
 *   typeof db,
 *   readonly [typeof defaults, typeof cached, typeof methods]
 * >;
 * ```
 */
export type ExtendedClient<
  Base,
  Extensions extends readonly unknown[],
> = number extends Extensions["length"]
  ? never
  : Base extends VibORMClient<infer C, infer X>
    ? ApplyClientExtensions<C, X, Extensions>
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
> = Client extends VibORMClient<infer C, infer X>
  ? ContextualOperationResult<
      C,
      ModelName & keyof ClientSchema<C>,
      O,
      Args,
      ClientRowsContext<C, X["rows"]>
    >
  : never;

/**
 * VibORM Client
 */
export class VibORM<C extends VibORMConfig> {
  readonly #schema: ClientSchema<C>;
  readonly #engine: QueryEngine;
  readonly #relations: ResolvedRelationIndex;
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

    // The Raptor 3 route is the ONE operation owner (C-01). The two resolved
    // views above travel to it by identity, so the route's engine hydrates,
    // validates and registers nothing a second time (B-3).
    this.#engine = new QueryEngine(
      config.driver,
      createCandidateRoute(this.#schema, config.driver, {
        index: relations,
        registry: schemaRegistry,
      })
    );
  }

  /**
   * Create the client with model proxies and utility methods
   * Model operations return PendingOperation for deferred execution
   */
  #createClient(
    engine: QueryEngine,
    modelMethods: BoundExtensionMethods["models"] | undefined,
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
      modelMethods
    ) as Client<C>;
  }

  /** Build one model operation through the common lazy client preparation path. */
  #prepareModelOperation(
    engine: QueryEngine,
    modelName: keyof ClientSchema<C>,
    operation: Operations,
    args: unknown,
    clientOmit: ClientOmitResolver | undefined,
    officialReadCache?: OfficialReadCache
  ): PendingOperation<unknown> {
    const officialCache = getOfficialCacheChainCapability(
      engine.extensionChain
    );
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

    const requestHandlers = lookupResolvedExtensionHandlers(
      chain,
      "request",
      modelNameStr,
      operation
    );
    const hasOperationObservers = (chain?.observe.length ?? 0) > 0;
    const hasPlacedControls =
      lookupPlacedControls(chain, modelNameStr, operation).length > 0;
    let operationArgs: Record<string, unknown> = rawArgs;
    let prepareInput: PrepareOperationInput | undefined;

    if (
      requestHandlers === undefined &&
      !hasPlacedControls &&
      !hasOperationObservers
    ) {
      const requestArgs = rawArgs;
      operationArgs = clientOmit
        ? applyClientOmit(model, operation, requestArgs, clientOmit)
        : requestArgs;
      assertNonEmptyUniqueWhere(operation, operationArgs);
    } else {
      // Request code stays behind PendingOperation's first preparation
      // boundary. That boundary memoizes both this callback's value and its
      // failure when several lifecycle entry points observe the same
      // operation, and hands it the arguments with their controls removed.
      prepareInput = (controlFreeArgs, controls) => {
        const transformed =
          requestHandlers === undefined
            ? controlFreeArgs
            : applyRequestTransforms(
                modelNameStr,
                operation,
                controlFreeArgs,
                requestHandlers,
                chain?.controls === undefined
                  ? undefined
                  : { names: chain.controls.names, admitted: controls }
              );
        const requestArgs = transformed ?? {};
        const omittedArgs = clientOmit
          ? applyClientOmit(model, operation, requestArgs, clientOmit)
          : requestArgs;
        assertNonEmptyUniqueWhere(operation, omittedArgs);
        return omittedArgs;
      };
    }

    const prepareWriteOutcomeRegistration:
      | PrepareWriteOutcomeRegistration
      | undefined =
      officialCache === undefined || !isWrite
        ? undefined
        : (context, controls) =>
            officialCacheRuntime().prepareMutationCacheWriteOutcome(
              officialCache.driver,
              modelNameStr,
              operation,
              officialCacheRuntime().readMutationCacheOptions(controls),
              context,
              officialCache.scope
            );

    // Engine handles OrThrow suffix internally. Routing to the V2 operation is
    // decided lazily — before any I/O — for the whole payload.
    const pendingOperation = officialReadCache
      ? engine.prepare(
          model,
          operation,
          operationArgs,
          { skipSpan: true },
          prepareInput
        )
      : engine.prepare(
          model,
          operation,
          operationArgs,
          undefined,
          prepareInput,
          prepareWriteOutcomeRegistration
        );
    if (officialReadCache === undefined) return pendingOperation;
    return this.#wrapOfficialCachedRead(
      engine,
      modelNameStr,
      operation,
      pendingOperation,
      officialReadCache
    );
  }

  /** Bind cached reads to the same root or derived engine as their client. */
  #withCache(
    engine: QueryEngine,
    capability: NonNullable<ReturnType<typeof getOfficialCacheChainCapability>>,
    clientOmit: ClientOmitResolver | undefined,
    config?: WithCacheOptions
  ): CachedClient<C> {
    const runtime = officialCacheRuntime();
    const options = runtime.createCacheExecutionOptions(
      config,
      capability.waitUntil,
      readDriverIdentity(engine.driver)
    );
    const officialReadCache = Object.freeze({ capability, options });
    return createModelProxy(this.#schema, ({ modelName, operation, args }) => {
      try {
        runtime.validateCacheableOperation(operation);
        return this.#prepareModelOperation(
          engine,
          modelName,
          operation,
          args,
          clientOmit,
          officialReadCache
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }) as CachedClient<C>;
  }

  /** Resolve one authenticated declarative omit once for this client schema. */
  #resolveClientOmit(
    chain: ResolvedExtensionChain
  ): ClientOmitResolver | undefined {
    const capability = getOfficialDefaultOmitChainCapability(chain);
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

  /** Keep every arbitrary query handler outside the official cache child. */
  #wrapOfficialCachedRead(
    engine: QueryEngine,
    modelName: string,
    operation: Operations,
    pendingOperation: PendingOperation<unknown>,
    cacheRead: OfficialReadCache
  ): PendingOperation<unknown> {
    return attachPendingCacheExecution(
      pendingOperation,
      async (execute, driverOverride) => {
        if (
          driverOverride !== undefined ||
          engine.transactionWriteOutcomes !== undefined ||
          (engine.extensionChain?.statement.length ?? 0) > 0
        ) {
          return execute();
        }
        const cacheResult = readPendingCacheResult(pendingOperation);
        const runtime = officialCacheRuntime();
        const key = runtime.cacheKeyOf(
          cacheResult.args,
          cacheResult.controls,
          engine.extensionChain?.rows
        );
        if (key === undefined) return execute();
        return runtime.executeCachedResultOperation(
          cacheRead.capability.driver,
          modelName,
          operation,
          key,
          () => execute(),
          {
            ...cacheRead.options,
            executionContext: cacheResult.executionContext,
          },
          cacheResult.codec,
          cacheRead.capability.scope
        );
      }
    );
  }

  /**
   * The one get-trap ladder of every concrete view: the root client, an
   * interactive transaction's `tx`, and the scope each extension factory sees.
   * Every utility member is `$`-named or a symbol and a model name never is, so
   * model access is answered first. `extra` adds the root-only utilities.
   */
  #createViewProxy<V>(
    engine: QueryEngine,
    clientOmit: ClientOmitResolver | undefined,
    transaction: CallableFunction,
    clientMethods: BoundExtensionMethods["client"] | undefined,
    modelMethods: BoundExtensionMethods["models"] | undefined,
    extra?: (prop: string | symbol) => unknown
  ): V {
    // Raw SQL rides this view's engine: inside an interactive transaction it
    // shares the transaction's connection and rolls back with it. The surface
    // is built on first `$queryRaw`-family access.
    let rawSurface: RawSurface | undefined;
    return new Proxy(this.#createClient(engine, modelMethods, clientOmit), {
      get: (target, prop) => {
        if (typeof prop === "string") {
          if (!prop.startsWith("$")) return Reflect.get(target, prop);
          if (clientMethods && Object.hasOwn(clientMethods, prop)) {
            return clientMethods[prop];
          }
        }
        if (prop === "$schema") return this.#schema;
        if (prop === "$transaction") return transaction;
        if (isRawMethodName(prop)) {
          rawSurface ??= createRawSurface({ engine });
          return rawSurface[prop];
        }
        const member = extra?.(prop);
        // A `$`-named model is still reachable; anything else is absent.
        return member === undefined &&
          typeof prop === "string" &&
          Object.hasOwn(this.#schema, prop)
          ? Reflect.get(target, prop)
          : member;
      },
    }) as V;
  }

  /** Build one concrete view over one engine scope and its extension chain. */
  #createView<V>(
    engine: QueryEngine,
    clientOmit: ClientOmitResolver | undefined,
    extra?: (prop: string | symbol) => unknown
  ): V {
    const transaction = (
      input: TransactionInput<C>,
      options?: TransactionOptions | BatchTransactionOptions
    ) => this.#transact(engine, clientOmit, input, options);
    const chain = engine.extensionChain;
    const methods =
      chain &&
      bindExtensionMethods(chain, (clientMethods, modelMethods) =>
        this.#createViewProxy<object>(
          engine,
          clientOmit,
          transaction,
          clientMethods,
          modelMethods
        )
      );
    return this.#createViewProxy<V>(
      engine,
      clientOmit,
      transaction,
      methods?.client,
      methods?.models,
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
      // A coordinated chain collects write outcomes per scope: the root
      // publishes them, a savepoint promotes them into its parent's collector.
      const outcomes =
        chain?.hasQueryHandlers ||
        chain?.hasCache ||
        (chain?.observe.length ?? 0) > 0
          ? new TransactionWriteOutcomes()
          : undefined;
      const body = async (txDriver: AnyDriver) =>
        input(
          this.#createView(engine.bind(txDriver, chain, outcomes), clientOmit)
        );
      return outcomes
        ? runOutcomeTransaction(
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
  >(engine: QueryEngine): VibORMClient<ViewConfig, X> {
    const chain = engine.extensionChain;
    const clientOmit =
      chain === undefined ? undefined : this.#resolveClientOmit(chain);
    // One close path behind two doors: `$disconnect()` and, where the platform
    // has the protocol, `await using`. They are the same function object.
    const disconnect = () =>
      engine.driver._disconnect(
        createOperationExecutionContext("$connection", "$disconnect", chain)
      );

    return this.#createView(engine, clientOmit, (prop) => {
      if (prop === "$driver") return engine.driver;
      if (prop === "$extends") {
        return (extension: ClientExtension) => {
          const extensionChain = appendResolvedExtension(
            chain,
            extension,
            this.#schema
          );
          // The one point that holds both the resolved chain and the concrete
          // driver, so the one point that can partition the official cache by
          // this client's dialect and SQL namespace. A chain without the
          // official cache makes no call at all.
          if (extensionChain.hasCache) {
            bindOfficialCacheChain(extensionChain, engine.driver);
          }
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
      if (prop === "$disconnect" || prop === ASYNC_DISPOSE) return disconnect;
      if (prop !== "$withCache" && prop !== "$invalidate") return undefined;
      const officialCache = getOfficialCacheChainCapability(chain);
      if (officialCache === undefined) return undefined;
      if (prop === "$withCache") {
        return (cacheConfig?: WithCacheOptions) =>
          this.#withCache(engine, officialCache, clientOmit, cacheConfig);
      }
      return async (...keys: string[]) => {
        await officialCacheRuntime().invalidateManualCache(
          officialCache.driver,
          keys,
          createOperationExecutionContext("$cache", "$invalidate", chain),
          officialCache.scope
        );
      };
    });
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
      if (!reused?.fittingDialects.has(config.driver.dialect))
        assertDecimalDomainsFitProvider(config.schema, config.driver.dialect);
      assertGeoPointFieldsFitAdapter(config.schema, config.driver.adapter);
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
  const { schema, skipSchemaValidation } = config;
  const coreConfig = {
    schema,
    driver,
    ...(skipSchemaValidation === undefined ? {} : { skipSchemaValidation }),
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
