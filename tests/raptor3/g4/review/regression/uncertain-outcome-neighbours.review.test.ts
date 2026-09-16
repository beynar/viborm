/**
 * G4 regression INDEPENDENT REVIEW probes — neighbours of the repaired rule.
 *
 * The repair narrows `OperationContext.failure()`
 * (`src/query-engine/raptor3/shared/operation-context.ts:347-372`) so an
 * UNCERTAIN outcome is published as `recordSeriesProgress` only when the
 * failing member is NOT the operation's own set-oriented statement window
 * (`setWindow`, :100-113, named by `setMutations` :1009-1010).
 *
 * These probes measure shapes the unit's own two cells do not reach, on the
 * same batch-only transport and the same before-dispatch fault as the
 * `sqlite-atomic-batch` harness world (`tests/raptor3/harness/sqlite-world.ts`),
 * comparing the SHIPPED client route with the CANDIDATE client route.
 *
 * First measured on `operation-context.ts`
 * `ff8b6b47f2977ada73c9ede8131c7ee7a6630477b8622941c81627756d5cf069`;
 * re-measured after the SEAM round on
 * `46060d8cb2838d3ce6c83d76ae0be91f37e811718c42be417a7fc9946c6736e0`
 * (only P7 changed, and only its expectation — see its docblock):
 *
 *  - P1/P2/P3 — root `update`, a nested write inside a root `create`, and a
 *    `$transaction([...])` member: byte-identical published failures.
 *    Reverting the repaired branch turns P1 red (it publishes
 *    `recordSeriesProgress` again), so P1 is a second falsifier for the rule
 *    on a verb the unit's cells never exercise.
 *  - P4/P5/P6 — the relation-free bulk verbs, which reach `setMutations` the
 *    same way the folded root write does: no `recordSeriesProgress` on either
 *    engine (the repair agrees with shipped), and the ONLY remaining
 *    difference is the driver-seam `statementIndex: 0` recorded as the §4
 *    blocker of `g4/regression/note.md`. The blocker therefore reaches three
 *    more verbs than the note states.
 *  - P7 — the cache-invalidation consequence of the repair. Round 1 measured
 *    the regression it caused (shipped 1, candidate 0) because the route
 *    inferred the fact from the progress the repair removed; after the SEAM
 *    round the transport states it itself
 *    (`shared/operation-context.ts` `WriteOutcomeSeam`, `submit()`), so this
 *    probe now pins the parity: 1 on both routes.
 *  - P8 — the same folded root write whose segment DID commit and whose result
 *    is malformed still publishes record-series progress on the candidate and
 *    none on shipped (the surviving `committedSegments > 0` arm, pinned by
 *    `tests/raptor3/post-prep/g29-result-progress.test.ts`), so the repaired
 *    rule's sentence — "a set-oriented statement has no series to report" —
 *    holds only for the uncertain arm.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { VibORMError } from "@errors";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

/** The harness fault of `tests/raptor3/harness/sqlite-world.ts:78-91`. */
class BeforeDispatchDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  failuresBeforeDispatch = 0;
  /** Statements that dispatch normally before the fault is allowed to fire. */
  dispatchesBeforeFault = 0;
  dispatched = 0;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    if (this.failuresBeforeDispatch > 0 && this.dispatchesBeforeFault === 0) {
      this.failuresBeforeDispatch--;
      throw new Error("Controlled failure before dispatch");
    }
    if (this.dispatchesBeforeFault > 0) this.dispatchesBeforeFault--;
    this.dispatched++;
    return super.execute<T>(client, statement, parameters);
  }
}

/**
 * The G2.9 malformed-result cut, stated over ANY row-bearing response so that
 * it reaches the shipped statement path AND the candidate's batch.
 */
function corruptIds<T>(response: QueryResult<T>): boolean {
  let corrupted = false;
  for (const row of response.rows) {
    if (typeof row !== "object" || row === null) continue;
    if (!("id" in row)) continue;
    Reflect.set(row, "id", "not-an-integer");
    corrupted = true;
  }
  return corrupted;
}

class CorruptingDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  armed = false;
  corrupted = false;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(client, statement, parameters);
    if (this.armed && corruptIds(response)) this.corrupted = true;
    return response;
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const responses = await this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
    if (this.armed) {
      for (const response of responses) {
        if (corruptIds(response)) this.corrupted = true;
      }
    }
    return responses;
  }
}

class RecordingCache extends MemoryCache {
  readonly invalidations: string[] = [];

  protected override async clear(prefix: string): Promise<void> {
    this.invalidations.push(`clear:${prefix}`);
    return super.clear(prefix);
  }
}

const owner = s
  .model({
    id: s.int().id(),
    label: s.string().map("owner_label"),
    notes: s.toMany(() => note),
  })
  .map("g4rev_reg_owners");
const note = s
  .model({
    id: s.int().id().increment(),
    body: s.string(),
    ownerId: s.int().nullable().map("owner_id"),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map("g4rev_reg_notes");
const schema = { owner, note };

type AnyWorldDriver = BeforeDispatchDriver | CorruptingDriver;

interface World<D extends AnyWorldDriver> {
  readonly client: VibORMClient<{ driver: D; schema: typeof schema }>;
  readonly database: Database.Database;
  readonly driver: D;
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function createWorld<D extends AnyWorldDriver>(
  route: "shipped" | "candidate",
  driver: D
): Promise<World<D>> {
  const database = (driver as unknown as { client: Database.Database }).client;
  const config = { driver, schema };
  const client = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as World<D>["client"];
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, database, driver };
}

/** The published failure, minus the per-execution identity. */
function identity(failure: unknown): {
  code: string;
  meta: Record<string, unknown>;
  name: string;
} {
  assert.ok(
    failure instanceof VibORMError,
    `not a VibORMError: ${String(failure)}`
  );
  const { correlationId: _id, ...meta } = failure.meta as Record<
    string,
    unknown
  >;
  return { code: failure.code, meta, name: failure.name };
}

interface Observation {
  readonly failure: ReturnType<typeof identity>;
  readonly notes: unknown[];
  readonly owners: unknown[];
  readonly value: unknown;
}

async function observe(
  route: "shipped" | "candidate",
  drive: (world: World<BeforeDispatchDriver>) => PromiseLike<unknown>,
  dispatchesBeforeFault = 0
): Promise<Observation> {
  const database = new Database(":memory:");
  const world = await createWorld(
    route,
    new BeforeDispatchDriver({ client: database })
  );
  await world.client.owner.create({ data: { id: 7, label: "seed" } });
  world.driver.dispatchesBeforeFault = dispatchesBeforeFault;
  world.driver.failuresBeforeDispatch = 1;
  let failure: unknown;
  let value: unknown;
  try {
    value = await drive(world);
  } catch (error) {
    failure = error;
  }
  world.driver.failuresBeforeDispatch = 0;
  return {
    failure: identity(failure),
    notes: world.database
      .prepare("SELECT id, body FROM g4rev_reg_notes ORDER BY id")
      .all(),
    owners: world.database
      .prepare("SELECT id, owner_label FROM g4rev_reg_owners ORDER BY id")
      .all(),
    value,
  };
}

async function differential(
  drive: (world: World<BeforeDispatchDriver>) => PromiseLike<unknown>,
  dispatchesBeforeFault = 0
): Promise<{ candidate: Observation; shipped: Observation }> {
  return {
    shipped: await observe("shipped", drive, dispatchesBeforeFault),
    candidate: await observe("candidate", drive, dispatchesBeforeFault),
  };
}

function report(label: string, pair: object): string {
  return `${label} ${JSON.stringify(pair, undefined, 2)}`;
}

describe("G4 regression review — neighbouring uncertain-outcome shapes", () => {
  it("P1 a root update rejected before dispatch answers the shipped failure", async () => {
    // INVERTED AT THE D-7 ROUND (review 3). Rounds 1 and 2 measured the two
    // engines answering identically here, because the candidate's ONE-statement
    // fold was wrapped in a batch and the driver seam gave it the shipped
    // engine's `statementIndex: 0` by coincidence. D-7 takes the batch away, and
    // the shipped root `update`/`delete` fold really is two statements
    // (`[presence guard, mutation … RETURNING]`), so it keeps the index while
    // the candidate's JavaScript postcondition has none. That is blocker D-7.1
    // (`g4/regression/note.md` §D.6, author cell 7), recorded here as measured;
    // the pre-D-7 equality is in `g4/regression-review.md`.
    const { shipped, candidate } = await differential((world) =>
      world.client.owner.update({ data: { label: "moved" }, where: { id: 7 } })
    );
    assert.equal(shipped.failure.meta.recordSeriesProgress, undefined);
    assert.equal(
      shipped.failure.meta.statementIndex,
      0,
      report("P1 shipped batches a presence guard", { candidate, shipped })
    );
    assert.equal(
      candidate.failure.meta.statementIndex,
      undefined,
      report("P1 candidate D-7.1", { candidate, shipped })
    );
    assert.deepEqual(
      {
        ...candidate,
        failure: { ...candidate.failure, meta: { ...candidate.failure.meta, statementIndex: undefined } },
      },
      {
        ...shipped,
        failure: { ...shipped.failure, meta: { ...shipped.failure.meta, statementIndex: undefined } },
      },
      report("P1 nothing else diverges", { candidate, shipped })
    );
  });

  it("P2 a nested write inside a root create rejected before dispatch answers the shipped failure", async () => {
    const { shipped, candidate } = await differential((world) =>
      world.client.owner.create({
        data: { id: 8, label: "nested", notes: { create: [{ body: "n" }] } },
      })
    );
    assert.equal(shipped.failure.meta.recordSeriesProgress, undefined);
    assert.deepEqual(candidate, shipped, report("P2", { candidate, shipped }));
  });

  it("P3 an array member rejected before dispatch answers the shipped failure", async () => {
    const { shipped, candidate } = await differential((world) =>
      (
        world.client as unknown as {
          $transaction(
            members: readonly PromiseLike<unknown>[]
          ): Promise<unknown>;
        }
      ).$transaction([
        world.client.owner.create({ data: { id: 9, label: "a" } }),
        world.client.owner.create({ data: { id: 10, label: "b" } }),
      ])
    );
    assert.equal(shipped.failure.meta.recordSeriesProgress, undefined);
    assert.deepEqual(candidate, shipped, report("P3", { candidate, shipped }));
  });

  /**
   * P4-P6: the relation-free bulk verbs reach `setMutations` exactly as the
   * folded root write does. MEASURED: neither engine publishes
   * `recordSeriesProgress`, and the single remaining difference is the
   * one-statement-batch `statementIndex` of `driver-diagnostics.ts:35-36` —
   * the §4 blocker, here on three verbs the note does not name.
   */
  for (const bulk of [
    {
      drive: (world: World<BeforeDispatchDriver>) =>
        world.client.owner.createMany({
          data: [
            { id: 11, label: "a" },
            { id: 12, label: "b" },
          ],
        }),
      name: "P4 createMany",
    },
    {
      drive: (world: World<BeforeDispatchDriver>) =>
        world.client.owner.updateMany({
          data: { label: "bulk" },
          where: { id: 7 },
        }),
      name: "P5 updateMany",
    },
    {
      drive: (world: World<BeforeDispatchDriver>) =>
        world.client.owner.deleteMany({ where: { id: 7 } }),
      name: "P6 deleteMany",
    },
  ]) {
    it(`${bulk.name} rejected before dispatch publishes no progress on either engine`, async () => {
      const { shipped, candidate } = await differential(bulk.drive);
      assert.equal(shipped.failure.meta.recordSeriesProgress, undefined);
      assert.equal(candidate.failure.meta.recordSeriesProgress, undefined);
      assert.equal(shipped.failure.meta.statementIndex, undefined);
      // INVERTED AT THE D-7 ROUND (review 3). Rounds 1 and 2 pinned the blocker
      // here — the candidate answered `statementIndex: 0` where shipped answers
      // none, on all three relation-free bulk verbs. D-7 removes the
      // one-statement batch that produced it, so the two now agree field for
      // field. Restoring the batch envelope for a lone statement reddens this.
      assert.equal(
        candidate.failure.meta.statementIndex,
        undefined,
        report(bulk.name, { candidate, shipped })
      );
      assert.deepEqual(
        candidate.failure.meta,
        shipped.failure.meta,
        report(bulk.name, { candidate, shipped })
      );
      assert.deepEqual(candidate.owners, shipped.owners);
      assert.deepEqual(candidate.notes, shipped.notes);
    });
  }

  /**
   * P7: the cache seam. The shipped executor calls `writeMayBeVisible` itself
   * (`OperationExecutor.ts:1052-1058`).
   *
   * REVIEW ROUND 1 pinned the DEFECT here — the candidate route inferred the
   * fact from the PUBLISHED progress the repair had just removed, so it
   * invalidated 0 against shipped's 1 (finding 1, blocking). The SEAM ROUND
   * moved the fact to its owner (`OperationContext.submit` →
   * `ExecutionBinding.writeOutcome`), so the probe is inverted here to the
   * repaired expectation: 1 on both routes. Disabling the context's
   * notification returns it to candidate 0, which is the falsifier.
   */
  it("P7 an uncertain root create invalidates the cache on both routes", async () => {
    const observeInvalidation = async (route: "shipped" | "candidate") => {
      const database = new Database(":memory:");
      const driver = new BeforeDispatchDriver({ client: database });
      const world = await createWorld(route, driver);
      const cacheDriver = new RecordingCache();
      const background: Promise<unknown>[] = [];
      const client = world.client.$extends(
        cache({
          driver: cacheDriver,
          waitUntil(promise) {
            background.push(promise);
          },
        })
      );
      driver.failuresBeforeDispatch = 1;
      let failure: unknown;
      try {
        await client.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 21, label: "uncertain" },
        });
      } catch (error) {
        failure = error;
      }
      driver.failuresBeforeDispatch = 0;
      await Promise.allSettled(background.splice(0));
      return {
        invalidations: cacheDriver.invalidations.length,
        rejected: identity(failure).name,
      };
    };
    const shipped = await observeInvalidation("shipped");
    const candidate = await observeInvalidation("candidate");
    assert.equal(candidate.rejected, shipped.rejected);
    // MEASURED on the seam-round tree: both engines invalidate for an outcome
    // neither can prove rolled back, each from the transport that learned it.
    assert.equal(shipped.invalidations, 1, JSON.stringify({ shipped }));
    assert.equal(
      candidate.invalidations,
      1,
      report("P7", { candidate, shipped })
    );
  });

  /**
   * P8: the surviving `committedSegments > 0` arm. The same folded root write,
   * committed and then decoded from a malformed row, still publishes
   * record-series progress on the candidate — `committedWriteMembers: 1` for
   * the very window the repair calls "not a member".
   */
  it("P8 a committed set window with a malformed result still publishes progress on the candidate only", async () => {
    const observeMalformed = async (route: "shipped" | "candidate") => {
      const database = new Database(":memory:");
      const driver = new CorruptingDriver({ client: database });
      const world = await createWorld(route, driver);
      driver.armed = true;
      let failure: unknown;
      try {
        await world.client.owner.create({ data: { id: 31, label: "written" } });
      } catch (error) {
        failure = error;
      }
      driver.armed = false;
      return {
        corrupted: driver.corrupted,
        failure: identity(failure),
        stored: database
          .prepare("SELECT id, owner_label FROM g4rev_reg_owners ORDER BY id")
          .all(),
      };
    };
    const shipped = await observeMalformed("shipped");
    const candidate = await observeMalformed("candidate");
    assert.equal(shipped.corrupted, true);
    assert.equal(candidate.corrupted, true);
    assert.equal(shipped.failure.meta.recordSeriesProgress, undefined);
    // INVERTED AT THE D-7 ROUND (review 3). Round 1's finding 3 established that
    // a set window which DID commit keeps publishing its progress, and rounds 1
    // and 2 measured this candidate-only publication for the FOLDED ROOT WRITE.
    // D-7 takes that write out of the batch, so it has no window and no series
    // at all, and the candidate now answers the shipped meta exactly. The
    // committed-window pin moved to the shape that still has a series — a
    // two-statement set mutation — in `g4/unit02/lone-statement-transport.test.ts`
    // row 6 and `g4/unit02/malformed-result-cuts.test.ts` cell 1b.
    assert.equal(
      candidate.failure.meta.recordSeriesProgress,
      undefined,
      report("P8", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.failure.meta,
      shipped.failure.meta,
      report("P8 meta parity", { candidate, shipped })
    );
  });

  /**
   * P9/P10: the brief's rule is broader than the diff — "a root single-record
   * write (create/update/delete/upsert, folded or packaged) answers the
   * driver's own error with the shipped meta even when its outcome is
   * unknown". A RELATION-BEARING root create does not reach `setMutations`, so
   * its members are ordinary members and the narrowed arm never sees them.
   * These probes let the first statements dispatch and inject the fault later,
   * which is the state the unit's cells never reach.
   */
  for (const delay of [1, 2, 3]) {
    it(`P9.${delay} a relation-bearing root create faulted after ${delay} dispatched statement(s)`, async () => {
      const { shipped, candidate } = await differential(
        (world) =>
          world.client.owner.create({
            data: {
              id: 40 + delay,
              label: "late",
              notes: { create: [{ body: "a" }, { body: "b" }] },
            },
          }),
        delay
      );
      // MEASURED: neither engine publishes progress here, and both attribute
      // the same `statementIndex` (1, 2, 3) — the multi-statement batch the
      // driver seam CAN index. No divergence in this family.
      assert.equal(shipped.failure.meta.recordSeriesProgress, undefined);
      assert.equal(candidate.failure.meta.recordSeriesProgress, undefined);
      assert.equal(candidate.failure.meta.statementIndex, delay);
      assert.deepEqual(
        candidate.failure.meta,
        shipped.failure.meta,
        report(`P9.${delay}`, { candidate, shipped })
      );
      assert.deepEqual(
        candidate.owners,
        shipped.owners,
        report(`P9.${delay}`, { candidate, shipped })
      );
      assert.deepEqual(
        candidate.notes,
        shipped.notes,
        report(`P9.${delay}`, { candidate, shipped })
      );
    });
  }
});
