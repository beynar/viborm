import { s } from "@schema";

/**
 * Fixture for many-to-many write conformance.
 *
 * - post <-> tag: junction config (.through()/.A()/.B()) set on the post side
 *   only — the tag side must resolve the same junction via the pair.
 * - post <-> category: implicit junction, all defaults.
 * - user <-> user: self-referential M2M with .A()/.B() on one side.
 * - tag.featuredIn: a to-one relation pointing back at post carrying a real
 *   FK (featuredPostId) — regression guard: M2M writes on post.tags must
 *   never touch it.
 * - alpha <-> beta: two .name()d M2M pairs between the same models — each
 *   pair must resolve its own junction table.
 * - article <-> label: BOTH sides carry a DB-generated (auto-increment) primary
 *   key — the regression class every string-PK fixture above missed: a junction
 *   create whose target identity is *produced* by the INSERT (and a parent
 *   whose own produced id the join row references).
 */
export const manyToManySchema = (() => {
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      tags: s
        .toMany(() => tag)
        .through("m2m_post_tags")
        .source("post_ref")
        .target("tag_ref"),
      categories: s.toMany(() => category),
      featuredTags: s.toMany(() => tag).name("featured"),
    })
    .map("m2m_posts");

  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      featuredPostId: s.string().nullable(),
      posts: s.toMany(() => post),
      featuredIn: s
        .toOne(() => post)
        .fields("featuredPostId")
        .references("id")
        .name("featured"),
    })
    .map("m2m_tags");

  const category = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map("m2m_categories");

  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      follows: s
        .toMany(() => user)
        .source("followerId")
        .target("followedId"),
      followedBy: s.toMany(() => user),
    })
    .map("m2m_users");

  const alpha = s
    .model({
      id: s.string().id(),
      likes: s.toMany(() => beta).name("likes"),
      stars: s.toMany(() => beta).name("stars"),
    })
    .map("m2m_alphas");

  const beta = s
    .model({
      id: s.string().id(),
      likedBy: s.toMany(() => alpha).name("likes"),
      starredBy: s.toMany(() => alpha).name("stars"),
    })
    .map("m2m_betas");

  const article = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      labels: s.toMany(() => label),
    })
    .map("m2m_articles");

  const label = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      articles: s.toMany(() => article),
    })
    .map("m2m_labels");

  return { post, tag, category, user, alpha, beta, article, label };
})();
