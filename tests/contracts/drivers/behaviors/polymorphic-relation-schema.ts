/**
 * The polymorphic relation behavior's schema, and the selections its
 * unnamed-arm cell reads, in a module of their own so that the three views of
 * that one contract are pinned on the same models: the runtime cell
 * (`./polymorphic-relation-behavior.ts`, every provider it is registered on),
 * the schema-only renderer
 * (`tests/contracts/public-client/schema-introspection.core.test.ts`) and the
 * inferred client type
 * (`tests/types/client/polymorphic-relation-behavior.core.types.ts`). The
 * renderer and the static pin import it without the runtime harness.
 */

import { s } from "@schema";
import { PG, SQLITE } from "@schema/scalars/native-types";

export const polymorphicRelationSchema = (() => {
  const post = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string(),
      comments: s.toMany(() => comment).name("commentable"),
    })
    .map("poly_contract_posts");

  // `video` is the arm the selections below leave unnamed. Its `title` states a
  // native type per dialect (#45) — each dialect's own default; MySQL falls
  // back — so the default projection is pinned over a mapped declaration.
  const video = s
    .model({
      id: s.int().id().increment(),
      slug: s.string().unique(),
      title: s.string({ pg: PG.STRING.TEXT, sqlite: SQLITE.STRING.TEXT }),
    })
    .map("poly_contract_videos");

  const comment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      commentable: s
        .toOne(
          { post: () => post, video: () => video },
          {
            values: {
              post: "content.post.v1",
              video: "content.video.v1",
            },
          }
        )
        .name("commentable")
        .optional(),
    })
    .map("poly_contract_comments");

  const requiredComment = s
    .model({
      id: s.int().id().increment(),
      body: s.string(),
      subject: s.toOne({
        post: () => post,
        video: () => video,
      }),
    })
    .map("poly_contract_required_comments");

  return { post, video, comment, requiredComment };
})();

/**
 * Selections that name the `post` arm only, so a `video` row reads at that
 * model's default scalar projection: on the required slot and on the optional
 * one.
 */
export const unnamedArmSelections = {
  requiredComment: {
    id: true,
    subject: { post: { select: { title: true } } },
  },
  comment: {
    id: true,
    commentable: { post: { select: { title: true } } },
  },
} as const;
