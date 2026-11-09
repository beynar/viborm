/**
 * Cloudflare Durable Object SQLite driver (`ctx.storage.sql`).
 *
 * Statements run synchronously on `storage.sql.exec`. A Durable Object refuses
 * `BEGIN`, `SAVEPOINT` and `PRAGMA busy_timeout`, so this driver never sends
 * them: a transaction, at any depth, is `storage.transaction()`, which nests
 * natively, and the SQLite migration lock is a pending one of those
 * (`openMigrationFrame`).
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createClientFromDriverConfig,
  type DriverConfig,
  type LinkedClientConfig,
  type NoExtraDriverConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import type { DurableObjectStorage as PlatformStorage } from "@cloudflare/workers-types";
import { ClientInitializationError } from "@errors";
import {
  Driver,
  type DriverResultParser,
  DURABLE_OBJECT_MIGRATION_CAPABILITY,
  type MigrationFrame,
  type QueryExecutionContext,
  TransactionBoundDriver,
} from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import {
  convertValueForSQLite,
  runProviderManagedTransaction,
  sqliteResultParser,
  type TransactionOptionSupport,
} from "../shared";
import { refuseUnknownDriverConfigKeys } from "../shared/driver-options";
import { isSQLiteMutationStatement } from "../shared/sqlite-statement-classifier";
import { LOCAL_SQLITE_TRANSACTION_SUPPORT } from "../shared/sqlite-utils";
import type { QueryResult } from "../types";

/** What the driver uses of `ctx.storage`. */
export type DurableObjectStorage = Pick<
  PlatformStorage,
  "sql" | "sync" | "transaction"
>;

export interface DurableObjectDriverOptions {
  storage: DurableObjectStorage;
  /**
   * The adapter the driver renders with, instead of its default
   * `new SQLiteAdapter({ temporaryObjects: false, deepExpressions: false })`.
   * It is read when the storage's driver is created; a later call naming
   * another adapter for the same storage is refused.
   */
  adapter?: DatabaseAdapter;
}

export type DurableObjectClientConfig<C extends DriverConfig> =
  DurableObjectDriverOptions & C;

const CONFIG_KEYS: Record<keyof DurableObjectDriverOptions, true> = {
  storage: true,
  adapter: true,
};

/** Exact inside ±2^53 as a number; beyond, a decimal string SQLite's INTEGER affinity reads exactly. */
function toBindValue(parameter: unknown): unknown {
  const value = convertValueForSQLite(parameter);
  if (typeof value === "bigint")
    return Number.isSafeInteger(Number(value)) ? Number(value) : `${value}`;
  if (ArrayBuffer.isView(value))
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength
    );
  return value;
}

class DurableObjectDriver extends Driver<
  DurableObjectStorage,
  DurableObjectStorage
> {
  readonly adapter: DatabaseAdapter;
  // The platform's limit per statement; the engine splits or refuses above it.
  readonly maxBindParametersPerStatement: number | undefined = 100;
  readonly result: DriverResultParser = sqliteResultParser;
  readonly supportsTransactions = true;
  readonly supportsBatch = false;
  readonly sqliteMigrationCapability = DURABLE_OBJECT_MIGRATION_CAPABILITY;
  protected override readonly serializeTransactions = true;
  // Not `#private`: migration views run these methods on `Object.create(driver)`.
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage, adapter: DatabaseAdapter) {
    super("sqlite", "durable-object");
    this.storage = storage;
    this.client = storage;
    this.adapter = adapter;
  }

  protected override createTransactionBoundDriver(
    tx: DurableObjectStorage,
    context: QueryExecutionContext
  ): TransactionBoundDriver<DurableObjectStorage, DurableObjectStorage> {
    return new DurableObjectTransactionDriver(this, tx, context);
  }

  protected initClient(): Promise<DurableObjectStorage> {
    return Promise.resolve(this.storage);
  }

  protected closeClient(): Promise<void> {
    // The platform owns the storage.
    return Promise.resolve();
  }

  protected async execute<T>(
    storage: DurableObjectStorage,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const cursor = storage.sql.exec(sql, ...params.map(toBindValue));
    const rows = cursor.toArray() as T[];
    if (cursor.columnNames.length > 0 || !isSQLiteMutationStatement(sql))
      return { rows, rowCount: rows.length };
    // `cursor.rowsWritten` counts index writes too; `changes()` counts rows.
    const { changes } = storage.sql
      .exec<{ changes: number }>("SELECT changes() AS changes")
      .one();
    return { rows, rowCount: changes };
  }

  protected executeRaw<T>(
    storage: DurableObjectStorage,
    sql: string,
    params: unknown[] | undefined
  ): Promise<QueryResult<T>> {
    return this.execute<T>(storage, sql, params ?? []);
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    return LOCAL_SQLITE_TRANSACTION_SUPPORT;
  }

  protected transaction<T>(
    storage: DurableObjectStorage,
    fn: (tx: DurableObjectStorage) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    return runProviderManagedTransaction({
      run: (callback) => storage.transaction(() => callback(storage)),
      callback: fn,
      phases: getExecutionTransactionPhases(context),
      // The platform rolls a rejected transaction back itself.
      close: () => Promise.resolve(),
    });
  }

  /** A pending write makes `PRAGMA foreign_keys = OFF` a silent no-op. */
  protected override async beforeForeignKeysOff(): Promise<void> {
    await this.storage.sync();
  }

  /**
   * A `storage.transaction()` kept pending until the migration settles it.
   * The object has one SQLite connection, so every statement sent meanwhile
   * belongs to it.
   */
  async openMigrationFrame(): Promise<MigrationFrame> {
    let settle: (commit: boolean) => void = () => undefined;
    const decision = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    let opened: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const rolledBack = new Error("The migration frame was rolled back.");
    const ended = this.storage.transaction(async () => {
      opened();
      if (!(await decision)) throw rolledBack;
    });
    // A transaction the platform refused rejects before its body runs.
    await Promise.race([open, ended]);
    return {
      commit: () => {
        settle(true);
        return ended;
      },
      rollback: async () => {
        settle(false);
        await ended.catch((error: unknown) => {
          if (error !== rolledBack) throw error;
        });
      },
    };
  }
}

/** A nested `$transaction` is a nested `storage.transaction()`, not a SAVEPOINT. */
class DurableObjectTransactionDriver extends TransactionBoundDriver<
  DurableObjectStorage,
  DurableObjectStorage
> {
  protected override createTransactionBoundDriver(
    tx: DurableObjectStorage,
    context: QueryExecutionContext
  ): DurableObjectTransactionDriver {
    return new DurableObjectTransactionDriver(this, tx, context);
  }

  protected override transaction<T>(
    storage: DurableObjectStorage,
    fn: (tx: DurableObjectStorage) => Promise<T>
  ): Promise<T> {
    this.assertTransactionCommittable();
    return storage.transaction(() => fn(storage));
  }
}

const drivers = new WeakMap<DurableObjectStorage, DurableObjectDriver>();

/**
 * The driver of one Durable Object's storage, created on the first call and
 * returned by every later one. One per storage is the contract: the driver
 * queues its transactions and its migration lock, so every client of that
 * storage must share it.
 */
export function createDurableObjectDriver(
  storage: DurableObjectStorage,
  adapter?: DatabaseAdapter
): DurableObjectDriver {
  const existing = drivers.get(storage);
  if (existing === undefined) {
    const driver = new DurableObjectDriver(
      storage,
      adapter ??
        new SQLiteAdapter({ temporaryObjects: false, deepExpressions: false })
    );
    drivers.set(storage, driver);
    return driver;
  }
  if (adapter !== undefined && adapter !== existing.adapter)
    throw new ClientInitializationError(
      "This Durable Object storage already has a driver, created with another adapter. Create the adapter once and pass that same object.",
      { meta: { driver: "durable-object" } }
    );
  return existing;
}

// The class is a type only: `createDurableObjectDriver` is the one way to a
// driver, so a storage never has two.
export type { DurableObjectDriver };

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: DurableObjectClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, DurableObjectDriverOptions, S>
): VibORMClient<{
  [P in keyof LinkedClientConfig<
    C & { driver: DurableObjectDriver }
  >]: LinkedClientConfig<C & { driver: DurableObjectDriver }>[P];
}> {
  refuseUnknownDriverConfigKeys(config, "durable-object", CONFIG_KEYS);
  const driver = createDurableObjectDriver(config.storage, config.adapter);
  return createClientFromDriverConfig<S, C, DurableObjectDriver>(
    config,
    driver
  );
}
