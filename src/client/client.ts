import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import { type CacheExecutionOptions, withCacheSchema } from "@cache";
import type { AnyDriver, QueryResult, TransactionOptions } from "@drivers";
import {
  CacheOperationNotCacheableError,
  InvalidTransactionInputError,
  PendingOperationError,
} from "@errors";
import {
  createInstrumentationContext,
  type InstrumentationConfig,
  type InstrumentationContext,
} from "@instrumentation";

// Note: Removed unused imports - ATTR_DB_COLLECTION, ATTR_DB_OPERATION_NAME, getNoopTracer, SPAN_OPERATION, SPAN_PARSE
// These were used for manual batch tracing which is now handled by each operation's executor

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

import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { ModelRegistry } from "@query-engine/types";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Sql } from "@sql";
import { parse } from "@validation";
import { isPendingOperation, type PendingOperation } from "./pending-operation";
import type {
  CacheableOperations,
  CachedClient,
  Client,
  MutationOperations,
  Operations,
  Schema,
  WaitUntilFn,
} from "./types";

/**
 * Set of mutation operations that trigger cache invalidation
 */
const MUTATION_OPERATIONS: Set<string> = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
]);

/**
 * Set of cacheable operations (read-only)
 */
const CACHEABLE_OPERATIONS: Set<string> = new Set([
  "findFirst",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
]);

/**
 * Check if an operation is a mutation
 */
function isMutationOperation(
  operation: string
): operation is MutationOperations {
  return MUTATION_OPERATIONS.has(operation);
}

/**
 * Check if an operation is cacheable
 */
function isCacheableOperation(
  operation: string
): operation is CacheableOperations {
  return CACHEABLE_OPERATIONS.has(operation);
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
  path: string[] = []
): unknown {
  // biome-ignore lint: <it's ok>
  return new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      // Prevent Promise-like behavior - return undefined for 'then'
      // This allows the proxy to be returned from async functions without
      // being treated as a thenable
      if (key === "then") return undefined;
      return createModelProxy(schema, createOperation, [...path, key]);
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
    this.registry = createModelRegistry(this.schema as Record<string, any>);
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
  private createClient(): Client<C> {
    return createModelProxy(this.schema, ({ modelName, operation, args }) => {
      const modelNameStr = String(modelName);
      const model = this.schema[modelNameStr as keyof C["schema"]];
      if (!model) {
        throw new Error(`Model "${modelNameStr}" not found in schema`);
      }

      // Extract cache invalidation options from args (client-level concern)
      const { cache: cacheOptions, ...cleanArgs } = (args ?? {}) as Record<
        string,
        unknown
      > & {
        cache?: CacheInvalidationOptions;
      };

      // Engine handles OrThrow suffix internally
      const pendingOp = this.engine.prepare(model, operation, cleanArgs);

      // Wrap with cache invalidation for mutations (client-level concern)
      if (this.cache && isMutationOperation(operation)) {
        return pendingOp.wrapExecutor(async (execute) => {
          const result = await execute();
          await this.cache!._invalidate(modelNameStr, cacheOptions);
          return result;
        });
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
      throw new Error(
        "Cache driver not configured. Pass a cache driver in createClient options."
      );
    }

    const parsed = parse(withCacheSchema, config);
    if (parsed.issues) {
      throw new Error(
        `Invalid cache options: ${parsed.issues.map((i) => i.message).join(", ")}`
      );
    }
    const { bypass, key, ttl, swr } = parsed.value;

    // Build execution options
    const options: CacheExecutionOptions = {
      ttlMs: ttl,
      swr,
      bypass,
      key,
      waitUntil: this.waitUntil,
      dbAttributes: this.driver.getBaseAttributes(),
    };
    // Create proxy that validates cacheable operations and delegates to cache driver
    // Returns Promises directly (not PendingOperation) - cache operations are not batchable
    return createModelProxy(this.schema, ({ modelName, operation, args }) => {
      const modelNameStr = String(modelName);

      // Runtime check - only cacheable operations allowed
      // Return rejected Promise to maintain async behavior consistency
      if (!isCacheableOperation(operation)) {
        return Promise.reject(
          new CacheOperationNotCacheableError(operation, [
            ...CACHEABLE_OPERATIONS,
          ])
        );
      }

      const model = this.schema[modelNameStr as keyof C["schema"]];
      if (!model) {
        return Promise.reject(
          new Error(`Model "${modelNameStr}" not found in schema`)
        );
      }

      // Execute via cache with lazy executor - only prepares on cache miss
      return this.cache!._executeCached(
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
    // Hydrate schema names (tsName, sqlName) for all models, fields, and relations
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
                // Check if all operations can be batched
                const allCanBatch = operations.every((op) => op.canBatch());

                if (allCanBatch) {
                  // Prepare all queries for batch execution
                  const batchQueries: { sql: string; params?: unknown[] }[] =
                    [];
                  for (const op of operations) {
                    const prepared = op.prepare(driver);
                    if (!prepared) {
                      // Fallback to sequential execution if prepare fails
                      break;
                    }
                    batchQueries.push(prepared);
                  }

                  // If all queries were prepared, execute as batch
                  if (batchQueries.length === operations.length) {
                    const batchResults =
                      await driver._executeBatch(batchQueries);

                    // Parse results using each operation's parseResult
                    const results: unknown[] = [];
                    for (let i = 0; i < operations.length; i++) {
                      const op = operations[i]!;
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

                // If we can't batch all operations, warn and fall through to sequential
                console.warn(
                  `${driver.driverName} does not support transactions. ` +
                    "Some operations have nested writes and cannot be batched atomically. " +
                    "Operations will execute sequentially without full atomicity."
                );
              }

              // For drivers that support neither transactions nor batch,
              // warn about lack of atomicity
              if (!(supportsTransactions || supportsBatch)) {
                console.warn(
                  `${driver.driverName} supports neither transactions nor batch operations. ` +
                    "Operations will execute sequentially without atomicity guarantees. " +
                    "If any operation fails, previous operations will remain committed."
                );
              }

              // Execute all operations within a transaction (or sequentially for non-tx drivers)
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

            // Helper to create a transaction client with $transaction support
            const createTxClient = (txDriver: AnyDriver): Client<C> => {
              const txOrm = new VibORM({
                driver: txDriver,
                schema: orm.schema,
                cache: orm.cache,
                instrumentation: orm.instrumentation,
                waitUntil: orm.waitUntil,
                cacheVersion: orm.cacheVersion,
              });
              const baseClient = txOrm.createClient();

              // Use the transaction client's clientId for nested validation
              const txClientId = txOrm.clientId;

              // Wrap with proxy to intercept $transaction
              return new Proxy(baseClient, {
                get(target, prop) {
                  if (prop === "$transaction") {
                    return <NT>(
                      nestedInput:
                        | ((nestedTx: Client<C>) => Promise<NT>)
                        | PendingOperation<unknown>[],
                      nestedOptions?: TransactionOptions
                    ) => {
                      if (Array.isArray(nestedInput)) {
                        // Batch mode in nested transaction
                        // Validate all items are PendingOperations from this transaction client
                        for (const op of nestedInput) {
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
                        return txDriver.withTransaction(
                          async (nestedTxDriver) => {
                            const results: unknown[] = [];
                            for (const op of nestedInput as PendingOperation<unknown>[]) {
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
            if (!orm.cache) {
              throw new Error(
                "Cache driver not configured. Pass a cache driver in createClient options."
              );
            }

            await orm.cache._invalidate("manual", { invalidate: keys });
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
