import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    comments: s.toMany(() => comment).name("subject"),
  })
  .map("g4_vr_posts");

const video = s
  .model({
    id: s.int().id(),
    title: s.string(),
  })
  .map("g4_vr_videos");

const comment = s
  .model({
    id: s.int().id(),
    body: s.string(),
    subject: s
      .toOne(
        { post: () => post, video: () => video },
        { values: { post: "content.post.v1", video: "content.video.v1" } }
      )
      .name("subject")
      .optional(),
  })
  .map("g4_vr_comments");

const schema = { post, video, comment };

function createWorld() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE g4_vr_posts(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE g4_vr_videos(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE g4_vr_comments(
      id INTEGER PRIMARY KEY,
      body TEXT NOT NULL,
      subject_type TEXT,
      subject_id INTEGER
    );
    INSERT INTO g4_vr_posts VALUES (1, 'Post one');
    INSERT INTO g4_vr_videos VALUES (1, 'Video one');
    INSERT INTO g4_vr_comments VALUES (1, 'on post', 'content.post.v1', 1);
    INSERT INTO g4_vr_comments VALUES (2, 'on video', 'content.video.v1', 1);
    INSERT INTO g4_vr_comments VALUES (3, 'unattached', NULL, NULL);
  `);
  const driver = new SQLite3Driver({ client: database });
  return { database, driver, engine: createCommandEngine({ schema, driver }) };
}

async function ids(
  world: ReturnType<typeof createWorld>,
  where: Record<string, unknown>
): Promise<number[]> {
  const rows = (await world.engine.execute("comment", "findMany", {
    where,
    orderBy: { id: "asc" },
    select: { id: true },
  })) as Record<string, unknown>[];
  return rows.map((row) => row.id as number);
}

describe("G4-01 variant slots (Q-W10, Q-S03)", () => {
  it("projects a tagged to-one arm as its own carrier", async () => {
    const world = createWorld();
    try {
      const rows = (await world.engine.execute("comment", "findMany", {
        orderBy: { id: "asc" },
        select: {
          id: true,
          subject: {
            post: { select: { title: true } },
            video: { select: { title: true } },
          },
        },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows, [
        { id: 1, subject: { type: "post", data: { title: "Post one" } } },
        { id: 2, subject: { type: "video", data: { title: "Video one" } } },
        { id: 3, subject: null },
      ]);
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });

  it("filters by a tagged arm and by slot presence", async () => {
    const world = createWorld();
    try {
      assert.deepEqual(await ids(world, { subject: { type: "post" } }), [1]);
      assert.deepEqual(await ids(world, { subject: { type: "video" } }), [2]);
      assert.deepEqual(
        await ids(world, { subject: { type: "post", is: { title: "Post one" } } }),
        [1]
      );
      assert.deepEqual(
        await ids(world, { subject: { type: "post", is: { title: "absent" } } }),
        []
      );
      assert.deepEqual(
        await ids(world, { subject: { type: "post", isNot: { title: "Post one" } } }),
        [2, 3]
      );
      assert.deepEqual(await ids(world, { subject: { is: null } }), [3]);
      assert.deepEqual(await ids(world, { subject: { isNot: null } }), [1, 2]);
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });

  it("keeps the inverse collection exact", async () => {
    const world = createWorld();
    try {
      const rows = (await world.engine.execute("post", "findMany", {
        select: { id: true, comments: { select: { id: true } } },
      })) as Record<string, unknown>[];
      assert.deepEqual(rows, [{ id: 1, comments: [{ id: 1 }] }]);
      const counted = (await world.engine.execute("post", "findMany", {
        select: { id: true, _count: { select: { comments: true } } },
      })) as Record<string, unknown>[];
      assert.deepEqual(counted, [{ id: 1, _count: { comments: 1 } }]);
    } finally {
      await world.driver.disconnect();
      world.database.close();
    }
  });
});
