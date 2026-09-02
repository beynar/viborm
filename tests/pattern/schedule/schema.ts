/**
 * The fixture schema shared by the scheduler and packer tests: the K4 smoke
 * schema (post / author / tags on postgresql) plus a child-held `comment`
 * edge for the child-held, transition and legality fixtures.
 */
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateSchemaOrThrow } from "@schema/validation";

export const schema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("k4_users");
  const tag = s
    .model({
      id: s.string().id(),
      label: s.string(),
      posts: s.toMany(() => post),
    })
    .map("k4_tags");
  const comment = s
    .model({
      id: s.string().id(),
      body: s.string(),
      slug: s.string().unique(),
      postId: s.string().nullable(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
    })
    .map("k4_comments");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
      tags: s.toMany(() => tag),
      comments: s.toMany(() => comment),
    })
    .map("k4_posts");
  return { user, tag, comment, post };
})();
hydrateSchemaNames(schema);
validateSchemaOrThrow(schema);

export const models = schema as unknown as Record<string, Model<any>>;

/** The K4 smoke payload (tests/pattern/harness/smoke.core.test.ts). */
export const smokeArgs = {
  where: { id: "p1" },
  data: {
    title: "t",
    author: { connect: { id: "u1" } },
    tags: { connect: [{ id: "a" }, { id: "b" }] },
  },
  select: { id: true },
};
