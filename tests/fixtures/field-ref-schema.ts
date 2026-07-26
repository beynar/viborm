import { s } from "@schema";

/**
 * Schema for field-reference (Prisma `FieldRef`) coverage.
 *
 * `post` carries two comparable int columns (`views`, `likes`) plus two string
 * columns where one is `.map()`ed to a different physical name, so a reference
 * operand proves it resolves through the column-name registry and not through
 * the field key.
 */
export const fieldRefSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      nickname: s.string(),
      posts: s.oneToMany(() => post),
    })
    .map("fieldref_users");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      slug: s.string().map("slug_column"),
      views: s.int().default(0),
      likes: s.int().default(0),
      // JSON is the only operand/data slot that accepts an arbitrary object,
      // so it is the only one where a reference token is a structurally valid
      // value and has to be refused deliberately rather than for free.
      payload: s.json().nullable(),
      authorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("fieldref_posts");

  return { user, post };
})();
