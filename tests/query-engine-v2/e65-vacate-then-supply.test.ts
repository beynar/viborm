import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import {
  registerVacateThenSupplyBehavior,
  vacateThenSupplySchema,
} from "./e65-vacate-then-supply-behavior";

/**
 * E6.5 on both substrates, plus the half only this file can state: the PARENT-HELD
 * direction keeps the pair refused, and the measurement that says why.
 */

class BatchOnlyPGliteDriver extends PGliteDriver {
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
  let shared: any;
  registerVacateThenSupplyBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: vacateThenSupplySchema,
        driver: substrate.make(new PGlite()),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}

/**
 * The PARENT-HELD twin of the same payload. It stays refused, and the reason is this
 * direction's write shape rather than the payload's meaning: `delete` NULLs the
 * parent's own foreign key in a post-root write, which lands AFTER the supplier's
 * rebind has been folded into the root SET. Lifting the guard here was measured to
 * insert the fresh row and then ORPHAN it.
 */
const parentHeldSchema = (() => {
  const depot = s
    .model({
      id: s.string().id(),
      note: s.string(),
      stations: s.oneToMany(() => station),
    })
    .map("e65p_depots");

  const station = s
    .model({
      id: s.string().id(),
      label: s.string(),
      depotId: s.string().nullable(),
      depot: s
        .manyToOne(() => depot)
        .fields("depotId")
        .references("id")
        .optional(),
    })
    .map("e65p_stations");

  return { depot, station };
})();

describe("E6.5 the parent-held direction keeps the pair refused", () => {
  test("delete + create still refuses, and writes nothing", async () => {
    const db = new PGlite();
    const client = createClient({
      schema: parentHeldSchema,
      driver: new PGliteDriver({ client: db }),
    }) as any;
    await push(client, { force: true });
    await client.depot.create({ data: { id: "d1", note: "incumbent" } });
    await client.station.create({
      data: { id: "s1", label: "L", depotId: "d1" },
    });

    await expect(
      client.station.update({
        where: { id: "s1" },
        data: {
          depot: { delete: true, create: { id: "d-new", note: "fresh" } },
        },
      })
    ).rejects.toThrow(
      "query-engine-v2 update supports one mutation kind on the to-one relation 'depot'; it has delete, create."
    );

    // Construction-time: nothing ran.
    expect(
      await client.station.findUnique({ where: { id: "s1" } })
    ).toMatchObject({ depotId: "d1" });
    expect(
      (await client.depot.findMany({ orderBy: { id: "asc" } })).map(
        (row: any) => row.id
      )
    ).toEqual(["d1"]);
    await client.$disconnect();
  }, 30_000);
});
