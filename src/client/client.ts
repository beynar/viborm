import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import type { AnyDriver, QueryResult, TransactionOptions } from "@drivers";
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
 * while InstrumentationConfig only has 'tracing' and 'logging'
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
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type {
  BatchPreparationContext,
  ModelRegistry,
} from "@query-engine/types";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Sql } from "@sql";
import { createSchemaRegistry, type SchemaRegistry } from "@validation";
import { isPendingOperation, type PendingOperation } from "./pending-operation";
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
        <T>(
          fn: (tx: Client<C>) => Promise<T>,
          options?: TransactionOptions
        ): Promise<T>;
        // Overload 2: Batch of independent operations (Prisma-style)
        <T extends PendingOperation<unknown>[]>(
          operations: [...T],
          options?: TransactionOptions
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
  private readonly driver: AnyDriver;
  private readonly schema: C["schema"];
  private readonly cache: C["cache"];
  private readonly instrumentation: InstrumentationContext | undefined;
  private readonly waitUntil: WaitUntilFn | undefined;
  private readonly cacheVersion: string | number | undefined;
  private readonly registry: ModelRegistry;
  private readonly schemaRegistry: SchemaRegistry<C["schema"]>;
  private readonly engine: QueryEngine;

  /**
   * Unique identifier for this client instance.
   * Used to verify operations belong to the same client in $transaction.
   */
  get clientId(): symbol {
    return this.engine.clientId;
  }

  constructor(config: C) {
    this.driver = config.driver;
    this.schema = config.schema as C["schema"];
    this.cache = config.cache as C["cache"];
    // Accept either InstrumentationConfig (initial setup) or InstrumentationContext (internal reuse)
    this.instrumentation = isInstrumentationContext(config.instrumentation)
      ? config.instrumentation
      : config.instrumentation
        ? createInstrumentationContext(config.instrumentation)
        : undefined;
    this.waitUntil = config.waitUntil;
    this.cacheVersion = config.cacheVersion;

    // Create registry and engine once, reuse for all operations
    this.schemaRegistry = createSchemaRegistry(this.schema);
    this.registry = createModelRegistry(this.schema, this.schemaRegistry);
    this.engine = new QueryEngine(
      this.driver,
      this.registry,
      this.instrumentation
    );
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

      // Engine handles OrThrow suffix internally
      const pendingOp = engine.prepare(model, operation, cleanArgs);

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
      this.driver.getBaseAttributes()
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

      // Execute via cache with lazy executor - only prepares on cache miss
      return executeCachedOperation(
        this.cache!,
        modelNameStr,
        operation,
        args,
        () =>
          this.engine
            .prepare(
              model,
              operation,
              (args ?? {}) as Record<string, unknown>,
              {
                skipSpan: true, // Cache driver provides its own SPAN_OPERATION
              }
            )
            .execute(),
        options
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

    // Inject instrumentation into driver if supported
    config.driver?.setInstrumentation(orm.instrumentation);

    // Inject instrumentation into cache driver if supported
    config.cache?.setInstrumentation(orm.instrumentation);

    // Set cache version on driver
    config.cache?.setVersion(config.cacheVersion);

    const client = orm.createClient();

    // Create proxy that combines model operations with utility methods
    return new Proxy(client, {
      get(target, prop) {
        // Utility methods
        if (prop === "$driver") {
          return orm.driver;
        }

        if (prop === "$schema") {
          return orm.schema;
        }

        if (prop === "$executeRaw") {
          return <T>(query: Sql) => orm.driver._execute<T>(query);
        }

        if (prop === "$queryRaw") {
          return <T>(sql: string, params?: unknown[]) =>
            orm.driver._executeRaw<T>(sql, params);
        }

        if (prop === "$transaction") {
          return async <T>(
            input:
              | ((tx: Client<C>) => Promise<T>)
              | PendingOperation<unknown>[],
            options?: TransactionOptions
          ): Promise<T | unknown[]> => {
            // Client ID for validating operations belong to this client
            const expectedClientId = orm.clientId;

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
                // Verify operation belongs to this client
                if (op.getClientId() !== expectedClientId) {
                  throw PendingOperationError.clientMismatch(
                    op.getModel(),
                    op.getOperation()
                  );
                }
              }

              // Check driver capabilities for proper execution strategy
              const driver = orm.driver;
              const supportsTransactions = driver.supportsTransactions;
              const supportsBatch = driver.supportsBatch;

              // For batch-only drivers (D1, D1-HTTP, Neon-HTTP), use native batch execution
              // This provides atomicity for operations that can be batched
              if (!supportsTransactions && supportsBatch) {
                const operationQueries: {
                  sql: string;
                  params?: unknown[];
                }[] = [];
                let setupQueries: { sql: string; params?: unknown[] }[] = [];
                let cleanupQueries: { sql: string; params?: unknown[] }[] = [];
                let hasNestedBatchPlan = false;
                const batchContext: BatchPreparationContext = {};
                const parsers: Array<{
                  start: number;
                  length: number;
                  parse: (
                    raw: Array<{ rows: unknown[]; rowCount: number }>
                  ) => unknown;
                }> = [];

                for (const op of operations) {
                  const prepared = op.prepare(driver);
                  if (prepared) {
                    const start = operationQueries.length;
                    operationQueries.push(prepared);
                    parsers.push({
                      start,
                      length: 1,
                      parse: (raw) => op.parseResult(raw[0]!),
                    });
                    continue;
                  }

                  const preparedBatch = await op.prepareBatch(
                    driver,
                    batchContext
                  );
                  if (!preparedBatch) {
                    break;
                  }

                  hasNestedBatchPlan = true;
                  setupQueries = preparedBatch.setupQueries ?? setupQueries;
                  cleanupQueries =
                    preparedBatch.cleanupQueries ?? cleanupQueries;

                  const start = operationQueries.length;
                  operationQueries.push(...preparedBatch.queries);
                  parsers.push({
                    start,
                    length: preparedBatch.queries.length,
                    parse: (raw) => preparedBatch.parseResult(raw),
                  });
                }

                if (
                  parsers.length === operations.length &&
                  operationQueries.length > 0
                ) {
                  const setupOffset = hasNestedBatchPlan
                    ? setupQueries.length
                    : 0;
                  const batchQueries = hasNestedBatchPlan
                    ? [...setupQueries, ...operationQueries, ...cleanupQueries]
                    : operationQueries;
                  const batchResults = await driver._executeBatch(
                    batchQueries,
                    options
                  );

                  const results: unknown[] = [];
                  for (const parser of parsers) {
                    const raw = batchResults
                      .slice(
                        setupOffset + parser.start,
                        setupOffset + parser.start + parser.length
                      )
                      .map((result) => ({
                        rows: (result?.rows ?? []) as Record<string, unknown>[],
                        rowCount: result?.rowCount ?? 0,
                      }));
                    results.push(parser.parse(raw));
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
              return driver.withTransaction(async (txDriver) => {
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
              }, options);
            }

            // Callback = dynamic transaction mode
            const fn = input as (tx: Client<C>) => Promise<T>;
            if (!orm.driver.supportsTransactions) {
              throw new TransactionError(
                `Driver "${orm.driver.driverName}" does not support callback transactions.`,
                {
                  meta: {
                    driver: orm.driver.driverName,
                    method: "$transaction(callback)",
                  },
                }
              );
            }

            // Helper to create a transaction client with $transaction support
            const createTxClient = (txDriver: AnyDriver): Client<C> => {
              const txEngine = new QueryEngine(
                txDriver,
                orm.registry,
                orm.instrumentation
              );
              const baseClient = orm.createClient(txEngine);

              // Use the transaction client's clientId for nested validation
              const txClientId = txEngine.clientId;

              // Wrap with proxy to intercept $transaction
              return new Proxy(baseClient, {
                get(target, prop) {
                  if (prop === "$transaction") {
                    return async <NT>(
                      nestedInput:
                        | ((nestedTx: Client<C>) => Promise<NT>)
                        | PendingOperation<unknown>[],
                      nestedOptions?: TransactionOptions
                    ) => {
                      if (Array.isArray(nestedInput)) {
                        // Batch mode in nested transaction
                        // Validate all items are PendingOperations from this transaction client
                        const nestedOperations =
                          nestedInput as PendingOperation<unknown>[];
                        for (const op of nestedOperations) {
                          if (!isPendingOperation(op)) {
                            throw new InvalidTransactionInputError();
                          }
                          // Verify operation belongs to this transaction client
                          if (op.getClientId() !== txClientId) {
                            throw PendingOperationError.clientMismatch(
                              op.getModel(),
                              op.getOperation()
                            );
                          }
                        }

                        // For batch-only drivers (no real transactions), use native batch
                        // execution for nested batches to preserve atomicity optimization
                        if (
                          !txDriver.supportsTransactions &&
                          txDriver.supportsBatch
                        ) {
                          const allCanBatch = nestedOperations.every((op) =>
                            op.canBatch()
                          );

                          if (allCanBatch) {
                            const batchQueries: {
                              sql: string;
                              params?: unknown[];
                            }[] = [];
                            for (const op of nestedOperations) {
                              const prepared = op.prepare(
                                txDriver as AnyDriver
                              );
                              if (!prepared) {
                                break;
                              }
                              batchQueries.push(prepared);
                            }

                            if (
                              batchQueries.length === nestedOperations.length
                            ) {
                              const batchResults =
                                await txDriver._executeBatch(batchQueries);

                              const results: unknown[] = [];
                              for (
                                let i = 0;
                                i < nestedOperations.length;
                                i++
                              ) {
                                const op = nestedOperations[i]!;
                                const raw = batchResults[i]!;
                                results.push(
                                  op.parseResult({
                                    rows: raw.rows as unknown[],
                                    rowCount: raw.rowCount,
                                  })
                                );
                              }
                              return results;
                            }
                          }
                          // Fall through to the transaction path below.
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
                          nestedOptions
                        );
                      }
                      // Callback mode - create nested client recursively
                      return txDriver.withTransaction((nestedTxDriver) => {
                        const nestedClient = createTxClient(
                          nestedTxDriver as AnyDriver
                        );
                        return (nestedInput as (tx: Client<C>) => Promise<NT>)(
                          nestedClient
                        );
                      }, nestedOptions);
                    };
                  }
                  // Forward all other property access to the base client
                  return Reflect.get(target, prop);
                },
              }) as Client<C>;
            };

            return orm.driver.withTransaction((txDriver) => {
              const txClient = createTxClient(txDriver as AnyDriver);
              return fn(txClient);
            }, options);
          };
        }

        if (prop === "$connect") {
          return () => orm.driver._connect();
        }

        if (prop === "$disconnect") {
          return () => orm.driver._disconnect();
        }

        if (prop === "$withCache") {
          return (cacheConfig?: WithCacheOptions) =>
            orm.$withCache(cacheConfig);
        }

        if (prop === "$invalidate") {
          return async (...keys: string[]) => {
            await invalidateManualCache(orm.cache, keys);
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
