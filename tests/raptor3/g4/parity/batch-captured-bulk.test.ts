/**
 * N4 row 25 (the refusals plan §4, D-52) — a selected bulk mutation that needs
 * a plan-time capture runs on a batch-only transport.
 *
 * A selected `deleteMany` / `updateMany` the provider cannot answer with
 * RETURNING reads the rows it is about to change before it changes them, and
 * an interactive session protected that capture with `FOR UPDATE`. A
 * batch-only transport (D1, PlanetScale, Neon) holds no lock across two
 * statements, so the engine refused it outright — `Driver 'x' cannot
 * atomically capture selected deleteMany rows.`
 *
 * The execution: the capture is a SEGMENT OF ITS OWN, and the mutation's
 * segment carries the premises the observation requires as statements inside
 * its own batch — every captured row still present and still a member of the
 * selection, and no row joined it — so a stale capture aborts the batch BEFORE
 * the write instead of being found afterwards by a row count. The row-count
 * check stays as the detection it always was, and both state the one
 * registered sentence for the fact.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

/**
 * A PlanetScale-shaped transport, credential-free: a native batch, no
 * interactive transaction, and MySQL's `supportsReturning: false` — the
 * profile on which a selected bulk mutation must capture its rows.
 */
class NonReturningBatchOnlyDriver extends BatchOnlyDriver {
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
  }
}

/** The same transport, with the provider rejecting one statement of the batch. */
class FailingWriteDriver extends NonReturningBatchOnlyDriver {
  failOn?: RegExp;
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    if (this.failOn?.test(statement))
      throw new Error("injected provider failure");
    return super.execute<T>(client, statement, parameters);
  }
}

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post).name("n4pAuthor"),
  })
  .map("n4p_users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("userId")
      .references("id")
      .name("n4pAuthor"),
  })
  .map("n4p_posts");
const schema = { user, post };

const DELETE_POSTS = /^DELETE FROM "n4p_posts"/;
const CHANGED = (verb: string) =>
  `${verb} selected-row cardinality changed during its locked mutation.`;

describe("N4-25: a captured selected bulk mutation on a batch-only transport", () => {
  let driver: BatchOnlyDriver;
  afterEach(async () => {
    await driver?.disconnect();
  });

  async function world(make: () => BatchOnlyDriver) {
    driver = make();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    await client.user.create({ data: { id: "u1", name: "Owner" } });
    await client.post.create({
      data: { id: "p1", title: "One", userId: "u1" },
    });
    await client.post.create({
      data: { id: "p2", title: "Two", userId: "u1" },
    });
    driver.reset();
    return client;
  }
  const remaining = async (client: Awaited<ReturnType<typeof world>>) =>
    (await client.post.findMany({ orderBy: { id: "asc" } })).map(
      (row) => row.id
    );

  it("a selected deleteMany publishes every captured row and removes them", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    assert.deepEqual(
      await client.post.deleteMany({
        where: { userId: "u1" },
        select: { id: true, title: true },
      }),
      [
        { id: "p1", title: "One" },
        { id: "p2", title: "Two" },
      ]
    );
    assert.deepEqual(await remaining(client), []);
  });

  it("a selected updateMany publishes the rows it wrote", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    assert.deepEqual(
      await client.post.updateMany({
        where: { userId: "u1" },
        data: { title: "Renamed" },
        select: { id: true, title: true },
      }),
      [
        { id: "p1", title: "Renamed" },
        { id: "p2", title: "Renamed" },
      ]
    );
  });

  it("a captured row lost between the capture and the batch aborts before the write", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    driver.plant = (database) => {
      database.exec(`DELETE FROM "n4p_posts" WHERE "id" = 'p1'`);
    };
    await assert.rejects(
      async () => {
        await client.post.deleteMany({
          where: { userId: "u1" },
          select: { id: true },
        });
      },
      (error: unknown) =>
        (error as Error).message.includes(CHANGED("deleteMany"))
    );
    // Nothing of the unit committed: the row the race left is still there.
    assert.deepEqual(await remaining(client), ["p2"]);
  });

  it("a row that JOINED the selection after the capture aborts before the write", async () => {
    const client = await world(() => new NonReturningBatchOnlyDriver());
    driver.plant = (database) => {
      database.exec(
        `INSERT INTO "n4p_posts" ("id", "title", "userId") VALUES ('p3', 'Three', 'u1')`
      );
    };
    await assert.rejects(
      async () => {
        await client.post.updateMany({
          where: { userId: "u1" },
          data: { title: "Renamed" },
          select: { id: true },
        });
      },
      (error: unknown) =>
        (error as Error).message.includes(CHANGED("updateMany"))
    );
    assert.deepEqual(
      (await client.post.findMany({ orderBy: { id: "asc" } })).map(
        (row) => row.title
      ),
      ["One", "Two", "Three"]
    );
  });

  it("a relation-bearing selected root delete captures on a RETURNING batch transport too", async () => {
    const client = await world(() => new BatchOnlyDriver());
    assert.deepEqual(
      await client.post.delete({
        where: { id: "p1" },
        include: { author: true },
      }),
      {
        id: "p1",
        title: "One",
        userId: "u1",
        author: { id: "u1", name: "Owner" },
      }
    );
    assert.deepEqual(await remaining(client), ["p2"]);
  });

  it("the live route answers the same rows", async () => {
    const live = new RecordingSQLiteDriver();
    const client = createClient({ schema, driver: live });
    try {
      await syncLiveSchema(client);
      await client.user.create({ data: { id: "u1", name: "Owner" } });
      await client.post.create({
        data: { id: "p1", title: "One", userId: "u1" },
      });
      assert.deepEqual(
        await client.post.delete({
          where: { id: "p1" },
          include: { author: true },
        }),
        {
          id: "p1",
          title: "One",
          userId: "u1",
          author: { id: "u1", name: "Owner" },
        }
      );
    } finally {
      await live.disconnect();
    }
  });

  it("a captured write the provider rejects is no record series of its own: its failure carries no series progress", async () => {
    const failing = new FailingWriteDriver();
    const client = await world(() => failing);
    failing.failOn = DELETE_POSTS;
    const raised = await client.post
      .deleteMany({ where: { userId: "u1" }, select: { id: true } })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    assert.ok(raised instanceof Error, String(raised));
    // The mutation's statement is the operation's set window, as the
    // set-oriented route already states it: a merely uncertain outcome
    // reports nothing (`OperationContext.failure`), the same on both routes
    // of a bulk mutation. The batch rolled back; nothing was written.
    const meta = (raised as { meta?: Record<string, unknown> }).meta ?? {};
    assert.equal(
      Object.hasOwn(meta, "recordSeriesProgress"),
      false,
      JSON.stringify(meta)
    );
    assert.deepEqual(await remaining(client), ["p1", "p2"]);
  });
});
