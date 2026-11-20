/**
 * A database view in the rendered schema type: its scalars as its source
 * types them, then each JSON column typed as the row its query reads.
 */

import { renderSchemaType } from "@client/schema-introspection";
import { s } from "@schema";
import { expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  score: s.int(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const scoredPost = s.view(() => post, {
  select: { id: true, title: true, author: { select: { name: true } } },
});
// A view over a view reads its source's JSON column as it is.
const postTitle = s.view(() => scoredPost, {
  select: { title: true, author: true },
});
const writer = s.view(() => user, {
  select: {
    id: true,
    posts: { select: { title: true }, take: 3 },
    _count: true,
    _aggregate: { posts: { _sum: { score: true } } },
  },
});

test("a view's JSON columns are typed as its query reads them", () => {
  const rendered = renderSchemaType({
    user,
    post,
    scoredPost,
    postTitle,
    writer,
  });
  expect(rendered).toContain(`  scoredPost: {
    id: string;
    title: string;
    author: {
      name: string;
    };
  };
  postTitle: {
    title: string;
    author: {
      name: string;
    };
  };
  writer: {
    id: string;
    posts: Array<{
      title: string;
    }>;
    _count: {
      posts: number;
    };
    _aggregate: {
      posts: {
        _sum: {
          score: number | null;
        };
      };
    };
  };
};`);
});

test("a view's inherited relations are typed as its source's, and no other", () => {
  // Keeps `authorId`: it reads `author` as `post` does.
  const authored = s.view(() => post, {
    select: { id: true, authorId: true },
  });
  // Keeps neither `authorId` nor `id`: no relation of `post`.
  const titled = s.view(() => post, { select: { title: true } });
  const rendered = renderSchemaType({ user, post, authored, titled });
  expect(rendered).toContain(`  authored: {
    id: string;
    authorId: string;
    author: VibORMSchema["user"];
  };
  titled: {
    title: string;
  };`);
});
