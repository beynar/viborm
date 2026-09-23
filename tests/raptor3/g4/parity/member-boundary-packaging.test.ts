/**
 * N5 — a member boundary is the MEMBER's, and a dispatch commits the whole
 * queue.
 *
 * On a batch-only transport a dispatch is a committed segment. A boundary taken
 * at every member therefore made durable whatever was already waiting: a nested
 * `createMany` of literal rows dispatched [INSERT board, INSERT post#1] at the
 * first member, and the second row's duplicate key then left the parent and its
 * first child behind, where the interactive route rolls the whole operation
 * back. So the packaging boundary `executeMember` would take at a member's end
 * is DEFERRED while an enclosing write waits (a series of literal rows is one
 * unit with its parent, and D-51's "one result" holds for it on both routes),
 * and the boundary a later member's observation needs is taken by the
 * OBSERVING member, in `OperationContext.answer`, whenever another record of
 * the series left a write waiting — a succession of segments, which D-51
 * admits as packaging. What that succession leaves committed behind a later
 * failure differs by route, and the last cell pins both states.
 *
 * The controls beside it are what keep that packaging honest. A series whose
 * members really do need the boundary — a later member's `connectOrCreate`
 * probe must see the row an earlier member created — still segments, and still
 * answers with one author row, and it does so WHATEVER the enclosing record is
 * doing: under a parent whose `data` carries only the relation, under a parent
 * that also writes a scalar of its own, and under a `create` whose parent row
 * is itself the pending write. The boundary such a member earns is deferred by
 * the enclosing write, never dropped — the probe is answered outside the queue,
 * so the queue is dispatched before it is asked. The two latter shapes are the
 * regression this file exists to keep out: they answered
 * `UniqueConstraintError` with a second `INSERT INTO "n5mb_authors"` in one
 * dispatched unit, where the interactive twin answered `ok`.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { UniqueConstraintError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

const author = s
  .model({
    id: s.int().id().increment(),
    name: s.string().unique(),
    posts: s.toMany(() => post),
  })
  .map("n5mb_authors");
const board = s
  .model({
    id: s.string().id(),
    label: s.string().nullable(),
    posts: s.toMany(() => post),
  })
  .map("n5mb_boards");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    boardId: s.string().nullable(),
    board: s
      .toOne(() => board)
      .fields("boardId")
      .references("id"),
    authorId: s.int().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("n5mb_posts");
const schema = { author, board, post };

/** Counts the units the transport was asked to make durable. */
class SegmentCountingDriver extends BatchOnlyDriver {
  segments = 0;
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.segments++;
    return super.executeBatch<T>(client, queries);
  }
}

describe("N5: the member boundary on a batch-only transport", () => {
  let driver: SegmentCountingDriver;
  afterEach(async () => {
    await driver?.disconnect();
  });

  async function world() {
    driver = new SegmentCountingDriver();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    return client;
  }

  it("a nested createMany of literal rows is ONE unit with its parent", async () => {
    const client = await world();
    driver.segments = 0;
    await assert.rejects(async () => {
      await client.board.create({
        data: {
          id: "b1",
          posts: {
            createMany: {
              data: [
                { id: "dup", title: "First" },
                { id: "dup", title: "Duplicate" },
              ],
            },
          },
        },
      });
    });
    assert.equal(driver.segments, 1, "one dispatched unit, not one per member");
    assert.deepEqual(await client.board.findMany(), []);
    assert.deepEqual(await client.post.findMany(), []);
  });

  /** The series whose second member's probe must SEE the first member's row. */
  const observing = [
    {
      id: "p1",
      title: "first",
      author: { create: { name: "shared" } },
    },
    {
      id: "p2",
      title: "second",
      author: {
        connectOrCreate: {
          where: { name: "shared" },
          create: { name: "shared" },
        },
      },
    },
  ];

  /** What the world holds after an observing series: read once, asserted in each cell. */
  async function observedState(client: Awaited<ReturnType<typeof world>>) {
    const authors = await client.author.findMany({ select: { name: true } });
    const posts = await client.post.findMany({
      orderBy: { id: "asc" },
      select: { id: true, boardId: true, authorId: true },
    });
    return {
      authors,
      posts: posts.map((row) => [row.id, row.boardId, row.authorId !== null]),
      oneAuthor: posts[0]?.authorId === posts[1]?.authorId,
      // a series whose members observe each other still segments
      segmented: driver.segments > 1,
    };
  }
  /** One author row, both posts on the board, both pointing at that author. */
  const ONE_SHARED_AUTHOR = {
    authors: [{ name: "shared" }],
    posts: [
      ["p1", "b1", true],
      ["p2", "b1", true],
    ],
    oneAuthor: true,
    segmented: true,
  };

  it("a member a later member must SEE still takes its boundary", async () => {
    const client = await world();
    await client.board.create({ data: { id: "b1" } });
    driver.segments = 0;
    await client.board.update({
      where: { id: "b1" },
      data: { posts: { createMany: { data: observing } } },
    });
    assert.deepEqual(await observedState(client), ONE_SHARED_AUTHOR);
  });

  it("it takes it while the parent's own write is still pending", async () => {
    const client = await world();
    await client.board.create({ data: { id: "b1", label: "before" } });
    driver.segments = 0;
    await client.board.update({
      where: { id: "b1" },
      data: { label: "new", posts: { createMany: { data: observing } } },
    });
    assert.deepEqual(await observedState(client), ONE_SHARED_AUTHOR);
    assert.deepEqual(await client.board.findMany({ select: { label: true } }), [
      { label: "new" },
    ]);
  });

  it("it takes it where the parent row is itself the pending write", async () => {
    const client = await world();
    driver.segments = 0;
    await client.board.create({
      data: {
        id: "b1",
        label: "fresh",
        posts: { createMany: { data: observing } },
      },
    });
    assert.deepEqual(await observedState(client), ONE_SHARED_AUTHOR);
    assert.deepEqual(await client.board.findMany({ select: { label: true } }), [
      { label: "fresh" },
    ]);
  });

  it("an observing series that then fails: the interactive route rolls back, the batch route keeps the committed prefix (D-51)", async () => {
    // The boundary the observing member claimed made the board, the first post
    // and the author durable on a batch-only transport; the interactive route
    // holds one transaction and rolls everything back. D-51's "one result"
    // is the answer (both routes reject), not what stands committed behind it.
    const failing = [...observing, { id: "p1", title: "duplicate" }];
    for (const [route, make, durable] of [
      ["interactive", () => new RecordingSQLiteDriver(), false],
      ["batch-only", () => new SegmentCountingDriver(), true],
    ] as const) {
      const live = make();
      const client = createClient({ schema, driver: live });
      await syncLiveSchema(client);
      await assert.rejects(
        async () => {
          await client.board.create({
            data: {
              id: "b1",
              label: "fresh",
              posts: { createMany: { data: failing } },
            },
          });
        },
        UniqueConstraintError,
        route
      );
      assert.deepEqual(
        await client.board.findMany({ select: { id: true } }),
        durable ? [{ id: "b1" }] : [],
        route
      );
      assert.deepEqual(
        await client.post.findMany({ select: { id: true } }),
        durable ? [{ id: "p1" }] : [],
        route
      );
      assert.deepEqual(
        await client.author.findMany({ select: { name: true } }),
        durable ? [{ name: "shared" }] : [],
        route
      );
      await live.disconnect();
    }
  });
});
