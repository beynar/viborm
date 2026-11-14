/** The schema the cache pages' blocks read. */
import { createClient } from "viborm/pglite";
import { s } from "viborm/schema";

export const user = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string(),
  active: s.boolean().default(true),
  posts: s.toMany(() => post),
});
export const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  authorId: s.string(),
  author: s.toOne(() => user).fields("authorId").references("id"),
});
export const schema = { user, post };
export const base = createClient({ schema });
