import type { AnyDriver, QueryResult, TransactionOptions } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation } from "@query-engine/types";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Sql } from "@sql";
import type { VibORMError } from "../errors";
import { NotFoundError } from "../errors";
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
} from "../instrumentation";
import type { CacheDriver, CacheOptions } from "./cache/types";
import type { Client, Operations, Schema } from "./types";

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
export interface VibORMConfig<S extends Schema> {
  schema: S;
  driver: AnyDriver;
  cache?: CacheDriver;
  /** Instrumentation configuration for tracing and logging */
  instrumentation?: InstrumentationConfig;
}

/**
 * Extended client type with utility methods
 */
export type VibORMClient<S extends Schema> = Client<S> & {
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
    fn: (tx: Client<S>) => Promise<T>,
    options?: TransactionOptions
  ) => Promise<T>;
  /** Connect to the database */
  $connect: () => Promise<void>;
  /** Disconnect from the database */
  $disconnect: () => Promise<void>;
  /** Create a client with cache */
  withCache: (config: CacheOptions) => Client<S>;
};

/**
 * VibORM Client
 */
export class VibORM<S extends Schema> {
  private readonly driver: AnyDriver;
  private readonly schema: S;
  private readonly cache: CacheDriver | undefined;
  private readonly instrumentation: InstrumentationContext | undefined;

  constructor(config: VibORMConfig<S>) {
    this.driver = config.driver;
    this.schema = config.schema;
    this.cache = config.cache;
    this.instrumentation = config.instrumentation
      ? createInstrumentationContext(config.instrumentation)
      : undefined;
  }

  /**
   * Create the client with model proxies and utility methods
   */
  private createClient(driver: AnyDriver = this.driver): Client<S> {
    // Create a query engine for this driver (may be transaction driver)
    const registry = createModelRegistry(this.schema as Record<string, any>);
    const engine = new QueryEngine(
      driver.adapter,
      registry,
      driver,
      this.instrumentation
    );

    const instrumentation = this.instrumentation;

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

        // Core execution logic (SQL logging is handled by QueryEngine)
        const executeCore = async () => {
          try {
            const result = await engine.execute(
              model,
              baseOperation,
              (args ?? {}) as Record<string, unknown>
            );

            if (operation.endsWith("OrThrow") && result === null) {
              throw new NotFoundError(modelNameStr, operation);
            }

            // Handle exist operation (convert count to boolean)
            return operation === "exist" ? (result as number) > 0 : result;
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
    ) as Client<S>;
  }

  /**
   * Create a client with caching enabled
   */
  withCache(_config: CacheOptions): Client<S> {
    // TODO: Implement caching layer
    // For now, return a regular client
    return this.createClient();
  }

  /**
   * Create the full client with all utility methods
   */
  static create<S extends Schema>(config: VibORMConfig<S>): VibORMClient<S> {
    // Hydrate schema names (tsName, sqlName) for all models, fields, and relations
    hydrateSchemaNames(config.schema);

    const orm = new VibORM(config);

    // Inject instrumentation into driver if supported
    if (orm.instrumentation && "setInstrumentation" in config.driver) {
      (config.driver as any).setInstrumentation(orm.instrumentation);
    }

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
            fn: (tx: Client<S>) => Promise<T>,
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

        if (prop === "withCache") {
          return (cacheConfig: CacheOptions) => orm.withCache(cacheConfig);
        }

        // Model operations
        return (target as any)[prop];
      },
    }) as VibORMClient<S>;
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
export const createClient = <S extends Schema>(
  config: VibORMConfig<S>
): VibORMClient<S> => {
  return VibORM.create(config);
};
