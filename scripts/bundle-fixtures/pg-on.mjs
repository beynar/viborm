// Fixture (l) — pg-representative with `viborm/on` applied: its difference
// from (c) is what installing write hooks costs an application.

import { on } from "../../dist/on.mjs";
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

export const synced = [];

export const client = createClient({
  schema: { user, post },
  databaseUrl: "postgres://localhost:5432/app",
}).$extends(
  on({
    post: {
      create: (rows) => {
        synced.push(...rows);
      },
    },
  })
);

export async function run() {
  const users = await client.user.findMany({
    where: { email: { contains: "@example.com" } },
    include: { posts: true },
  });
  return client.post.create({
    data: { title: "hello", authorId: users[0].id },
  });
}
