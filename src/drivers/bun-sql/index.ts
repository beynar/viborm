/**
 * Bun SQL Driver
 *
 * Driver implementation for Bun's built-in PostgreSQL client.
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
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import { Driver, type QueryExecutionContext } from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import { normalizeProviderRowCount } from "../normalized-result";
import {
  defineImmutableDriverFact,
  nestedTransactionDispatchError,
  type PinnedSessionReservation,
  releaseReservedPostgresSession,
  resolveNamespaceOption,
  runProviderManagedTransaction,
  type TransactionOptionSupport,
} from "../shared";
import type { QueryResult } from "../types";

// ============================================================
// TYPE DECLARATIONS FOR BUN SQL
// ============================================================

// Bun's SQL type - we define inline to avoid requiring bun types at compile time
// Every result is an array carrying its required provider row count.
type BunSQLResult<T> = T[] & { count: number };

interface BunSQL {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe<T = unknown>(
    sql: string,
    params?: unknown[]
  ): Promise<BunSQLResult<T>>;
  begin<T>(fn: (sql: BunSQLTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  reserve(): Promise<BunSQLReservedConnection>;
}

interface BunSQLTransaction {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe<T = unknown>(
    sql: string,
    params?: unknown[]
  ): Promise<BunSQLResult<T>>;
  savepoint<T>(fn: (sql: BunSQLTransaction) => Promise<T>): Promise<T>;
}

/**
 * Bun's `ReservedSQL` is an `SQL` bound to one connection, plus `release()` —
 * not a reduced surface. Declaring it that way is both faithful and load-
 * bearing: a reserved connection is what {@link BunSQLDriver.pinnedSession}
 * hands to the pinned view as its client, and the view's transaction control
 * runs `BEGIN`/`COMMIT` on it through the same `unsafe` path every statement
 * uses.
 */
interface BunSQLReservedConnection extends BunSQL {
  release(): void;
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export interface BunSQLOptions {
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  tls?: boolean | object;
  max?: number;
  idleTimeout?: number;
  maxLifetime?: number;
}

export interface BunSQLDriverOptions {
  client?: BunSQL;
  databaseUrl?: string;
  options?: BunSQLOptions;
  pgvector?: boolean;
  postgis?: boolean;
  /** The PostgreSQL schema this driver's persistent objects live in. Defaults to `public`. */
  namespace?: string;
}

export type BunSQLClientConfig<C extends DriverConfig> = BunSQLDriverOptions &
  C;

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class BunSQLDriver extends Driver<BunSQL, BunSQLTransaction> {
  declare readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined = 65_535;

  private readonly driverOptions: BunSQLDriverOptions;
  /**
   * The EXACT transport the caller supplied, or absent when this driver makes
   * its own. Identity, settled here from ONE read, is the whole ownership
   * answer: the caller's options object is theirs to change, and a `client`
   * getter answering differently on a second read used to leave this driver
   * holding the caller's transport while believing it had made its own.
   */
  private readonly suppliedClient: BunSQL | undefined;

  constructor(options: BunSQLDriverOptions = {}) {
    super("postgresql", "bun-sql");
    const namespace = resolveNamespaceOption(options);
    this.driverOptions = options;
    this.suppliedClient = options.client;

    if (this.suppliedClient) {
      this.client = this.suppliedClient;
    }

    const adapter = new PostgresAdapter(namespace);
    adapter.capabilities.supportsVector = options.pgvector === true;
    adapter.capabilities.supportsGeospatial = options.postgis === true;
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    defineImmutableDriverFact(this, "adapter", adapter);
  }

  /**
   * The transport this driver connects through.
   *
   * A caller's transport is RETURNED rather than replaced: reconnecting after a
   * `$disconnect()` used to build a second one behind their back — a transport
   * they never asked for, pointed at whatever their options record said by
   * then, and then never closed, because the ownership question was still
   * answered "supplied".
   */
  protected async initClient(): Promise<BunSQL> {
    if (this.suppliedClient !== undefined) {
      return this.suppliedClient;
    }
    const { SQL } = await import("bun");

    if (this.driverOptions.databaseUrl) {
      return new SQL(this.driverOptions.databaseUrl) as unknown as BunSQL;
    }

    return new SQL(this.driverOptions.options ?? {}) as unknown as BunSQL;
  }

  /**
   * A supplied transport belongs to the caller, who may be sharing it with
   * other clients — two schema-scoped estates over one transport is the
   * documented shape — and §5.3's rule is that VibORM never changes a caller's
   * connection state. `$disconnect()` used to close it regardless, so
   * disconnecting one client tore down every other consumer of that transport.
   *
   * The test is on the transport's IDENTITY against what construction
   * captured, so it answers for the transport actually being closed rather than
   * for whatever the caller's record says now.
   */
  protected async closeClient(sql: BunSQL): Promise<void> {
    if (sql === this.suppliedClient) {
      return;
    }
    await sql.close();
  }

  protected async execute<T>(
    client: BunSQL | BunSQLTransaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const result = await client.unsafe<T>(sql, params);
    return {
      rows: result,
      rowCount: normalizeProviderRowCount(result.count, {
        provider: "bun-sql",
        operation,
      }),
    };
  }

  protected async executeRaw<T>(
    client: BunSQL | BunSQLTransaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.unsafe<T>(sql, params);
    return {
      rows: result,
      rowCount: normalizeProviderRowCount(result.count, {
        provider: "bun-sql",
        operation,
      }),
    };
  }

  /**
   * Bun's `sql.begin()` owns BEGIN and connection acquisition, so the isolation
   * level goes in as the transaction's first statement and there is no
   * acquisition step VibORM can bound.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "post-begin",
      timeout: true,
      maxWait: "unsupported",
      maxWaitReason:
        "Bun SQL acquires the connection inside sql.begin(), which VibORM cannot observe or bound — the wait would be unbounded no matter what maxWait said",
    };
  }

  protected async transaction<T>(
    client: BunSQL | BunSQLTransaction,
    fn: (tx: BunSQLTransaction) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    if ("savepoint" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    return runProviderManagedTransaction({
      run: (callback) => client.begin(callback),
      callback: fn,
      phases: getExecutionTransactionPhases(context),
      // Containment for a transaction the provider broke, through the one place
      // that decides whether a transport may be closed at all: closing the
      // caller's transport to contain VibORM's transaction would be a far
      // larger effect than the one being contained.
      close: async () => {
        await this.closeClient(client);
        this.client = null;
      },
    });
  }

  /**
   * One `reserve()` result — plan §3.5's pinned producer for Bun SQL, and the
   * producer its transaction control uses too, because the pinned view opens
   * `BEGIN`/`COMMIT` on this exact connection.
   *
   * Bun exposes only `release()` for a reserved connection — the same shape
   * postgres.js has — so a condemned session takes the same rule: reset with
   * `pg_advisory_unlock_all()`, and when that reset fails, abandoned rather
   * than returned to a pool with a lock state nobody can account for.
   */
  protected override async pinnedSession(): Promise<
    PinnedSessionReservation<BunSQL | BunSQLTransaction>
  > {
    const client = await this.getClient({ operation: "pinnedSession" });
    if ("savepoint" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    const reserved = await client.reserve();
    return {
      session: reserved,
      release: (discard) =>
        releaseReservedPostgresSession({
          driverName: this.driverName,
          discard,
          reset: () => reserved.unsafe("SELECT pg_advisory_unlock_all()"),
          release: () => reserved.release(),
          // Settled at construction, never re-read: see `suppliedClient`.
          closeOwnedTransport:
            client === this.suppliedClient
              ? undefined
              : async () => {
                  // Withdrawn BEFORE the close, never after it: see the
                  // postgres.js driver, which has the same shape and the same
                  // reason — a rejecting `close()` used to leave this condemned
                  // transport installed for the next ordinary query.
                  this.client = null;
                  this.initPromise = null;
                  await client.close();
                },
        }),
    };
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: BunSQLClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, BunSQLDriverOptions, S>
): VibORMClient<C & { driver: BunSQLDriver }> {
  const { client, databaseUrl, options, pgvector, postgis } = config;
  const namespace = resolveNamespaceOption(config);

  const driver = new BunSQLDriver({
    client,
    databaseUrl,
    options,
    pgvector,
    postgis,
    namespace,
  });

  return createClientFromDriverConfig(config, driver) as VibORMClient<
    C & { driver: BunSQLDriver }
  >;
}
