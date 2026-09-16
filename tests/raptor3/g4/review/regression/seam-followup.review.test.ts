/**
 * G4 regression INDEPENDENT REVIEW — follow-up probes for the SEAM round.
 *
 * The seam round moved both cache-invalidation facts out of the route's error
 * reading and into the transport that learns them
 * (`shared/operation-context.ts` `WriteOutcomeSeam`, called from `submit()`'s
 * `acknowledged()` and from `submit()`'s catch), leaving the route with one
 * success-arm publication gated by `!outcome.published` — the candidate's
 * restatement of the shipped rail's `publishedDirectUnits === 0`
 * (`src/extensions/query.ts:286-293`).
 *
 * P7 in the sibling file measures the uncertain root create. These probes
 * measure the neighbours the author's four cells and P7 do not reach, all as
 * SHIPPED-vs-CANDIDATE differentials on the client's own cache rail:
 *
 *  - S1 — a root create the driver ROLLED BACK (unique violation) on the same
 *    batch-only transport: neither engine may invalidate.
 *  - S2 — a successful root create on a TRANSACTION-capable driver, where the
 *    candidate's `submit()` never runs and the route's success arm is the only
 *    publisher.
 *  - S3 — a failed root create on a transaction-capable driver: no publisher
 *    at all, on either engine.
 *  - S4 — a MULTI-SEGMENT write (a relation-bearing create whose generated
 *    output forces a second segment) on the batch-only transport: the author's
 *    unverified claim that both engines notify once per acknowledged segment.
 *  - S5 — a write inside `$transaction(callback)`, where the route states a
 *    `borrowed-transaction` situation carrying the same seam and the shipped
 *    rail stages its outcome until commit.
 *  - S6 — a cache driver whose invalidation THROWS on the uncertain root
 *    create: the author's other unverified claim (the notification's failure
 *    moved site, from the route's catch into `submit()`'s catch).
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers";
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
class BatchOnlyDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  failuresBeforeDispatch = 0;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    if (this.failuresBeforeDispatch > 0) {
      this.failuresBeforeDispatch--;
      throw new Error("Controlled failure before dispatch");
    }
    return super.execute<T>(client, statement, parameters);
  }
}

/** Counts what the official cache driver was actually asked to drop. */
class RecordingCache extends MemoryCache {
  readonly invalidations: string[] = [];
  failing = false;

  protected override async clear(prefix: string): Promise<void> {
    this.invalidations.push(`clear:${prefix}`);
    if (this.failing) throw new Error("cache driver refused to clear");
    return super.clear(prefix);
  }
}

const owner = s
  .model({
    id: s.int().id(),
    label: s.string().map("owner_label"),
    notes: s.toMany(() => note),
  })
  .map("g4rev_seam_owners");
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
  .map("g4rev_seam_notes");
const schema = { owner, note };

type Route = "shipped" | "candidate";
type AnyWorldDriver = BatchOnlyDriver | SQLite3Driver;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** One cached world per ROUTE, reached the way a client reaches it. */
async function cachedWorld(route: Route, transactional: boolean) {
  const database = new Database(":memory:");
  const driver: AnyWorldDriver = transactional
    ? new SQLite3Driver({ client: database })
    : new BatchOnlyDriver({ client: database });
  const config = { driver, schema };
  const base = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as VibORMClient<typeof config>;
  const migration = await syncLiveSchema(base);
  if (!migration.applied) throw new Error("schema did not apply");
  const cacheDriver = new RecordingCache();
  const background: Promise<unknown>[] = [];
  const client = base.$extends(
    cache({
      driver: cacheDriver,
      waitUntil(promise) {
        background.push(promise);
      },
    })
  );
  closers.push(async () => {
    await base.$disconnect();
    database.close();
  });
  return {
    cacheDriver,
    client,
    database,
    driver,
    async settle() {
      await Promise.allSettled(background.splice(0));
    },
  };
}

type CachedWorld = Awaited<ReturnType<typeof cachedWorld>>;

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

interface Measurement {
  readonly invalidations: number;
  readonly outcome: string;
  readonly rows: unknown[];
}

async function measure(
  route: Route,
  transactional: boolean,
  drive: (world: CachedWorld) => PromiseLike<unknown>
): Promise<Measurement> {
  const world = await cachedWorld(route, transactional);
  let outcome = "published";
  try {
    await drive(world);
  } catch (failure) {
    outcome =
      failure instanceof VibORMError
        ? identity(failure).name
        : `raw:${String(failure)}`;
  }
  (world.driver as BatchOnlyDriver).failuresBeforeDispatch = 0;
  await world.settle();
  return {
    invalidations: world.cacheDriver.invalidations.length,
    outcome,
    rows: world.database
      .prepare("SELECT id, owner_label FROM g4rev_seam_owners ORDER BY id")
      .all(),
  };
}

async function differential(
  transactional: boolean,
  drive: (world: CachedWorld) => PromiseLike<unknown>
): Promise<{ candidate: Measurement; shipped: Measurement }> {
  return {
    shipped: await measure("shipped", transactional, drive),
    candidate: await measure("candidate", transactional, drive),
  };
}

function report(label: string, pair: object): string {
  return `${label} ${JSON.stringify(pair, undefined, 2)}`;
}

describe("G4 seam round review — the cache rail's neighbours", () => {
  it("S1 a rolled-back root create invalidates on neither engine", async () => {
    const { shipped, candidate } = await differential(false, async (world) => {
      await world.client.owner.create({ data: { id: 5, label: "first" } });
      world.cacheDriver.invalidations.length = 0;
      return world.client.owner.create({
        cache: { autoInvalidate: true },
        data: { id: 5, label: "duplicate" },
      });
    });
    assert.equal(candidate.outcome, shipped.outcome);
    assert.equal(
      shipped.invalidations,
      0,
      report("S1 shipped", { candidate, shipped })
    );
    assert.equal(
      candidate.invalidations,
      0,
      report("S1 candidate", { candidate, shipped })
    );
  });

  it("S2 a successful root create on a transaction-capable driver invalidates exactly once", async () => {
    const { shipped, candidate } = await differential(true, (world) =>
      world.client.owner.create({
        cache: { autoInvalidate: true },
        data: { id: 11, label: "committed" },
      })
    );
    assert.equal(shipped.outcome, "published");
    assert.equal(candidate.outcome, "published");
    assert.equal(shipped.invalidations, 1, report("S2", { shipped }));
    assert.equal(
      candidate.invalidations,
      1,
      report("S2", { candidate, shipped })
    );
    assert.deepEqual(candidate.rows, shipped.rows);
  });

  it("S3 a failed root create on a transaction-capable driver invalidates on neither engine", async () => {
    const { shipped, candidate } = await differential(true, async (world) => {
      await world.client.owner.create({ data: { id: 12, label: "first" } });
      world.cacheDriver.invalidations.length = 0;
      return world.client.owner.create({
        cache: { autoInvalidate: true },
        data: { id: 12, label: "duplicate" },
      });
    });
    assert.equal(candidate.outcome, shipped.outcome);
    assert.equal(shipped.invalidations, 0, report("S3", { shipped }));
    assert.equal(
      candidate.invalidations,
      0,
      report("S3", { candidate, shipped })
    );
  });

  it("S4 a multi-segment write notifies the same number of times on both engines", async () => {
    const { shipped, candidate } = await differential(false, (world) =>
      world.client.owner.create({
        cache: { autoInvalidate: true },
        data: {
          id: 13,
          label: "parent",
          notes: { create: [{ body: "a" }, { body: "b" }] },
        },
      })
    );
    assert.equal(shipped.outcome, "published");
    assert.equal(candidate.outcome, "published");
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("S4", { candidate, shipped })
    );
    assert.deepEqual(candidate.rows, shipped.rows);
  });

  it("S5 a write inside $transaction(callback) invalidates the same on both engines", async () => {
    const { shipped, candidate } = await differential(true, (world) =>
      world.client.$transaction(async (tx) => {
        await tx.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 14, label: "in-transaction" },
        });
        return tx.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 15, label: "in-transaction-2" },
        });
      })
    );
    assert.equal(shipped.outcome, "published");
    assert.equal(candidate.outcome, "published");
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("S5", { candidate, shipped })
    );
    assert.deepEqual(candidate.rows, shipped.rows);
  });

  it("S6 a throwing cache invalidation on the uncertain root create answers the same on both engines", async () => {
    const observe = async (route: Route) => {
      const world = await cachedWorld(route, false);
      world.cacheDriver.failing = true;
      (world.driver as BatchOnlyDriver).failuresBeforeDispatch = 1;
      let outcome = "published";
      let progress: unknown;
      try {
        await world.client.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 16, label: "uncertain" },
        });
      } catch (failure) {
        if (failure instanceof VibORMError) {
          const published = identity(failure);
          outcome = published.name;
          progress = published.meta.recordSeriesProgress;
        } else outcome = `raw:${(failure as Error).message}`;
      }
      (world.driver as BatchOnlyDriver).failuresBeforeDispatch = 0;
      world.cacheDriver.failing = false;
      await world.settle();
      return {
        attempts: world.cacheDriver.invalidations.length,
        outcome,
        progress,
      };
    };
    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    // The SEAM is at parity: both engines attempt the invalidation exactly once
    // for an outcome neither can prove rolled back.
    assert.equal(shipped.attempts, 1, report("S6 shipped", { shipped }));
    assert.equal(
      candidate.attempts,
      1,
      report("S6 candidate", { candidate, shipped })
    );
    // INVERTED AT THE D-7 ROUND (review 3). Rounds 1 and 2 measured the
    // divergence: the candidate let the listener's failure REPLACE the query
    // failure, where the shipped engine keeps the operation's own error primary
    // and retains the listener's beside it (`retainWriteOutcomeFailure`,
    // `extensions/query.ts:859-871`). The D-7 round states that composition once
    // in `OperationContext.stateWriteOutcome`, so both engines now answer the
    // same sentence. Inverting the wrapper's primary-retention arm reddens this.
    assert.equal(
      shipped.outcome,
      "raw:Query execution and write-outcome publication both failed.",
      report("S6 shipped outcome", { shipped })
    );
    assert.equal(
      candidate.outcome,
      shipped.outcome,
      report("S6 candidate outcome", { candidate, shipped })
    );
  });

  it("S8 a guard-aborted atomic batch invalidates the same on both engines", async () => {
    // The candidate's uncertain-outcome branch excludes only
    // `UniqueConstraintError` (`shared/operation-context.ts:726-740`), where the
    // shipped engine also excludes a guard abort it can prove rolled back
    // (`isRetryableRace` / `SkippedRecordSeriesMember`,
    // `OperationExecutor.ts:1048-1053`). A nested `connect` to a missing parent
    // is the reachable guard abort on an atomic batch.
    const { shipped, candidate } = await differential(false, async (world) => {
      await world.client.owner.create({ data: { id: 18, label: "present" } });
      world.cacheDriver.invalidations.length = 0;
      return world.client.note.create({
        cache: { autoInvalidate: true },
        data: { body: "orphan", owner: { connect: { id: 999 } } },
      });
    });
    assert.equal(candidate.outcome, shipped.outcome);
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("S8", { candidate, shipped })
    );
  });

  it("S7 a throwing cache invalidation on a SUCCESSFUL write answers the same on both engines", async () => {
    // The route's success arm is not new to the seam round (it published
    // `committedWriteSegment` on every successful write before it too), so this
    // measures whether the S6 divergence is a family or a seam-round artifact.
    const observe = async (route: Route, transactional: boolean) => {
      const world = await cachedWorld(route, transactional);
      world.cacheDriver.failing = true;
      let outcome = "published";
      try {
        await world.client.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 17, label: "committed" },
        });
      } catch (failure) {
        outcome =
          failure instanceof VibORMError
            ? identity(failure).name
            : `raw:${(failure as Error).message}`;
      }
      world.cacheDriver.failing = false;
      await world.settle();
      return {
        attempts: world.cacheDriver.invalidations.length,
        outcome,
        rows: world.database
          .prepare("SELECT id, owner_label FROM g4rev_seam_owners ORDER BY id")
          .all(),
      };
    };
    for (const transactional of [true, false]) {
      const shipped = await observe("shipped", transactional);
      const candidate = await observe("candidate", transactional);
      assert.equal(
        candidate.attempts,
        shipped.attempts,
        report(`S7 attempts transactional=${transactional}`, {
          candidate,
          shipped,
        })
      );
      assert.deepEqual(
        candidate.rows,
        shipped.rows,
        report(`S7 rows transactional=${transactional}`, {
          candidate,
          shipped,
        })
      );
      // MEASURED: both engines fail the successful write with the listener's
      // own error here — the divergence S6 records is confined to the case
      // where the operation ALSO has a failure of its own to keep.
      assert.equal(
        candidate.outcome,
        shipped.outcome,
        report(`S7 outcome transactional=${transactional}`, {
          candidate,
          shipped,
        })
      );
    }
  });
});
