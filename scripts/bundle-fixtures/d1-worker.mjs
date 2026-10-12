// Fixture (g) — a Cloudflare Worker on D1: `viborm/d1`, a realistic model
// (ids, enum, JSON, timestamps, a relation), one filtered read with a nested
// include and one write. Bundled with the Worker options, not the Node ones.

import { createClient } from "../../dist/d1.mjs";
import { s } from "../../dist/schema.mjs";

const role = s.enum(["MEMBER", "ADMIN"]);

const user = s.model({
  id: s.string().id().ulid(),
  email: s.string().unique(),
  name: s.string().nullable(),
  role: role.default("MEMBER"),
  createdAt: s.dateTime().now(),
  posts: s.toMany(() => post),
});

const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  published: s.boolean().default(false),
  views: s.int().default(0),
  metadata: s.json().nullable(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});

export default {
  async fetch(request, env) {
    const db = createClient({ database: env.DB, schema: { user, post } });
    if (request.method === "POST") {
      const { email, title } = await request.json();
      return Response.json(
        await db.user.create({
          data: { email, posts: { create: { title } } },
          include: { posts: true },
        })
      );
    }
    const users = await db.user.findMany({
      where: { role: "ADMIN", posts: { some: { published: true } } },
      select: {
        id: true,
        email: true,
        posts: {
          where: { views: { gte: 10 } },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      take: 20,
    });
    return Response.json(users);
  },
};
