import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { Driver, QueryResult, TransactionOptions } from "@drivers";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Sql } from "@sql";
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
  return new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
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
  adapter: DatabaseAdapter;
  driver: Driver;
  cache?: CacheDriver;
}

/**
 * Extended client type with utility methods
 */
export type VibORMClient<S extends Schema> = Client<S> & {
  /** Access the underlying driver */
  $driver: Driver;
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
  private readonly adapter: DatabaseAdapter;
  private readonly driver: Driver;
  private readonly schema: S;
  private readonly cache: CacheDriver | undefined;

  constructor(config: VibORMConfig<S>) {
    this.adapter = config.adapter;
    this.driver = config.driver;
    this.schema = config.schema;
    this.cache = config.cache;
  }

  /**
   * Create the client with model proxies and utility methods
   */

  private createClient(driver: Driver = this.driver): Client<S> {
    return createModelProxy(
      this.schema,
      async ({ modelName, operation, args }) => {
        const model = this.schema[modelName];
        if (!model) {
          throw new Error(`Model "${String(modelName)}" not found in schema`);
        }

        // TODO: Use query engine to build and execute
        // const sql = queryEngine.build(model, operation, args);
        // return queryEngine.execute(driver, model, operation, args);

        throw new Error(`Operation ${operation} not yet implemented`);
      }
    ) as Client<S>;
  }

  withCache(config: CacheOptions): Client<S> {
    return createModelProxy(
      this.schema,
      async ({ modelName, operation, args }) => {
        const model = this.schema[modelName];
        if (!model) {
          throw new Error(`Model "${String(modelName)}" not found in schema`);
        }

        // TODO: Use query engine to build and execute
        // const sql = queryEngine.build(model, operation, args);
        // return queryEngine.execute(driver, model, operation, args);

        throw new Error(`Operation ${operation} not yet implemented`);
      }
    ) as Client<S>;
  }

  /**
   * Create the full client with all utility methods
   */
  static create<S extends Schema>(config: VibORMConfig<S>): VibORMClient<S> {
    // Hydrate schema names (tsName, sqlName) for all models, fields, and relations
    hydrateSchemaNames(config.schema);

    const orm = new VibORM(config);
    const client = orm.createClient();

    // Create proxy that combines model operations with utility methods
    return new Proxy(client, {
      get(target, prop) {
        // Utility methods
        if (prop === "$driver") {
          return orm.driver;
        }

        if (prop === "$executeRaw") {
          return <T>(query: Sql) => orm.driver.execute<T>(query);
        }

        if (prop === "$queryRaw") {
          return <T>(sql: string, params?: unknown[]) =>
            orm.driver.executeRaw<T>(sql, params);
        }

        if (prop === "$transaction") {
          return <T>(
            fn: (tx: Client<S>) => Promise<T>,
            options?: TransactionOptions
          ) => {
            return orm.driver.transaction(async (txDriver) => {
              // Create a transactional client backed by the tx driver
              const txClient = orm.createClientWithDriver(txDriver);
              return fn(txClient);
            }, options);
          };
        }

        if (prop === "$connect") {
          return () => orm.driver.connect?.() ?? Promise.resolve();
        }

        if (prop === "$disconnect") {
          return () => orm.driver.disconnect?.() ?? Promise.resolve();
        }

        // Model operations
        return (target as any)[prop];
      },
    }) as VibORMClient<S>;
  }

  /**
   * Create a client backed by a specific driver (used for transactions)
   */
  private createClientWithDriver(driver: Driver): Client<S> {
    return createModelProxy(
      this.schema,
      async ({ modelName, operation, args }) => {
        const model = this.schema[modelName];
        if (!model) {
          throw new Error(`Model "${String(modelName)}" not found in schema`);
        }

        // TODO: Use query engine with the provided driver
        // return queryEngine.execute(driver, model, operation, args);

        throw new Error(`Operation ${operation} not yet implemented`);
      }
    ) as Client<S>;
  }
}

/**
 * Create a VibORM client
 *
 * @example
 * ```ts
 * import { createClient } from "viborm";
 * import { PgDriver } from "viborm/drivers/pg";
 *
 * const driver = new PgDriver({ connectionString: "..." });
 * const client = createClient({
 *   driver,
 *   adapter: new PostgresAdapter(),
 *   schema: { user, post },
 * });
 *
 * // Connect
 * await client.$connect();
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
