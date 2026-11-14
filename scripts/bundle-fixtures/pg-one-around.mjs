// Fixture — pg-representative with one extension that declares only a generic
// `query` handler around every call, built with `defineHooks`: its difference
// from (c) is what this one capability costs alone. A measuring instrument
// for scripts/extension-bytes.mjs, not a size-limit row.

import { defineHooks } from "../../dist/index.mjs";
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
});

export const seen = [];

export const client = createClient({
  schema: { user, post },
  databaseUrl: "postgres://localhost:5432/app",
}).$extends(
  defineHooks({
    name: "query",
    async query({ model, operation, proceed }) {
      seen.push([model, operation]);
      return await proceed();
    },
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
  return created;
}
