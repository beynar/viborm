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
  type LinkedClientConfig,
  type NoExtraDriverConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import {
  ClientInitializationError,
  TransactionError,
  unsupportedVector,
} from "@errors";
import { Pool, type PoolClient, type PoolConfig, types as pgTypes } from "pg";
import {
  Driver,
  type MigrationSessionAttestation,
  type QueryExecutionContext,
} from "../driver";
import {
  normalizeDriverConnectionError,
  normalizeDriverError,
} from "../error-mapping";
import { getExecutionTransactionPhases } from "../execution-context";
import {
  acquireWithMaxWait,
  type DriverTransactionOptions,
  defineImmutableDriverFact,
  nestedTransactionDispatchError,
  normalizePostgresRowCount,
  type PinnedSessionReservation,
  resolveMigrationSessionAttestationOption,
  resolveNamespaceOption,
  runTransactionLifecycle,
  type TransactionOptionSupport,
  withSuppressedFailure,
} from "../shared";
import {
  refuseEmptyDatabaseUrl,
  refuseUnknownDriverConfigKeys,
} from "../shared/driver-options";
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
    if (
      [DATE_OID, TIMESTAMP_OID, 1184, 1115, 1182, 1185].includes(oid) &&
      format !== "binary"
    ) {
      return identityParser;
    }
    return pgTypes.getTypeParser(oid as never, format as never);
  },
};

interface BackgroundPoolFailure {
  readonly error: Error;
  readonly generation: number;
  isAvailable: boolean;
}

interface OwnedPoolErrorState {
  backgroundFailure?: BackgroundPoolFailure;
  readonly retain: (error: Error) => void;
}

function createOwnedPoolErrorState(): OwnedPoolErrorState {
  let generation = 0;
  const state: OwnedPoolErrorState = {
    retain(error) {
      generation += 1;
      state.backgroundFailure = { error, generation, isAvailable: true };
    },
  };
  return state;
}

/**
 * The `error` channel of one checked-out client, owned for as long as VibORM
 * holds that client.
 *
 * pg-pool removes its idle listener on checkout and puts it back on release,
 * so a connection that drops in between (a restart, a failover, a terminated
 * backend) would otherwise emit an unhandled `error` and end the process. The
 * first failure is kept: its holder refuses to commit after it and releases the
 * client with it, so the pool destroys that connection instead of reusing it.
 *
 * This holds for a supplied pool too. Its `error` event stays the caller's, but
 * a checked-out client is the holder's to answer for until it is released.
 */
interface HeldClientErrors {
  readonly failure: () => Error | undefined;
  readonly stop: () => void;
}

function holdClientErrors(client: PgPoolClient): HeldClientErrors {
  let failure: Error | undefined;
  const retain = (error: Error) => {
    failure ??= error;
  };
  client.on("error", retain);
  return {
    failure: () => failure,
    stop: () => {
      client.off("error", retain);
    },
  };
}

/** The keys node-postgres's URL parser reads from the query before the authority. */
const URL_QUERY_KEYS = new Set(["user", "password", "host", "port"]);
/** The query parameters node-postgres derives `ssl` from. */
const URL_SSL_KEYS = ["sslmode", "sslcert", "sslkey", "sslrootcert"];

/**
 * The pool's connection record: the caller's options, with `databaseUrl` as
 * the connection string unless `options.connectionString` names one, and each
 * connection option they set written into that URL so that it wins.
 *
 * node-postgres parses the connection string over the options beside it and
 * fills the connection keys the URL lacks with empty values, so a per-tenant
 * URL without a password lost `options.password` from a secret, and the URL's
 * port replaced `options.port`. Its parser prefers `user`, `password`, `host`
 * and `port` from the query and reads the database from the path, so an
 * explicit key is written there; any other option the query also names is
 * dropped from it, and an explicit `ssl` drops the parameters that derive one.
 * A password callback cannot be written into a URL and is not kept beside one.
 */
function connectionRecord(
  options: PoolConfig,
  databaseUrl: string | undefined
): PoolConfig {
  const connectionString = options.connectionString ?? databaseUrl;
  if (!connectionString) return options;
  let url: URL | undefined;
  try {
    url = new URL(connectionString);
  } catch {
    url = undefined;
  }
  const entries: [string, unknown][] = Object.entries(options);
  const overrides = entries.filter(
    ([key, value]) =>
      value !== undefined &&
      (URL_QUERY_KEYS.has(key) ||
        key === "database" ||
        key === "ssl" ||
        (key !== "connectionString" && url?.searchParams.has(key)))
  );
  if (overrides.length === 0) return { ...options, connectionString };
  if (url === undefined) {
    throw new ClientInitializationError(
      'Driver "pg" could not read its connection URL to apply the connection options beside it.',
      { meta: { driver: "pg", operation: "configuration" } }
    );
  }
  for (const [key, value] of overrides) {
    url.searchParams.delete(key);
    if (key === "ssl") {
      for (const sslKey of URL_SSL_KEYS) url.searchParams.delete(sslKey);
    } else if (key === "database") {
      url.pathname = `/${String(value)}`;
    } else if (
      URL_QUERY_KEYS.has(key) &&
      (typeof value === "string" || typeof value === "number")
    ) {
      url.searchParams.set(key, String(value));
    }
  }
  return { ...options, connectionString: url.href };
}

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type { PoolConfig as PgOptions } from "pg";

interface PgErrorEvents {
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** The part of a node-postgres `PoolClient` this driver uses. */
interface PgPoolClient
  extends Pick<PoolClient, "query" | "release">,
    PgErrorEvents {}

/**
 * The part of a node-postgres `Pool` this driver uses, so any pool with that
 * shape is accepted. A Neon WebSocket `Pool` (`@neondatabase/serverless`) is
 * node-postgres's pool over a WebSocket and runs here unchanged, but its
 * bundled copy of the pg declarations lags `@types/pg`: in 8.23 a
 * `PoolClient` is a whole `Client`, and the full `Pool` type refused Neon's.
 */
interface PgPool extends Pick<Pool, "query" | "end">, PgErrorEvents {
  connect(): Promise<PgPoolClient>;
}

export interface PgDriverOptions {
  pool?: PgPool;
  options?: PoolConfig;
  pgvector?: boolean;
  postgis?: boolean;
  databaseUrl?: string;
  /** The PostgreSQL schema this driver's persistent objects live in. Defaults to `public`. */
  namespace?: string;
  /**
   * Your claim, at your risk, that every connection this pool opens is one
   * server session for its whole life. It lifts migrations' refusal of
   * Cloudflare Hyperdrive and Neon `-pooler` hosts; application queries never
   * need it.
   */
  migrationSessionAttestation?: MigrationSessionAttestation;
}

export type PgClientConfig<C extends DriverConfig> = PgDriverOptions & C;

const PG_CONFIG_KEYS: Record<keyof PgDriverOptions, true> = {
  pool: true,
  options: true,
  pgvector: true,
  postgis: true,
  databaseUrl: true,
  namespace: true,
  migrationSessionAttestation: true,
};

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PgDriver extends Driver<PgPool, PgPoolClient> {
  declare readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined = 65_535;

  /**
   * The EXACT pool the caller supplied, or absent when this driver makes its
   * own. Identity, settled here, is the whole ownership answer: the caller's
   * options object is theirs to change, and a `pool` key deleted after
   * construction used to make `$disconnect()` end a transport VibORM was handed
   * and may be sharing with the caller's own code.
   */
  private readonly suppliedPool: PgPool | undefined;
  /**
   * The caller's connection record, copied once.
   *
   * A copy of THIS record, not of what it points at: a nested `ssl` object or
   * stream is the caller's to own, and the keys that decide where a pool
   * connects — host, port, user, database, connectionString — all live here,
   * with the caller's `databaseUrl` merged in (see `connectionRecord`).
   */
  private readonly connectionOptions: PoolConfig;
  /**
   * The listener and latest idle failure for each pool this driver created.
   *
   * Pool identity matters after a failed `end()`: the base lifecycle
   * quarantines that exact pool for a later disconnect retry, while this state
   * keeps its error listener and retained evidence attached to the same
   * transport until a proven successful end.
   */
  private readonly ownedPoolErrors = new WeakMap<object, OwnedPoolErrorState>();

  constructor(options: PgDriverOptions = {}) {
    super("postgresql", "pg");
    const namespace = resolveNamespaceOption(options);
    this.suppliedPool = options.pool;
    const connection = { ...options.options };
    refuseEmptyDatabaseUrl(
      "pg",
      options,
      Boolean(
        this.suppliedPool || connection.host || connection.connectionString
      )
    );
    this.connectionOptions = connectionRecord(connection, options.databaseUrl);

    if (this.suppliedPool) {
      this.client = this.suppliedPool;
    }

    const adapter = new PostgresAdapter(namespace, options.postgis === true);
    adapter.capabilities.supportsVector = options.pgvector === true;
    if (!options.pgvector) adapter.vector = unsupportedVector;
    defineImmutableDriverFact(this, "adapter", adapter);
    defineImmutableDriverFact(
      this,
      "migrationSessionAttestation",
      resolveMigrationSessionAttestationOption(options)
    );
  }

  /** Every host or URL this driver's pool connects through, for migration admission. */
  protected override migrationSessionEndpoints(): readonly unknown[] {
    const supplied: unknown = this.suppliedPool
      ? Reflect.get(this.suppliedPool, "options")
      : undefined;
    const pool =
      typeof supplied === "object" && supplied !== null ? supplied : {};
    return [
      this.connectionOptions.host,
      this.connectionOptions.connectionString,
      Reflect.get(pool, "host"),
      Reflect.get(pool, "connectionString"),
    ];
  }

  /**
   * The pool this driver connects through.
   *
   * A caller's pool is RETURNED rather than replaced: reconnecting after a
   * `$disconnect()` used to build a second pool behind their back — a transport
   * they never asked for, pointed at whatever their options record said by
   * then, and then never closed, because the ownership question was still
   * answered "supplied".
   *
   * It is also returned UNSUBSCRIBED. A supplied pool is borrowed transport and
   * its events belong to its owner: an 'error' listener added here is the very
   * thing that stops Node from throwing, so VibORM would be silencing a crash
   * for a caller who never asked it to — and for the other consumers of a pool
   * two estates share. This driver listens only on the pool it made.
   */
  protected initClient(): Promise<PgPool> {
    if (this.suppliedPool !== undefined) {
      return Promise.resolve(this.suppliedPool);
    }
    const pool = new Pool({ types: utcSafeTypes, ...this.connectionOptions });
    const errorState = createOwnedPoolErrorState();
    this.ownedPoolErrors.set(pool, errorState);
    pool.on("error", errorState.retain);
    return Promise.resolve(pool);
  }

  private readBackgroundPoolFailure(
    pool: PgPool | PgPoolClient
  ): BackgroundPoolFailure | undefined {
    return this.ownedPoolErrors.get(pool)?.backgroundFailure;
  }

  /** Clear exactly the failure observed before an operation started. */
  private clearBackgroundPoolFailure(
    pool: PgPool | PgPoolClient,
    observed: BackgroundPoolFailure | undefined
  ): boolean {
    if (observed === undefined || !observed.isAvailable) return false;
    observed.isAvailable = false;
    const state = this.ownedPoolErrors.get(pool);
    if (state?.backgroundFailure?.generation === observed.generation) {
      state.backgroundFailure = undefined;
    }
    return true;
  }

  /** Claim one retained failure for one failed acquisition, at most once. */
  private consumeBackgroundPoolFailure(
    pool: PgPool | PgPoolClient,
    observed: BackgroundPoolFailure | undefined
  ): Error | undefined {
    if (!this.clearBackgroundPoolFailure(pool, observed)) return undefined;
    return observed?.error;
  }

  /** Surface one pool-owned idle failure beside one pool query failure. */
  private throwPoolQueryFailure(
    pool: PgPool | PgPoolClient,
    observed: BackgroundPoolFailure | undefined,
    error: unknown,
    sql: string,
    params: unknown[] | undefined,
    context: QueryExecutionContext | undefined
  ): never {
    const background = this.consumeBackgroundPoolFailure(pool, observed);
    if (background === undefined) throw error;
    const queryFailure = normalizeDriverError(error, {
      driverName: this.driverName,
      dialect: this.dialect,
      model: context?.model,
      operation: context?.operation,
      correlationId: context?.correlationId,
      query: sql,
      params: this.getDiagnosticParameters(params ?? [], context),
      diagnostics: this.getErrorDisclosure(context),
      forceContext: true,
    });
    throw withSuppressedFailure(queryFailure, background);
  }

  /**
   * One pooled connection, and — when there is none to be had — the current
   * acquisition failure as primary, with the pool's last background failure
   * retained beside it.
   *
   * The acquisition rejection is the failure of the requested action, so it
   * stays primary. The background report arrived outside every request and is
   * retained through the shared suppressed-failure record. Reported once and
   * released, so the next failure speaks for itself rather than inheriting an
   * explanation that has already been given. An acquisition that fails with
   * nothing retained is left exactly as it was.
   */
  private async acquirePooledClient(
    pool: PgPool,
    context: QueryExecutionContext = {},
    maxWaitMs?: number
  ): Promise<PgPoolClient> {
    const observed = this.readBackgroundPoolFailure(pool);
    let acquisitionSettled = false;
    try {
      const client = await acquireWithMaxWait(
        async () => {
          try {
            const acquired = await pool.connect();
            // This runs even when maxWait has already rejected the caller: a
            // late success healed the pre-start failure before the abandoned
            // client goes straight back to the pool.
            this.clearBackgroundPoolFailure(pool, observed);
            return acquired;
          } finally {
            acquisitionSettled = true;
          }
        },
        (acquired) => acquired.release(),
        maxWaitMs,
        { driverName: this.driverName, form: "callback" }
      );
      return client;
    } catch (error) {
      // A maxWait winner abandons the acquisition. Its eventual rejection is
      // observed by acquireWithMaxWait, but it must not consume evidence into
      // a promise whose result no caller will ever inspect.
      if (!acquisitionSettled) throw error;
      const background = this.consumeBackgroundPoolFailure(pool, observed);
      if (background === undefined) throw error;
      const acquisitionFailure = normalizeDriverConnectionError(
        error,
        {
          driverName: this.driverName,
          model: context.model,
          operation: context.operation,
          correlationId: context.correlationId,
          diagnostics: this.getErrorDisclosure(context),
        },
        "Database connection failed after the pool reported a background failure"
      );
      throw withSuppressedFailure(acquisitionFailure, background);
    }
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
  protected async closeClient(pool: PgPool): Promise<void> {
    if (pool === this.suppliedPool) {
      return;
    }
    const errorState = this.ownedPoolErrors.get(pool);
    try {
      await pool.end();
    } catch (error) {
      const background = this.consumeBackgroundPoolFailure(
        pool,
        errorState?.backgroundFailure
      );
      if (background === undefined) throw error;
      const disconnectFailure = normalizeDriverConnectionError(
        error,
        { driverName: this.driverName },
        "Database disconnection failed"
      );
      throw withSuppressedFailure(disconnectFailure, background);
    }
    // AFTER a proven end, not before it: `end()` disposes idle clients whose
    // own listeners can still re-emit on the pool. If end rejects, the still
    // live pool keeps containment; its pre-start evidence travels on the public
    // disconnect failure, exactly once.
    if (errorState !== undefined) {
      pool.off("error", errorState.retain);
      errorState.backgroundFailure = undefined;
      this.ownedPoolErrors.delete(pool);
    }
  }

  protected async execute<T>(
    client: PgPool | PgPoolClient,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const observed = this.readBackgroundPoolFailure(client);
    const result = await client
      .query({ text: sql, values: params, types: utcSafeTypes })
      .catch((error: unknown) =>
        this.throwPoolQueryFailure(
          client,
          observed,
          error,
          sql,
          params,
          context
        )
      );
    // `Pool.query` includes an acquisition. Its success proves transport
    // recovery, but only for evidence that predates this exact operation.
    this.clearBackgroundPoolFailure(client, observed);
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
    client: PgPool | PgPoolClient,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const observed = this.readBackgroundPoolFailure(client);
    const result = await client
      .query({ text: sql, values: params, types: utcSafeTypes })
      .catch((error: unknown) =>
        this.throwPoolQueryFailure(
          client,
          observed,
          error,
          sql,
          params,
          context
        )
      );
    this.clearBackgroundPoolFailure(client, observed);
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
    client: PgPool | PgPoolClient,
    fn: (tx: PgPoolClient) => Promise<T>,
    context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if ("release" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    // Start a new transaction
    const poolClient = await this.acquirePooledClient(
      client,
      context,
      options?.maxWaitMs
    );
    const clientErrors = holdClientErrors(poolClient);
    // A step's own failure stays primary; a different client failure travels
    // beside it through the shared evidence owner instead of being lost.
    const withClientFailure = (error: unknown): unknown => {
      const failure = clientErrors.failure();
      return failure === undefined || failure === error
        ? error
        : withSuppressedFailure(error, failure);
    };
    let releaseError: Error | boolean | undefined;
    const queryOrDiscard = async (statement: string) => {
      try {
        await poolClient.query(statement);
      } catch (error) {
        releaseError ??= error instanceof Error ? error : true;
        throw withClientFailure(error);
      }
    };
    return runTransactionLifecycle({
      begin: () => queryOrDiscard("BEGIN"),
      callback: async () => {
        try {
          return await fn(poolClient);
        } catch (error) {
          throw withClientFailure(error);
        }
      },
      commit: () => {
        // A callback that settles after its connection failed must not commit:
        // whatever it awaited meanwhile never reached the database.
        const failure = clientErrors.failure();
        if (failure !== undefined) throw failure;
        return queryOrDiscard("COMMIT");
      },
      // The server ends a transaction with its session; a ROLLBACK sent on a
      // client that is no longer queryable would only add a second failure.
      rollback: () =>
        clientErrors.failure() === undefined
          ? queryOrDiscard("ROLLBACK")
          : undefined,
      phases: getExecutionTransactionPhases(context),
      close: () => {
        try {
          const discard = releaseError ?? clientErrors.failure();
          if (discard) {
            poolClient.release(discard);
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
        } finally {
          clientErrors.stop();
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
    PinnedSessionReservation<PgPool | PgPoolClient>
  > {
    const client = await this.getClient({ operation: "pinnedSession" });
    if ("release" in client) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    const poolClient = await this.acquirePooledClient(client, {
      operation: "pinnedSession",
    });
    const clientErrors = holdClientErrors(poolClient);
    return {
      session: poolClient,
      // The client's own `error` event is how pg reports a socket that died
      // between or under statements; the pinned session then sends nothing
      // more on it (plan S2). Release destroys it either way.
      lost: clientErrors.failure,
      release: (discard) => {
        try {
          poolClient.release(
            clientErrors.failure() ?? (discard ? true : undefined)
          );
        } finally {
          clientErrors.stop();
        }
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
): VibORMClient<{
  [P in keyof LinkedClientConfig<C & { driver: PgDriver }>]: LinkedClientConfig<
    C & { driver: PgDriver }
  >[P];
}> {
  refuseUnknownDriverConfigKeys(config, "pg", PG_CONFIG_KEYS);
  const { pool, options = {}, pgvector, postgis, databaseUrl } = config;
  const namespace = resolveNamespaceOption(config);
  const attestation = resolveMigrationSessionAttestationOption(config);

  const driverOptions: PgDriverOptions = { options };
  // Present even when undefined: the driver refuses an empty one (parity-18).
  if (Object.hasOwn(config, "databaseUrl")) {
    driverOptions.databaseUrl = databaseUrl;
  }
  if (pool) driverOptions.pool = pool;
  if (pgvector !== undefined) driverOptions.pgvector = pgvector;
  if (postgis !== undefined) driverOptions.postgis = postgis;
  if (namespace !== undefined) driverOptions.namespace = namespace;
  if (attestation !== undefined) {
    driverOptions.migrationSessionAttestation = attestation;
  }

  const driver = new PgDriver(driverOptions);

  return createClientFromDriverConfig<S, C, PgDriver>(config, driver);
}
