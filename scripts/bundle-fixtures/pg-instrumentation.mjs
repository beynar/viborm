// Fixture — pg-representative with `viborm/instrumentation` applied, logging
// on: its difference from (c) is what tracing and structured logs cost an
// application (`@opentelemetry/api` stays external, imported on demand).

import { instrumentation } from "../../dist/instrumentation.mjs";
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

export const client = createClient({
  schema: { user, post },
  databaseUrl: "postgres://localhost:5432/app",
}).$extends(instrumentation({ logging: true }));

export async function run() {
  const users = await client.user.findMany({
    where: { email: { contains: "@example.com" } },
    include: { posts: true },
  });
  return client.post.create({
    data: { title: "hello", authorId: users[0].id },
  });
}
