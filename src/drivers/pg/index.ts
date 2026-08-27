/**
 * PostgreSQL Driver (node-postgres)
 *
 * Driver implementation for pg (node-postgres) with connection pooling.
 *
 * No statement pipelining. node-postgres has no pipeline mode: a `Client` holds
 * one query active at a time and drains the rest from an internal queue, so the
 * statements of a transaction always cost one round trip each no matter how
 * they are issued. Nothing here can change that, and nothing here tries to —
 * see the Phase 9 disposition in `docs/architecture/query-performance-plan.md`,
 * which measured the same limit on the postgres.js driver for different
 * reasons.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  createClientFromDriverConfig,
  type DriverConfig,
  type NoExtraDriverConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import {
  TransactionError,
  unsupportedGeospatial,
  unsupportedVector,
} from "@errors";
import { Pool, type PoolClient, type PoolConfig, types as pgTypes } from "pg";
import { Driver, type QueryExecutionContext } from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import {
  acquireWithMaxWait,
  type DriverTransactionOptions,
  defineImmutableDriverFact,
  nestedTransactionDispatchError,
  normalizePostgresRowCount,
  type PinnedSessionReservation,
  resolveNamespaceOption,
  runTransactionLifecycle,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

// DATE (1082) and TIMESTAMP WITHOUT TIME ZONE (1114): pg's default parsers
// build process-local Dates, shifting the stored value by the process
// timezone. Return the raw strings instead — the shared result parser builds
// UTC Dates from them, matching every other driver.
const DATE_OID = 1082;
const TIMESTAMP_OID = 1114;
const identityParser = (value: string) => value;
const utcSafeTypes: PoolConfig["types"] = {
  getTypeParser: (oid: number, format?: string) => {
    if ((oid === DATE_OID || oid === TIMESTAMP_OID) && format !== "binary") {
      return identityParser;
    }
    return pgTypes.getTypeParser(oid as never, format as never);
  },
};

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type { PoolConfig as PgOptions } from "pg";

export interface PgDriverOptions {
  pool?: Pool;
  options?: PoolConfig;
  pgvector?: boolean;
  postgis?: boolean;
  databaseUrl?: string;
  /** The PostgreSQL schema this driver's persistent objects live in. Defaults to `public`. */
  namespace?: string;
}

export type PgClientConfig<C extends DriverConfig> = PgDriverOptions & C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PgDriver extends Driver<Pool, PoolClient> {
  declare readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined = 65_535;

  /**
   * The EXACT pool the caller supplied, or absent when this driver makes its
   * own. Identity, settled here, is the whole ownership answer: the caller's
   * options object is theirs to change, and a `pool` key deleted after
   * construction used to make `$disconnect()` end a transport VibORM was handed
   * and may be sharing with the caller's own code.
   */
  private readonly suppliedPool: Pool | undefined;
  /**
   * The caller's connection record, copied once.
   *
   * A copy of THIS record, not of what it points at: a nested `ssl` object or
   * stream is the caller's to own, and the keys that decide where a pool
   * connects — host, port, user, database, connectionString — all live here.
   */
  private readonly connectionOptions: PoolConfig;
  /** The caller's `databaseUrl`, read once, for the same reason. */
  private readonly connectionString: string | undefined;

  constructor(options: PgDriverOptions = {}) {
    super("postgresql", "pg");
    const namespace = resolveNamespaceOption(options);
    this.suppliedPool = options.pool;
    this.connectionOptions = { ...options.options };
    this.connectionString = options.databaseUrl;

    if (this.suppliedPool) {
      this.client = this.suppliedPool;
    }

    const adapter = new PostgresAdapter(namespace);
    adapter.capabilities.supportsVector = options.pgvector === true;
    adapter.capabilities.supportsGeospatial = options.postgis === true;
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    defineImmutableDriverFact(this, "adapter", adapter);
  }

  /**
   * The pool this driver connects through.
   *
   * A caller's pool is RETURNED rather than replaced: reconnecting after a
   * `$disconnect()` used to build a second pool behind their back — a transport
   * they never asked for, pointed at whatever their options record said by
   * then, and then never closed, because the ownership question was still
   * answered "supplied".
   */
  protected initClient(): Promise<Pool> {
    if (this.suppliedPool !== undefined) {
      return Promise.resolve(this.suppliedPool);
    }
    const options: PoolConfig = {
      types: utcSafeTypes,
      ...this.connectionOptions,
    };
    if (this.connectionString !== undefined) {
      options.connectionString ??= this.connectionString;
    }
    return Promise.resolve(new Pool(options));
  }

  /**
   * A supplied pool belongs to the caller, who may be sharing it with other
   * clients — two schema-scoped estates over one pool is the documented shape
   * — and §5.3's rule is that VibORM never changes a caller's connection
   * state. `$disconnect()` used to end it regardless, so disconnecting one
   * client tore down every other consumer of that pool.
   *
   * The test is on the pool's IDENTITY against what construction captured, so
   * it answers for the pool actually being closed rather than for whatever the
   * caller's record says now: every pool this driver made is ended, and the one
   * it was handed never is.
   */
  protected async closeClient(pool: Pool): Promise<void> {
    if (pool === this.suppliedPool) {
      return;
    }
    await pool.end();
  }

  protected async execute<T>(
    client: Pool | PoolClient,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const result = await client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: normalizePostgresRowCount(
        result.rowCount,
        result.command,
        result.rows,
        { provider: "pg", operation }
      ),
    };
  }

  protected async executeRaw<T>(
    client: Pool | PoolClient,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.query(sql, params);
    return {
      rows: result.rows,
      rowCount: normalizePostgresRowCount(
        result.rowCount,
        result.command,
        result.rows,
        { provider: "pg", operation }
      ),
    };
  }

  /**
   * PostgreSQL takes the isolation level as the first statement inside the
   * transaction, and node-postgres hands out a pooled client we can wait for
   * with a bound (and release if we stop waiting).
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "post-begin",
      timeout: true,
      maxWait: "acquisition",
    };
  }

  protected async transaction<T>(
    client: Pool | PoolClient,
    fn: (tx: PoolClient) => Promise<T>,
    context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if ("release" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    // Start a new transaction
    const pool = client as Pool;
    const poolClient = await acquireWithMaxWait(
      () => pool.connect(),
      (acquired) => acquired.release(),
      options?.maxWaitMs,
      { driverName: this.driverName, form: "callback" }
    );
    let releaseError: Error | boolean | undefined;
    const queryOrDiscard = async (statement: string) => {
      try {
        await poolClient.query(statement);
      } catch (error) {
        releaseError ??= error instanceof Error ? error : true;
        throw error;
      }
    };
    return runTransactionLifecycle({
      begin: () => queryOrDiscard("BEGIN"),
      callback: () => fn(poolClient),
      commit: () => queryOrDiscard("COMMIT"),
      rollback: () => queryOrDiscard("ROLLBACK"),
      phases: getExecutionTransactionPhases(context),
      close: () => {
        try {
          if (releaseError) {
            poolClient.release(releaseError);
            return;
          }
          poolClient.release();
        } catch (error) {
          super.transactionCleanupFailed(
            new TransactionError(
              'Driver "pg" could not release an unsafe transaction connection.',
              { meta: { driver: "pg", method: "$transaction" } }
            )
          );
          throw error;
        }
      },
    });
  }

  protected override transactionCleanupFailed(_error: Error): void {
    // The failed PoolClient was discarded with release(error); the pool stays usable.
  }

  /**
   * One `PoolClient` from `pool.connect()` — plan §3.5's pinned producer for
   * `pg`. `release(true)` destroys the connection instead of returning it, so a
   * session whose advisory-lock state is unknown never re-enters the pool.
   */
  protected override async pinnedSession(): Promise<
    PinnedSessionReservation<Pool | PoolClient>
  > {
    const client = await this.getClient({ operation: "pinnedSession" });
    if ("release" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    const poolClient = await client.connect();
    return {
      session: poolClient,
      release: (discard) => {
        poolClient.release(discard ? true : undefined);
        return Promise.resolve();
      },
    };
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: PgClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, PgDriverOptions, S>
): VibORMClient<C & { driver: PgDriver }> {
  const { pool, options = {}, pgvector, postgis, databaseUrl } = config;
  const namespace = resolveNamespaceOption(config);

  // The caller's `options` record is theirs: the connection string goes on a
  // copy this wrapper owns.
  const driverOptions: PgDriverOptions = {
    options:
      databaseUrl === undefined
        ? options
        : { ...options, connectionString: databaseUrl },
  };
  if (pool) driverOptions.pool = pool;
  if (pgvector !== undefined) driverOptions.pgvector = pgvector;
  if (postgis !== undefined) driverOptions.postgis = postgis;
  if (namespace !== undefined) driverOptions.namespace = namespace;

  const driver = new PgDriver(driverOptions);

  return createClientFromDriverConfig(config, driver) as VibORMClient<
    C & { driver: PgDriver }
  >;
}
