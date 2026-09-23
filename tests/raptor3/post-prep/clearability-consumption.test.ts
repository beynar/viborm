import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

function clearabilitySchema() {
  const author = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .id(["tenantId", "id"])
    .map("post_g3_clearability_authors");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      tenantId: s.string(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => author)
        .fields("tenantId", "authorId")
        .references("tenantId", "id"),
    })
    .map("post_g3_clearability_posts");
  return { author, post };
}

async function createWorld() {
  const schema = clearabilitySchema();
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  await client.author.create({
    data: { tenantId: "t1", id: "a1", name: "author" },
  });
  await client.author.create({
    data: { tenantId: "t2", id: "a1", name: "unrelated" },
  });
  await client.post.create({
    data: {
      id: "p1",
      title: "departing",
      tenantId: "t1",
      authorId: "a1",
    },
  });
  await client.post.create({
    data: { id: "p2", title: "retained", tenantId: "t1", authorId: "a1" },
  });
  await client.post.create({
    data: { id: "p3", title: "unrelated", tenantId: "t2", authorId: "a1" },
  });
  return {
    candidate: createCommandEngine({ schema, driver }),
    client,
    database,
  };
}

type World = Awaited<ReturnType<typeof createWorld>>;

async function closeWorld(world: World): Promise<void> {
  await world.client.$disconnect();
  world.database.close();
}

async function postState(world: World) {
  return world.client.post.findMany({
    where: { tenantId: "t1" },
    orderBy: { id: "asc" },
    select: { id: true, tenantId: true, authorId: true },
  });
}

async function assertUnrelatedTenant(world: World): Promise<void> {
  assert.deepEqual(
    await world.client.post.findUnique({
      where: { id: "p3" },
      select: { tenantId: true, authorId: true },
    }),
    { tenantId: "t2", authorId: "a1" },
  );
}

describe("post-G3 authoritative clearability consumption", () => {
  it("direct disconnect clears only the nullable compound member", async () => {
    const world = await createWorld();
    try {
      await world.candidate.execute("post", "update", {
        where: { id: "p1" },
        data: { author: { disconnect: true } },
        select: { id: true },
      });
      assert.deepEqual(await postState(world), [
        { id: "p1", tenantId: "t1", authorId: null },
        { id: "p2", tenantId: "t1", authorId: "a1" },
      ]);
      await assertUnrelatedTenant(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("inverse disconnect preserves required context and unrelated tenant", async () => {
    const world = await createWorld();
    try {
      await world.candidate.execute("author", "update", {
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { disconnect: { id: "p1" } } },
        select: { tenantId: true, id: true },
      });
      assert.deepEqual(await postState(world), [
        { id: "p1", tenantId: "t1", authorId: null },
        { id: "p2", tenantId: "t1", authorId: "a1" },
      ]);
      assert.equal(
        await world.client.author.count({ where: { tenantId: "t2" } }),
        1,
      );
      await assertUnrelatedTenant(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("set departures clear only the nullable member and retain selected rows", async () => {
    const world = await createWorld();
    try {
      await world.candidate.execute("author", "update", {
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { set: [{ id: "p2" }] } },
        select: { tenantId: true, id: true },
      });
      assert.deepEqual(await postState(world), [
        { id: "p1", tenantId: "t1", authorId: null },
        { id: "p2", tenantId: "t1", authorId: "a1" },
      ]);
      await assertUnrelatedTenant(world);
    } finally {
      await closeWorld(world);
    }
  });

  it("parent-held delete cleanup retains context before deleting the target", async () => {
    const world = await createWorld();
    try {
      await world.client.post.delete({ where: { id: "p2" } });
      await world.candidate.execute("post", "update", {
        where: { id: "p1" },
        data: { author: { delete: true } },
        select: { id: true },
      });
      assert.deepEqual(await postState(world), [
        { id: "p1", tenantId: "t1", authorId: null },
      ]);
      assert.equal(
        await world.client.author.count({
          where: { tenantId: "t1", id: "a1" },
        }),
        0,
      );
      await assertUnrelatedTenant(world);
    } finally {
      await closeWorld(world);
    }
  });
});
