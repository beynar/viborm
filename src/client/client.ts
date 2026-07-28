import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { assertNormalizedBatchResults } from "@drivers/normalized-result";
import type {
  BatchTransactionOptions,
  TransactionOptions,
} from "@drivers/shared/transaction-options";
import type { DiagnosticDisclosure } from "@errors";
import {
  CacheConfigurationError,
  ClientInitializationError,
  InvalidTransactionInputError,
  isVibORMError,
  PendingOperationError,
  TransactionError,
} from "@errors";
import {
  createInstrumentationContext,
  type InstrumentationConfig,
  type InstrumentationContext,
  type LoggingConfig,
  type TracingConfig,
} from "@instrumentation";

/**
 * Check if a value is an InstrumentationContext (already processed)
 * InstrumentationContext has 'config' and 'tracer' properties,
 * while InstrumentationConfig has no processed tracer instance
 */
function isInstrumentationContext(
  value: InstrumentationConfig | InstrumentationContext | undefined
): value is InstrumentationContext {
  return value !== undefined && "config" in value && "tracer" in value;
}

import { attributeOperationBatchError } from "@query-engine/batch-error-attribution";
import {
  createCacheExecutionOptions,
  executeCachedOperation,
  invalidateCommittedBatch,
  invalidateManualCache,
  validateCacheableOperation,
  withMutationCacheInvalidation,
} from "@query-engine/cache-flow";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import {
  isPendingOperation,
  PendingOperation,
} from "@query-engine/pending-operation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { PreparedBatchGuard } from "@query-engine/types";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry } from "@validation";
import {
  applyClientOmit,
  type ClientModelOmit,
  type ClientOmitConfig,
  type ClientOmitResolver,
  createClientOmitResolver,
} from "./omit";
import {
  createLegacyRawWarner,
  createRawSurface,
  isRawOperationPromise,
  type LegacyRawWarner,
  type RawSurface,
  rawOperationInBatchError,
} from "./raw";
import type {
  CachedClient,
  Client,
  Operations,
  Schema,
  WaitUntilFn,
} from "./types";
import { assertNonEmptyUniqueWhere } from "./unique-where-guard";

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
  path: string[] = []
): unknown {
  // Memoize child proxies: model/operation names are a small finite set, so
  // `client.user.findUnique` resolves to the same proxy every time instead of
  // allocating two fresh Proxy objects (+ path arrays) per query.
  const children = new Map<string, unknown>();
  // biome-ignore lint: <it's ok>
  return new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      // Prevent Promise-like behavior - return undefined for 'then'
      // This allows the proxy to be returned from async functions without
      // being treated as a thenable
      if (key === "then") return undefined;
      let child = children.get(key);
      if (child === undefined) {
        child = createModelProxy(schema, createOperation, [...path, key]);
        children.set(key, child);
      }
      return child;
    },
    apply(_target, _thisArg, [args]) {
      const modelName = path[0] as keyof S;
      const operation = path[1] as Operations;
      return createOperation({ modelName, operation, args });
    },
  });
}

const RAW_METHOD_NAMES = new Set<string>([
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRaw",
  "$queryRawUnsafe",
]);

/** The four raw methods the client and its transaction clients answer. */
function isRawMethodName(prop: string | symbol): prop is keyof RawSurface {
  return typeof prop === "string" && RAW_METHOD_NAMES.has(prop);
}

/**
 * Every item of `$transaction([...])` must be a deferrable model operation. A
 * raw query is not one — it already ran — so it gets its own refusal instead
 * of the generic "not a pending operation".
 */
function assertBatchableOperation(
  candidate: unknown
): asserts candidate is PendingOperation<unknown> {
  if (isPendingOperation(candidate)) return;
  if (isRawOperationPromise(candidate)) throw rawOperationInBatchError();
  throw new InvalidTransactionInputError();
}

function assertOperationOwnership(
  operation: PendingOperation<unknown>,
  engine: QueryEngine
): void {
  if (operation.getClientId() !== engine.clientId) {
    throw PendingOperationError.clientMismatch(
      operation.getModel(),
      operation.getOperation()
    );
  }
  if (operation.getScopeId() !== engine.scopeId) {
    throw PendingOperationError.scopeMismatch(
      operation.getModel(),
      operation.getOperation()
    );
  }
}

/**
 * VibORM Configuration
 */
export interface VibORMConfig<S extends Schema = Schema> {
  schema: S;
  driver: AnyDriver;
  cache?: CacheDriver;
  /** Instrumentation config (for initial setup) or context (for internal reuse) */
  instrumentation?: InstrumentationConfig | InstrumentationContext;
  waitUntil?: WaitUntilFn;
  /** Cache version for invalidating cache on schema changes */
  cacheVersion?: number | string;
  /**
   * Fields this client hides by default, per model:
   * `omit: { user: { passwordHash: true } }`.
   *
   * A DEFAULT, not a rule. A query overrides it per field
   * (`omit: { passwordHash: false }`) or wholesale by naming the field in an
   * explicit `select`. Model-level `.omit()` is the rule — see
   * `docs/content/docs/client/omit.mdx` for the full precedence.
   */
  omit?: ClientOmitConfig<S>;
  /**
   * **Transitional escape hatch — removed in the release after this one.**
   *
   * `"number"` restores the pre-W6 decimal decode, where a decimal read comes
   * back as a JS `number`. It is RUNTIME ONLY: the static types still say
   * `string`, so a client with this set is deliberately type-incoherent and
   * your editor will keep telling you so.
   *
   * It exists for one thing — unblocking a deploy that cannot migrate every
   * decimal read at once. It is not a supported mode. A `number` is a double
   * and cannot hold what a `numeric` / `DECIMAL(65,30)` column holds, which is
   * the entire reason decimals became strings.
   */
  decimal?: "string" | "number";
}

export interface DriverConfig<S extends Schema = Schema>
  extends Omit<VibORMConfig<S>, "driver"> {}

/**
 * The keys a proposed config names that the surface does not have: the typos.
 *
 * `createClient` infers `Config` FROM the literal, so the literal's own keys are
 * by construction "known" to the parameter type and excess-property checking has
 * nothing to complain about — `cacheVerison: 1` recorded a setting nobody reads
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
 * The unknown keys of ONE nested bag: the depth-2 flavour of the same refusal.
 *
 * `NoExtraConfigKeys` guards the config's OWN keys. It says nothing about what
 * is inside `omit`, `instrumentation`, or a driver's `options` — and inside is
 * where nothing was refusing. The contextual type there is
 * `Config["<key>"] & <the declared type>`, and `Config` was inferred from the
 * literal, so every key the caller wrote is "known" to the intersection by
 * construction. Excess-property checking has nothing to say, exactly as at
 * depth 1.
 *
 * What LOOKED like a refusal was TypeScript's weak-type detection: the declared
 * bags (`ClientModelOmit`, `InstrumentationConfig`, every driver's options) are
 * all-optional, so an object sharing NO property with them is an error. That
 * fires for `{ passwordHsh: true }` and stops firing the instant one real key
 * sits beside the typo — `{ passwordHash: true, passwordHsh: true }` compiled,
 * which is the shape a real config has. A probe with the typo ALONE therefore
 * measures weak-type detection, not the surface.
 *
 * `unknown` for a non-object so intersecting this never disturbs `tracing: true`
 * or a driver instance.
 */
export type NoExtraNestedKeys<Given, Allowed> = Given extends object
  ? Record<Exclude<keyof Given, keyof Allowed>, never>
  : unknown;

/**
 * Per-KEY refusal for the client `omit` config, at BOTH of its levels: an
 * unknown MODEL name, and an unknown FIELD of a known model.
 *
 * This is the surface the case-study commits (`f842302`, `2f7bd59`) keyed, and
 * the one that most needs the per-key form: `omit` is where secrets are named,
 * and a silently-ignored key there is a leaked column. The model builder's
 * `.omit()` already refuses per key (`UnknownOmitKeys`) for exactly this
 * reason; the client-level config did not, so
 * `{ author: { passwordHash: true, passwordHsh: true } }` hid one secret and
 * quietly ignored the other.
 *
 * Mapped over `keyof O` — the keys the caller actually wrote — so this adds no
 * requirement, and gated on `Config` having an `omit` at all so it never makes
 * one necessary.
 */
export type NoExtraOmitKeys<Config, S extends Schema> = Config extends {
  omit: infer O;
}
  ? {
      omit: Record<Exclude<keyof O, keyof S>, never> & {
        [M in keyof O]: M extends keyof S
          ? NoExtraNestedKeys<O[M], ClientModelOmit<S[M]>>
          : unknown;
      };
    }
  : unknown;

/**
 * Per-key refusal for the `instrumentation` bag and each of its three sub-bags.
 *
 * The accepted top-level set is the union of `InstrumentationConfig`'s keys and
 * `InstrumentationContext`'s, because the property takes either: a config when
 * an app sets one up, a context when the client is rebuilt from a live one.
 */
export type NoExtraInstrumentationKeys<Config> = Config extends {
  instrumentation: infer I;
}
  ? {
      instrumentation: NoExtraNestedKeys<
        I,
        InstrumentationConfig & InstrumentationContext
      > & {
        [K in keyof I]: K extends "tracing"
          ? NoExtraNestedKeys<I[K], TracingConfig>
          : K extends "logging"
            ? NoExtraNestedKeys<I[K], LoggingConfig>
            : K extends "diagnostics"
              ? NoExtraNestedKeys<I[K], DiagnosticDisclosure>
              : unknown;
      };
    }
  : unknown;

/** Everything `createClient` refuses beyond the config's own key set. */
export type NoExtraNestedConfigKeys<Config, S extends Schema> = NoExtraOmitKeys<
  Config,
  S
> &
  NoExtraInstrumentationKeys<Config>;

/**
 * The client an interactive `$transaction(async (tx) => ...)` callback gets:
 * every model operation, the raw SQL surface bound to the OPEN transaction,
 * and nested `$transaction` (savepoints).
 */
export type TransactionClient<C extends VibORMConfig> = Client<C> &
  RawSurface & {
    $transaction: {
      <T>(
        fn: (tx: TransactionClient<C>) => Promise<T>,
        options?: TransactionOptions
      ): Promise<T>;
      <T extends PendingOperation<unknown>[]>(
        operations: [...T],
        options?: BatchTransactionOptions
      ): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
    };
  };

/**
 * Extended client type with utility methods
 */
export type VibORMClient<C extends VibORMConfig> = Client<C> &
  RawSurface &
  Omit<
    {
      /** Access the underlying driver */
      $driver: AnyDriver;
      /** Access the schema (models) */
      $schema: C["schema"];
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
          fn: (tx: TransactionClient<C>) => Promise<T>,
          options?: TransactionOptions
        ): Promise<T>;
        // Overload 2: Batch of independent operations (Prisma-style)
        <T extends PendingOperation<unknown>[]>(
          operations: [...T],
          options?: BatchTransactionOptions
        ): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
      };
      /** Connect to the database */
      $connect: () => Promise<void>;
      /** Disconnect from the database */
      $disconnect: () => Promise<void>;
      /** Create a client with cache - only read operations available */
      $withCache: (config?: WithCacheOptions) => CachedClient<C>;
      /** Invalidate cache entries by keys or patterns (use * suffix for prefix matching) */
      $invalidate: (...keys: string[]) => Promise<void>;
    },
    C["cache"] extends CacheDriver ? "never" : "$withCache" | "$invalidate"
  >;

/**
 * VibORM Client
 */
export class VibORM<C extends VibORMConfig> {
  private readonly schema: C["schema"];
  private readonly cache: C["cache"];
  private readonly waitUntil: WaitUntilFn | undefined;
  private readonly cacheVersion: string | number | undefined;
  private readonly engine: QueryEngine;
  /**
   * One deprecation sink per client, shared with every transaction client it
   * opens, so the legacy raw-string notice is announced once — not once per
   * transaction.
   */
  private readonly legacyRawWarner: LegacyRawWarner;
  /** `undefined` unless `config.omit` named at least one field to hide. */
  private readonly clientOmit: ClientOmitResolver | undefined;

  /**
   * Unique identifier for this client instance.
   * Used to verify operations belong to the same client in $transaction.
   */
  get clientId(): symbol {
    return this.engine.clientId;
  }

  /**
   * The raw SQL surface bound to one driver — the client's own driver, or the
   * transaction-bound driver inside an open interactive transaction.
   */
  private rawSurface(driver: AnyDriver): RawSurface {
    return createRawSurface({
      driver,
      instrumentation: this.engine.instrumentation,
      warnLegacyString: this.legacyRawWarner,
    });
  }

  constructor(config: C) {
    this.schema = config.schema as C["schema"];
    this.cache = config.cache as C["cache"];
    // Accept either InstrumentationConfig (initial setup) or InstrumentationContext (internal reuse)
    const instrumentation = isInstrumentationContext(config.instrumentation)
      ? config.instrumentation
      : config.instrumentation
        ? createInstrumentationContext(config.instrumentation)
        : undefined;
    this.waitUntil = config.waitUntil;
    this.cacheVersion = config.cacheVersion;
    this.clientOmit = createClientOmitResolver(this.schema, config.omit);

    // Create registry and engine once, reuse for all operations
    const schemaRegistry = createSchemaRegistry(this.schema);
    const registry = createModelRegistry(this.schema, schemaRegistry);
    this.engine = new QueryEngine(
      config.driver,
      registry,
      instrumentation,
      undefined,
      undefined,
      config.decimal ?? "string"
    );
    this.legacyRawWarner = createLegacyRawWarner(instrumentation);
  }

  /**
   * Create the client with model proxies and utility methods
   * Model operations return PendingOperation for deferred execution
   */
  private createClient(engine: QueryEngine = this.engine): Client<C> {
    return createModelProxy(this.schema, ({ modelName, operation, args }) => {
      const modelNameStr = String(modelName);
      const model = this.schema[modelNameStr as keyof C["schema"]];
      if (!model) {
        throw new ClientInitializationError(
          `Model "${modelNameStr}" not found in schema`,
          { meta: { model: modelNameStr, operation: String(operation) } }
        );
      }

      assertNonEmptyUniqueWhere(operation, args);

      // Extract cache invalidation options from args (client-level concern).
      // Only clone args when a `cache` key is actually present — the common
      // path passes args straight through without a per-query shallow copy.
      const rawArgs = (args ?? {}) as Record<string, unknown> & {
        cache?: CacheInvalidationOptions;
      };
      let cacheOptions: CacheInvalidationOptions | undefined;
      let cleanArgs: Record<string, unknown> = rawArgs;
      if ("cache" in rawArgs) {
        const { cache, ...rest } = rawArgs;
        cacheOptions = cache;
        cleanArgs = rest;
      }

      // Client-level `omit` is a payload rewrite, applied once here so the rest
      // of the stack only ever sees a query-level `omit` (see ./omit.ts).
      const omitArgs = this.clientOmit
        ? applyClientOmit(model, operation, cleanArgs, this.clientOmit)
        : cleanArgs;

      // Engine handles OrThrow suffix internally. Routing to the V2 operation is
      // decided lazily — before any I/O — for the whole payload.
      const pendingOp = PendingOperation.create(
        engine,
        model,
        operation,
        omitArgs
      );

      // Wrap with cache invalidation for mutations (client-level concern)
      if (this.cache) {
        return withMutationCacheInvalidation(
          pendingOp,
          this.cache,
          modelNameStr,
          operation,
          cacheOptions
        );
      }

      return pendingOp;
    }) as Client<C>;
  }

  /**
   * Create a client with caching enabled
   * Returns a client with only cacheable (read) operations
   */
  $withCache(config?: WithCacheOptions): CachedClient<C> {
    if (!this.cache) {
      throw new CacheConfigurationError(
        "Cache driver not configured. Pass a cache driver in createClient options."
      );
    }

    const options = createCacheExecutionOptions(
      config,
      this.waitUntil,
      this.engine.driver.getBaseAttributes()
    );

    // Create proxy that validates cacheable operations and delegates to cache driver
    // Returns Promises directly (not PendingOperation) - cache operations are not batchable
    return createModelProxy(this.schema, ({ modelName, operation, args }) => {
      const modelNameStr = String(modelName);

      // Runtime check - only cacheable operations allowed
      // Return rejected Promise to maintain async behavior consistency
      try {
        validateCacheableOperation(operation);
      } catch (error) {
        return Promise.reject(error);
      }

      const model = this.schema[modelNameStr as keyof C["schema"]];
      if (!model) {
        return Promise.reject(
          new ClientInitializationError(
            `Model "${modelNameStr}" not found in schema`,
            { meta: { model: modelNameStr, operation: String(operation) } }
          )
        );
      }

      try {
        assertNonEmptyUniqueWhere(operation, args);
      } catch (error) {
        return Promise.reject(error);
      }

      const cacheableArgs = (args ?? {}) as Record<string, unknown>;
      const omitArgs = this.clientOmit
        ? applyClientOmit(model, operation, cacheableArgs, this.clientOmit)
        : cacheableArgs;
      const pendingOperation = PendingOperation.create(
        this.engine,
        model,
        operation,
        omitArgs,
        {
          skipSpan: true, // Cache driver provides its own SPAN_OPERATION
        }
      );
      // The cache key is derived from the payload that will actually RUN, not
      // the one the caller wrote: with a client-level `omit`, identical call
      // sites on two differently-configured clients project different columns,
      // and keying on the caller's args would let one serve the other's rows.
      // For the same reason keying waits for VALIDATION — an operand callback is
      // a function until validation resolves it, and a function has no stable
      // serialization (see `PendingOperation.cacheKeyArgs`). A payload that does
      // not validate is refused here, asynchronously, exactly as it would be on
      // a miss.
      let keyArgs: Record<string, unknown>;
      try {
        keyArgs = pendingOperation.cacheKeyArgs();
      } catch (error) {
        return Promise.reject(error);
      }
      return executeCachedOperation(
        this.cache!,
        modelNameStr,
        operation,
        keyArgs,
        () => pendingOperation.execute(),
        {
          ...options,
          executionContext: pendingOperation.getExecutionContext(),
        }
      );
    }) as CachedClient<C>;
  }

  /**
   * Create the full client with all utility methods
   */
  static create<C extends VibORMConfig>(config: C): VibORMClient<C> {
    if (!config.driver) {
      throw new ClientInitializationError(
        "Driver is required to create a client. Pass a driver in createClient options."
      );
    }

    // Hydrate schema names (tsName, sqlName) for all models, scalars, and relations.
    // Construction faults (a malformed schema, an invalid identifier) surface as a typed
    // ClientInitializationError instead of a bare Error; already-typed failures pass through
    // unchanged so their own code survives.
    const orm = assertConstructed(() => {
      hydrateSchemaNames(config.schema);
      return new VibORM<C>(config);
    });

    // Set cache version on driver
    config.cache?.setVersion(config.cacheVersion);

    const client = orm.createClient();

    // The raw surface is built on first `$queryRaw`-family access.
    let rawSurface: RawSurface | undefined;

    // Create proxy that combines model operations with utility methods
    return new Proxy(client, {
      get(target, prop) {
        // Utility methods
        if (prop === "$driver") {
          return orm.engine.driver;
        }

        if (prop === "$schema") {
          return orm.schema;
        }

        if (isRawMethodName(prop)) {
          rawSurface ??= orm.rawSurface(orm.engine.driver);
          return rawSurface[prop];
        }

        if (prop === "$transaction") {
          return async <T>(
            input:
              | ((tx: Client<C>) => Promise<T>)
              | PendingOperation<unknown>[],
            options?: TransactionOptions | BatchTransactionOptions
          ): Promise<T | unknown[]> => {
            // Refuse before dispatching, so that paths which never reach a
            // driver entry point (an empty array, a driver without callback
            // transactions) still reject an option that could not be honored.
            orm.engine.driver.assertTransactionOptionsSupported(
              options,
              Array.isArray(input) ? "batch" : "callback"
            );
            const transactionContext = createOperationExecutionContext(
              "$transaction",
              Array.isArray(input)
                ? "$transaction([...])"
                : "$transaction(callback)",
              orm.engine.instrumentation
            );
            // Array of PendingOperations = batch mode
            if (Array.isArray(input)) {
              const operations = input as PendingOperation<unknown>[];

              // Early return for empty array
              if (operations.length === 0) {
                return [] as unknown[];
              }

              // Validate all items are PendingOperations from this client
              for (const op of operations) {
                assertBatchableOperation(op);
                assertOperationOwnership(op, orm.engine);
              }

              // Check driver capabilities for proper execution strategy
              const driver = orm.engine.driver;
              const supportsTransactions = driver.supportsTransactions;
              const supportsBatch = driver.supportsBatch;

              // Drivers with an atomic batch API (D1 bindings and Neon HTTP)
              // can execute preplanned operations without callback transactions.
              // This provides atomicity for operations that can be batched
              if (!supportsTransactions && supportsBatch) {
                const operationQueries: BatchQuery[] = [];
                let setupQueries: BatchQuery[] = [];
                let cleanupQueries: BatchQuery[] = [];
                let hasProgramBatchState = false;
                const batchGuards: PreparedBatchGuard[] = [];
                const parsers: Array<{
                  start: number;
                  length: number;
                  parse: (
                    raw: Array<{ rows: unknown[]; rowCount: number }>
                  ) => Promise<unknown>;
                }> = [];

                for (const op of operations) {
                  const preparation = await op.observeBatchPhase(
                    driver,
                    async () => {
                      const prepared = op.prepare(driver);
                      if (prepared) {
                        return { kind: "single" as const, prepared };
                      }
                      return {
                        kind: "batch" as const,
                        preparedBatch: await op.prepareBatch(driver),
                      };
                    }
                  );
                  if (preparation.kind === "single") {
                    const start = operationQueries.length;
                    operationQueries.push(preparation.prepared);
                    parsers.push({
                      start,
                      length: 1,
                      parse: (raw) =>
                        op.observeBatchPhase(driver, () => {
                          assertNormalizedBatchResults(raw, 1, {
                            provider: driver.driverName,
                            operation: op.getOperation(),
                          });
                          const [result] = raw;
                          if (!result) {
                            throw new TransactionError(
                              `Driver "${driver.driverName}" omitted the result for operation "${op.getOperation()}".`,
                              {
                                meta: {
                                  driver: driver.driverName,
                                  operation: op.getOperation(),
                                },
                              }
                            );
                          }
                          return op.parseResult(result);
                        }),
                    });
                    continue;
                  }

                  const { preparedBatch } = preparation;
                  if (!preparedBatch) {
                    break;
                  }

                  hasProgramBatchState = true;
                  setupQueries = (
                    preparedBatch.setupQueries ?? setupQueries
                  ).map((query) => ({
                    ...query,
                    context: transactionContext,
                  }));
                  cleanupQueries = (
                    preparedBatch.cleanupQueries ?? cleanupQueries
                  ).map((query) => ({
                    ...query,
                    context: transactionContext,
                  }));

                  const start = operationQueries.length;
                  operationQueries.push(...preparedBatch.queries);
                  for (const guard of preparedBatch.guards ?? []) {
                    batchGuards.push({
                      ...guard,
                      queryIndex: start + guard.queryIndex,
                    });
                  }
                  parsers.push({
                    start,
                    length: preparedBatch.queries.length,
                    parse: (raw) =>
                      op.observeBatchPhase(driver, () =>
                        preparedBatch.parseResult(raw)
                      ),
                  });
                }

                if (parsers.length === operations.length) {
                  const setupOffset = hasProgramBatchState
                    ? setupQueries.length
                    : 0;
                  const batchQueries = hasProgramBatchState
                    ? [...setupQueries, ...operationQueries, ...cleanupQueries]
                    : operationQueries;
                  // A merged batch can be EMPTY: `limit: 0` is the bulk write
                  // that affects nothing, so a transaction of nothing but those
                  // has nothing to send. Skipping the round-trip lets each such
                  // operation answer the documented `{ count: 0 }` / `[]` from
                  // its own empty result window below, instead of drawing the
                  // refusal underneath — untrue of this payload (nothing here is
                  // un-batchable) and already lifted by any statement-emitting
                  // sibling. Atomicity is unaffected: a MIXED batch still goes
                  // to the driver as one unit, and an empty one runs nothing.
                  let batchResults: QueryResult<unknown>[] = [];
                  if (batchQueries.length > 0) {
                    try {
                      batchResults = await driver._executeBatch(
                        batchQueries,
                        options as BatchTransactionOptions | undefined,
                        transactionContext
                      );
                    } catch (error) {
                      const guards = batchGuards.map((guard) => ({
                        ...guard,
                        queryIndex: setupOffset + guard.queryIndex,
                      }));
                      throw await attributeOperationBatchError(
                        error,
                        guards,
                        driver
                      );
                    }
                  }
                  // The batch has COMMITTED (or had nothing to commit). This
                  // branch prepares and parses its operations, so it never
                  // reaches the wrapped executor that carries mutation cache
                  // invalidation on the execute path (see createClient) — it
                  // runs the same invalidation itself, before parsing, because
                  // the writes are already durable and a parse failure must not
                  // leave a warm entry describing rows that no longer exist. A
                  // statement-free mutation invalidates here too, exactly as it
                  // does when awaited directly.
                  await invalidateCommittedBatch(operations);
                  const resultContext = {
                    provider: driver.driverName,
                    operation: "$transaction([...])",
                  };
                  assertNormalizedBatchResults(
                    batchResults,
                    batchQueries.length,
                    resultContext
                  );

                  const results: unknown[] = [];
                  for (const parser of parsers) {
                    const resultWindow = batchResults.slice(
                      setupOffset + parser.start,
                      setupOffset + parser.start + parser.length
                    );
                    assertNormalizedBatchResults(
                      resultWindow,
                      parser.length,
                      resultContext
                    );
                    const raw = resultWindow.map((result) => ({
                      rows: result.rows,
                      rowCount: result.rowCount,
                    }));
                    results.push(await parser.parse(raw));
                  }

                  return results;
                }

                throw new TransactionError(
                  `Driver "${driver.driverName}" does not support callback transactions and this transaction contains operations that cannot be batched atomically.`,
                  {
                    meta: {
                      driver: driver.driverName,
                      method: "$transaction([...])",
                    },
                  }
                );
              }

              if (!(supportsTransactions || supportsBatch)) {
                throw new TransactionError(
                  `Driver "${driver.driverName}" supports neither transactions nor atomic batch execution.`,
                  {
                    meta: {
                      driver: driver.driverName,
                      method: "$transaction([...])",
                    },
                  }
                );
              }

              // Execute all operations within a real transaction.
              // Each operation's executor handles its own tracing (validate, build, execute, parse).
              // This branch DOES execute each operation, so the wrapped executor
              // (see createClient) carries cache invalidation for it — unlike the
              // shared-batch branch above, which prepares/parses and therefore
              // invalidates explicitly after its commit.
              return driver.withTransaction(
                async (txDriver) => {
                  const txDriverTyped = txDriver as AnyDriver;

                  // Execute operations sequentially to maintain order
                  // Each executor already has full tracing via query engine
                  // Cache invalidation with proper options is handled by the mutation wrapper
                  const results: unknown[] = [];
                  for (const op of operations) {
                    const result = await op.executeWith(txDriverTyped);
                    results.push(result);
                  }

                  return results;
                },
                options as TransactionOptions | undefined,
                transactionContext
              );
            }

            // Callback = dynamic transaction mode
            const fn = input as (tx: TransactionClient<C>) => Promise<T>;
            if (!orm.engine.driver.supportsTransactions) {
              throw new TransactionError(
                `Driver "${orm.engine.driver.driverName}" does not support callback transactions.`,
                {
                  meta: {
                    driver: orm.engine.driver.driverName,
                    method: "$transaction(callback)",
                  },
                }
              );
            }

            // Helper to create a transaction client with $transaction support
            const createTxClient = (
              txDriver: AnyDriver
            ): TransactionClient<C> => {
              const txEngine = orm.engine.bind(txDriver);
              const baseClient = orm.createClient(txEngine);
              // Raw SQL inside the callback rides the transaction-bound driver,
              // so it shares the single connection with the model operations
              // and rolls back with them. Built on first access.
              let txRawSurface: RawSurface | undefined;

              // Wrap with proxy to intercept $transaction
              return new Proxy(baseClient, {
                get(target, prop) {
                  if (isRawMethodName(prop)) {
                    txRawSurface ??= orm.rawSurface(txDriver);
                    return txRawSurface[prop];
                  }
                  if (prop === "$transaction") {
                    return <NT>(
                      nestedInput:
                        | ((nestedTx: TransactionClient<C>) => Promise<NT>)
                        | PendingOperation<unknown>[],
                      nestedOptions?:
                        | TransactionOptions
                        | BatchTransactionOptions
                    ): Promise<NT | unknown[]> => {
                      try {
                        // A nested $transaction is a SAVEPOINT: its option
                        // contract differs from the outermost one, and the
                        // transaction-bound driver declares that difference.
                        txDriver.assertTransactionOptionsSupported(
                          nestedOptions,
                          Array.isArray(nestedInput) ? "batch" : "callback"
                        );
                        if (
                          Array.isArray(nestedInput) &&
                          nestedInput.length === 0
                        ) {
                          return Promise.resolve([]);
                        }
                        const nestedTransactionContext =
                          createOperationExecutionContext(
                            "$transaction",
                            Array.isArray(nestedInput)
                              ? "$transaction([...])"
                              : "$transaction(callback)",
                            orm.engine.instrumentation
                          );
                        if (Array.isArray(nestedInput)) {
                          // Batch mode in nested transaction
                          // Validate all items are PendingOperations from this transaction client
                          const nestedOperations =
                            nestedInput as PendingOperation<unknown>[];
                          for (const op of nestedOperations) {
                            assertBatchableOperation(op);
                            assertOperationOwnership(op, txEngine);
                          }

                          return txDriver.withTransaction(
                            async (nestedTxDriver) => {
                              const results: unknown[] = [];
                              for (const op of nestedOperations) {
                                results.push(
                                  await op.executeWith(nestedTxDriver)
                                );
                              }
                              return results;
                            },
                            nestedOptions as TransactionOptions | undefined,
                            nestedTransactionContext
                          );
                        }
                        // Callback mode - create nested client recursively
                        return txDriver.withTransaction(
                          (nestedTxDriver) => {
                            const nestedClient = createTxClient(
                              nestedTxDriver as AnyDriver
                            );
                            return (
                              nestedInput as (
                                tx: TransactionClient<C>
                              ) => Promise<NT>
                            )(nestedClient);
                          },
                          nestedOptions as TransactionOptions | undefined,
                          nestedTransactionContext
                        );
                      } catch (error) {
                        return Promise.reject(error);
                      }
                    };
                  }
                  // Forward all other property access to the base client
                  return Reflect.get(target, prop);
                },
              }) as TransactionClient<C>;
            };

            return orm.engine.driver.withTransaction(
              (txDriver) => {
                const txClient = createTxClient(txDriver as AnyDriver);
                return fn(txClient);
              },
              options as TransactionOptions | undefined,
              transactionContext
            );
          };
        }

        if (prop === "$connect") {
          return () =>
            orm.engine.driver._connect(
              createOperationExecutionContext(
                "$connection",
                "$connect",
                orm.engine.instrumentation
              )
            );
        }

        if (prop === "$disconnect") {
          return () =>
            orm.engine.driver._disconnect(
              createOperationExecutionContext(
                "$connection",
                "$disconnect",
                orm.engine.instrumentation
              )
            );
        }

        if (prop === "$withCache") {
          return (cacheConfig?: WithCacheOptions) =>
            orm.$withCache(cacheConfig);
        }

        if (prop === "$invalidate") {
          return async (...keys: string[]) => {
            await invalidateManualCache(
              orm.cache,
              keys,
              createOperationExecutionContext(
                "$cache",
                "$invalidate",
                orm.engine.instrumentation
              )
            );
          };
        }

        // Model operations
        return (target as any)[prop];
      },
    }) as VibORMClient<C>;
  }
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
 * import { PGliteDriver } from "viborm/drivers/pglite";
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
  // The `VibORMConfig<S>` intersection member is what gives the editor a KEYED
  // contextual type while the literal is still being written: `S` is inferred
  // from the sibling `schema` property, so `omit` completes with model names
  // (and each model with its projectable fields) instead of the widened
  // `Record<string, …>` constraint. `Config` still captures the whole literal
  // for result-type threading — and because it does, the third member is what
  // refuses a key that is not a config key at all, and the fourth the same one
  // level down, inside `omit` and `instrumentation`.
  config: Config &
    VibORMConfig<S> &
    NoExtraConfigKeys<Config, VibORMConfig<S>> &
    NoExtraNestedConfigKeys<Config, S>
): VibORMClient<Config> => {
  // Explicit `Config`: the parameter's refusal members (`NoExtraConfigKeys`) are
  // there to reject typo'd keys, not to be threaded into the client's result
  // types — inferring `C` from the intersection would carry them along.
  return VibORM.create<Config>(config);
};

/**
 * The seam a driver package's `createClient` forwards through, after it has
 * already refused the caller's typos with its own parameter.
 *
 * Not a second public entry point and not a loophole: what reaches it is the
 * wrapper's `{ ...restConfig, driver }`, an object the wrapper BUILT, never a
 * literal a user wrote. The refusal members belong on the surface the literal
 * is written against, and re-applying them here cannot work anyway — inside the
 * wrapper `C` and `S` are still unresolved, so `NoExtraOmitKeys<Config, S>`
 * stays a deferred conditional that nothing satisfies.
 */
export const createClientFromDriverConfig = <C extends VibORMConfig>(
  config: C
): VibORMClient<C> => VibORM.create<C>(config);
