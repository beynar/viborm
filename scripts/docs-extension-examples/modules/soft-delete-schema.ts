/** The schema and clients the soft-delete page's blocks run against. */
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";
import { softDelete } from "viborm/soft-delete";

export const user = s.model({
  id: s.string().id(),
  email: s.string(),
  deletedAt: s.dateTime().nullable(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  createdAt: s.dateTime(),
  authorId: s.string(),
  author: s.toOne(() => user).fields("authorId").references("id"),
  deletedAt: s.dateTime().nullable(),
  deletedById: s.string().nullable(),
  comments: s.toMany(() => comment),
});
const comment = s.model({
  id: s.string().id(),
  postId: s.string(),
  post: s.toOne(() => post).fields("postId").references("id"),
});
export const base = createClient({ schema: { user, post, comment } });
export const db = base.$extends(
  softDelete({ models: { post: { deletedAt: "deletedAt" } } })
);
