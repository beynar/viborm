// Fixture — pg-representative with the four official extensions that build
// on public capabilities applied to one client (`on`, `soft-delete`,
// `ordering`, `permissions`): its difference from (c) is what an application
// that uses all of them pays, the code they share counted once.

import { on } from "../../dist/on.mjs";
import { ordering } from "../../dist/ordering.mjs";
import { permissions } from "../../dist/permissions.mjs";
import { createClient } from "../../dist/pg.mjs";
import { s } from "../../dist/schema.mjs";
import { softDelete } from "../../dist/soft-delete.mjs";
import { v } from "../../dist/validation.mjs";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  rank: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  deletedAt: s.dateTime().nullable(),
});

export const synced = [];

const hooked = createClient({
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

const blog = permissions({
  actor: v.object({ userId: v.string(), admin: v.boolean() }),
  models: {
    post: {
      read: {},
      update: { authorId: { actor: "userId" } },
      delete: { authorId: { actor: "userId" } },
      create: { authorId: { actor: "userId" } },
    },
    user: { read: {} },
  },
});

export const client = hooked
  .$extends(softDelete({ models: { post: { deletedAt: "deletedAt" } } }))
  .$extends(ordering({ post: { key: "rank", within: ["authorId"] } }))
  .$extends(blog);

export async function run(session) {
  const call = client.$as({ userId: session.userId, admin: session.admin });
  const users = await call.user.findMany({
    where: { email: { contains: "@example.com" } },
    include: { posts: true },
  });
  const created = await call.post.create({
    data: { title: "hello", authorId: session.userId },
  });
  await call.post.move({ where: { id: created.id }, first: true });
  await call.post.delete({ where: { id: created.id } });
  await call.post.restore({ where: { id: created.id } });
  await call.post.can("update", { id: created.id });
  return users;
}
