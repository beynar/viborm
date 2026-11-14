// Fixture — pg-representative with one extension made of a first moment alone (`call`) that bounds every read's `take`: its
// difference from (c) is what this one part costs alone. A measuring
// instrument for scripts/extension-bytes.mjs, not a size-limit row.

import { call, extension, reads, target } from "../../dist/index.mjs";
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
  views: s.int().default(0),
});

export const client = createClient({
  schema: { user, post },
  databaseUrl: "postgres://localhost:5432/app",
}).$extends(
  extension(
    "call",
    call(
      (c) => c.set({ take: Math.min(c.args.take ?? 100, 100) }),
      target(reads)
    )
  )
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
