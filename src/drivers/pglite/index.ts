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
  type NoExtraNestedConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import {
  PGlite,
  type PGliteOptions,
  type Transaction,
} from "@electric-sql/pglite";
import { unsupportedGeospatial, unsupportedVector } from "@errors";
import {
  activateConsumableResultProducer,
  deactivateConsumableResultProducer,
  registerConsumableResultCandidate,
} from "../consumable-result-candidate";
import { type AnyDriver, Driver, type QueryExecutionContext } from "../driver";
import { normalizeProviderRowCount } from "../normalized-result";
import {
  nestedTransactionDispatchError,
  runProviderManagedTransaction,
  type TransactionOptionSupport,
} from "../shared";
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
}

export type PGliteConfig<C extends DriverConfig> = PGliteDriverOptions & C;

// ===  ======================================================
// DRIVER IMPLEMENTATION
// ============================================================

export class PGliteDriver extends Driver<PGlite, Transaction> {
  private static readonly canonicalExecuteEntry =
    PGliteDriver.prototype._execute;
  private static readonly canonicalExecute = PGliteDriver.prototype.execute;

  readonly adapter: DatabaseAdapter;
  readonly maxBindParametersPerStatement: number | undefined = 65_535;
  protected override readonly serializeTransactions = true;

  private readonly driverOptions: PGliteDriverOptions;
  private readonly ownsClient: boolean;
  private readonly canonicalAdapterParseResult: DatabaseAdapter["result"]["parseResult"];

  constructor(options: PGliteDriverOptions = {}) {
    super("postgresql", "pglite");
    this.driverOptions = options;
    this.ownsClient = options.client === undefined;

    if (options.client) {
      this.client = options.client;
    }

    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = options.pgvector === true;
    if (!options.pgvector) adapter.vector = unsupportedVector;
    if (!options.postgis) adapter.geospatial = unsupportedGeospatial;
    this.adapter = adapter;
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

  protected async initClient(): Promise<PGlite> {
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

  protected async closeClient(client: PGlite): Promise<void> {
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
      driver.ownsClient &&
      driver.driverOptions.client === undefined &&
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
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    if (!(client instanceof PGlite)) {
      throw nestedTransactionDispatchError(this.driverName);
    }
    return runProviderManagedTransaction({
      run: (callback) => client.transaction(callback),
      callback: fn,
      close: async () => {
        try {
          await client.close();
        } finally {
          deactivateConsumableResultProducer(this, client);
          this.client = null;
        }
      },
    });
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
    NoExtraDriverConfigKeys<C, PGliteDriverOptions, S> &
    NoExtraNestedConfigKeys<C, S>
): VibORMClient<C & { driver: PGliteDriver }> {
  const { client, dataDir, options, pgvector, postgis, ...restConfig } = config;

  const driver = new PGliteDriver({
    client,
    dataDir,
    options,
    pgvector,
    postgis,
  });

  return createClientFromDriverConfig({
    ...restConfig,
    driver,
  }) as VibORMClient<C & { driver: PGliteDriver }>;
}
