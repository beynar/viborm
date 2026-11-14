// Fixture — pg-representative with one extension that declares only a
// `deletion` that turns a post delete into an update, built with
// `defineExtension`: its difference from (c) is what this one capability
// costs alone. A measuring instrument for scripts/extension-bytes.mjs, not a
// size-limit row.

import { defineExtension } from "../../dist/index.mjs";
import { createClient } from "../../dist/pg.mjs";
import { s } from "../../dist/schema.mjs";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  deletedAt: s.dateTime().nullable(),
});

export const client = createClient({
  schema: { user, post },
  databaseUrl: "postgres://localhost:5432/app",
}).$extends(
  defineExtension({
    name: "deletion",
    deletion: { models: { post: { at: "deletedAt" } } },
  })
);

export async function run() {
  const users = await client.user.findMany({
    where: { email: { contains: "@example.com" } },
    include: { posts: true },
  });
  const created = await client.post.create({
    data: { title: "hello", authorId: users[0].id },
  });
  await client.post.delete({ where: { id: created.id } });
  return created;
}
