import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchTransactionOptions } from "@drivers/shared/transaction-options";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Sql } from "@sql";
import { updateFamilySchema } from "@tests/contracts/engine/write/update-family-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

const getFamily = usePGliteSchemaFamily(updateFamilySchema);

/** The folded write's shape: it must project through its own RETURNING clause,
 *  because a folded plan has no terminal read left to answer from. */
const FOLDED_UPDATE = /^UPDATE .* RETURNING /;
const FOLDED_DELETE = /^DELETE FROM .* RETURNING /;
const SELECT_STATEMENT = /^SELECT /;

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
  const family = getFamily();
  await family.reset();
  const db = family.database;
  const driver = new CountingBatchOnlyDriver({ client: db });
  const client = createClient({ schema: updateFamilySchema, driver });
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
  // BASELINE UPDATED DELIBERATELY — PLAN Phase 6.2, the batch-mode fold. This
  // cost TWO round trips (a planning locate, then the write batch) because the
  // fold gate required transaction mode. It now costs ONE, which is 6.2's
  // deliverable, so the number moves with it. The STATEMENTS are pinned beside
  // the count: "one round trip" would also be true of an operation that dropped
  // the presence assertion, and the whole point of this shape is that the
  // premise the transaction fold enforces in JS is asserted IN the batch.
  test("a scalar update costs ONE: [presence guard, UPDATE … RETURNING]", async () => {
    const { driver, client } = await seeded();

    await client.user.update({
      where: { email: "root@x" },
      data: { count: 2 },
    });

    expect(driver.roundTrips).toHaveLength(1);
    const [unit] = driver.roundTrips;
    expect(unit?.kind).toBe("batch");
    expect(unit?.statements).toHaveLength(2);
    expect(unit?.statements[0]).toContain("__viborm_assert__");
    expect(unit?.statements[1]).toMatch(FOLDED_UPDATE);
  });

  // BASELINE UPDATED DELIBERATELY — PLAN Phase 6.2, the delete projection of
  // the same fold. Two round trips became one, and the unit is the same pair.
  test("a scalar delete costs ONE: [presence guard, DELETE … RETURNING]", async () => {
    const { driver, client } = await seeded();
    await client.user.delete({ where: { email: "root@x" } });

    expect(driver.roundTrips).toHaveLength(1);
    const [unit] = driver.roundTrips;
    expect(unit?.kind).toBe("batch");
    expect(unit?.statements).toHaveLength(2);
    expect(unit?.statements[0]).toContain("__viborm_assert__");
    expect(unit?.statements[1]).toMatch(FOLDED_DELETE);
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

  // WHY PHASE 6.2 DOES NOT EXTEND HERE — measured, not asserted. The upsert's
  // update arm ALREADY compiles to the shape 6.2 builds for update and delete:
  // `[presence guard, UPDATE … RETURNING]`, no postcondition (`enforceAffected`
  // is a transaction-mode-only conjunct). There is nothing to fold.
  //
  // Its remaining round trip is not the fold's to remove: the planning locate is
  // what DECIDES create-versus-update, and an upsert with no locate has no arm.
  // Decision 7.1's `INSERT … ON CONFLICT DO UPDATE` door is the mechanism that
  // removes it, and this payload is the one the door excludes (conjunct 6 —
  // PostgreSQL calls the bare column reference ambiguous inside `DO UPDATE SET`).
  test("an upsert the door excludes still costs two — its locate picks the arm", async () => {
    const { driver, client } = await seeded();
    await client.user.upsert({
      where: { email: "root@x" },
      create: { email: "root@x", count: 9 },
      update: { count: { increment: 7 } },
    });
    expect(driver.roundTrips).toHaveLength(2);
    expect(driver.roundTrips[0]?.kind).toBe("execute");
    // The atomic unit is already the folded pair — the arm's terminal refetch is
    // gone and the presence premise rides inside the batch.
    const unit = driver.roundTrips[1];
    expect(unit?.kind).toBe("batch");
    expect(unit?.statements).toHaveLength(2);
    expect(unit?.statements[0]).toContain("__viborm_assert__");
    expect(unit?.statements[1]).toMatch(FOLDED_UPDATE);
  });

  test("a conditional skip keeps two trips and pins both decided facts", async () => {
    const { driver, client } = await seeded();

    const result = await client.user.upsert({
      where: { email: "root@x" },
      targetWhere: { count: 999 },
      create: { email: "root@x", count: 9 },
      update: { count: 7 },
      select: { email: true, count: true },
    });

    expect(result).toEqual({ email: "root@x", count: 1 });
    expect(driver.roundTrips).toHaveLength(2);
    expect(driver.roundTrips[0]?.kind).toBe("batch");
    expect(driver.roundTrips[0]?.statements).toHaveLength(2);
    const unit = driver.roundTrips[1];
    expect(unit?.kind).toBe("batch");
    expect(unit?.statements).toHaveLength(3);
    expect(unit?.statements[0]).toContain("CASE WHEN EXISTS");
    expect(unit?.statements[1]).toContain("CASE WHEN NOT EXISTS");
    expect(unit?.statements[2]).toMatch(SELECT_STATEMENT);
  });

  // WHY PHASE 6.2 DOES NOT EXTEND TO `create` EITHER. A scalar create has no
  // planning read at all — there is no premise about an existing row to check —
  // so on this substrate it already costs ONE round trip. Its transaction-mode
  // fold saves a STATEMENT (the terminal refetch), not a round trip, and this
  // phase is about round trips. Pinned so the claim stays measured: if a create
  // ever grows a planning read, this is where it shows up.
  test("a scalar create already costs one round trip", async () => {
    const { driver, client } = await seeded();
    await client.user.create({ data: { email: "fresh@x", count: 4 } });
    expect(driver.roundTrips).toHaveLength(1);
    expect(driver.roundTrips[0]?.kind).toBe("batch");
  });

  // BASELINE UPDATED DELIBERATELY — PLAN Phase 6.1, the level-grouped planning
  // reads. This shape cost FOUR round trips when this file was written: a root
  // locate and two sibling probes, one `_execute` each, then the write batch.
  // It now costs THREE, which is 6.1's deliverable, so the number moves with it
  // rather than the assertion being relaxed. The SHAPE is pinned alongside the
  // count, because "three" would also be true of a plan that lost a probe: the
  // locate still travels alone (a level of one stays on the per-statement path)
  // and the two probes now share one batch.
  test("independent sibling probes share ONE planning round trip", async () => {
    // The two sibling probes below reference nothing but their own unique keys
    // and the located parent, so nothing orders them against EACH OTHER — only
    // a technique-#1 reference orders planning steps, and both of theirs point
    // at the same locate. Same level, one round trip.
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

    expect(driver.roundTrips).toHaveLength(3);
    const planning = planningTrips(driver);
    expect(planning).toHaveLength(2);
    // Level 0 — the root locate, alone, on the per-statement path.
    expect(planning[0]?.kind).toBe("execute");
    expect(planning[0]?.statements).toHaveLength(1);
    // Level 1 — both correlated probes in ONE batch.
    expect(planning[1]?.kind).toBe("batch");
    expect(planning[1]?.statements).toHaveLength(2);
    // ...and one atomic batch carrying every write.
    expect(driver.roundTrips.at(-1)?.kind).toBe("batch");
  });

  // BASELINE UPDATED DELIBERATELY — PLAN Phase 6.1. This shape cost SIX round
  // trips (a locate, four sibling probes one at a time, the write batch). It
  // now costs THREE, and the point of the test is that three is the number for
  // ANY fan-out: the planning cost is one round trip per dependency LEVEL, and
  // adding siblings adds statements to a level, never levels.
  test("the planning cost no longer grows with the fan-out", async () => {
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

    expect(driver.roundTrips).toHaveLength(3);
    const planning = planningTrips(driver);
    expect(planning).toHaveLength(2);
    expect(planning[0]?.statements).toHaveLength(1);
    // Four probes, one batch — this is the entry that would grow again if the
    // grouping were lost.
    expect(planning[1]?.statements).toHaveLength(4);
  });

  // BASELINE UPDATED DELIBERATELY — PLAN Phase 6.1. Two reads at the SAME level
  // rather than one per level: the nested upsert's probe selects its target by
  // the caller's literal id and references nothing the locate produced, so it
  // is level 0 beside the root locate. Three round trips became two.
  test("planning reads that reference nothing of each other's share a level", async () => {
    const { driver, client } = await seeded([40]);

    await client.user.update({
      where: { email: "root@x" },
      data: {
        posts: {
          upsert: [
            {
              where: { id: 40 },
              create: { id: 40, title: "c", slug: "sc" },
              update: { title: "u" },
            },
          ],
        },
      },
    });

    expect(driver.roundTrips).toHaveLength(2);
    const planning = planningTrips(driver);
    expect(planning).toHaveLength(1);
    expect(planning[0]?.kind).toBe("batch");
    expect(planning[0]?.statements).toHaveLength(2);
  });

  // BASELINE UPDATED DELIBERATELY — PLAN Phase 6.2. This is the seam that
  // falsified the plan's own correction: fold to a step carrying a JS
  // postcondition and `compileToEntries` refuses it here, because this path
  // merges several operations into ONE driver batch and a check that runs after
  // the batch returns cannot un-commit the siblings. A working payload would
  // have become a typed refusal, so the count stayed at two.
  //
  // The shipped fold carries no postcondition — its premise is a guard INSIDE
  // the unit — so nothing is deferred past the merge, the seam keeps working,
  // and its planning read is gone: two round trips became one. The RESULT is
  // asserted first and unchanged; that is the half of this test that says the
  // seam still works rather than merely still being cheap.
  test("$transaction([...]) folds the update into the merged batch", async () => {
    const { driver, client } = await seeded();

    const out = await client.$transaction([
      client.user.update({ where: { email: "root@x" }, data: { count: 3 } }),
    ]);

    expect(out).toEqual([{ id: 1, email: "root@x", count: 3 }]);
    expect(driver.roundTrips).toHaveLength(1);
    expect(driver.roundTrips[0]?.kind).toBe("batch");
  });
});
