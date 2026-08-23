import { s } from "@schema";

/**
 * Schema for field-reference (Prisma `FieldRef`) coverage.
 *
 * `post` carries two comparable int columns (`views`, `likes`) plus two string
 * columns where one is `.map()`ed to a different physical name, so a reference
 * operand proves it resolves through the column-name registry and not through
 * the field key.
 *
 * It also carries TWO enum columns over the same value set. On PostgreSQL each
 * enum field gets its own type, so `status = reviewStatus` compares two
 * DIFFERENT types — the shape that used to fail with 42883 there while
 * SQLite/LibSQL (which store enums as text) answered it happily. Their
 * defaults differ so every seeded row has `status != reviewStatus`, leaving the
 * equality tests to create the one row where they agree.
 */
export const fieldRefSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      nickname: s.string(),
      posts: s.toMany(() => post),
    })
    .map("fieldref_users");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      slug: s.string().map("slug_column"),
      views: s.int().default(0),
      likes: s.int().default(0),
      status: s.enum(["draft", "review", "published"]).default("draft"),
      reviewStatus: s
        .enum(["draft", "review", "published"])
        .default("published")
        .map("review_status"),
      // JSON is the only operand/data slot that accepts an arbitrary object,
      // so it is the only one where a reference token is a structurally valid
      // value and has to be refused deliberately rather than for free.
      payload: s.json().nullable(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("fieldref_posts");

  return { user, post };
})();
