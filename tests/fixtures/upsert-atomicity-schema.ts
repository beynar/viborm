import { s } from "@schema";

export const upsertAtomicitySchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("upsert_atomicity_users");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      userId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    })
    .map("upsert_atomicity_posts");

  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      count: s.int().default(0),
    })
    .map("upsert_atomicity_tags");

  const counter = s
    .model({
      id: s.int().id().increment(),
      key: s.string().unique(),
      value: s.int(),
    })
    .map("upsert_atomicity_counters");

  return { user, post, tag, counter };
})();
