/**
 * Parity lane X — U6.2 and U6.3 falsifiers.
 *
 * U6.2: a nested `updateMany`/`deleteMany` whose payload names no relation is
 * ONE correlated statement at its own position in the declared body order, so
 * it manufactures no planning read for the dependency analyser to refuse. The
 * refusal itself is untouched: a relation-bearing nested `updateMany` still
 * captures, and a genuine one-operation feedback loop still raises the
 * registered `NestedWriteError`.
 *
 * U6.3: `docs/architecture/retired/write-engine-ATOM.md` §12 "Same-operation duplicate" — first-create-wins locally, the
 * later entry adopts that row; an entry whose target an earlier entry only
 * HAPPENS to produce is still a feedback loop and still refuses.
 *
 * U6.6 (round 2): a `skipDuplicates` member whose target row already exists
 * writes the MEMBERSHIP it declared against that existing row and nothing else
 * — its nested RECORD children belong to the row that was never created, which
 * is what the shipped engine did (a relation-bearing row went to a series and a
 * skipped root stranded nothing).
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { NestedWriteError, UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("lanex_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    rank: s.int(),
    authorId: s.int().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    tags: s.toMany(() => tag),
  })
  .map("lanex_posts");

const tag = s
  .model({
    id: s.int().id(),
    label: s.string(),
    postId: s.int().nullable(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  })
  .map("lanex_tags");

const board = s
  .model({
    id: s.int().id(),
    name: s.string(),
    cards: s.toMany(() => card),
  })
  .map("lanex_boards");

const card = s
  .model({
    id: s.int().id(),
    label: s.string(),
    boards: s.toMany(() => board),
    notes: s.toMany(() => note),
  })
  .map("lanex_cards");

const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    cardId: s.int().nullable(),
    card: s
      .toOne(() => card)
      .fields("cardId")
      .references("id"),
  })
  .map("lanex_notes");

const schema = { author, post, tag, board, card, note };

/**
 * Plants the row a nested `connectOrCreate` decided to CREATE, in the window
 * between its decision read and its INSERT — the create-branch race, made
 * deterministic. `plantsLeft` is how many attempts lose it.
 */
class RacingSQLiteDriver extends RecordingSQLiteDriver {
  plantsLeft = 1;
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.plantsLeft > 0 && TAG_INSERT.test(statement)) {
      this.plantsLeft--;
      client
        .prepare(
          'INSERT INTO "lanex_tags" ("id","label","postId") VALUES (?,?,?)'
        )
        .run(99, "planted-winner", null);
    }
    return super.execute<T>(client, statement, parameters, context);
  }
}

interface World<Driver extends RecordingSQLiteDriver = RecordingSQLiteDriver> {
  readonly driver: Driver;
  readonly client: ReturnType<typeof buildClient>;
  close(): Promise<void>;
}

function buildClient(driver: RecordingSQLiteDriver) {
  return createClient({ schema, driver });
}

async function createRacingWorld(
  plantsLeft: number
): Promise<World<RacingSQLiteDriver>> {
  const database = new Database(":memory:");
  const driver = new RacingSQLiteDriver({ client: database });
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("lane X world schema did not apply");
  driver.reset();
  driver.plantsLeft = plantsLeft;
  return {
    driver,
    client,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

let world: World<RecordingSQLiteDriver> | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function createWorld(): Promise<World> {
  const database = new Database(":memory:");
  const driver = new RecordingSQLiteDriver({ client: database });
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("lane X world schema did not apply");
  await client.author.createMany({
    data: [
      { id: 1, name: "Owner" },
      { id: 2, name: "Other" },
    ],
  });
  await client.post.createMany({
    data: [
      { id: 10, title: "Draft", rank: 1, authorId: 1 },
      { id: 11, title: "Queued", rank: 2, authorId: 1 },
      { id: 12, title: "Queued", rank: 3, authorId: 2 },
    ],
  });
  driver.reset();
  return {
    driver,
    client,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

const TAG_INSERT = /^insert\s+into\s+"lanex_tags"/i;
const POST_UPDATE = /^update\s+"lanex_posts"/i;
const POST_DELETE = /^delete\s+from\s+"lanex_posts"/i;
const POST_SELECT = /^select[\s\S]*"lanex_posts"/i;

function statementsMatching(driver: RecordingSQLiteDriver, pattern: RegExp) {
  return driver.statements.filter((statement) => pattern.test(statement.sql));
}

describe("lane X — nested set mutations", () => {
  it("compiles a nested updateMany to one correlated UPDATE, with no member read", async () => {
    world = await createWorld();
    const { client, driver } = world;

    await client.author.update({
      where: { id: 1 },
      data: {
        posts: {
          updateMany: { where: { title: "Queued" }, data: { rank: 9 } },
        },
      },
    });

    assert.equal(statementsMatching(driver, POST_UPDATE).length, 1);
    assert.equal(statementsMatching(driver, POST_SELECT).length, 0);
    const rows = await client.post.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      rows.map((row) => [row.id, row.rank]),
      [
        [10, 1],
        [11, 9],
        [12, 3],
      ]
    );
  });

  it("compiles a nested deleteMany to one correlated DELETE, with no member read", async () => {
    world = await createWorld();
    const { client, driver } = world;

    await client.author.update({
      where: { id: 1 },
      data: { posts: { deleteMany: { title: "Queued" } } },
    });

    assert.equal(statementsMatching(driver, POST_DELETE).length, 1);
    assert.equal(statementsMatching(driver, POST_SELECT).length, 0);
    const rows = await client.post.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      rows.map((row) => row.id),
      [10, 12]
    );
  });

  it("runs a sibling update before the updateMany that filters on what it wrote", async () => {
    world = await createWorld();
    const { client } = world;

    await client.author.update({
      where: { id: 1 },
      data: {
        posts: {
          update: { where: { id: 10 }, data: { title: "Updated one" } },
          updateMany: {
            where: { title: "Queued" },
            data: { title: "Updated many" },
          },
        },
      },
    });

    const rows = await client.post.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      rows.map((row) => row.title),
      ["Updated one", "Updated many", "Queued"]
    );
  });

  it("still refuses a relation-bearing updateMany that reads what a sibling update wrote", async () => {
    world = await createWorld();
    const { client } = world;

    await assert.rejects(
      async () => {
        await client.author.update({
          where: { id: 1 },
          data: {
            posts: {
              update: { where: { id: 10 }, data: { title: "Moved" } },
              updateMany: {
                where: { title: "Moved" },
                data: {
                  rank: 7,
                  tags: { createMany: { data: [{ id: 30, label: "t" }] } },
                },
              },
            },
          },
        });
      },
      (error: unknown) =>
        error instanceof NestedWriteError &&
        error.message ===
          "Nested operation 'updateMany' on relation 'posts' depends on an earlier 'update' target write in the same nested write. Split these operations into separate queries."
    );
    const rows = await client.post.findMany({ where: { title: "Moved" } });
    assert.equal(rows.length, 0);
  });

  it("collapses duplicate connectOrCreate targets to the first entry's row", async () => {
    world = await createWorld();
    const { client } = world;

    await client.author.update({
      where: { id: 2 },
      data: {
        posts: {
          connectOrCreate: [
            {
              where: { id: 40 },
              create: { id: 40, title: "first-create-wins", rank: 1 },
            },
            {
              where: { id: 40 },
              create: { id: 40, title: "adopted", rank: 2 },
            },
          ],
        },
      },
    });

    const created = await client.post.findMany({ where: { id: 40 } });
    assert.equal(created.length, 1);
    assert.equal(created[0]!.title, "first-create-wins");
    assert.equal(created[0]!.authorId, 2);
  });

  it("recovers a lost create race once, in a fresh region", async () => {
    const racing = await createRacingWorld(1);
    world = racing;
    const { client, driver } = racing;

    const created = await client.post.create({
      data: {
        id: 70,
        title: "converged",
        rank: 1,
        tags: {
          connectOrCreate: {
            where: { id: 99 },
            create: { id: 99, label: "mine" },
          },
        },
      },
    });

    assert.equal(created.id, 70);
    // The rejection destroyed the first region, so the recovery is a SECOND,
    // fresh one — never a replay inside the aborted transaction.
    assert.equal(driver.transactionCalls, 2);
    assert.equal(driver.plantsLeft, 0);
    const tags = await client.tag.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      tags.map((row) => [row.id, row.postId]),
      [[99, 70]]
    );
  });

  it("spends the recovery allowance once: a second consecutive race propagates", async () => {
    const racing = await createRacingWorld(Number.POSITIVE_INFINITY);
    world = racing;
    const { client, driver } = racing;

    await assert.rejects(
      async () => {
        await client.post.create({
          data: {
            id: 71,
            title: "lost twice",
            rank: 1,
            tags: {
              connectOrCreate: {
                where: { id: 99 },
                create: { id: 99, label: "mine" },
              },
            },
          },
        });
      },
      (error: unknown) => error instanceof UniqueConstraintError
    );
    assert.equal(driver.transactionCalls, 2);
    assert.equal((await client.post.findMany({})).length, 0);
  });

  it("still refuses a connectOrCreate whose target a different earlier entry creates", async () => {
    world = await createWorld();
    const { client } = world;

    await assert.rejects(
      async () => {
        await client.author.update({
          where: { id: 2 },
          data: {
            posts: {
              connectOrCreate: [
                {
                  where: { id: 51 },
                  create: { id: 50, title: "elsewhere", rank: 1 },
                },
                {
                  where: { id: 50 },
                  create: { id: 50, title: "collides", rank: 2 },
                },
              ],
            },
          },
        });
      },
      (error: unknown) =>
        error instanceof NestedWriteError &&
        error.message ===
          "Nested operation 'connectOrCreate' on relation 'posts' depends on an earlier 'connectOrCreate' target write in the same nested write. Split these operations into separate queries."
    );
    assert.equal((await client.post.findMany({ where: { id: 50 } })).length, 0);
  });

  it("writes a suppressed member's membership but not its nested record children", async () => {
    world = await createWorld();
    const { client } = world;
    await client.board.createMany({
      data: [
        { id: 1, name: "left" },
        { id: 2, name: "right" },
      ],
    });
    await client.card.create({
      data: { id: 60, label: "existing", boards: { connect: { id: 1 } } },
    });

    await client.board.update({
      where: { id: 2 },
      data: {
        cards: {
          createMany: {
            data: [
              {
                id: 60,
                label: "duplicate",
                notes: { create: { id: 90, body: "stranded" } },
              },
            ],
            skipDuplicates: true,
          },
        },
      },
    });

    const existing = await client.card.findUnique({
      where: { id: 60 },
      include: { boards: { orderBy: { id: "asc" } }, notes: true },
    });
    assert.ok(existing);
    // The INSERT was suppressed, so the row is the one that was already there
    // and the nested record write this member declared belongs to the row that
    // was never created.
    assert.equal(existing.label, "existing");
    assert.deepEqual(existing.notes, []);
    // The membership the member declared IS written, against that existing row.
    assert.deepEqual(
      existing.boards.map((linked) => linked.id),
      [1, 2]
    );
    assert.equal((await client.note.findMany({})).length, 0);
  });
});
