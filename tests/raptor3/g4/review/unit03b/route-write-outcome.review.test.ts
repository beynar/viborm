/**
 * G4-03b independent review probe — the write-outcome rail through the route.
 *
 * `createCandidateRoute(...).operation(...).execute` is the only place the
 * candidate publishes a write outcome:
 *
 *   success → `execution.committedWriteSegment?.()` for every write verb;
 *   failure → `publishFailedWriteOutcome`, which reads the error's trusted
 *             `RecordSeriesProgress` and publishes `committedWriteSegment`
 *             (committed prefix) or `writeMayBeVisible` (unknown commit).
 *
 * The shipped owner publishes from inside the executor instead
 * (`OperationExecutor.runTransactionScope` / `executeProgressiveAtomicPlan`),
 * and it wraps a listener failure with `retainWriteOutcomeFailure` so the
 * caller keeps the PRIMARY error. These probes compare the two on the cases
 * the unit's LX-08 cells do not reach: a listener that throws, and a write
 * that fails AFTER a committed segment.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

const entry = s
  .model({
    id: s.int().id().increment(),
    label: s.string().unique(),
  })
  .map("g4r3b_outcome_entries");

const schema = { entry };

class SegmentedDriver extends SQLite3Driver {
  /** Two placeholders per row, so three rows need two statements. */
  override readonly maxBindParametersPerStatement: number | undefined = 2;
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return super.executeBatch<T>(client, queries);
  }
}

class ThrowingCache extends MemoryCache {
  readonly invalidations: string[] = [];
  failing = false;

  protected override async clear(prefix: string): Promise<void> {
    this.invalidations.push(`clear:${prefix}`);
    if (this.failing) throw new Error("cache backend is down");
    return super.clear(prefix);
  }
}

type BaseClient = VibORMClient<{
  driver: SQLite3Driver;
  schema: typeof schema;
}>;

const closers: (() => Promise<void>)[] = [];

async function createWorld(
  route: "shipped" | "candidate",
  driverKind: "plain" | "segmented" = "plain"
) {
  const database = new Database(":memory:");
  const driver =
    driverKind === "plain"
      ? new SQLite3Driver({ client: database })
      : new SegmentedDriver({ client: database });
  const config = { driver, schema };
  const base = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as BaseClient;
  const migration = await syncLiveSchema(base);
  if (!migration.applied) throw new Error("schema did not apply");
  const cacheDriver = new ThrowingCache();
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
    await client.$disconnect();
    database.close();
  });
  return {
    cacheDriver,
    client,
    database,
    driver,
    async settle(): Promise<string> {
      try {
        await Promise.all(background.splice(0));
        return "settled";
      } catch (error) {
        return `settle!${(error as Error).constructor.name}`;
      }
    },
  };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function outcome<T>(run: () => PromiseLike<T>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await run())}`;
  } catch (error) {
    return `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
}

describe("G4-03b review — write-outcome publication through the route", () => {
  /**
   * The cache listener is registered with `failurePolicy: "boundary-owned"`
   * (`src/query-engine/cache-flow.ts`). A listener that throws must reach the
   * caller the same way on both routes — and must not replace or swallow the
   * operation's own result.
   */
  test("a write whose cache invalidation THROWS surfaces the same way on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      world.cacheDriver.failing = true;
      const written = await outcome(() =>
        world.client.entry.create({
          cache: { autoInvalidate: true },
          data: { label: "boom" },
        })
      );
      const settled = await world.settle();
      return {
        invalidations: [...world.cacheDriver.invalidations],
        settled,
        stored: world.database
          .prepare("SELECT label FROM g4r3b_outcome_entries ORDER BY id")
          .all(),
        written,
      };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    // Non-vacuous: the listener really ran and really failed on the shipped route.
    assert.equal(shipped.invalidations.length, 1);
    assert.deepEqual(candidate, shipped);
  });

  /**
   * A write that fails AFTER a committed segment. The bind budget forces
   * `createMany` into two statements; the second row collides, so the first
   * segment is durable and the operation still rejects.
   *
   * The shipped owner publishes `committedWriteSegment` from inside the
   * executor as the segment commits; the route publishes it afterwards, from
   * the error's trusted progress. Both must publish exactly once, keep the
   * caller's error, and leave the same rows behind.
   */
  test("a write that fails after a committed segment publishes the same outcome on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route, "segmented");
      await world.client.entry.create({ data: { label: "taken" } });
      world.cacheDriver.invalidations.length = 0;
      const written = await outcome(() =>
        world.client.entry.createMany({
          cache: { autoInvalidate: true },
          data: [{ label: "fresh-a" }, { label: "taken" }],
        })
      );
      const settled = await world.settle();
      return {
        invalidations: world.cacheDriver.invalidations.length,
        settled,
        stored: world.database
          .prepare("SELECT label FROM g4r3b_outcome_entries ORDER BY id")
          .all(),
        written,
      };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    // MEASURED: on this transactional substrate the whole `createMany` rolls
    // back, so no committed prefix is reached and `publishFailedWriteOutcome`'s
    // progress arm stays unexercised here. The parity claim below still holds,
    // and the progress arm remains unverified in the credential-free estate.
    assert.equal(shipped.stored.length, 1);
    assert(shipped.written.startsWith("UniqueConstraintError"));
    assert.deepEqual(candidate, shipped);
  });

  /**
   * The route gates the write-outcome publication on the VERB
   * (`execution.isWrite`), while the shipped owner gates it on the PLAN
   * (`atomicPlanHasWrite`). An empty `createMany` is the payload where the two
   * predicates can disagree: the verb is a write, the plan may hold none.
   */
  test("an empty createMany publishes the same outcome on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route);
      const written = await outcome(() =>
        world.client.entry.createMany({
          cache: { autoInvalidate: true },
          data: [],
        })
      );
      const settled = await world.settle();
      return {
        invalidations: [...world.cacheDriver.invalidations],
        settled,
        statements: 0,
        written,
      };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    assert.deepEqual(candidate, shipped);
  });

  /**
   * The same shape, succeeding: a multi-segment `createMany` must publish ONE
   * invalidation on both routes, not one per committed segment.
   */
  test("a multi-segment write publishes the same number of invalidations on both routes", async () => {
    const observe = async (route: "shipped" | "candidate") => {
      const world = await createWorld(route, "segmented");
      const written = await outcome(() =>
        world.client.entry.createMany({
          cache: { autoInvalidate: true },
          data: [{ label: "s-1" }, { label: "s-2" }, { label: "s-3" }],
        })
      );
      const settled = await world.settle();
      return {
        invalidations: world.cacheDriver.invalidations.length,
        settled,
        stored: world.database
          .prepare("SELECT label FROM g4r3b_outcome_entries ORDER BY id")
          .all(),
        written,
      };
    };

    const shipped = await observe("shipped");
    const candidate = await observe("candidate");
    // Non-vacuous: three rows really needed more than one statement.
    assert.equal(shipped.stored.length, 3);
    assert.equal(shipped.invalidations, 1);
    assert.deepEqual(candidate, shipped);
  });
});
