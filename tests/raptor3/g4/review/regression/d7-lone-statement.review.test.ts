/**
 * G4-02 D-7 INDEPENDENT REVIEW probes — "a lone statement leaves the batch".
 *
 * The unit makes `OperationContext.setMutations` ask the envelope rule's own
 * question before it picks a transport: a set statement that is the operation's
 * only statement takes the plain `dispatch`/`_execute` path on every driver, a
 * batch-only one included (`shared/operation-context.ts` `lone`). The plain path
 * (`dispatchSetMutations`) then states the durable write phase on the same
 * `ExecutionBinding.writeOutcome` seam `submit()` uses, and one wrapper
 * (`stateWriteOutcome`) keeps the operation's own failure primary when the
 * client's cache listener throws.
 *
 * The author's seven rows measure the rejection BEFORE dispatch. These probes
 * measure the shapes that reach the provider, plus the two the rule's reach
 * makes newly interesting — every one a SHIPPED-vs-CANDIDATE differential:
 *
 *  - D1/D2 — a root `update` whose `where` matches nothing, on a batch-only and
 *    on a transaction-capable driver: the candidate's fold is one statement plus
 *    a JavaScript postcondition, the shipped fold is a presence guard batched
 *    with its mutation, so the two learn "no row" at different places. Does the
 *    candidate tell the cache a write became durable where shipped does not?
 *  - D3 — a lone statement that FAILS AFTER the provider ran it (uncertain
 *    outcome on the new path): invalidation count and published failure.
 *  - D4 — the same statement rejected by a UNIQUE violation: the one class that
 *    proves rollback, now excluded at a second site.
 *  - D5/D6 — the G2.9 cut, re-measured against the shipped engine on both
 *    profiles: committed rows, failure identity and progress. D5 is the
 *    `sqlite-interactive` expectation this round changed from `[]` to one row.
 *  - D7 — `createMany({ skipDuplicates: true })` as ONE statement: the shipped
 *    direct-path condition excludes an `onUniqueConflict` write and the
 *    candidate's `lone` does not, so this is where the two rules could differ.
 *  - D8/D9 — a throwing cache listener on the new path, on the uncertain arm and
 *    on the committed arm (the followup review's S6/S7 pair, re-sited).
 *  - D10 — a lone `deleteMany` that matches nothing: a write that changed no row
 *    still ran, on both engines.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { VibORMError } from "@errors";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

type Fault = "none" | "afterDispatch" | "corruptRows";

/** One driver, four transports, three faults — so shipped and candidate meet the same world. */
class ProbeDriver extends SQLite3Driver {
  fault: Fault = "none";
  executes = 0;
  batches = 0;

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.executes++;
    const response = await super.execute<T>(client, statement, parameters);
    if (this.fault === "afterDispatch") {
      throw new Error("provider connection lost after the statement ran");
    }
    if (this.fault === "corruptRows") {
      for (const row of response.rows) {
        if (isRecord(row)) Reflect.set(row, "id", "not-an-integer");
      }
    }
    return response;
  }
}

/** A transaction-capable transport whose bind budget splits one set into two. */
class SplittingProbeDriver extends ProbeDriver {
  override readonly maxBindParametersPerStatement: number | undefined = 2;
}

class BatchOnlyProbeDriver extends ProbeDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: Parameters<SQLite3Driver["executeBatch"]>[1]
  ): Promise<QueryResult<T>[]> {
    this.batches++;
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

/** The batch-only transport whose bind budget splits one set into two. */
class SplittingBatchOnlyProbeDriver extends BatchOnlyProbeDriver {
  override readonly maxBindParametersPerStatement: number | undefined = 2;
}

/** Counts what the official cache driver was asked to drop, and can refuse. */
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
  })
  .map("g4rev_d7_owners");
const schema = { owner };

type Route = "shipped" | "candidate";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function cachedWorld(route: Route, transactional: boolean, split = false) {
  const database = new Database(":memory:");
  const driver = transactional
    ? split
      ? new SplittingProbeDriver({ client: database })
      : new ProbeDriver({ client: database })
    : split
      ? new SplittingBatchOnlyProbeDriver({ client: database })
      : new BatchOnlyProbeDriver({ client: database });
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

/** What a failure IS, at the depth an AggregateError composition is visible. */
function shape(failure: unknown): unknown {
  if (failure instanceof AggregateError) {
    return {
      cause: shape(failure.cause),
      errors: failure.errors.map((entry) => shape(entry)),
      kind: "AggregateError",
      message: failure.message,
    };
  }
  if (failure instanceof VibORMError) {
    const { code, meta, name } = identity(failure);
    return { code, kind: name, meta };
  }
  if (failure instanceof Error) {
    return { kind: failure.name, message: failure.message };
  }
  return failure === undefined ? undefined : { kind: "raw", value: String(failure) };
}

interface Measurement {
  readonly batches: number;
  readonly failure: unknown;
  readonly invalidations: number;
  readonly rows: unknown[];
}

async function measure(
  route: Route,
  transactional: boolean,
  drive: (world: CachedWorld) => PromiseLike<unknown>,
  split = false
): Promise<Measurement> {
  const world = await cachedWorld(route, transactional, split);
  let failure: unknown;
  try {
    await drive(world);
  } catch (caught) {
    failure = caught;
  }
  world.driver.fault = "none";
  world.cacheDriver.failing = false;
  await world.settle();
  return {
    batches: world.driver.batches,
    failure: shape(failure),
    invalidations: world.cacheDriver.invalidations.length,
    rows: world.database
      .prepare("SELECT id, owner_label FROM g4rev_d7_owners ORDER BY id")
      .all(),
  };
}

async function differential(
  transactional: boolean,
  drive: (world: CachedWorld) => PromiseLike<unknown>,
  split = false
): Promise<{ candidate: Measurement; shipped: Measurement }> {
  return {
    shipped: await measure("shipped", transactional, drive, split),
    candidate: await measure("candidate", transactional, drive, split),
  };
}

function report(label: string, pair: object): string {
  return `${label} ${JSON.stringify(pair, undefined, 2)}`;
}

/** Seed one row, forget what that cost the cache, then run the measured call. */
async function afterSeed(
  world: CachedWorld,
  run: () => PromiseLike<unknown>
): Promise<unknown> {
  await world.client.owner.create({ data: { id: 1, label: "seed" } });
  world.cacheDriver.invalidations.length = 0;
  world.driver.batches = 0;
  return run();
}

describe("G4-02 D-7 review — the lone statement once it reaches the provider", () => {
  it("D1 root update matching no row, batch-only: same failure, same cache answer", async () => {
    const { shipped, candidate } = await differential(false, (world) =>
      afterSeed(world, () =>
        world.client.owner.update({
          cache: { autoInvalidate: true },
          data: { label: "changed" },
          where: { id: 404 },
        })
      )
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D1 failure", { candidate, shipped })
    );
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("D1 invalidations", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.rows,
      shipped.rows,
      report("D1 rows", { candidate, shipped })
    );
  });

  it("D2 root update matching no row, transaction-capable: same failure, same cache answer", async () => {
    const { shipped, candidate } = await differential(true, (world) =>
      afterSeed(world, () =>
        world.client.owner.update({
          cache: { autoInvalidate: true },
          data: { label: "changed" },
          where: { id: 404 },
        })
      )
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D2 failure", { candidate, shipped })
    );
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("D2 invalidations", { candidate, shipped })
    );
  });

  it("D3 a lone statement that fails AFTER the provider ran it", async () => {
    const { shipped, candidate } = await differential(false, (world) =>
      afterSeed(world, () => {
        world.driver.fault = "afterDispatch";
        return world.client.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 2, label: "uncertain" },
        });
      })
    );
    assert.equal(
      shipped.invalidations,
      1,
      report("D3 shipped must invalidate", { candidate, shipped })
    );
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("D3 invalidations", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D3 failure", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.rows,
      shipped.rows,
      report("D3 rows", { candidate, shipped })
    );
  });

  it("D4 a lone statement rejected by a unique violation invalidates on neither engine", async () => {
    const { shipped, candidate } = await differential(false, (world) =>
      afterSeed(world, () =>
        world.client.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 1, label: "duplicate" },
        })
      )
    );
    assert.equal(
      shipped.invalidations,
      0,
      report("D4 shipped", { candidate, shipped })
    );
    assert.equal(
      candidate.invalidations,
      0,
      report("D4 candidate", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D4 failure", { candidate, shipped })
    );
  });

  it("D5 the G2.9 cut on a transaction-capable driver leaves the same state on both engines", async () => {
    const { shipped, candidate } = await differential(true, (world) => {
      world.driver.fault = "corruptRows";
      return world.client.owner.create({ data: { id: 1, label: "written" } });
    });
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D5 failure", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.rows,
      shipped.rows,
      report("D5 committed state", { candidate, shipped })
    );
  });

  it("D6 the G2.9 cut on a batch-only driver leaves the same state on both engines", async () => {
    const { shipped, candidate } = await differential(false, (world) => {
      world.driver.fault = "corruptRows";
      return world.client.owner.create({ data: { id: 1, label: "written" } });
    });
    assert.equal(
      candidate.batches,
      0,
      report("D6 the lone statement left the batch", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D6 failure", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.rows,
      shipped.rows,
      report("D6 committed state", { candidate, shipped })
    );
  });

  it("D7 a one-statement createMany with skipDuplicates answers what shipped answers", async () => {
    const { shipped, candidate } = await differential(false, (world) =>
      afterSeed(world, () => {
        world.driver.fault = "afterDispatch";
        return world.client.owner.createMany({
          cache: { autoInvalidate: true },
          data: [{ id: 2, label: "skipped" }],
          skipDuplicates: true,
        });
      })
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D7 failure", { candidate, shipped })
    );
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("D7 invalidations", { candidate, shipped })
    );
  });

  it("D8 a throwing cache listener never replaces the operation's own failure (uncertain arm)", async () => {
    const { shipped, candidate } = await differential(false, (world) =>
      afterSeed(world, () => {
        world.driver.fault = "afterDispatch";
        world.cacheDriver.failing = true;
        return world.client.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 2, label: "uncertain" },
        });
      })
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D8 failure", { candidate, shipped })
    );
  });

  it("D9 a throwing cache listener beside a malformed committed result (committed arm)", async () => {
    const { shipped, candidate } = await differential(false, (world) =>
      afterSeed(world, () => {
        world.driver.fault = "corruptRows";
        world.cacheDriver.failing = true;
        return world.client.owner.create({
          cache: { autoInvalidate: true },
          data: { id: 2, label: "written" },
        });
      })
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D9 failure", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.rows,
      shipped.rows,
      report("D9 committed state", { candidate, shipped })
    );
  });

  it("D12 the same listener failure beside a malformed result on the BATCH transport", async () => {
    // The neighbour of D9: the two-statement form of the same request, which
    // still goes through `submit()`. It says whether the primary-retention gap
    // D9 measures is confined to the plain path or is a property of the
    // composition wherever the decode failure is raised.
    const { shipped, candidate } = await differential(
      false,
      (world) =>
        afterSeed(world, () => {
          world.driver.fault = "corruptRows";
          world.cacheDriver.failing = true;
          return world.client.owner.createMany({
            cache: { autoInvalidate: true },
            data: [
              { id: 2, label: "a" },
              { id: 3, label: "b" },
            ],
            select: { id: true, label: true },
          });
        }),
      true
    );
    assert.deepEqual(
      candidate.failure,
      shipped.failure,
      report("D12 failure", { candidate, shipped })
    );
  });

  it("D11 a multi-statement write inside its own region tells the cache nothing", async () => {
    // The falsifier for the plain path's `owned` gate
    // (`ownership === "standalone" && !ownRegionOpen`), which no registered
    // suite reaches: two statements on a TRANSACTION-capable driver open the
    // operation's own region, the malformed result rolls it back, and a
    // `committedSegment` said from inside that region would tell the cache a
    // write became durable that the provider then discarded. Dropping the gate
    // reddens this cell; the shipped `runTransactionScope` notifies by
    // transaction phase and publishes nothing for a rollback.
    const { shipped, candidate } = await differential(
      true,
      (world) =>
        afterSeed(world, () => {
          world.driver.fault = "corruptRows";
          return world.client.owner.createMany({
            cache: { autoInvalidate: true },
            data: [
              { id: 2, label: "a" },
              { id: 3, label: "b" },
            ],
            select: { id: true, label: true },
          });
        }),
      true
    );
    assert.equal(
      shipped.invalidations,
      0,
      report("D11 shipped", { candidate, shipped })
    );
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("D11 invalidations", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.rows,
      shipped.rows,
      report("D11 rolled back on both", { candidate, shipped })
    );
  });

  it("D10 a lone deleteMany that matches nothing still ran, on both engines", async () => {
    const { shipped, candidate } = await differential(false, (world) =>
      afterSeed(world, () =>
        world.client.owner.deleteMany({
          cache: { autoInvalidate: true },
          where: { id: 404 },
        })
      )
    );
    assert.equal(
      candidate.invalidations,
      shipped.invalidations,
      report("D10 invalidations", { candidate, shipped })
    );
    assert.deepEqual(
      candidate.rows,
      shipped.rows,
      report("D10 rows", { candidate, shipped })
    );
  });
});
