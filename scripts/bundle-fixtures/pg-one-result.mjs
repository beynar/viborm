// Fixture — pg-representative with one extension that declares only one
// computed `result` field, written as a literal after `enableExtensions()`:
// its difference from (c) is what this one capability costs alone. A
// measuring instrument for scripts/extension-bytes.mjs, not a size-limit row.

import { enableExtensions } from "../../dist/index.mjs";
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

// `defineHooks` and `defineExtension` refuse a `result` today: the definition
// they return is read again by `$extends`, and its frozen `needs` list no
// longer reads as an object. A literal is the public way that works.
enableExtensions();

export const client = createClient({
  schema: { user, post },
  databaseUrl: "postgres://localhost:5432/app",
}).$extends({
  name: "result",
  result: {
    user: {
      handle: {
        needs: { email: true },
        compute: (row) => row.email.split("@")[0],
      },
    },
  },
});

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
