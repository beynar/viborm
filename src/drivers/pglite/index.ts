/**
 * PGlite Driver
 *
 * Driver implementation for PGlite (PostgreSQL in WebAssembly).
 * Supports optional pgvector and PostGIS extensions.
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
  PGlite,
  type PGliteOptions,
  type Transaction,
} from "@electric-sql/pglite";
import { unsupportedVector } from "@errors";
import {
  activateConsumableResultProducer,
  deactivateConsumableResultProducer,
  registerConsumableResultCandidate,
} from "../consumable-result-candidate";
import { type AnyDriver, Driver, type QueryExecutionContext } from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import { normalizeProviderRowCount } from "../normalized-result";
import {
  defineImmutableDriverFact,
  nestedTransactionDispatchError,
  resolveNamespaceOption,
  runProviderManagedTransaction,
  type TransactionOptionSupport,
} from "../shared";
import {
  condemnPhysicalSession,
  type PinnedSessionReservation,
  unprovenLockStateError,
} from "../shared/pinned-session";
import type { QueryResult } from "../types";

// ============================================================
// EXPORTED OPTIONS
// ============================================================

export type { PGliteOptions } from "@electric-sql/pglite";

export interface PGliteDriverOptions {
  client?: PGlite;
  dataDir?: string;
  options?: PGliteOptions;
  pgvector?: boolean;
  postgis?: boolean;
  /** The PostgreSQL schema this driver's persistent objects live in. Defaults to `public`. */
  namespace?: string;
}

export type PGliteConfig<C extends DriverConfig> = PGliteDriverOptions & C;

// ===  ======================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PGliteDriver extends Driver<PGlite, Transaction> {
  private static readonly canonicalExecuteEntry =
    PGliteDriver.prototype._execute;
  private static readonly canonicalExecute = PGliteDriver.prototype.execute;

  declare readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined = 65_535;
  protected override readonly serializeTransactions = true;

  private readonly driverOptions: PGliteDriverOptions;
  /**
   * The EXACT database the caller supplied, or absent when this driver makes
   * its own. Identity, settled here from ONE read, is the whole ownership
   * answer: the caller's options object is theirs to change, and a `client`
   * getter answering differently on a second read used to leave this driver
   * holding the caller's database while believing it had made its own.
   */
  private readonly suppliedClient: PGlite | undefined;
  private readonly canonicalAdapterParseResult: DatabaseAdapter["result"]["parseResult"];

  constructor(options: PGliteDriverOptions = {}) {
    super("postgresql", "pglite");
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
    this.canonicalAdapterParseResult = adapter.result.parseResult;
    if (PGliteDriver.isConsumableCandidate(this)) {
      registerConsumableResultCandidate(
        this,
        PGliteDriver.canonicalExecuteEntry,
        PGliteDriver.isConsumableCandidate,
        PGliteDriver.isConsumableProducer
      );
    }
  }

  /**
   * The database this driver runs on.
   *
   * A caller's database is RETURNED rather than replaced: reconnecting after a
   * `$disconnect()` used to build a second, EMPTY in-memory PGlite behind their
   * back — a database they never asked for, holding none of their data, while
   * the one they handed over stayed open and unused.
   */
  protected async initClient(): Promise<PGlite> {
    if (this.suppliedClient !== undefined) {
      return this.suppliedClient;
    }
    deactivateConsumableResultProducer(this);
    const dataDir = this.driverOptions.dataDir;
    const userOptions = this.driverOptions.options ?? {};
    const options: PGliteOptions = {
      ...userOptions,
      parsers: {
        // TIMESTAMP WITHOUT TIME ZONE: PGlite builds process-local Dates,
        // shifting the stored UTC wall clock. Keep the raw string — the
        // shared result parser builds a UTC Date, matching other drivers.
        1114: (value: string) => value,
        ...userOptions.parsers,
      },
    };
    const isConsumableClient = PGliteDriver.isConsumableCandidate(this);

    // PGlite.create accepts dataDir as first argument or in options
    const client = dataDir
      ? await PGlite.create(dataDir, options)
      : await PGlite.create(options);
    if (isConsumableClient && PGliteDriver.isConsumableCandidate(this)) {
      activateConsumableResultProducer(this, client);
    }
    return client;
  }

  /**
   * A supplied database belongs to the caller, who may be running two
   * schema-scoped estates over it — the documented shape — and closing it here
   * would take the sibling's data down with this one's `$disconnect()`, on an
   * in-memory database for good.
   *
   * The test is on the client's IDENTITY against what construction captured, so
   * it answers for the database actually being closed rather than for whatever
   * the caller's record says now.
   */
  protected async closeClient(client: PGlite): Promise<void> {
    if (client === this.suppliedClient) {
      return;
    }
    try {
      await client.close();
    } finally {
      deactivateConsumableResultProducer(this, client);
    }
  }

  protected async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "execute";
    const result = await client.query<T>(sql, params);
    const affectedRows = normalizeProviderRowCount(result.affectedRows, {
      provider: "pglite",
      operation,
    });
    return {
      rows: result.rows,
      rowCount: result.rows.length > 0 ? result.rows.length : affectedRows,
    };
  }

  protected async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const operation = context?.operation ?? "executeRaw";
    const result = await client.query<T>(sql, params);
    const affectedRows = normalizeProviderRowCount(result.affectedRows, {
      provider: "pglite",
      operation,
    });
    return {
      rows: result.rows,
      rowCount: result.rows.length > 0 ? result.rows.length : affectedRows,
    };
  }

  private static isConsumableProducer(
    driver: AnyDriver,
    client: object
  ): boolean {
    if (!(driver instanceof PGliteDriver)) return false;
    return (
      PGliteDriver.isConsumableCandidate(driver) &&
      Object.getPrototypeOf(client) === PGlite.prototype &&
      driver.client === client
    );
  }

  private static isConsumableCandidate(driver: AnyDriver): boolean {
    if (!(driver instanceof PGliteDriver)) return false;
    return (
      driver.suppliedClient === undefined &&
      hasStockPGliteSubstrate(driver.driverOptions.options ?? {}) &&
      PGliteDriver.hasCanonicalProducerSurface(driver)
    );
  }

  private static hasCanonicalProducerSurface(driver: PGliteDriver): boolean {
    return (
      Object.getPrototypeOf(driver) === PGliteDriver.prototype &&
      driver._execute === PGliteDriver.canonicalExecuteEntry &&
      driver.execute === PGliteDriver.canonicalExecute &&
      driver.result?.parseResult === undefined &&
      driver.adapter.result.parseResult === driver.canonicalAdapterParseResult
    );
  }

  /**
   * PGlite is a full PostgreSQL, so the isolation level is a real post-BEGIN
   * statement. It is also single-connection, so top-level transactions queue —
   * and that queue wait is exactly what `maxWait` bounds.
   */
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "post-begin",
      timeout: true,
      maxWait: "queue",
    };
  }

  protected transaction<T>(
    client: PGlite | Transaction,
    fn: (tx: Transaction) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    if (!(client instanceof PGlite)) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    return runProviderManagedTransaction({
      run: (callback) => client.transaction(callback),
      callback: fn,
      phases: getExecutionTransactionPhases(context),
      // Containment for a transaction the provider broke, through the one place
      // that decides whether a transport may be closed at all: destroying the
      // caller's database to contain VibORM's transaction would be a far larger
      // effect than the one being contained.
      close: async () => {
        try {
          await this.closeClient(client);
        } finally {
          this.client = null;
        }
      },
    });
  }

  /**
   * The PGlite instance itself — the physical session a pinned command runs on.
   *
   * A caller may hand ONE PGlite to several drivers (two schema-scoped estates
   * over one database is the documented shape), and each of those drivers owns
   * its own connection queue. The client is what they all agree on, so it is
   * what serializes their pinned commands; without it the second command
   * re-acquires the reentrant session advisory lock the first is holding and
   * runs inside the first command's session.
   */
  protected override async physicalPinnedSession(): Promise<object> {
    return await this.getClient({ operation: "pinnedSession" });
  }

  /**
   * PGlite's single client, under the queue it already owns — plan §3.5's
   * pinned producer here. There is nothing to reserve and nothing to return:
   * one connection IS the session, which is exactly what a session lock needs.
   *
   * A condemned session can be neither destroyed nor abandoned: closing this
   * client closes the DATABASE, which for an in-memory one takes the caller's
   * data with it and for a supplied one is not VibORM's to do at all. So the
   * session is reset with `pg_advisory_unlock_all()`, and when that reset FAILS
   * the CLIENT is condemned instead — the subject of an unknown lock state is
   * the session, so the condemnation is recorded on it and refuses the next
   * pinned command through every driver over it. Ordinary queries keep working
   * — the data was never in doubt. Swallowing that reset failure was the
   * alternative, and it left the next migration command running inside a
   * session that may still hold the lock, on the one transport where the lock
   * is reentrant and would not stop it.
   */
  protected override async pinnedSession(): Promise<
    PinnedSessionReservation<PGlite | Transaction>
  > {
    const client = await this.getClient({ operation: "pinnedSession" });
    if (!(client instanceof PGlite)) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    return {
      session: client,
      release: async (discard) => {
        if (!discard) {
          return;
        }
        try {
          await client.query("SELECT pg_advisory_unlock_all()");
        } catch (resetFailure) {
          condemnPhysicalSession(client);
          throw unprovenLockStateError(
            this.driverName,
            "No driver will pin a further migration session on that client. The client itself was NOT closed: it is the caller's database, not a pooled connection VibORM may discard.",
            resetFailure
          );
        }
      },
    };
  }
}

function hasStockPGliteSubstrate(options: PGliteOptions): boolean {
  for (const key of Object.keys(options)) {
    switch (key) {
      case "dataDir":
      case "username":
      case "database":
      case "debug":
      case "relaxedDurability":
      case "initialMemory":
      case "parsers":
      case "serializers":
        break;
      default:
        return false;
    }
  }
  return true;
}

// ============================================================
// CONVENIENCE FUNCTION
// ============================================================

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: PGliteConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, PGliteDriverOptions, S>
): VibORMClient<C & { driver: PGliteDriver }> {
  const { client, dataDir, options, pgvector, postgis } = config;
  const namespace = resolveNamespaceOption(config);

  const driver = new PGliteDriver({
    client,
    dataDir,
    options,
    pgvector,
    postgis,
    namespace,
  });

  return createClientFromDriverConfig(config, driver) as VibORMClient<
    C & { driver: PGliteDriver }
  >;
}
