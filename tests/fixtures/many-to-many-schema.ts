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

  return { post, tag, category, user, alpha, beta };
})();
