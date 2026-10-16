// Fixture (i) — pg-representative with `viborm/rbac` applied: its difference
// from (c) is what governing an application costs. The policy is the guide's
// blog (one actor schema, owner and an identity-provider claim), bound per
// request with `$as`, with one read, one write and one `can`.

import { createClient } from "../../dist/pg.mjs";
import { rbac } from "../../dist/rbac.mjs";
import { s } from "../../dist/schema.mjs";
import { v } from "../../dist/validation.mjs";

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

const blog = rbac({
  actor: v.object({ userId: v.string(), admin: v.boolean() }),
  models: {
    post: {
      view: {},
      edit: { authorId: { actor: "userId" } },
      delete: { actor: { admin: true } },
      create: { authorId: { actor: "userId" } },
    },
    user: { view: {} },
  },
});

export const client = blog(
  createClient({
    schema: { user, post },
    databaseUrl: "postgres://localhost:5432/app",
  })
);

export async function run(session) {
  const call = client.$as({ userId: session.userId, admin: session.admin });
  const users = await call.user.findMany({
    where: { email: { contains: "@example.com" } },
    include: { posts: true },
  });
  const created = await call.post.create({
    data: { title: "hello", authorId: session.userId },
  });
  await call.post.can("edit", { id: created.id });
  return users;
}
