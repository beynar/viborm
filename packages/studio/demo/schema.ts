// A small blog that exercises every relation shape the studio draws:
// user ↔ profile (one to one), user → post (one to many), post ↔ tag (many to many).
import { s } from "viborm";

export const user = s.model({
  id: s.int().id().increment(),
  email: s.string().unique(),
  name: s.string(),
  role: s.enum(["reader", "author", "admin"]).default("reader"),
  karma: s.bigInt().default(0n),
  joinedAt: s.dateTime().now(),
  birthday: s.date().nullable(),
  profile: s.toOne(() => profile),
  posts: s.toMany(() => post),
});

export const profile = s.model({
  id: s.int().id().increment(),
  bio: s.string().nullable(),
  website: s.string().nullable(),
  userId: s.int().unique(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id"),
});

export const post = s.model({
  id: s.int().id().increment(),
  title: s.string(),
  body: s.string(),
  published: s.boolean().default(false),
  rating: s.decimal({ precision: 4, scale: 2 }).nullable(),
  metadata: s.json().nullable(),
  createdAt: s.dateTime().now(),
  publishedAt: s.dateTime().nullable(),
  authorId: s.int(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
  tags: s.toMany(() => tag),
});

export const tag = s.model({
  id: s.int().id().increment(),
  label: s.string().unique(),
  posts: s.toMany(() => post),
});

export const schema = { user, profile, post, tag };
