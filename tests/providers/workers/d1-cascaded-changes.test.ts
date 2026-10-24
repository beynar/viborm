/**
 * D1's `meta.changes` also counts the rows a foreign key's cascade changed:
 * deleting one post holding two junction rows reports 3, where SQLite's own
 * count is 1. Before 1.4.2 the engine read that count as the statement's
 * own: `deleteMany` over-counted every row with cascading links, and a
 * `delete` answering a relation (a captured DELETE, judged by its count)
 * failed with a cardinality TransactionError after its batch had committed.
 * Such a statement now counts its own rows through `RETURNING`
 * (`capabilities.countsCascadedChanges`).
 */

import { env } from "cloudflare:test";
import type { D1Database } from "@cloudflare/workers-types";
import { createClient } from "@src/client/client";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { permissions } from "@src/permissions";
import { s } from "@src/schema";
import { v } from "@src/validation";
import { beforeAll, expect, test } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const post = s
  .model({
    id: s.string().id(),
    authorId: s.string(),
    tags: s.toMany(() => tag),
  })
  .map("dcc_posts");
const tag = s
  .model({
    id: s.string().id(),
    secret: s.boolean(),
    posts: s.toMany(() => post),
  })
  .map("dcc_tags");

const policy = permissions({
  actor: v.object({ userId: v.string() }),
  models: {
    post: { read: true, delete: { authorId: { actor: "userId" } } },
    tag: { read: { secret: false }, update: { secret: false } },
  },
});

const base = createClient({
  schema: { post, tag },
  driver: new D1Driver({ database: env.DB }),
});

beforeAll(async () => {
  const pushed = await createMigrationClient(base).push({
    dryRun: true,
  });
  for (const statement of pushed.statements)
    await env.DB.prepare(statement.sql).run();
  await base.tag.createMany({
    data: [
      { id: "t1", secret: false },
      { id: "t2", secret: true },
    ],
  });
});

const linkedPost = (id: string) =>
  base.post.create({
    data: {
      id,
      authorId: "alice",
      tags: { connect: [{ id: "t1" }, { id: "t2" }] },
    },
  });

test("deleteMany counts the rows it deleted, not their cascaded links", async () => {
  await linkedPost("a");
  await linkedPost("b");
  await base.post.create({ data: { id: "c", authorId: "bob" } });
  expect(await base.post.deleteMany({})).toEqual({ count: 3 });
  expect(await base.post.count()).toBe(0);
});

test("a delete answering its links deletes and answers", async () => {
  await linkedPost("d");
  const deleted = await base.post.delete({
    where: { id: "d" },
    include: { tags: { orderBy: { id: "asc" } } },
  });
  expect(deleted.tags.map((row) => row.id)).toEqual(["t1", "t2"]);
  expect(await base.post.findUnique({ where: { id: "d" } })).toBeNull();
});

test("a governed delete answering its links deletes and answers the links it reads", async () => {
  await linkedPost("e");
  const deleted = await base
    .$extends(policy)
    .$as({ userId: "alice" })
    .post.delete({
      where: { id: "e" },
      include: { tags: { orderBy: { id: "asc" } } },
    });
  expect(deleted.tags.map((row) => row.id)).toEqual(["t1"]);
  expect(await base.post.findUnique({ where: { id: "e" } })).toBeNull();
});
