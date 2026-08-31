import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  parentHeldCompoundEdgeSchema,
  registerParentHeldCompoundEdgeBehavior,
  resetParentHeldCompoundEdge,
} from "@tests/contracts/engine/write/parent-held-compound-edge-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * Rewrites ONE column of the rows the station LOCATE read returns, after the database
 * answered and before the engine consumes it. Armed once, and only for a read of the
 * station table, so the depot probe that follows sees the corrupted correlation.
 */
class CorruptStationLocateDriver extends PGliteDriver {
  private readonly column: string;
  private readonly wrongValue: unknown;
  private armed = true;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    config: { column: string; wrongValue: unknown }
  ) {
    super(options);
    this.column = config.column;
    this.wrongValue = config.wrongValue;
  }

  private corrupt<T>(sql: string, result: QueryResult<T>): QueryResult<T> {
    const isLocate =
      this.armed &&
      sql.startsWith("SELECT") &&
      sql.includes("e64_stations") &&
      result.rows.length > 0;
    if (!isLocate) return result;
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map((row) => {
        const next = { ...(row as Record<string, unknown>) };
        next[this.column] = this.wrongValue;
        return next as T;
      }),
    };
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.execute<T>(client, sql, params, context)
    );
  }

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.executeRaw<T>(client, sql, params, context)
    );
  }
}

async function setup(driver: PGliteDriver) {
  const client = createClient({
    schema: parentHeldCompoundEdgeSchema,
    driver,
  }) as any;
  await syncLiveSchema(client);
  return client;
}

const substrates = [
  {
    name: "transaction",
    make: (db: PGlite) => new PGliteDriver({ client: db }),
  },
  {
    name: "atomic batch",
    make: (db: PGlite) => new BatchOnlyPGliteDriver({ client: db }),
  },
] as const;

for (const substrate of substrates) {
  // One client per leg: the schema is migrated once and each test reseeds.
  let shared: any;
  registerParentHeldCompoundEdgeBehavior(substrate.name, async () => {
    shared ??= await setup(substrate.make(openBorrowedPGlite()));
    return shared;
  });
}

describe("E6.4 the correlation's provenance is the LOCATED row, per member", () => {
  for (const substrate of substrates) {
    test(`corrupting ONE member moves the write to the twin that member names (${substrate.name})`, async () => {
      const db = openBorrowedPGlite();
      const stateClient = await setup(new PGliteDriver({ client: db }));
      await resetParentHeldCompoundEdge(stateClient);
      await stateClient.depot.create({
        data: { id: "d-target", region: "eu", code: "west", note: "before" },
      });
      // The live row the CORRUPTED tuple (region "us", code "west") names. It agrees
      // with the target on the code alone, so nothing but a per-member correlation
      // taken from the located row can land here.
      await stateClient.depot.create({
        data: { id: "d-code-twin", region: "us", code: "west", note: "before" },
      });
      await stateClient.station.create({
        data: { id: "s1", label: "L", depotRegion: "eu", depotCode: "west" },
      });

      const client = createClient({
        schema: parentHeldCompoundEdgeSchema,
        driver: substrate.make(db),
      }) as any;
      // Re-wrap: the corrupting driver must be the one that runs the operation.
      const corrupting = new CorruptStationLocateDriver(
        { client: db },
        { column: "depotRegion", wrongValue: "us" }
      );
      const corruptingClient = createClient({
        schema: parentHeldCompoundEdgeSchema,
        driver:
          substrate.name === "atomic batch"
            ? Object.assign(corrupting, {
                supportsTransactions: false,
                supportsBatch: true,
              })
            : corrupting,
      }) as any;

      await corruptingClient.station.update({
        where: { id: "s1" },
        data: { depot: { update: { note: "followed-the-located-row" } } },
      });

      const rows = await client.depot.findMany({ orderBy: { id: "asc" } });
      const notes = Object.fromEntries(
        rows.map((row: any) => [row.id, row.note])
      );
      // THE CLAIM: the arm followed the CORRUPTED located value, per member.
      expect(notes["d-code-twin"]).toBe("followed-the-located-row");
      expect(notes["d-target"]).toBe("before");
      await closeTestPGlite(db);
    });
  }
});
