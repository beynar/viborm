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
import { createClient } from "@src/client/client";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { permissions } from "@src/permissions";
import { s } from "@src/schema";
import { v } from "@src/validation";
import { beforeAll, expect, test } from "vitest";

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
  driver: new D1Driver({ database: (env as any).DB }),
});

beforeAll(async () => {
  const pushed = await createMigrationClient(base as any).push({
    dryRun: true,
  });
  for (const statement of pushed.statements)
    await (env as any).DB.prepare(statement.sql).run();
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

test.each([
  ["the client", (client: any) => client],
  [
    "a governed view",
    (client: any) => client.$extends(policy).$as({ userId: "alice" }),
  ],
])("a delete answering its links deletes and answers, through %s", async (_, view) => {
  await linkedPost("d");
  const deleted = await view(base).post.delete({
    where: { id: "d" },
    include: { tags: { orderBy: { id: "asc" } } },
  });
  expect(deleted.id).toBe("d");
  expect(deleted.tags.map((row: { id: string }) => row.id)).toEqual(
    _ === "the client" ? ["t1", "t2"] : ["t1"]
  );
  expect(await base.post.findUnique({ where: { id: "d" } })).toBeNull();
});
