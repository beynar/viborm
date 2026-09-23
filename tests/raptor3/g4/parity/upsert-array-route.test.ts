/**
 * D-46 — a top-level upsert on the ARRAY route of a batch-only transport.
 *
 * `client.$transaction([…])` on a driver with no callback transactions packages
 * every operation for one native batch. The conditional upsert form (a locate,
 * two arms with their premises, a terminal read) cannot be packaged: the array
 * owner prepares before anything runs, so the form answered "unbatchable". The
 * engine replaced served that route with its two top-level upsert paths, and
 * `CommandPlanner.rootUpsert` restates them at one owner:
 *
 *  1. the `ON CONFLICT` fold — one targeted conflict statement, when the
 *     `where` names one constraint that the create spells with the same
 *     primitive values and the update is set-only;
 *  2. otherwise probe-first — the locate read runs at preparation, directly,
 *     and the selected scalar arm rides the batch as ONE statement with
 *     RETURNING: the create arm through the folded root INSERT, the found arm
 *     through the folded root UPDATE with its packaged presence premise.
 *
 * Shapes outside both paths (a relation-bearing arm, an empty update, a
 * conditional filter) keep the conditional form and, on this route, its
 * existing answer. The live route is untouched: its pins stay as they are.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { TransactionError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const shelf = s
  .model({
    id: s.string().id(),
    label: s.string().unique(),
    books: s.toMany(() => book),
  })
  .map("d46_shelves");

const book = s
  .model({
    id: s.string().id(),
    title: s.string(),
    shelfId: s.string().nullable(),
    shelf: s
      .toOne(() => shelf)
      .fields("shelfId")
      .references("id"),
  })
  .map("d46_books");

const entry = s
  .model({
    id: s.int().id().increment(),
    code: s.string().unique(),
    label: s.string(),
  })
  .map("d46_entries");

const schema = { entry, shelf, book };

const SELECT = /^SELECT/;
const INSERT = /^INSERT/;
const INSERT_INTO = /^INSERT INTO/;
const UPDATE = /^UPDATE/;
const RETURNING = /RETURNING/;
const ON_CONFLICT = /ON CONFLICT/;

/**
 * The array route's transport: a native batch, no callback transaction. The
 * recording base logs a batch's statements twice (once per batch, once per
 * statement the batch executes), so this driver keeps the two facts the cells
 * ask about apart: the statements sent DIRECTLY, in order, and each batch's
 * own statement list.
 */
class BatchOnlyDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly direct: string[] = [];
  readonly batches: string[][] = [];
  private inBatch = false;

  override reset(): void {
    super.reset();
    this.direct.length = 0;
    this.batches.length = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (!this.inBatch) this.direct.push(statement);
    return super.execute<T>(client, statement, parameters, context);
  }

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => query.sql));
    this.inBatch = true;
    try {
      return await super.executeBatch<T>(client, queries, context);
    } finally {
      this.inBatch = false;
    }
  }
}

/**
 * A concurrent writer between the planning read and the batch: the captured
 * row is deleted by the time the batch runs, so the found arm's packaged
 * presence premise must fail the batch instead of updating nothing silently.
 */
class RacingDriver extends BatchOnlyDriver {
  raceDeletes: number | undefined;
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    if (this.raceDeletes !== undefined) {
      client
        .prepare("DELETE FROM d46_entries WHERE id = ?")
        .run(this.raceDeletes);
      this.raceDeletes = undefined;
    }
    return super.executeBatch<T>(client, queries, context);
  }
}

interface World<D extends BatchOnlyDriver> {
  readonly database: Database.Database;
  readonly driver: D;
  readonly client: ReturnType<typeof buildClient>;
  close(): Promise<void>;
}

function buildClient(driver: BatchOnlyDriver) {
  return createClient({ schema, driver });
}

let world: World<BatchOnlyDriver> | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function createWorld<D extends BatchOnlyDriver>(
  make: (database: Database.Database) => D
): Promise<World<D>> {
  const database = new Database(":memory:");
  const driver = make(database);
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("D-46 world schema did not apply");
  await client.entry.create({ data: { code: "seed", label: "seeded" } });
  driver.reset();
  return {
    database,
    driver,
    client,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

function stored(database: Database.Database): unknown[] {
  return database
    .prepare("SELECT id, code, label FROM d46_entries ORDER BY id")
    .all();
}

describe("D-46 — an upsert on the array route of a batch-only transport", () => {
  it("probe-first, create arm: the locate runs at preparation and the arm is ONE INSERT … RETURNING in the batch", async () => {
    world = await createWorld(
      (database) => new BatchOnlyDriver({ client: database })
    );
    const { client, driver, database } = world;
    const [upserted, created] = await client.$transaction([
      client.entry.upsert({
        where: { id: 999 },
        create: { code: "u", label: "upserted" },
        update: { label: "must-not-run" },
        select: { id: true, label: true },
      }),
      client.entry.create({
        data: { code: "c", label: "created" },
        select: { id: true, label: true },
      }),
    ]);
    assert.deepEqual(upserted, { id: 2, label: "upserted" });
    assert.deepEqual(created, { id: 3, label: "created" });
    // One planning read, direct; then one batch of exactly two writes, each
    // carrying its own RETURNING — no terminal read-back after either.
    assert.equal(driver.direct.length, 1, driver.direct.join(" | "));
    assert.match(driver.direct[0]!, SELECT);
    assert.equal(driver.batches.length, 1);
    const batched = driver.batches[0]!;
    assert.equal(batched.length, 2, batched.join(" | "));
    for (const statement of batched) {
      assert.match(statement, INSERT_INTO);
      assert.match(statement, RETURNING);
    }
    assert.deepEqual(stored(database), [
      { id: 1, code: "seed", label: "seeded" },
      { id: 2, code: "u", label: "upserted" },
      { id: 3, code: "c", label: "created" },
    ]);
  });

  it("probe-first, found arm: the arm is ONE UPDATE … RETURNING by the captured key, and the batch pins the row's presence", async () => {
    world = await createWorld(
      (database) => new BatchOnlyDriver({ client: database })
    );
    const { client, driver, database } = world;
    const [updated] = await client.$transaction([
      client.entry.upsert({
        where: { id: 1 },
        create: { code: "never", label: "never" },
        update: { label: "renamed" },
        select: { id: true, code: true, label: true },
      }),
    ]);
    assert.deepEqual(updated, { id: 1, code: "seed", label: "renamed" });
    assert.equal(driver.direct.length, 1, driver.direct.join(" | "));
    assert.match(driver.direct[0]!, SELECT);
    assert.equal(driver.batches.length, 1);
    const batched = driver.batches[0]!;
    const update = batched.find((statement) => UPDATE.test(statement));
    assert.ok(update, "the found arm is an UPDATE");
    assert.match(update, RETURNING);
    assert.equal(
      batched.filter((statement) => INSERT.test(statement)).length,
      0
    );
    // Nothing after the UPDATE: the RETURNING window IS the result.
    assert.equal(batched.at(-1), update);
    assert.deepEqual(stored(database), [
      { id: 1, code: "seed", label: "renamed" },
    ]);
  });

  it("probe-first, found arm: a row deleted between the locate and the batch fails the batch instead of updating nothing", async () => {
    const racing = await createWorld(
      (database) => new RacingDriver({ client: database })
    );
    world = racing;
    const { client, driver, database } = racing;
    driver.raceDeletes = 1;
    await assert.rejects(
      client.$transaction([
        client.entry.upsert({
          where: { id: 1 },
          create: { code: "never", label: "never" },
          update: { label: "renamed" },
        }),
      ]),
      (error: unknown) => error instanceof Error
    );
    assert.deepEqual(stored(database), []);
  });

  it("the ON CONFLICT fold: a where naming one constraint the create spells is ONE statement, inserting then updating", async () => {
    world = await createWorld(
      (database) => new BatchOnlyDriver({ client: database })
    );
    const { client, driver, database } = world;
    const args = {
      where: { code: "k1" },
      create: { code: "k1", label: "first" },
      update: { label: "second" },
      select: { code: true, label: true },
    } as const;
    const [inserted] = await client.$transaction([client.entry.upsert(args)]);
    assert.deepEqual(inserted, { code: "k1", label: "first" });
    assert.equal(
      driver.direct.length,
      0,
      `no planning read: ${driver.direct.join(" | ")}`
    );
    assert.equal(driver.batches.length, 1);
    assert.equal(driver.batches[0]!.length, 1, driver.batches[0]!.join(" | "));
    const fold = driver.batches[0]![0]!;
    assert.match(fold, INSERT_INTO);
    assert.match(fold, ON_CONFLICT);
    assert.match(fold, RETURNING);
    driver.reset();
    const [updated] = await client.$transaction([client.entry.upsert(args)]);
    assert.deepEqual(updated, { code: "k1", label: "second" });
    assert.equal(driver.direct.length, 0);
    assert.deepEqual(
      driver.batches.map((batch) => batch.length),
      [1]
    );
    assert.deepEqual(stored(database), [
      { id: 1, code: "seed", label: "seeded" },
      { id: 2, code: "k1", label: "second" },
    ]);
  });

  it("outside both paths, the route keeps its existing answer: an empty update is still unbatchable here", async () => {
    world = await createWorld(
      (database) => new BatchOnlyDriver({ client: database })
    );
    const { client } = world;
    await assert.rejects(
      client.$transaction([
        client.entry.upsert({
          where: { id: 1 },
          create: { code: "never", label: "never" },
          update: {},
        }),
      ]),
      (error: unknown) =>
        error instanceof TransactionError &&
        error.message.includes("does not support callback transactions")
    );
  });

  it("the boundary the review measured: a relation-bearing member elsewhere in the array keeps the unbatchable refusal, never a false absence", async () => {
    // Only the upsert locate may read at preparation. A `connect` to a row an
    // EARLIER member of the same array inserts must not run its planning read
    // early (it would answer a false "not found"); the interpreter's reads keep
    // refusing preparation, so the route's answer stays the honest refusal.
    world = await createWorld(
      (database) => new BatchOnlyDriver({ client: database })
    );
    const { client, database } = world;
    await client.book.create({ data: { id: "b1", title: "one" } });
    await assert.rejects(
      client.$transaction([
        client.shelf.create({ data: { id: "s1", label: "fiction" } }),
        client.book.update({
          where: { id: "b1" },
          data: { shelf: { connect: { label: "fiction" } } },
        }),
      ]),
      (error: unknown) =>
        error instanceof TransactionError &&
        error.message.includes("does not support callback transactions")
    );
    assert.deepEqual(database.prepare("SELECT id FROM d46_shelves").all(), []);
  });
});
