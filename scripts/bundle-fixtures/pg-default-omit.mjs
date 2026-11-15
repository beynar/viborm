// Fixture — pg-representative with `defaultOmit()` hiding one field: its
// difference from (c) is what omitting fields by default costs an
// application.

import { defaultOmit } from "../../dist/client.mjs";
import { createClient } from "../../dist/pg.mjs";
import { s } from "../../dist/schema.mjs";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  secret: s.string(),
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

const schema = { user, post };

export const client = createClient({
  schema,
  databaseUrl: "postgres://localhost:5432/app",
}).$extends(defaultOmit({ user: { secret: true } }));

export async function run() {
  const users = await client.user.findMany({
    where: { email: { contains: "@example.com" } },
    include: { posts: true },
  });
  return client.post.create({
    data: { title: "hello", authorId: users[0].id },
  });
}
