import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import type { AnyDriver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import type { Schema } from "@client/types";
import type { ProviderFixture } from "@tests/contracts/contract";
import { afterAll, beforeAll, beforeEach } from "vitest";

/**
 * Exercises the atomic-batch execution substrate with PostgreSQL semantics.
 * The transaction is an implementation detail of the PGlite stand-in; VibORM
 * sees a batch-only driver and must compile the complete write before I/O.
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
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
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

/** One database, one schema push, and one owner disconnect for a PGlite suite. */
export function usePGliteSchemaFamily<const S extends Schema>(
  schema: S,
  mode: "transaction" | "atomicBatch" = "transaction"
): () => PGliteSchemaFamily<S> {
  let family: PGliteSchemaFamily<S> | undefined;

  beforeAll(async () => {
    const database = new PGlite();
    const driver =
      mode === "transaction"
        ? new PGliteDriver({ client: database })
        : new BatchOnlyPGliteDriver({ client: database });
    const client = createClient({ schema, driver });
    await push(client, { force: true });
    const tables = await client.$queryRawUnsafe<PublicTable>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
    );
    const truncateStatement =
      tables.length === 0
        ? undefined
        : `TRUNCATE TABLE ${tables
            .map(({ tablename }) => quoteIdentifier(tablename))
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
  });

  beforeEach(async () => {
    if (!family) throw new Error("PGlite schema family was not provisioned");
    await family.reset();
  });

  afterAll(async () => {
    if (family) await family.client.$disconnect();
    family = undefined;
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
      throw new Error("An isolated behavior database requires a driver factory");
    }
    const driver = source.createDriver();
    const stateDriver = source.createStateDriver?.() ?? driver;
    const client = createClient({ schema, driver: stateDriver });
    await push(client, { force: true });
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
      dispose: async () => {},
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
