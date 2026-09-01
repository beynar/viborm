import { createClient } from "@client/client";
import type { Schema } from "@client/types";
import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { isVerbatimBatchQuery } from "@drivers/driver-batch-query-kind";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import type { ProviderFixture } from "@tests/contracts/contract";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Exercises the batch-only execution substrate with PostgreSQL semantics.
 * Each submitted batch is atomic. VibORM may submit ordered batches when a
 * default operation must materialize a generated output; the PGlite transaction
 * below is the implementation of each batch, not an operation-wide transaction.
 */
export class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        const result = isVerbatimBatchQuery(query)
          ? await this.executeRaw<T>(
              transaction,
              query.sql,
              query.params,
              query.context
            )
          : await this.execute<T>(
              transaction,
              query.sql,
              query.params ?? [],
              query.context
            );
        results.push(result);
      }
      return results;
    });
  }
}

export function createInMemoryPGliteDriver(): PGliteDriver {
  return new PGliteDriver();
}

export type BehaviorDatabaseSource =
  | {
      readonly pgliteMode: "transaction" | "atomicBatch";
      readonly createDriver?: never;
      readonly createStateDriver?: never;
    }
  | {
      readonly pgliteMode?: never;
      readonly createDriver: () => AnyDriver;
      readonly createStateDriver?: () => AnyDriver;
    };

interface PublicTable {
  readonly tablename: string;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

type SchemaClient<S extends Schema> = ReturnType<
  typeof createClient<S, { schema: S; driver: AnyDriver }>
>;

export interface PGliteSchemaFamily<S extends Schema> {
  readonly database: PGlite;
  readonly driver: PGliteDriver;
  readonly client: SchemaClient<S>;
  readonly reset: () => Promise<void>;
}

/**
 * ONE PGlite per worker process, shared by every suite that uses this fixture,
 * with a private Postgres schema per suite.
 *
 * A PGlite instance is a whole Postgres compiled to Wasm and costs a measured
 * ~1.3 GiB. Creating one PER SUITE meant a process could hold only one suite,
 * which is why the credential-free estate ran as ~209 single-file processes and
 * took ~40 minutes. The database is the expensive thing; a schema is nearly
 * free, and the driver already qualifies every table with its `namespace`, so
 * suites isolate perfectly well inside one instance.
 *
 * A suite that must NOT share - one that condemns its session, manipulates
 * schemas directly, or asserts cluster-global state - should keep building its
 * own `new PGlite()` instead of using this fixture.
 */
let workerDatabase: PGlite | undefined;
let suiteCounter = 0;

function sharedWorkerDatabase(): PGlite {
  workerDatabase ??= new PGlite();
  return workerDatabase;
}

/** One shared database, one private schema, one reset per test. */
export function usePGliteSchemaFamily<const S extends Schema>(
  schema: S,
  mode: "transaction" | "atomicBatch" = "transaction"
): () => PGliteSchemaFamily<S> {
  let family: PGliteSchemaFamily<S> | undefined;

  let namespace: string;

  beforeAll(async () => {
    const database = sharedWorkerDatabase();
    suiteCounter += 1;
    namespace = `suite_${suiteCounter}`;
    await database.query(`CREATE SCHEMA ${quoteIdentifier(namespace)}`);
    const driver =
      mode === "transaction"
        ? new PGliteDriver({ client: database, namespace })
        : new BatchOnlyPGliteDriver({ client: database, namespace });
    const client = createClient({ schema, driver });
    try {
      await syncLiveSchema(client);
      const tables = await client.$queryRawUnsafe<PublicTable>(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
        namespace
      );
      const truncateStatement =
        tables.length === 0
          ? undefined
          : `TRUNCATE TABLE ${tables
              .map(
                ({ tablename }) =>
                  `${quoteIdentifier(namespace)}.${quoteIdentifier(tablename)}`
              )
              .join(", ")} RESTART IDENTITY`;
      family = {
        database,
        driver,
        client,
        reset: async () => {
          if (truncateStatement) {
            await client.$executeRawUnsafe(truncateStatement);
          }
        },
      };
    } catch (setupError) {
      const failures = [setupError];
      try {
        await client.$disconnect();
      } catch (disconnectError) {
        failures.push(disconnectError);
      }
      try {
        await database.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`
        );
      } catch (closeError) {
        failures.push(closeError);
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "PGlite behavior database setup and cleanup failed"
        );
      }
      throw setupError;
    }
  });

  beforeEach(async () => {
    if (!family) throw new Error("PGlite schema family was not provisioned");
    await family.reset();
  });

  afterAll(async () => {
    const current = family;
    family = undefined;
    if (!current) return;

    const failures: unknown[] = [];
    try {
      await current.client.$disconnect();
    } catch (disconnectError) {
      failures.push(disconnectError);
    }
    // Drop the SCHEMA, not the database. The instance belongs to the worker and
    // serves every later suite in this process; closing it here would put the
    // cost straight back.
    try {
      await current.database.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`
      );
    } catch (closeError) {
      failures.push(closeError);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "PGlite behavior database cleanup failed"
      );
    }
  });

  return () => {
    if (!family) throw new Error("PGlite schema family was not provisioned");
    return family;
  };
}

/**
 * Owns one provisioned database for one PGlite schema and execution substrate.
 * Test cases get empty tables and reset identities, while the schema and
 * Wasm-backed database survive for the complete suite.
 */
export function useBehaviorDatabase<const S extends Schema>(
  schema: S,
  source: BehaviorDatabaseSource
) {
  interface OpenDatabase {
    readonly driver: AnyDriver;
    readonly client: SchemaClient<S>;
    readonly dispose: () => Promise<void>;
  }

  const openIsolated = async (): Promise<OpenDatabase> => {
    if (!source.createDriver) {
      throw new Error(
        "An isolated behavior database requires a driver factory"
      );
    }
    const driver = source.createDriver();
    const stateDriver = source.createStateDriver?.() ?? driver;
    const client = createClient({ schema, driver: stateDriver });
    try {
      await syncLiveSchema(client);
    } catch (setupError) {
      const cleanup = await Promise.allSettled([
        client.$disconnect(),
        ...(driver === stateDriver ? [] : [driver.disconnect()]),
      ]);
      const cleanupErrors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [setupError, ...cleanupErrors],
          "Behavior database setup and cleanup failed"
        );
      }
      throw setupError;
    }
    return {
      driver,
      client,
      dispose: async () => {
        await client.$disconnect();
        if (driver !== stateDriver) await driver.disconnect();
      },
    };
  };

  if (source.pgliteMode === undefined) return openIsolated;

  const getFamily = usePGliteSchemaFamily(schema, source.pgliteMode);

  return async (): Promise<OpenDatabase> => {
    const shared = getFamily();
    return {
      driver: shared.driver,
      client: shared.client,
      dispose: async () => {
        // The shared schema family owns the connection lifecycle.
      },
    };
  };
}

export const pgliteProviderFixture: ProviderFixture<PGliteDriver> = {
  id: "pglite",
  dialect: "postgresql",
  runtime: "node",
  capabilities: new Set([
    "sql-execution",
    "transactions",
    "atomic-batch",
    "returning",
    "ddl",
    "vector",
  ]),
  availability: () => ({ available: true }),
  createDriver: createInMemoryPGliteDriver,
  dispose: (driver) => driver.disconnect(),
};
