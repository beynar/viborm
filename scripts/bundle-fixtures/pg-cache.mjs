// Fixture — pg-representative with `viborm/cache` applied over the memory
// driver and one `$withCache` read: its difference from (c) is what caching
// reads costs an application.

import { MemoryCache } from "../../dist/cache/memory.mjs";
import { cache } from "../../dist/cache.mjs";
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
}).$extends(cache({ driver: new MemoryCache(), version: "1" }));

export async function run() {
  const users = await client.$withCache({ ttl: 1000 }).user.findMany({
    where: { email: { contains: "@example.com" } },
    include: { posts: true },
  });
  return client.post.create({
    data: { title: "hello", authorId: users[0].id },
  });
}
