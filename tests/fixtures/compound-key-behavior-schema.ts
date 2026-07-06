import { s } from "@schema";

export const compoundKeyBehaviorSchema = (() => {
  const author = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      name: s.string(),
      posts: s.oneToMany(() => post),
    })
    .id(["tenantId", "id"])
    .map("compound_authors");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      tenantId: s.string().nullable(),
      authorId: s.string().nullable(),
      author: s
        .manyToOne(() => author)
        .fields("tenantId", "authorId")
        .references("tenantId", "id")
        .optional(),
    })
    .map("compound_posts");

  const account = s
    .model({
      id: s.string().id(),
      provider: s.string(),
      providerId: s.string(),
    })
    .unique(["provider", "providerId"])
    .map("compound_accounts");

  return { author, post, account };
})();
