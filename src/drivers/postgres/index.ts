/**
 * PostgreSQL Driver (postgres.js)
 *
 * Driver implementation for postgres.js - a modern, fast PostgreSQL client.
 *
 * Generated statements use unsafe(query, values, queryOptions).
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
  unsupportedVector,
  VibORMErrorCode,
} from "@errors";
import postgres, {
  type Options as PostgresOptionsType,
  type Sql as PostgresSql,
} from "postgres";
import { Driver, type QueryExecutionContext } from "../driver";
import { normalizeDriverError } from "../error-mapping";
import { getExecutionTransactionPhases } from "../execution-context";
import {
  acquireWithMaxWait,
  type DriverTransactionOptions,
  defineImmutableDriverFact,
  nestedTransactionDispatchError,
  normalizePostgresRowCount,
  type PinnedSessionReservation,
  releaseReservedPostgresSession,
  resolveNamespaceOption,
  runProviderManagedTransaction,
  type TransactionOptionSupport,
  withSuppressedFailure,
} from "../shared";
import type { QueryResult } from "../types";

export type PostgresOptions = PostgresOptionsType<
  Record<string, postgres.PostgresType>
>;

type PostgresTransaction = postgres.TransactionSql<Record<string, unknown>>;

export interface PostgresDriverOptions {
  client?: PostgresSql<Record<string, unknown>>;
  options?: PostgresOptions;
  pgvector?: boolean;
  postgis?: boolean;
  databaseUrl?: string;
  /** The PostgreSQL schema this driver's persistent objects live in. Defaults to `public`. */
  namespace?: string;
}

export const vibormTypes: Record<string, postgres.PostgresType> = {
  // TIMESTAMP WITHOUT TIME ZONE (1114): postgres.js builds process-local
  // Dates, shifting the stored UTC wall clock by the process timezone. Keep
  // the raw string — the shared result parser builds a UTC Date from it,
  // matching every other driver. (DATE already arrives as a string.)
  timestamp: {
    to: 1114,
    from: [1082, 1114, 1184],
    serialize: (value: unknown) =>
      value instanceof Date ? value.toISOString() : String(value),
    parse: (value: string) => value,
  },
  // The adapter binds a `JsonParameter` carrier (src/sql/json-parameter.ts),
  // which the object arm serializes to its canonical text via `toJSON`. The
  // string arm exists for raw SQL: a caller's own JSON text bound to a
  // json/jsonb parameter must not be JSON.stringify'd a second time once the
  // server declares the param type — that double-encodes the stored value.
  json: {
    to: 114,
    from: [114, 3802],
    serialize: (value: unknown) =>
      typeof value === "string" ? value : JSON.stringify(value),
    parse: (value: string) => JSON.parse(value),
  },
};

/** Bind validated one-dimensional lists as PostgreSQL text, letting SQL infer
 * the column type; postgres.js otherwise guesses bigint[]/boolean[] wrongly. */
function encodeListParameters(params: unknown[]): unknown[] {
  return params.map((value) =>
    Array.isArray(value)
      ? `{${value.map((member) => (member === null ? "NULL" : `"${String(member).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",")}}`
      : value
  );
}

const withVibormTypes = (options: PostgresOptions = {}): PostgresOptions => ({
  ...options,
  types: { ...vibormTypes, ...options.types },
});

export type PostgresClientConfig<C extends DriverConfig> =
  PostgresDriverOptions & C;

type PostgresClient = PostgresSql<Record<string, unknown>>;

const isTransaction = (
  client: PostgresClient | PostgresTransaction
): client is PostgresTransaction => {
  return "savepoint" in client;
};

// ============================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PostgresDriver extends Driver<
  PostgresClient,
  PostgresTransaction
> {
  declare readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined = 65_533;

  private readonly driverOptions: PostgresDriverOptions;
  /**
   * The EXACT transport the caller supplied, or absent when this driver makes
   * its own. Identity, settled here from ONE read, is the whole ownership
   * answer: the caller's options object is theirs to change, and a `client`
   * getter answering differently on a second read used to leave this driver
   * holding the caller's transport while believing it had made its own.
   */
  private readonly suppliedClient: PostgresClient | undefined;

  constructor(options: PostgresDriverOptions = {}) {
    super("postgresql", "postgres");
    const namespace = resolveNamespaceOption(options);
    this.driverOptions = {
      databaseUrl: options.databaseUrl,
      options: { ...options.options },
    };
    this.suppliedClient = options.client;

    if (this.suppliedClient) {
      for (const oid of [1082, 1114, 1184]) {
        if (
          this.suppliedClient.options?.parsers[oid] !==
          vibormTypes.timestamp?.parse
        ) {
          throw new ClientInitializationError(
            "A supplied postgres.js client must use VibORM temporal parsers; construct postgres(url, { types: vibormTypes }).",
            { meta: { driver: "postgres", operation: "configuration" } }
          );
        }
      }
      this.client = this.suppliedClient;
    }

    const adapter = new PostgresAdapter(namespace, options.postgis === true);
    adapter.capabilities.supportsVector = options.pgvector === true;
    if (!options.pgvector) adapter.vector = unsupportedVector;
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
  protected async initClient(): Promise<PostgresClient> {
    if (this.suppliedClient !== undefined) {
      return this.suppliedClient;
    }
    const { databaseUrl, options } = this.driverOptions;
    if (databaseUrl) {
      const {
        host: _host,
        hostname: _hostname,
        port: _port,
        user: _user,
        username: _username,
        pass: _pass,
        password: _password,
        database: _database,
        db: _db,
        ...transportOptions
      } = options ?? {};
      return postgres(databaseUrl, withVibormTypes(transportOptions));
    }
    return postgres(withVibormTypes(options));
  }

  /**
   * A supplied transport belongs to the caller, who may be sharing it with
   * other clients — two schema-scoped estates over one transport is the
   * documented shape — and §5.3's rule is that VibORM never changes a caller's
   * connection state. `$disconnect()` used to end it regardless, so
   * disconnecting one client tore down every other consumer of that transport.
   *
   * The test is on the transport's IDENTITY against what construction
   * captured, so it answers for the transport actually being closed rather than
   * for whatever the caller's record says now.
   */
  protected async closeClient(sql: PostgresClient): Promise<void> {
    if (sql === this.suppliedClient) {
      return;
    }
    await sql.end();
  }

  protected async execute<T>(
    client: PostgresClient | PostgresTransaction,
    sqlStr: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    // postgres.js prepares only when the connection AND the query say so; every
    // query says yes, so the connection's `prepare` option decides.
    const result = await client.unsafe<T[]>(
      sqlStr,
      encodeListParameters(params),
      { prepare: true }
    );
    return {
      rows: result,
      rowCount: normalizePostgresRowCount(
        result.count,
        result.command,
        result,
        {
          provider: "postgres",
          operation,
        }
      ),
    };
  }

  protected async executeRaw<T>(
    client: PostgresClient | PostgresTransaction,
    sqlStr: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.unsafe<T[]>(sqlStr, params, { prepare: true });
    return {
      rows: result,
      rowCount: normalizePostgresRowCount(
        result.count,
        result.command,
        result,
        {
          provider: "postgres",
          operation,
        }
      ),
    };
  }

  /**
   * postgres.js owns BEGIN inside `client.begin()`, so the isolation level goes
   * in as the transaction's first statement. It also owns connection
   * acquisition inside that same call: there is no acquisition step VibORM can
   * bound or abandon, so `maxWait` is refused rather than faked.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "post-begin",
      timeout: true,
      maxWait: "unsupported",
      maxWaitReason:
        "postgres.js acquires the connection inside client.begin(), which VibORM cannot observe or bound — the wait would be unbounded no matter what maxWait said",
    };
  }

  protected async transaction<T>(
    client: PostgresClient | PostgresTransaction,
    fn: (tx: PostgresTransaction) => Promise<T>,
    context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    if (isTransaction(client)) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    return runProviderManagedTransaction({
      run: async (callback) => {
        let entered = false;
        try {
          return await client.begin((tx) => {
            entered = true;
            return callback(tx);
          });
        } catch (error) {
          if (!entered && this.isConnectionFailure(error))
            await this.recoverFailedBegin(
              client,
              error,
              options?.maxWaitMs ?? 5000
            );
          throw error;
        }
      },
      callback: fn,
      phases: getExecutionTransactionPhases(context),
      // The provider transaction primitive already rolls back/discards its
      // failed session. A transaction does not own this shared pool/database.
      close: async () => undefined,
    });
  }

  private isConnectionFailure(error: unknown): boolean {
    const failure = normalizeDriverError(error, {
      driverName: this.driverName,
      dialect: this.dialect,
    });
    return (
      failure.code === VibORMErrorCode.CONNECTION_FAILED ||
      failure.code === VibORMErrorCode.CONNECTION_TIMEOUT
    );
  }

  private async recoverFailedBegin(
    client: PostgresClient,
    primary: unknown,
    maxWaitMs: number
  ): Promise<void> {
    // postgres.js can retain a fatal response across reconnect, rejecting the
    // next acquisition before dispatch. Drain that startup error with leases,
    // never caller SQL; the callback above has provably not entered. A drain
    // that cannot connect needs no quarantine: a connection failure before the
    // callback leaves no live session, and the next lease that connects
    // clears the state.
    const deadline = Date.now() + maxWaitMs;
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const lease = await acquireWithMaxWait(
          () => client.reserve(),
          (late) => late.release(),
          remaining,
          { driverName: this.driverName, form: "callback" }
        );
        lease.release();
        return;
      } catch (cleanup) {
        withSuppressedFailure(primary, cleanup);
        if (!this.isConnectionFailure(cleanup)) break;
      }
    }
  }

  /**
   * One `reserve()` result — plan §3.5's pinned producer for postgres.js.
   *
   * postgres.js exposes no destroy for a reserved connection, so a condemned
   * session is reset with PostgreSQL's own instrument before it goes back:
   * `pg_advisory_unlock_all()` releases every advisory lock the session still
   * holds, which is the exact state that must not survive the release. When
   * that reset FAILS the session's lock state is unknown, and the shared rule
   * below is what keeps it out of the pool — the reset's failure is not
   * swallowed, because a session that may still hold VibORM's migration lock is
   * not something a caller can be left unaware of.
   */
  protected override async pinnedSession(): Promise<
    PinnedSessionReservation<PostgresClient | PostgresTransaction>
  > {
    const client = await this.getClient({ operation: "pinnedSession" });
    if (isTransaction(client)) {
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
          // Ownership is the identity this driver settled at construction,
          // never a later read of the caller's options object: a `client` key
          // deleted after construction would otherwise make VibORM end a
          // transport it was handed.
          closeOwnedTransport:
            client === this.suppliedClient
              ? undefined
              : async () => {
                  // Withdrawn BEFORE the close, never after it. `end()` can
                  // reject — a socket already gone is the ordinary way — and
                  // withdrawing afterwards left this exact transport installed,
                  // so the next ordinary query ran on the connection whose
                  // advisory-lock state is precisely what could not be
                  // accounted for. The in-flight connect goes with it, because
                  // `getClient()` answers from it when `client` is null.
                  this.client = null;
                  this.initPromise = null;
                  await client.end();
                },
        }),
    };
  }
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: PostgresClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, PostgresDriverOptions, S>
): VibORMClient<{
  [P in keyof LinkedClientConfig<
    C & { driver: PostgresDriver }
  >]: LinkedClientConfig<C & { driver: PostgresDriver }>[P];
}> {
  const { client, options = {}, pgvector, postgis, databaseUrl } = config;
  const namespace = resolveNamespaceOption(config);

  const driver = new PostgresDriver({
    client,
    options,
    databaseUrl,
    pgvector,
    postgis,
    namespace,
  });

  return createClientFromDriverConfig<S, C, PostgresDriver>(config, driver);
}
