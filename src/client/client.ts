import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { assertNormalizedBatchResults } from "@drivers/normalized-result";
import { assertNoTransactionOptions } from "@drivers/shared/transactions";
import {
  CacheConfigurationError,
  InvalidTransactionInputError,
  PendingOperationError,
  TransactionError,
} from "@errors";
import {
  createInstrumentationContext,
  type InstrumentationConfig,
  type InstrumentationContext,
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

import {
  createCacheExecutionOptions,
  executeCachedOperation,
  invalidateManualCache,
  validateCacheableOperation,
  withMutationCacheInvalidation,
} from "@query-engine/cache-flow";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { attributeOperationBatchError } from "@query-engine/OperationBatchRuntime";
import {
  isPendingOperation,
  PendingOperation,
} from "@query-engine/pending-operation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type {
  BatchPreparationContext,
  PreparedBatchGuard,
} from "@query-engine/types";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Sql } from "@sql";
import { createSchemaRegistry } from "@validation";
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
export interface VibORMConfig {
  schema: Schema;
  driver: AnyDriver;
  cache?: CacheDriver;
  /** Instrumentation config (for initial setup) or context (for internal reuse) */
  instrumentation?: InstrumentationConfig | InstrumentationContext;
  waitUntil?: WaitUntilFn;
  /** Cache version for invalidating cache on schema changes */
  cacheVersion?: number | string;
  /**
   * Which query engine serves migrated operations. Defaults to `"v2"` — the
   * per-tree routing of PLAN P5, ON for everyone. `"v1"` forces the frozen V1
   * runtime for every tree: the soak's A/B lever and the rollback story.
   *
   * MIGRATION-TEMPORARY: this escape hatch exists only for the P5 parity soak
   * and is scheduled for deletion in P6 (PLAN §P6), when V1's operation/execution
   * root is removed and routing becomes unconditional. Do not build durable
   * behaviour on it.
   */
  queryEngine?: "v1" | "v2";
}

export interface DriverConfig extends Omit<VibORMConfig, "driver"> {}

/**
 * Extended client type with utility methods
 */
export type VibORMClient<C extends VibORMConfig> = Client<C> &
  Omit<
    {
      /** Access the underlying driver */
      $driver: AnyDriver;
      /** Access the schema (models) */
      $schema: C["schema"];
      /** Execute a raw SQL query */
      $executeRaw: <T = Record<string, unknown>>(
        query: Sql
      ) => Promise<QueryResult<T>>;
      /** Execute a raw SQL string */
      $queryRaw: <T = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => Promise<QueryResult<T>>;
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
       */
      $transaction: {
        // Overload 1: Dynamic transaction (callback)
        <T>(fn: (tx: Client<C>) => Promise<T>): Promise<T>;
        // Overload 2: Batch of independent operations (Prisma-style)
        <T extends PendingOperation<unknown>[]>(
          operations: [...T]
        ): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
      };
      /** Connect to the database */
      $connect: () => Promise<void>;
      /** Disconnect from the database */
      $disconnect: () => Promise<void>;
      /** Create a client with cache - only read operations available */
      $withCache: (config?: WithCacheOptions) => CachedClient<C["schema"]>;
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
   * Whether migrated trees route to the V2 engine (PLAN P5, default ON). The
   * `queryEngine: "v1"` escape hatch flips this off for the whole client.
   */
  private readonly routeToV2: boolean;

  /**
   * Unique identifier for this client instance.
   * Used to verify operations belong to the same client in $transaction.
   */
  get clientId(): symbol {
    return this.engine.clientId;
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
    this.routeToV2 = config.queryEngine !== "v1";

    // Create registry and engine once, reuse for all operations
    const schemaRegistry = createSchemaRegistry(this.schema);
    const registry = createModelRegistry(this.schema, schemaRegistry);
    this.engine = new QueryEngine(config.driver, registry, instrumentation);
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
        throw new Error(`Model "${modelNameStr}" not found in schema`);
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

      // Engine handles OrThrow suffix internally. Per-tree V2 routing (PLAN P5)
      // is decided here — before any I/O — for the whole payload; a tree V2 does
      // not own runs the frozen V1 runtime unchanged.
      const pendingOp = PendingOperation.createRouted(
        engine,
        model,
        operation,
        cleanArgs,
        undefined,
        this.routeToV2
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
  $withCache(config?: WithCacheOptions): CachedClient<C["schema"]> {
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
          new Error(`Model "${modelNameStr}" not found in schema`)
        );
      }

      try {
        assertNonEmptyUniqueWhere(operation, args);
      } catch (error) {
        return Promise.reject(error);
      }

      // Preparing remains lazy: it captures one immutable execution context
      // now, while validation, SQL building, and execution still wait for a miss.
      // Cached reads route through V2 too (PLAN P5 item 2b) — the routing law is
      // identical; a read V2 does not own runs the frozen V1 read path.
      const pendingOperation = PendingOperation.createRouted(
        this.engine,
        model,
        operation,
        (args ?? {}) as Record<string, unknown>,
        {
          skipSpan: true, // Cache driver provides its own SPAN_OPERATION
        },
        this.routeToV2
      );
      return executeCachedOperation(
        this.cache!,
        modelNameStr,
        operation,
        args,
        () => pendingOperation.execute(),
        {
          ...options,
          executionContext: pendingOperation.getExecutionContext(),
        }
      );
    }) as CachedClient<C["schema"]>;
  }

  /**
   * Create the full client with all utility methods
   */
  static create<C extends VibORMConfig>(config: C): VibORMClient<C> {
    // Hydrate schema names (tsName, sqlName) for all models, scalars, and relations
    hydrateSchemaNames(config.schema);

    const orm = new VibORM<C>(config);

    // Set cache version on driver
    config.cache?.setVersion(config.cacheVersion);

    const client = orm.createClient();

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

        if (prop === "$executeRaw") {
          return <T>(query: Sql) =>
            orm.engine.driver._execute<T>(
              query,
              createOperationExecutionContext(
                "$raw",
                "$executeRaw",
                orm.engine.instrumentation
              )
            );
        }

        if (prop === "$queryRaw") {
          return <T>(sql: string, params?: unknown[]) =>
            orm.engine.driver._executeRaw<T>(
              sql,
              params,
              createOperationExecutionContext(
                "$raw",
                "$queryRaw",
                orm.engine.instrumentation
              )
            );
        }

        if (prop === "$transaction") {
          return async <T>(
            input:
              | ((tx: Client<C>) => Promise<T>)
              | PendingOperation<unknown>[],
            unsupportedOptions?: unknown
          ): Promise<T | unknown[]> => {
            assertNoTransactionOptions(unsupportedOptions);
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
                if (!isPendingOperation(op)) {
                  throw new InvalidTransactionInputError();
                }
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
                const batchContext: BatchPreparationContext = {};
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
                        preparedBatch: await op.prepareBatch(
                          driver,
                          batchContext
                        ),
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

                if (
                  parsers.length === operations.length &&
                  operationQueries.length > 0
                ) {
                  const setupOffset = hasProgramBatchState
                    ? setupQueries.length
                    : 0;
                  const batchQueries = hasProgramBatchState
                    ? [...setupQueries, ...operationQueries, ...cleanupQueries]
                    : operationQueries;
                  let batchResults: QueryResult<unknown>[];
                  try {
                    batchResults = await driver._executeBatch(
                      batchQueries,
                      undefined,
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
              // Each operation's executor handles its own tracing (validate, build, execute, parse)
              // Cache invalidation is already handled by the wrapped executor (see createClient)
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
                undefined,
                transactionContext
              );
            }

            // Callback = dynamic transaction mode
            const fn = input as (tx: Client<C>) => Promise<T>;
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
            const createTxClient = (txDriver: AnyDriver): Client<C> => {
              const txEngine = orm.engine.bind(txDriver);
              const baseClient = orm.createClient(txEngine);

              // Wrap with proxy to intercept $transaction
              return new Proxy(baseClient, {
                get(target, prop) {
                  if (prop === "$transaction") {
                    return <NT>(
                      nestedInput:
                        | ((nestedTx: Client<C>) => Promise<NT>)
                        | PendingOperation<unknown>[],
                      nestedUnsupportedOptions?: unknown
                    ): Promise<NT | unknown[]> => {
                      try {
                        assertNoTransactionOptions(nestedUnsupportedOptions);
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
                            if (!isPendingOperation(op)) {
                              throw new InvalidTransactionInputError();
                            }
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
                            undefined,
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
                              nestedInput as (tx: Client<C>) => Promise<NT>
                            )(nestedClient);
                          },
                          undefined,
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
              }) as Client<C>;
            };

            return orm.engine.driver.withTransaction(
              (txDriver) => {
                const txClient = createTxClient(txDriver as AnyDriver);
                return fn(txClient);
              },
              undefined,
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
export const createClient = <Config extends VibORMConfig>(
  config: Config
): VibORMClient<Config> => {
  return VibORM.create(config);
};
