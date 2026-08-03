import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchTransactionOptions } from "@drivers/shared/transaction-options";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import type { Sql } from "@sql";
import { describe, expect, test } from "vitest";
import { updateFamilySchema } from "./update-family-behavior";

// ---------------------------------------------------------------------------
// PLAN Phase 6 — the measured starting line for "reduce the round trips on
// batch-only drivers (D1, Neon HTTP)".
//
// On those drivers every call that reaches a driver execution seam is one HTTP
// request, so the unit that matters is the NUMBER OF CALLS, not the number of
// statements. The compiled writes already ride one atomic batch; the planning
// reads do not — `OperationExecutor.buildAtomicPlan` runs them through the
// linear executor, one `_execute` each.
//
// This file pins those counts. It is a measurement harness, not a claim that
// the counts are right: Phase 6 exists to lower them, and every number below is
// a target. A change that lowers one must update the number here deliberately,
// and a change that RAISES one is a regression this file exists to catch.
//
// The numbers were taken on the batch-only PGlite stand-in (the same one
// `tests/drivers/pglite.test.ts` uses for D1 / Neon HTTP) at the commit that
// introduced this file.
// ---------------------------------------------------------------------------

/**
 * The batch-only stand-in for D1 / Neon HTTP, recording every call that reaches
 * a driver execution seam. `_execute` and `_executeBatch` are the two seams;
 * each recorded entry is one round trip.
 */
class CountingBatchOnlyDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  roundTrips: Array<{ kind: "execute" | "batch"; statements: string[] }> = [];

  override _execute<T>(
    statement: Sql,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.roundTrips.push({
      kind: "execute",
      statements: [statement.strings.join("?")],
    });
    return super._execute<T>(statement, context);
  }

  override _executeBatch<T>(
    queries: BatchQuery[],
    options?: BatchTransactionOptions,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    this.roundTrips.push({
      kind: "batch",
      statements: queries.map((query) => query.sql),
    });
    return super._executeBatch<T>(queries, options, context);
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

async function seeded(postIds: number[] = []): Promise<{
  driver: CountingBatchOnlyDriver;
  client: any;
}> {
  const db = new PGlite();
  const driver = new CountingBatchOnlyDriver({ client: db });
  const client = createClient({ schema: updateFamilySchema, driver });
  await push(client, { force: true });
  await client.user.create({ data: { email: "root@x", count: 1 } });
  for (const id of postIds) {
    await client.post.create({
      data: { id, title: `t${id}`, slug: `s${id}`, userId: 1 },
    });
  }
  driver.roundTrips = [];
  return { driver, client };
}

/** Every planning read the operation sent before its one atomic write batch. */
function planningTrips(driver: CountingBatchOnlyDriver) {
  return driver.roundTrips.slice(0, -1);
}

describe("PLAN Phase 6 baseline — round trips on a batch-only driver", () => {
  test("a scalar update costs two: one planning locate, then the write batch", async () => {
    const { driver, client } = await seeded();

    await client.user.update({
      where: { email: "root@x" },
      data: { count: 2 },
    });

    // Phase 6.2's target is ONE: the fold gates require transaction mode, so a
    // batch-only driver plans-then-executes where a single
    // `UPDATE … RETURNING` would do.
    expect(driver.roundTrips).toHaveLength(2);
    expect(driver.roundTrips[0]?.kind).toBe("execute");
    expect(driver.roundTrips[1]?.kind).toBe("batch");
  });

  test("a scalar delete costs two", async () => {
    const { driver, client } = await seeded();
    await client.user.delete({ where: { email: "root@x" } });
    expect(driver.roundTrips).toHaveLength(2);
  });

  // BASELINE UPDATED DELIBERATELY — PLAN Decision 7.1, the ON CONFLICT door.
  // This shape cost two round trips (a planning locate, then the write batch)
  // when this file was written for Phase 6. It now costs ONE: the whole upsert is
  // a single `INSERT … ON CONFLICT ("email") DO UPDATE … RETURNING`, with empty
  // planning and no batch envelope at all. That is this decision's deliverable,
  // so the number moves with it rather than the assertion being relaxed — the
  // KIND is pinned too, because "one round trip" would also be true of a broken
  // operation that planned nothing and wrote nothing.
  test("a scalar upsert costs ONE — the folded statement, not a batch", async () => {
    const { driver, client } = await seeded();
    await client.user.upsert({
      where: { email: "root@x" },
      create: { email: "root@x", count: 9 },
      update: { count: 7 },
    });
    expect(driver.roundTrips).toHaveLength(1);
    expect(driver.roundTrips[0]?.kind).toBe("execute");
  });

  test("an upsert the door excludes still costs two", async () => {
    // The same shape with atomic arithmetic in the update payload: conjunct 6
    // declines it (PostgreSQL calls the bare column reference ambiguous inside
    // `DO UPDATE SET`), so the Phase 6 baseline above still describes it.
    const { driver, client } = await seeded();
    await client.user.upsert({
      where: { email: "root@x" },
      create: { email: "root@x", count: 9 },
      update: { count: { increment: 7 } },
    });
    expect(driver.roundTrips).toHaveLength(2);
    expect(driver.roundTrips[0]?.kind).toBe("execute");
    expect(driver.roundTrips[1]?.kind).toBe("batch");
  });

  test("planning reads are SEQUENTIAL: one round trip per read", async () => {
    // Phase 6.1's target. The two sibling probes below reference nothing but
    // their own unique keys, so nothing orders them against each other — only a
    // technique-#1 reference orders planning steps — yet each costs its own
    // round trip.
    const { driver, client } = await seeded([20, 21]);

    await client.user.update({
      where: { email: "root@x" },
      data: {
        count: 5,
        posts: {
          update: [
            { where: { id: 20 }, data: { title: "a2" } },
            { where: { id: 21 }, data: { title: "b2" } },
          ],
        },
      },
    });

    expect(driver.roundTrips).toHaveLength(4);
    // Three separate planning reads, none of them batched together.
    const planning = planningTrips(driver);
    expect(planning).toHaveLength(3);
    for (const trip of planning) {
      expect(trip.kind).toBe("execute");
    }
    // ...and one atomic batch carrying every write.
    expect(driver.roundTrips.at(-1)?.kind).toBe("batch");
  });

  test("the planning cost grows with the fan-out, one read at a time", async () => {
    const { driver, client } = await seeded([30, 31, 32, 33]);

    await client.user.update({
      where: { email: "root@x" },
      data: {
        posts: {
          update: [30, 31, 32, 33].map((id) => ({
            where: { id },
            data: { title: `w${id}` },
          })),
        },
      },
    });

    // One root locate + four sibling probes + one write batch. Grouping the
    // probes by dependency level would make this three whatever the fan-out.
    expect(driver.roundTrips).toHaveLength(6);
    expect(planningTrips(driver)).toHaveLength(5);
  });

  test("$transaction([...]) merges the write batch but not the planning read", async () => {
    // The seam Phase 6.2 has to keep working. A folded single-statement
    // operation carries a JS postcondition, and `compileToEntries` refuses one
    // — a postcondition cannot abort a merged batch that has already committed,
    // so a fold here would turn this working payload into a typed refusal.
    const { driver, client } = await seeded();

    const out = await client.$transaction([
      client.user.update({ where: { email: "root@x" }, data: { count: 3 } }),
    ]);

    expect(out).toEqual([{ id: 1, email: "root@x", count: 3 }]);
    expect(driver.roundTrips).toHaveLength(2);
  });
});
