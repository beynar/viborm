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
        .manyToMany(() => tag)
        .through("m2m_post_tags")
        .A("post_ref")
        .B("tag_ref"),
      categories: s.manyToMany(() => category),
      featuredTags: s.oneToMany(() => tag).name("featured"),
    })
    .map("m2m_posts");

  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      featuredPostId: s.string().nullable(),
      posts: s.manyToMany(() => post),
      featuredIn: s
        .manyToOne(() => post)
        .fields("featuredPostId")
        .references("id")
        .name("featured")
        .optional(),
    })
    .map("m2m_tags");

  const category = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      posts: s.manyToMany(() => post),
    })
    .map("m2m_categories");

  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      follows: s
        .manyToMany(() => user)
        .A("followerId")
        .B("followedId"),
      followedBy: s.manyToMany(() => user),
    })
    .map("m2m_users");

  const alpha = s
    .model({
      id: s.string().id(),
      likes: s.manyToMany(() => beta).name("likes"),
      stars: s.manyToMany(() => beta).name("stars"),
    })
    .map("m2m_alphas");

  const beta = s
    .model({
      id: s.string().id(),
      likedBy: s.manyToMany(() => alpha).name("likes"),
      starredBy: s.manyToMany(() => alpha).name("stars"),
    })
    .map("m2m_betas");

  const article = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      labels: s.manyToMany(() => label),
    })
    .map("m2m_articles");

  const label = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      articles: s.manyToMany(() => article),
    })
    .map("m2m_labels");

  return { post, tag, category, user, alpha, beta, article, label };
})();
