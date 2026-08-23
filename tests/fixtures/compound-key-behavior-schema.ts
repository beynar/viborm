import { s } from "@schema";

export const compoundKeyBehaviorSchema = (() => {
  const author = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      name: s.string(),
      posts: s.toMany(() => post),
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
        .toOne(() => author)
        .fields("tenantId", "authorId")
        .references("tenantId", "id"),
    })
    .map("compound_posts");

  const account = s
    .model({
      id: s.string().id(),
      provider: s.string(),
      providerId: s.string(),
      memberships: s.toMany(() => membership),
    })
    .unique(["provider", "providerId"])
    .map("compound_accounts");

  // A child whose compound FK references a NON-PK compound unique of its parent
  // (account's `[provider, providerId]`, not its `id` PK) — the D4-style shape.
  // A root update on `account` must expose those referenced columns in its locate
  // read so the per-field edge correlates/writes them.
  const membership = s
    .model({
      id: s.string().id(),
      role: s.string(),
      accProvider: s.string().nullable(),
      accProviderId: s.string().nullable(),
      account: s
        .toOne(() => account)
        .fields("accProvider", "accProviderId")
        .references("provider", "providerId"),
    })
    .map("compound_memberships");

  return { author, post, account, membership };
})();
