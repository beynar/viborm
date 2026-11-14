/** The schema and the client the extension vocabulary's type tests use. */

import { createClient } from "@src/drivers/pglite";
import { s } from "@src/schema";

export const user = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  firstName: s.string(),
  lastName: s.string(),
  passwordHash: s.string(),
  posts: s.toMany(() => post).name("author"),
});

export const post = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  title: s.string(),
  deletedAt: s.dateTime().nullable(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .name("author")
    .fields("authorId")
    .references("id"),
  comments: s.toMany(() => comment).name("post"),
});

export const comment = s.model({
  id: s.string().id(),
  body: s.string(),
  postId: s.string(),
  post: s
    .toOne(() => post)
    .name("post")
    .fields("postId")
    .references("id"),
});

export const schema = { user, post, comment };

export const base = createClient({ schema });
