import type {
  CacheDriver,
  CacheInvalidationOptions,
  WithCacheOptions,
} from "@cache";
import { type CacheExecutionOptions, withCacheSchema } from "@cache";
import type { AnyDriver, QueryResult, TransactionOptions } from "@drivers";
import { CacheOperationNotCacheableError, NotFoundError } from "@errors";
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION_NAME,
  createErrorLogEvent,
  createInstrumentationContext,
  type InstrumentationConfig,
  type InstrumentationContext,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_OPERATION,
} from "@instrumentation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { ModelRegistry, Operation } from "@query-engine/types";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Sql } from "@sql";
import { parse } from "@validation";
import {
  isPendingOperation,
  PendingOperation,
  type QueryMetadata,
} from "./pending-operation";
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
 * Operations return PendingOperation which can be awaited directly or batched
 */
function createModelProxy<S extends Schema>(
  schema: S,
  createOperation: (opts: {
    modelName: keyof S;
    operation: Operations;
    args: unknown;
  }) => PendingOperation<unknown>,
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
  instrumentation?: InstrumentationConfig;
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

  constructor(config: C) {
    this.driver = config.driver;
    this.schema = config.schema as C["schema"];
    this.cache = config.cache as C["cache"];
    this.instrumentation = config.instrumentation
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
   * Execute an operation with full instrumentation
   *
   * @param modelName - Model name
   * @param operation - Operation name
   * @param args - Operation arguments
   * @param options - Execution options
   * @param options.skipSpan - Skip operation span (cache driver adds its own)
   * @param options.skipCacheInvalidation - Skip cache invalidation (for cached reads)
   */
  private async executeOperation(
    modelName: string,
    operation: Operations,
    args: unknown,
    options?: { skipSpan?: boolean; skipCacheInvalidation?: boolean }
  ): Promise<unknown> {
    const model = this.schema[modelName as keyof C["schema"]];
    if (!model) {
      throw new Error(`Model "${modelName}" not found in schema`);
    }

    // Strip "OrThrow" suffix for query engine (it only knows base operations)
    const OR_THROW_SUFFIX = "OrThrow";
    const baseOperation = operation.endsWith(OR_THROW_SUFFIX)
      ? (operation.slice(0, -OR_THROW_SUFFIX.length) as Operation)
      : (operation as Operation);

    const tableName = model["~"].names.sql ?? modelName;
    const startTime = Date.now();

    const { cache, ...cleanArgs } = (args ?? {}) as Record<string, unknown> & {
      cache?: CacheInvalidationOptions;
    };

    // Core execution logic
    const executeCore = async () => {
      try {
        const result = await this.engine.execute(
          model,
          baseOperation,
          cleanArgs as Record<string, unknown>
        );

        if (operation.endsWith("OrThrow") && result === null) {
          throw new NotFoundError(modelName, operation);
        }

        // Handle exist operation (convert count to boolean)
        const finalResult =
          operation === "exist" ? (result as number) > 0 : result;

        // Cache invalidation for mutations (unless skipped)
        if (
          !options?.skipCacheInvalidation &&
          this.cache &&
          isMutationOperation(operation)
        ) {
          await this.cache._invalidate(modelName, cache);
        }

        return finalResult;
      } catch (error) {
        if (error instanceof Error) {
          if (!("logged" in error)) {
            this.instrumentation?.logger?.error(
              createErrorLogEvent({
                error,
                model: modelName,
                operation: baseOperation,
                duration: Date.now() - startTime,
              })
            );
          }
          throw error;
        }
      }
    };

    // Wrap with tracing if available (unless skipped)
    if (!options?.skipSpan && this.instrumentation?.tracer) {
      return this.instrumentation.tracer.startActiveSpan(
        {
          name: SPAN_OPERATION,
          attributes: {
            ...this.driver.getBaseAttributes(),
            [ATTR_DB_COLLECTION]: tableName,
            [ATTR_DB_OPERATION_NAME]: operation,
          },
        },
        executeCore
      );
    }

    return executeCore();
  }

  /**
   * Create the client with model proxies and utility methods
   * Model operations return PendingOperation for deferred execution
   */
  private createClient(): Client<C> {
    return createModelProxy(this.schema, ({ modelName, operation, args }) =>
      this.createPendingOperation(String(modelName), operation, args)
    ) as Client<C>;
  }

  /**
   * Create a PendingOperation for deferred execution
   * The operation can be awaited directly or batched with $transaction([...])
   */
  private createPendingOperation(
    modelName: string,
    operation: Operations,
    args: unknown
  ): PendingOperation<unknown> {
    // Create the executor function that performs the actual operation
    const executor = () => this.executeOperation(modelName, operation, args);

    // Create minimal metadata for the PendingOperation
    // Note: We don't eagerly build SQL here since operations may have nested writes
    // that require multiple queries. The executor handles all complexity.
    const metadata: QueryMetadata<unknown> = {
      // @ts-expect-error - We use a placeholder since we don't eagerly build SQL
      sql: null,
      parseResult: (rows) => rows,
      isBatchOperation: [
        "createMany",
        "updateMany",
        "deleteMany",
      ].includes(operation),
    };

    return new PendingOperation(executor, metadata);
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

    // Validate and apply defaults using schema
    const parsed = parse(withCacheSchema, config);
    if (parsed.issues) {
      throw new Error(
        `Invalid cache options: ${parsed.issues.map((i) => i.message).join(", ")}`
      );
    }
    // Schema applies defaults, but TypeScript doesn't know that
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
    return createModelProxy(
      this.schema,
      ({ modelName, operation, args }) => {
        const modelNameStr = String(modelName);

        // Runtime check - only cacheable operations allowed
        if (!isCacheableOperation(operation)) {
          throw new CacheOperationNotCacheableError(operation, [
            ...CACHEABLE_OPERATIONS,
          ]);
        }

        // Create executor for cache operations
        const executor = () =>
          this.cache!._executeCached(
            modelNameStr,
            operation,
            args,
            () =>
              this.executeOperation(modelNameStr, operation, args, {
                skipSpan: true,
                skipCacheInvalidation: true,
              }),
            options
          );

        // Wrap in PendingOperation for consistency
        const metadata: QueryMetadata<unknown> = {
          // @ts-expect-error - We use a placeholder since cache operations don't have SQL
          sql: null,
          parseResult: (rows) => rows,
          isBatchOperation: false,
        };

        return new PendingOperation(executor, metadata);
      }
    ) as CachedClient<C["schema"]>;
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
            // Array of PendingOperations = batch mode
            if (Array.isArray(input)) {
              const operations = input as PendingOperation<unknown>[];

              // Validate all items are PendingOperations
              for (const op of operations) {
                if (!isPendingOperation(op)) {
                  throw new Error(
                    "$transaction array must contain only pending operations from client methods"
                  );
                }
              }

              // If driver supports transactions, wrap in transaction for atomicity
              if (orm.driver.supportsTransactions) {
                return orm.driver._transaction(async () => {
                  const results: unknown[] = [];
                  for (const op of operations) {
                    results.push(await op.execute());
                  }
                  return results;
                }, options);
              }

              // If driver supports batch but not transactions (D1, etc.)
              // For now, execute sequentially with warning since we don't have
              // the SQL queries extracted yet
              if (orm.driver.supportsBatch) {
                // TODO: Extract SQL from operations for true batch execution
                // For now, execute sequentially
                console.warn(
                  `Driver "${orm.driver.driverName}" supports batch but batch extraction is not yet implemented. ` +
                    "Operations will execute sequentially without atomicity."
                );
              } else {
                console.warn(
                  `Driver "${orm.driver.driverName}" supports neither transactions nor batch. ` +
                    "Operations will execute sequentially without atomicity. " +
                    "If any operation fails, others may still complete."
                );
              }

              // Execute sequentially (no atomicity)
              const results: unknown[] = [];
              for (const op of operations) {
                results.push(await op.execute());
              }
              return results;
            }

            // Callback = dynamic transaction mode
            const fn = input as (tx: Client<C>) => Promise<T>;

            if (!orm.driver.supportsTransactions) {
              console.warn(
                `Driver "${orm.driver.driverName}" does not support dynamic transactions. ` +
                  "Operations will execute sequentially without isolation. " +
                  "Consider using batch mode: $transaction([op1, op2, ...]) for atomicity."
              );
              // Execute without transaction wrapper
              const txClient = orm.createClient();
              return fn(txClient);
            }

            return orm.driver._transaction(() => {
              const txClient = orm.createClient();
              return fn(txClient);
            }, options);
          };
        }

        if (prop === "$connect") {
          return async () => {
            const doConnect = () => orm.driver.connect?.() ?? Promise.resolve();

            if (orm.instrumentation?.tracer) {
              return orm.instrumentation.tracer.startActiveSpan(
                {
                  name: SPAN_CONNECT,
                  attributes: orm.driver.getBaseAttributes(),
                },
                doConnect
              );
            }
            return doConnect();
          };
        }

        if (prop === "$disconnect") {
          return async () => {
            const doDisconnect = () =>
              orm.driver.disconnect?.() ?? Promise.resolve();

            if (orm.instrumentation?.tracer) {
              return orm.instrumentation.tracer.startActiveSpan(
                {
                  name: SPAN_DISCONNECT,
                  attributes: orm.driver.getBaseAttributes(),
                },
                doDisconnect
              );
            }
            return doDisconnect();
          };
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
