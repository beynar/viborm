/**
 * FC-05 — one write-outcome composition, and one scalar scratch read-back.
 *
 * Two deletions are pinned here, both through the public client on real
 * in-process SQLite.
 *
 * 1. `OperationContext.retainOutcomeFailure` restated the exported
 *    `retainWriteOutcomeFailure` rule inside the engine. The rule now has ONE
 *    owner at `@errors`, which the client, the deferred operation and this
 *    engine all reach. The composition itself had no registered witness after
 *    C-01: `uncertain-outcome-meta.test.ts` retired its cells 7 and 8 (their
 *    literals pinned the shipped arm), and its surviving cells 6 and 9 measure
 *    the invalidation count and the committed segment's progress, not the
 *    identity of the composed failure. Cells 1-3 below state it: the
 *    OPERATION's own failure is `errors[0]` and `cause` BY IDENTITY, the
 *    listener's failure is retained beside it, and a listener that fails
 *    beside an answer that SUCCEEDED is published alone.
 *
 *    The two timings the engine distinguishes are both here, and they are not
 *    interchangeable: cell 1 composes where the primary is already in hand
 *    (the dispatch failed), cell 2 composes where the batch transport
 *    acknowledged FIRST, HELD the listener's failure, and the operation only
 *    afterwards failed to decode a value it carries across its own boundary.
 *
 * 2. `OperationContext.referenceProjection` prepared a whole user projection to
 *    read one produced scalar back. `Queries.scalarQuery` composes that read
 *    from the field's own physical value and its own decode leaf. Cell 4 is its
 *    positive witness — the read-back is one aliased scalar expression with no
 *    FROM of its own, and the generated key it carries binds the child row —
 *    and cell 2 is its malformed-value witness, since the carry's decode
 *    failure is what that cell's primary IS.
 */
import assert from "node:assert/strict";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const COMPOSED = "Query execution and write-outcome publication both failed.";
const LISTENER_FAILED = /^Cache invalidation failed after mutation/;
const LISTENER_CLASS = "CacheConfigurationError";
const WRITTEN_TABLE = /FROM "fc05_composition_parents"/;
const ALIASED_SCALAR = /^SELECT .* AS "id"$/;
const SCRATCH_CLEANUP = /^DELETE FROM "__viborm_batch_refs"/;
const MALFORMED =
  'Driver "sqlite3" returned a malformed int scalar for operation "createMany": the value is not a canonical integer.';

/**
 * A batch-only transport, so the write window really is a batch and `submit()`
 * — not the plain path — acknowledges its committed segment before it decodes.
 */
class BatchOnlyDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly statements: string[] = [];
  readonly batches: string[][] = [];
  failuresBeforeDispatch = 0;
  corrupted = false;
  private armed = false;

  /** Arm the cut after the migration, and forget the migration's traffic. */
  arm(): void {
    this.statements.length = 0;
    this.batches.length = 0;
    this.corrupted = false;
    this.armed = true;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    if (this.armed) this.statements.push(statement);
    if (this.failuresBeforeDispatch > 0) {
      this.failuresBeforeDispatch--;
      throw new Error("Controlled failure before dispatch");
    }
    const response = await super.execute<T>(client, statement, parameters);
    if (this.corrupted)
      for (const row of response.rows)
        if (isRecord(row) && Object.hasOwn(row, "id"))
          Reflect.set(row, "id", "malformed");
    return response;
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    if (this.armed) this.batches.push(queries.map(({ sql }) => sql));
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

/** The client's own cache rail, as the write-outcome listener that fails. */
class RecordingCache extends MemoryCache {
  readonly invalidations: string[] = [];
  failing = false;

  protected override async clear(prefix: string): Promise<void> {
    this.invalidations.push(prefix);
    if (this.failing) throw new Error("cache driver refused to clear");
    return super.clear(prefix);
  }
}

function fc05Schema() {
  const parent = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      children: s.toMany(() => child),
    })
    .map("fc05_composition_parents");
  const child = s
    .model({
      id: s.int().id(),
      label: s.string(),
      parentId: s.int(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id"),
    })
    .map("fc05_composition_children");
  return { child, parent };
}

function makeWorld() {
  const database = new Database(":memory:");
  const driver = new BatchOnlyDriver({ client: database });
  const client = createClient({ driver, schema: fc05Schema() });
  const cacheDriver = new RecordingCache();
  const background: Promise<unknown>[] = [];
  const cached = client.$extends(
    cache({
      driver: cacheDriver,
      waitUntil(promise) {
        background.push(promise);
      },
    })
  );
  return { background, cacheDriver, cached, client, database, driver };
}

type World = ReturnType<typeof makeWorld>;

async function withWorld<T>(drive: (world: World) => Promise<T>): Promise<T> {
  const world = makeWorld();
  if (!(await syncLiveSchema(world.client)).applied)
    throw new Error("the fixture schema was not applied");
  world.driver.arm();
  try {
    return await drive(world);
  } finally {
    world.cacheDriver.failing = false;
    await Promise.allSettled(world.background.splice(0));
    await world.client.$disconnect();
    world.database.close();
  }
}

/** The nested write whose plan carries a scratch: parent key, then child. */
function nestedCreateMany(world: World): PromiseLike<unknown> {
  return world.cached.parent.createMany({
    cache: { autoInvalidate: true },
    data: [
      {
        label: "held",
        children: { createMany: { data: [{ id: 7, label: "carried" }] } },
      },
    ],
    select: { id: true, label: true },
  });
}

async function observe(
  run: () => PromiseLike<unknown>
): Promise<{ failure: unknown; value: unknown }> {
  try {
    return { failure: undefined, value: await run() };
  } catch (failure) {
    return { failure, value: undefined };
  }
}

/** The composed failure, as a diagnostic that names identities. */
function describeFailure(failure: unknown): unknown {
  if (failure instanceof AggregateError)
    return {
      cause: describeFailure(failure.cause),
      errors: failure.errors.map((entry) => describeFailure(entry)),
      kind: "AggregateError",
      message: failure.message,
    };
  if (failure instanceof Error)
    return { kind: failure.name, message: failure.message };
  return { raw: String(failure) };
}

describe("FC-05 — one write-outcome composition", () => {
  it("1. the operation's own failure stays primary when the listener fails beside it", async () => {
    await withWorld(async (world) => {
      const { cacheDriver, database, driver } = world;
      driver.failuresBeforeDispatch = 1;
      cacheDriver.failing = true;
      const seen = await observe(() =>
        world.cached.parent.create({
          cache: { autoInvalidate: true },
          data: { label: "rejected" },
        })
      );
      const diagnostic = JSON.stringify(
        { failure: describeFailure(seen.failure), value: seen.value },
        undefined,
        2
      );
      assert.ok(seen.failure instanceof AggregateError, diagnostic);
      assert.equal(seen.failure.message, COMPOSED, diagnostic);
      // The primary is the OPERATION's failure and it is there BY IDENTITY:
      // `errors[0]` and `cause` are the same object, which is what a caller
      // that unwraps `cause` and a caller that reads `errors[0]` both need.
      assert.equal(seen.failure.errors.length, 2, diagnostic);
      assert.equal(seen.failure.cause, seen.failure.errors[0], diagnostic);
      assert.ok(seen.failure.errors[0] instanceof Error, diagnostic);
      assert.notEqual(
        (seen.failure.errors[0] as Error).name,
        LISTENER_CLASS,
        `the listener's failure must not be primary: ${diagnostic}`
      );
      // The listener's own failure is retained beside it, in its own class —
      // not discarded, and not re-wrapped into the operation's.
      assert.equal(
        (seen.failure.errors[1] as Error).name,
        LISTENER_CLASS,
        diagnostic
      );
      assert.match(
        String((seen.failure.errors[1] as Error).message),
        LISTENER_FAILED,
        diagnostic
      );
      assert.equal(cacheDriver.invalidations.length, 1, diagnostic);
      assert.deepEqual(
        database.prepare("SELECT id FROM fc05_composition_parents").all(),
        [],
        diagnostic
      );
    });
  });

  it("2. a HELD listener failure composes with the carried value's decode failure, and the primary keeps its progress", async () => {
    await withWorld(async (world) => {
      const { cacheDriver, database, driver } = world;
      driver.corrupted = true;
      cacheDriver.failing = true;
      const seen = await observe(() => nestedCreateMany(world));
      const diagnostic = JSON.stringify(
        {
          batches: driver.batches,
          failure: describeFailure(seen.failure),
          value: seen.value,
        },
        undefined,
        2
      );
      assert.ok(seen.failure instanceof AggregateError, diagnostic);
      assert.equal(seen.failure.message, COMPOSED, diagnostic);
      assert.equal(seen.failure.errors.length, 2, diagnostic);
      assert.equal(seen.failure.cause, seen.failure.errors[0], diagnostic);
      const primary = seen.failure.errors[0];
      // The primary is the carry's own decode failure — the value this unit
      // produced, read back at its boundary and malformed by the provider.
      assert.ok(primary instanceof QueryEngineError, diagnostic);
      assert.equal(primary.message, MALFORMED, diagnostic);
      // The operation's progress marking survives the composition: the write
      // window acknowledged, so its committed segment is still reported on the
      // primary rather than lost behind the aggregate.
      assert.deepEqual(
        primary.meta.recordSeriesProgress,
        {
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
          committedWriteMembers: 2,
          completedMembers: 1,
        },
        diagnostic
      );
      assert.equal(
        (seen.failure.errors[1] as Error).name,
        LISTENER_CLASS,
        diagnostic
      );
      assert.match(
        String((seen.failure.errors[1] as Error).message),
        LISTENER_FAILED,
        diagnostic
      );
      // ONE batch: the acknowledgement, the hold and the decode are all inside
      // the window that wrote the row.
      assert.equal(driver.batches.length, 1, diagnostic);
      assert.deepEqual(
        database
          .prepare("SELECT id, label FROM fc05_composition_parents")
          .all(),
        [{ id: 1, label: "held" }],
        diagnostic
      );
    });
  });

  it("3. a listener that fails beside an answer that SUCCEEDED is published alone", async () => {
    await withWorld(async (world) => {
      const { cacheDriver, database } = world;
      cacheDriver.failing = true;
      const seen = await observe(() => nestedCreateMany(world));
      const diagnostic = JSON.stringify(
        { failure: describeFailure(seen.failure), value: seen.value },
        undefined,
        2
      );
      // No primary means no composition: the listener's failure is the answer,
      // never an aggregate whose `cause` is an operation failure that does not
      // exist.
      assert.ok(seen.failure !== undefined, diagnostic);
      assert.ok(
        !(seen.failure instanceof AggregateError) ||
          seen.failure.message !== COMPOSED,
        diagnostic
      );
      assert.equal((seen.failure as Error).name, LISTENER_CLASS, diagnostic);
      assert.match(
        String((seen.failure as Error).message),
        LISTENER_FAILED,
        diagnostic
      );
      // And the write is durable: the failure is the listener's, not the
      // operation's.
      assert.deepEqual(
        database
          .prepare("SELECT id, label FROM fc05_composition_parents")
          .all(),
        [{ id: 1, label: "held" }],
        diagnostic
      );
    });
  });

  it("4. the produced key is read back as one aliased scalar and binds the child row", async () => {
    await withWorld(async (world) => {
      const { database, driver } = world;
      const seen = await observe(() => nestedCreateMany(world));
      const readBacks = driver.statements.filter(
        (statement) =>
          statement.startsWith("SELECT") &&
          statement.includes("__viborm_batch_refs")
      );
      const diagnostic = JSON.stringify(
        {
          batches: driver.batches,
          failure: describeFailure(seen.failure),
          readBacks,
          value: seen.value,
        },
        undefined,
        2
      );
      assert.equal(seen.failure, undefined, diagnostic);
      assert.deepEqual(seen.value, [{ id: 1, label: "held" }], diagnostic);
      // ONE read-back per produced value, and it is a projection-only SELECT:
      // the produced expression aliased to the field it belongs to, with no
      // FROM of its own — which is why exactly one row comes back.
      assert.equal(readBacks.length, 1, diagnostic);
      assert.match(readBacks[0]!, ALIASED_SCALAR, diagnostic);
      assert.ok(
        !WRITTEN_TABLE.test(readBacks[0]!),
        `the read-back reads the scratch, never the written table: ${diagnostic}`
      );
      // The literal it carries is the parent's generated key, bound by the
      // child's own column through the same codec a spelled key would use.
      assert.deepEqual(
        database
          .prepare("SELECT id, label, parentId FROM fc05_composition_children")
          .all(),
        [{ id: 7, label: "carried", parentId: 1 }],
        diagnostic
      );
      // Scratch lifetime, unchanged: the write window is ONE batch that
      // creates the scratch, stores the key, binds it, reads it back and drops
      // it; the terminal read is the operation's other window and touches no
      // scratch at all.
      assert.equal(driver.batches.length, 2, diagnostic);
      const [writeWindow, terminal] = driver.batches;
      assert.equal(writeWindow!.length, 7, diagnostic);
      assert.equal(
        writeWindow!.filter((statement) =>
          statement.includes("__viborm_batch_refs")
        ).length,
        6,
        diagnostic
      );
      assert.equal(writeWindow![5], readBacks[0], diagnostic);
      assert.match(writeWindow![6]!, SCRATCH_CLEANUP, diagnostic);
      assert.equal(terminal!.length, 1, diagnostic);
      assert.ok(!terminal![0]!.includes("__viborm_batch_refs"), diagnostic);
    });
  });
});
