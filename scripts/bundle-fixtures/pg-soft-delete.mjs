// Fixture (e) — pg-representative with `viborm/soft-delete` applied: its
// difference from (c) is what installing the soft-delete extension costs.

import { createClient } from "../../dist/pg.mjs";
import { s } from "../../dist/schema.mjs";
import { softDelete } from "../../dist/soft-delete.mjs";

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

export const client = softDelete({
  models: { post: { deletedAt: "deletedAt" } },
})(
  createClient({
    schema: { user, post },
    databaseUrl: "postgres://localhost:5432/app",
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
  return client.post.restore({ where: { id: created.id } });
}
