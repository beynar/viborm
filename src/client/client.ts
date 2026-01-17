import type {
  CacheDriver,
  CacheInvalidationOptions,
  WaitUntilFn,
  WithCacheOptions,
} from "@cache";
import { createCachedClientProxy } from "@cache/client";
import type { AnyDriver, QueryResult, TransactionOptions } from "@drivers";
import { NotFoundError, type VibORMError } from "@errors";
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
  SPAN_TRANSACTION,
} from "@instrumentation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { ModelRegistry, Operation } from "@query-engine/types";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Sql } from "@sql";
import type {
  CacheableOperations,
  CachedClient,
  Client,
  MutationOperations,
  Operations,
  Schema,
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
 * Check if an operation is a mutation
 */
function isMutationOperation(
  operation: string
): operation is MutationOperations {
  return MUTATION_OPERATIONS.has(operation);
}

/**
 * Create a recursive proxy for model operations
 */
function createModelProxy<S extends Schema>(
  schema: S,
  executeOperation: (opts: {
    modelName: keyof S;
    operation: Operations;
    args: unknown;
  }) => Promise<unknown>,
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
      return createModelProxy(schema, executeOperation, [...path, key]);
    },
    apply(_target, _thisArg, [args]) {
      const modelName = path[0] as keyof S;
      const operation = path[1] as Operations;
      return executeOperation({ modelName, operation, args });
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
      /** Execute a raw SQL query */
      $executeRaw: <T = Record<string, unknown>>(
        query: Sql
      ) => Promise<QueryResult<T>>;
      /** Execute a raw SQL string */
      $queryRaw: <T = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => Promise<QueryResult<T>>;
      /** Run operations in a transaction */
      $transaction: <T>(
        fn: (tx: Client<C>) => Promise<T>,
        options?: TransactionOptions
      ) => Promise<T>;
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
  private readonly cachedExecuteOperation: (opts: {
    modelName: keyof C["schema"];
    operation: CacheableOperations;
    args: unknown;
  }) => Promise<unknown>;
  private readonly cachedSpanWrapper:
    | (<T>(
        modelName: string,
        operation: string,
        fn: () => Promise<T>,
        options?: { root?: boolean }
      ) => Promise<T>)
    | undefined;

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
      this.driver.adapter,
      this.registry,
      this.driver,
      this.instrumentation
    );

    // Cache executeOperation for $withCache
    this.cachedExecuteOperation = async ({ modelName, operation, args }) => {
      const model = (this.schema as C["schema"])[modelName];
      if (!model) {
        throw new Error(`Model "${String(modelName)}" not found in schema`);
      }

      const OR_THROW_SUFFIX = "OrThrow";
      const baseOperation = operation.endsWith(OR_THROW_SUFFIX)
        ? (operation.slice(0, -OR_THROW_SUFFIX.length) as Operation)
        : (operation as Operation);

      const result = await this.engine.execute(
        model,
        baseOperation,
        (args ?? {}) as Record<string, unknown>
      );

      if (operation.endsWith("OrThrow") && result === null) {
        throw new NotFoundError(String(modelName), operation);
      }

      return operation === "exist" ? (result as number) > 0 : result;
    };

    // Cache spanWrapper for $withCache
    this.cachedSpanWrapper = this.instrumentation?.tracer
      ? <T>(
          modelName: string,
          operation: string,
          fn: () => Promise<T>,
          options?: { root?: boolean }
        ) => {
          const model = (this.schema as C["schema"])[
            modelName as keyof C["schema"]
          ];
          const tableName = model?.["~"]?.names?.sql ?? modelName;

          return this.instrumentation!.tracer!.startActiveSpan(
            {
              name: SPAN_OPERATION,
              attributes: {
                ...this.driver.getBaseAttributes(),
                [ATTR_DB_COLLECTION]: tableName,
                [ATTR_DB_OPERATION_NAME]: operation,
              },
              root: options?.root,
            },
            fn
          );
        }
      : undefined;
  }

  /**
   * Create the client with model proxies and utility methods
   */
  private createClient(driver: AnyDriver = this.driver): Client<C> {
    // Use cached engine for default driver, create new one for transactions
    const engine =
      driver === this.driver
        ? this.engine
        : new QueryEngine(
            driver.adapter,
            this.registry,
            driver,
            this.instrumentation
          );

    const instrumentation = this.instrumentation;
    const cache = this.cache;
    const cacheVersion = this.cacheVersion;

    return createModelProxy(
      this.schema,
      async ({ modelName, operation, args }) => {
        const model = this.schema[modelName];
        if (!model) {
          throw new Error(`Model "${String(modelName)}" not found in schema`);
        }

        // Strip "OrThrow" suffix for query engine (it only knows base operations)
        const OR_THROW_SUFFIX = "OrThrow";
        const baseOperation = operation.endsWith(OR_THROW_SUFFIX)
          ? (operation.slice(0, -OR_THROW_SUFFIX.length) as Operation)
          : (operation as Operation);

        const modelNameStr = String(modelName);
        const tableName = model["~"].names.sql ?? modelNameStr;
        const startTime = Date.now();

        // Extract cache invalidation options from mutation args
        const argsObj = (args ?? {}) as Record<string, unknown>;
        const cacheOptions = argsObj.cache as
          | CacheInvalidationOptions
          | undefined;

        // Remove cache options from args before passing to engine
        const { cache: _, ...cleanArgs } = argsObj;

        // Core execution logic (SQL logging is handled by QueryEngine)
        const executeCore = async () => {
          try {
            const result = await engine.execute(
              model,
              baseOperation,
              cleanArgs as Record<string, unknown>
            );

            if (operation.endsWith("OrThrow") && result === null) {
              throw new NotFoundError(modelNameStr, operation);
            }

            // Handle exist operation (convert count to boolean)
            const finalResult =
              operation === "exist" ? (result as number) > 0 : result;

            // Cache invalidation for mutations
            if (cache && isMutationOperation(operation)) {
              await cache._invalidate(modelNameStr, cacheOptions);
            }

            return finalResult;
          } catch (error) {
            if (error instanceof Error && "logged" in error) {
              // logged down in the stack, probably in the driver in order for the sql to be injected in the log
              throw error;
            }
            // Log errors at client level
            instrumentation?.logger?.error(
              createErrorLogEvent({
                error: error as VibORMError,
                model: modelNameStr,
                operation: baseOperation,
                duration: Date.now() - startTime,
              })
            );
            throw error;
          }
        };

        // Wrap with tracing if available
        if (instrumentation?.tracer) {
          return instrumentation.tracer.startActiveSpan(
            {
              name: SPAN_OPERATION,
              attributes: {
                ...driver.getBaseAttributes(),
                [ATTR_DB_COLLECTION]: tableName,
                [ATTR_DB_OPERATION_NAME]: operation,
              },
            },
            executeCore
          );
        }

        return executeCore();
      }
    ) as Client<C>;
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

    return createCachedClientProxy(
      this.schema,
      this.cachedExecuteOperation,
      this.cache,
      config ?? {},
      this.waitUntil,
      this.cacheVersion,
      this.instrumentation,
      this.cachedSpanWrapper
    );
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
    const instrumentation = orm.instrumentation;

    // Create proxy that combines model operations with utility methods
    return new Proxy(client, {
      get(target, prop) {
        // Utility methods
        if (prop === "$driver") {
          return orm.driver;
        }

        if (prop === "$executeRaw") {
          return <T>(query: Sql) => orm.driver._execute<T>(query);
        }

        if (prop === "$queryRaw") {
          return <T>(sql: string, params?: unknown[]) =>
            orm.driver._executeRaw<T>(sql, params);
        }

        if (prop === "$transaction") {
          return <T>(
            fn: (tx: Client<C>) => Promise<T>,
            options?: TransactionOptions
          ) => {
            const executeTransaction = () =>
              orm.driver._transaction((txDriver) => {
                const txClient = orm.createClient(txDriver);
                return fn(txClient);
              }, options);

            // Wrap with tracing if available
            if (instrumentation?.tracer) {
              return instrumentation.tracer.startActiveSpan(
                {
                  name: SPAN_TRANSACTION,
                  attributes: orm.driver.getBaseAttributes(),
                },
                executeTransaction
              );
            }
            return executeTransaction();
          };
        }

        if (prop === "$connect") {
          return async () => {
            const doConnect = () => orm.driver.connect?.() ?? Promise.resolve();

            if (instrumentation?.tracer) {
              return instrumentation.tracer.startActiveSpan(
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

            if (instrumentation?.tracer) {
              return instrumentation.tracer.startActiveSpan(
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
            await orm.cache._invalidate("", { invalidate: keys });
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
