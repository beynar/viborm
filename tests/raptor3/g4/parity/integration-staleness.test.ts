/**
 * Integration unit — U6.5 under Arnaud's D-25.
 *
 * A captured member set is an assertion about every row that is NOT in it
 * (rule 5, "never cache observed absence"). On the batch route the set
 * therefore rides its own batch with one raceable complement guard —
 * "connected ∧ filter ∧ key ∉ captured is empty" — so a member committed
 * between the plan-time read and the atomic unit ABORTS the unit instead of
 * being silently missed.
 *
 * The convergence half is D-25: the one recovery allowance is refused only
 * after COMMITTED record-series progress, and the recovery RE-PLANS from the
 * admitted values with a fresh occurrence tree (a series occurrence is expanded
 * exactly once, so a replay of the same tree could not re-derive its members).
 * One recovery only: a race planted on every attempt still propagates.
 *
 * The estate's live witness for this is `pg filtered m2m deleteMany staleness`
 * on Docker PostgreSQL; it cannot open the window on this engine's statement
 * shape (see the integration note), so the same facts are pinned here,
 * deterministically, on a real SQLite database with a batch-only transport.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { s } from "@schema";
import { MemoryCache } from "@src/cache/drivers/memory";
import { cache } from "@src/cache/exports";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const board = s
  .model({
    id: s.int().id(),
    name: s.string(),
    cards: s.toMany(() => card),
  })
  .map("u65_boards");

const card = s
  .model({
    id: s.int().id(),
    label: s.string(),
    boards: s.toMany(() => board),
  })
  .map("u65_cards");

const schema = { board, card };

/** Does this batch carry a write? Only that batch is the atomic unit. */
const MUTATION = /^\s*(?:insert|update|delete)\b/i;
/** The junction's two sides, named by the models they reference. */
const BOARD_SIDE = /board/i;
const CARD_SIDE = /card/i;
/** The complement guard, as the adapter spells it. */
const COMPLEMENT_GUARD =
  /NOT EXISTS[\s\S]*"u65_cards"[\s\S]*"board_card"[\s\S]*NOT \(/i;
/** The captured keys the complement excludes. */
const EXCLUDED_KEY = /"id" = \?/g;
const FIRST_EXCLUDED_KEY = /NOT \(\s*"q\d+"\."id" = \?/i;
/** The guard's own raceable sentence. */
const ADDED_MEMBER = /member was added after the plan-time read/;
/** Any premise, as the adapter marks one. */
const PREMISE = /__viborm_assert__/;

/**
 * A batch-only transport over a real SQLite database, which commits a competing
 * membership in the window the guard exists for: after the plan-time read, and
 * before the atomic unit that trusts it.
 *
 * Its two subclasses differ in ONE fact — whether a rejected batch can prove it
 * rolled back — because that is the fact the progress companion of D-29 reads.
 */
class PlantingBatchSQLiteDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  /** How many atomic write batches lose the race; the world seeds with none. */
  plantsLeft = 0;
  planted = 0;
  private junction?: { table: string; board: string; card: string };

  /** Each dispatched batch, in order, so its COMPOSITION can be pinned. */
  readonly batches: string[][] = [];

  override reset(): void {
    super.reset();
    this.batches.length = 0;
  }

  /**
   * The window the guard exists for is between the plan-time membership read
   * and the ATOMIC WRITE UNIT that trusts it, so the competing commit lands
   * before a batch that mutates — never before a planning batch, which the
   * plan would simply read (the hazard
   * `tests/fixtures/drivers/batch-forced-pg.ts` documents for its own
   * before-first-batch driver).
   */
  protected plantBeforeMutation(
    client: Database.Database,
    queries: BatchQuery[]
  ): void {
    this.batches.push(queries.map((query) => query.sql));
    if (
      this.plantsLeft > 0 &&
      queries.some((query) => MUTATION.test(query.sql))
    ) {
      this.plantsLeft--;
      this.plant(client);
    }
  }

  /** The junction this schema derived, discovered once from the live database. */
  private membership(client: Database.Database) {
    if (this.junction) return this.junction;
    const tables = client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as { name: string }[];
    const table = tables
      .map((row) => row.name)
      .find((name) => name !== "u65_boards" && name !== "u65_cards");
    if (!table) throw new Error("U6.5 world has no junction table");
    const columns = (
      client.prepare(`PRAGMA table_info("${table}")`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    const boardColumn = columns.find((name) => BOARD_SIDE.test(name));
    const cardColumn = columns.find((name) => CARD_SIDE.test(name));
    if (!(boardColumn && cardColumn))
      throw new Error(`U6.5 junction ${table} has no recognisable sides`);
    this.junction = { table, board: boardColumn, card: cardColumn };
    return this.junction;
  }

  private plant(client: Database.Database): void {
    const membership = this.membership(client);
    const id = 900 + this.planted;
    this.planted++;
    client
      .prepare('INSERT INTO "u65_cards" ("id","label") VALUES (?,?)')
      .run(id, "del-added");
    client
      .prepare(
        `INSERT INTO "${membership.table}" ("${membership.board}","${membership.card}") VALUES (?,?)`
      )
      .run(1, id);
  }
}

/**
 * An atomic batch that PROVES its rollback — the D1 shape, the transport where
 * a rejected batch is known to have left nothing behind. Without that proof a
 * rejected batch is `may-have-committed` and no recovery is allowed, which is
 * the engine's rule, not this fixture's.
 */
class StaleBatchSQLiteDriver extends PlantingBatchSQLiteDriver {
  override readonly supportsOrderedCommittedSegments = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.plantBeforeMutation(client, queries);
    this.batchCalls++;
    return this.transaction(client, async (transaction) => {
      const responses: QueryResult<T>[] = [];
      for (const query of queries)
        responses.push(
          await this.execute<T>(transaction, query.sql, query.params ?? [])
        );
      return responses;
    });
  }
}

/**
 * The same world on a WEAK native batch: it advertises no ordered committed
 * segments, so a rejection after dispatch is `may-have-committed` unless the
 * engine can prove otherwise — which is the only transport where D-29's
 * progress companion decides anything. It keeps no loop of its own, because the
 * BASE loop (`driver-transaction-base.ts`) is what attaches the statement index
 * the proof reads; a fixture that loops itself attaches none and the arm is
 * unreachable.
 */
class WeakBatchSQLiteDriver extends PlantingBatchSQLiteDriver {
  /** Reject the batch's first write AT that statement, once. */
  failAtFirstWrite = false;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    this.plantBeforeMutation(client, queries);
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries, context)
    );
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.failAtFirstWrite && MUTATION.test(statement)) {
      this.failAtFirstWrite = false;
      throw new Error("Controlled rejection at the batch's first write");
    }
    return super.execute<T>(client, statement, parameters, context);
  }
}

/** Counts what the client's own cache rail was asked to drop. */
class RecordingCache extends MemoryCache {
  readonly invalidations: string[] = [];

  protected override async clear(prefix: string): Promise<void> {
    this.invalidations.push(prefix);
    return super.clear(prefix);
  }
}

interface World {
  readonly driver: StaleBatchSQLiteDriver;
  readonly client: ReturnType<typeof buildClient>;
  close(): Promise<void>;
}

/** The same world whose client carries its own cache rail. */
interface CachedWorld {
  readonly driver: WeakBatchSQLiteDriver;
  readonly cacheDriver: RecordingCache;
  readonly client: ReturnType<typeof buildCachedClient>;
  settle(): Promise<void>;
  close(): Promise<void>;
}

function buildClient(driver: PlantingBatchSQLiteDriver) {
  return createClient({ schema, driver });
}

function buildCachedClient(
  base: ReturnType<typeof buildClient>,
  cacheDriver: RecordingCache,
  background: Promise<unknown>[]
) {
  return base.$extends(
    cache({
      driver: cacheDriver,
      waitUntil(promise) {
        background.push(promise);
      },
    })
  );
}

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** One board holding two cards, one of them matching the filter. */
async function seedWorld(client: ReturnType<typeof buildClient>) {
  await client.card.create({ data: { id: 1, label: "del-seed" } });
  await client.card.create({ data: { id: 2, label: "keep" } });
  await client.board.create({ data: { id: 1, name: "main" } });
  await client.board.update({
    where: { id: 1 },
    data: { cards: { connect: [{ id: 1 }, { id: 2 }] } },
  });
}

async function createWorld(plantsLeft: number): Promise<World> {
  const database = new Database(":memory:");
  const driver = new StaleBatchSQLiteDriver({ client: database });
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("U6.5 world schema did not apply");
  await seedWorld(client);
  driver.reset();
  driver.plantsLeft = plantsLeft;
  driver.planted = 0;
  return {
    driver,
    client,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

/** The same world on the weak native batch, with the cache rail attached. */
async function createCachedWeakWorld(plantsLeft: number): Promise<CachedWorld> {
  const database = new Database(":memory:");
  const driver = new WeakBatchSQLiteDriver({ client: database });
  const base = buildClient(driver);
  const migration = await syncLiveSchema(base);
  if (!migration.applied)
    throw new Error("U6.5 weak world schema did not apply");
  await seedWorld(base);
  const cacheDriver = new RecordingCache();
  const background: Promise<unknown>[] = [];
  const client = buildCachedClient(base, cacheDriver, background);
  driver.reset();
  driver.plantsLeft = plantsLeft;
  driver.planted = 0;
  cacheDriver.invalidations.length = 0;
  return {
    cacheDriver,
    client,
    driver,
    async settle() {
      await Promise.allSettled(background.splice(0));
    },
    async close() {
      await base.$disconnect();
      database.close();
    },
  };
}

/** The refusal an operation published, for the meta it carries. */
async function refusalOf(run: () => PromiseLike<unknown>): Promise<Error> {
  try {
    await run();
  } catch (failure) {
    return failure as Error;
  }
  throw new Error("the operation published instead of refusing");
}

/** The public record-series report of a published failure, if it has one. */
function progressOf(failure: Error): Record<string, unknown> | undefined {
  return (
    failure as {
      meta?: { recordSeriesProgress?: Record<string, unknown> };
    }
  ).meta?.recordSeriesProgress;
}

const removeMatching = (client: World["client"]) =>
  client.board.update({
    where: { id: 1 },
    data: { cards: { deleteMany: { label: { startsWith: "del-" } } } },
  });

/** The same operation, asking the client's cache rail to invalidate. */
const removeMatchingCached = (client: CachedWorld["client"]) =>
  client.board.update({
    cache: { autoInvalidate: true },
    data: { cards: { deleteMany: { label: { startsWith: "del-" } } } },
    where: { id: 1 },
  });

/** The complement guards this operation emitted, one per plan-time capture. */
function guardStatements(driver: StaleBatchSQLiteDriver): string[] {
  return [
    ...new Set(
      driver.statements
        .map((statement) => statement.sql)
        .filter((sql) => COMPLEMENT_GUARD.test(sql))
    ),
  ];
}

describe("integration — a captured member set asserts its own complement", () => {
  it("rides the batch with one raceable complement guard naming the captured keys", async () => {
    world = await createWorld(0);
    await removeMatching(world.client);
    const guards = [
      ...new Set(
        world.driver.statements
          .map((statement) => statement.sql)
          .filter((sql) => COMPLEMENT_GUARD.test(sql))
      ),
    ];
    assert.equal(guards.length, 1);
    // The complement is the captured set's own negation, not a re-read of the
    // filter: the guard names the key it captured.
    assert.match(guards[0]!, FIRST_EXCLUDED_KEY);
    // And with nothing racing it, the operation is unaffected.
    const left = await world.client.card.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      left.map((row) => row.id),
      [2]
    );
  });

  it("aborts once on a member added after the plan-time read, then converges", async () => {
    world = await createWorld(1);
    await removeMatching(world.client);
    assert.equal(world.driver.planted, 1);
    // TWO plan-time captures, and the second one's complement excludes BOTH
    // keys: the recovery re-planned from the admitted values with a fresh
    // occurrence tree, over the larger set the race produced (D-25). A replay
    // of the first tree could not have re-derived its members at all.
    const guards = guardStatements(world.driver);
    assert.equal(guards.length, 2);
    assert.equal((guards[0]!.match(EXCLUDED_KEY) ?? []).length, 1);
    assert.equal((guards[1]!.match(EXCLUDED_KEY) ?? []).length, 2);
    const left = await world.client.card.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      left.map((row) => row.label),
      ["keep"]
    );
    const remaining = await world.client.board.findUniqueOrThrow({
      where: { id: 1 },
      include: { cards: true },
    });
    assert.deepEqual(
      remaining.cards.map((row) => row.id),
      [2]
    );
  });

  it("proves every premise inside the unit that carries its write", async () => {
    // Arnaud's D-29. The plan-time membership read is preceded by another
    // planning read (the parent's demanded values), and the operation has
    // already queued the root's presence premise by then. That premise must
    // not ride the planning round trip: proved there, it would be answered
    // against a world the write has not reached, and the window every
    // staleness premise exists for would close before it opened — which is
    // exactly how the live `pg filtered m2m deleteMany staleness` cell used to
    // miss its own race.
    world = await createWorld(0);
    await removeMatching(world.client);
    const proving = world.driver.batches.filter((batch) =>
      batch.some((sql) => PREMISE.test(sql))
    );
    assert.equal(proving.length, 1);
    assert.ok(proving[0]!.some((sql) => MUTATION.test(sql)));
    // And the planning reads that precede it are reads: no batch of this
    // operation is dispatched before the unit.
    assert.equal(world.driver.batches.indexOf(proving[0]!), 0);
  });

  it("reports no progress for a batch rejected at a premise, and keeps it for one rejected at a write", async () => {
    // The D-29 progress companion, on the ONLY transport that can reach it: a
    // WEAK native batch (no ordered committed segments) whose rejection carries
    // the statement index the base loop attaches. The companion decides TWO
    // public observables, so both are pinned here — the failure's own
    // record-series report, and the client's cache rail, which the transport
    // notifies through `ExecutionBinding.writeOutcome`
    // (`g4/unit02/uncertain-outcome-meta.test.ts` cell 3 is the seam's own
    // pin). A batch that rejected AT a premise with nothing but premises ahead
    // of it wrote nothing: there is no progress to report and nothing to
    // invalidate. A batch rejected AT a WRITE keeps the uncertainty it always
    // had.
    const premise = await createCachedWeakWorld(2);
    try {
      const refusal = await refusalOf(() =>
        removeMatchingCached(premise.client)
      );
      await premise.settle();
      assert.match(refusal.message, ADDED_MEMBER);
      assert.equal(progressOf(refusal), undefined);
      assert.deepEqual(premise.cacheDriver.invalidations, []);
      // And the allowance was spendable at all because of it: an operation
      // told it may have written is refused its recovery by progress alone
      // (D-25), so it would never reach the second race.
      assert.equal(premise.driver.planted, 2);
    } finally {
      await premise.close();
    }
    const write = await createCachedWeakWorld(0);
    try {
      write.driver.failAtFirstWrite = true;
      const refusal = await refusalOf(() => removeMatchingCached(write.client));
      await write.settle();
      const progress = progressOf(refusal);
      assert.ok(progress, `no record-series progress: ${refusal.message}`);
      assert.equal(progress.mayHaveCommittedSegment, true);
      assert.equal(write.cacheDriver.invalidations.length, 1);
    } finally {
      await write.close();
    }
  });

  it("spends the allowance once: a second consecutive race propagates", async () => {
    world = await createWorld(2);
    const racing = world.client;
    await assert.rejects(
      async () => {
        await removeMatching(racing);
      },
      (error: Error) => ADDED_MEMBER.test(error.message)
    );
    assert.equal(world.driver.planted, 2);
    // Exactly two plan-time captures: the allowance is spent once per
    // OPERATION, and the re-planned attempt's own interpreter brings no second
    // one with it.
    assert.equal(guardStatements(world.driver).length, 2);
    // And nothing was written: the abort rolled its atomic unit back.
    const left = await world.client.card.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      left.map((row) => row.id),
      [1, 2, 900, 901]
    );
  });
});
