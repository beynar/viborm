/**
 * PostgreSQL Driver (postgres.js)
 *
 * Driver implementation for postgres.js - a modern, fast PostgreSQL client.
 *
 * No statement pipelining, measured rather than assumed. postgres.js can
 * pipeline, but it gates that on `!q.describeFirst`, and it sets `describeFirst`
 * for every parameterized query that is not already a cached prepared
 * statement. `sql.unsafe()` — the only entry point that accepts a generated SQL
 * string, which is all this driver ever has — hard-sets `prepare: false`, so no
 * statement is ever cached and the gate never opens. Issuing a transaction's
 * statements without intermediate awaits therefore costs exactly what issuing
 * them one at a time costs, and each parameterized statement costs two round
 * trips rather than one.
 *
 * `tests/drivers/postgres-pipelining.test.ts` pins that measurement, and the
 * Phase 9 section of `docs/architecture/query-performance-plan.md` records the
 * numbers and the door that stays shut.
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
import { unsupportedVector } from "@errors";
import postgres, {
  type Options as PostgresOptionsType,
  type Sql as PostgresSql,
} from "postgres";
import { Driver, type QueryExecutionContext } from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import {
  defineImmutableDriverFact,
  nestedTransactionDispatchError,
  normalizePostgresRowCount,
  type PinnedSessionReservation,
  releaseReservedPostgresSession,
  resolveNamespaceOption,
  runProviderManagedTransaction,
  type TransactionOptionSupport,
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

const parseDatabaseUrl = (url: string): PostgresOptions => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
    database: parsed.pathname.slice(1), // Remove leading "/"
    user: parsed.username || undefined,
    password: parsed.password || undefined,
  };
};

const vibormTypes: Record<string, postgres.PostgresType> = {
  // TIMESTAMP WITHOUT TIME ZONE (1114): postgres.js builds process-local
  // Dates, shifting the stored UTC wall clock by the process timezone. Keep
  // the raw string — the shared result parser builds a UTC Date from it,
  // matching every other driver. (DATE already arrives as a string.)
  timestamp: {
    to: 1114,
    from: [1114],
    serialize: (value: unknown) => value as string,
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
  readonly maxBindParametersPerStatement: number | undefined = 65_535;

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
    this.driverOptions = options;
    this.suppliedClient = options.client;

    if (this.suppliedClient) {
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
      return postgres(
        withVibormTypes({ ...parseDatabaseUrl(databaseUrl), ...options })
      );
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
    // postgres.js unsafe() takes (query, parameters?, queryOptions?)
    // parameters must be cast as postgres expects specific types
    const result = await client.unsafe<T[]>(sqlStr, params);
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
    const result = await client.unsafe<T[]>(sqlStr, params);
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
    context?: QueryExecutionContext
  ): Promise<T> {
    if (isTransaction(client)) {
      throw nestedTransactionDispatchError(this.driverName);
    }

    return runProviderManagedTransaction({
      run: (callback) => client.begin(callback),
      callback: fn,
      phases: getExecutionTransactionPhases(context),
      // Containment for a transaction the provider broke, through the one place
      // that decides whether a transport may be closed at all: ending the
      // caller's transport to contain VibORM's transaction would be a far
      // larger effect than the one being contained.
      close: async () => {
        await this.closeClient(client);
        this.client = null;
      },
    });
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
): VibORMClient<C & { driver: PostgresDriver }> {
  const { client, options = {}, pgvector, postgis, databaseUrl } = config;
  const namespace = resolveNamespaceOption(config);

  // The URL still wins over the caller's option keys, on a copy this wrapper
  // owns rather than in the caller's record.
  const mergedOptions = databaseUrl
    ? { ...options, ...parseDatabaseUrl(databaseUrl) }
    : options;

  const driver = new PostgresDriver({
    client,
    options: mergedOptions,
    pgvector,
    postgis,
    namespace,
  });

  return createClientFromDriverConfig(config, driver) as VibORMClient<
    C & { driver: PostgresDriver }
  >;
}
