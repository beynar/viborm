/** The schema and client the recipes page's use blocks run against. */
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";

const comment = s.model({
  id: s.string().id().ulid(),
  body: s.string(),
  tenantId: s.string(),
  createdBy: s.string().nullable(),
  updatedBy: s.string().nullable(),
  postId: s.string(),
  post: s.toOne(() => post).fields("postId").references("id"),
});
const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  tenantId: s.string(),
  createdBy: s.string().nullable(),
  updatedBy: s.string().nullable(),
  version: s.int().default(0),
  comments: s.toMany(() => comment),
});

export const base = createClient({ schema: { post, comment } });
