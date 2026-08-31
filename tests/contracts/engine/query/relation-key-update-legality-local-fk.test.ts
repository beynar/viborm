import {
  AUTHOR_ID_RELATION_KEY_ERROR,
  expectParity,
  ID_RELATION_KEY_ERROR,
  type LegalityClient,
  POSTS_OWN_AUTHOR_ID_PARSE_ERROR,
} from "@tests/contracts/engine/query/relation-key-update-legality-fixtures";
import { describe, test } from "vitest";

// The LOCAL-FK slice: every scenario whose rewritten relation key is a column the CHILD
// holds — `post.authorId`, and the shared primary/local-FK of `sharedProfile`. It is its
// own file because `expectParity` boots one live and one forced-batch database per
// scenario; the referenced-column, transition-arm, and occupied-guard families each get
// their own sibling for the same reason. The one schema and the parity oracle live in
// `relation-key-update-legality-fixtures.ts`.

async function seedAuthorsAndPost(client: LegalityClient): Promise<void> {
  await client.author.create({ data: { id: 1, name: "Original" } });
  await client.author.create({ data: { id: 2, name: "Final" } });
  await client.post.create({
    data: { id: 10, title: "Post", score: 0, authorId: 1 },
  });
}

async function authorPostState(client: LegalityClient): Promise<unknown> {
  return {
    authors: await client.author.findMany({ orderBy: { id: "asc" } }),
    posts: await client.post.findMany({ orderBy: { id: "asc" } }),
  };
}

const originalAuthorPostState = {
  authors: [
    { id: 1, name: "Original" },
    { id: 2, name: "Final" },
  ],
  posts: [{ id: 10, title: "Post", score: 0, authorId: 1 }],
};

describe("relation-key update legality", () => {
  test("rejects parent local-FK arithmetic before effects in both modes", async () => {
    await expectParity(
      {
        seed: seedAuthorsAndPost,
        act: (client) =>
          client.post.update({
            where: { id: 10 },
            data: {
              authorId: { increment: 1 },
              author: { update: { name: "must not change" } },
            },
          }),
        snapshot: authorPostState,
        expectedState: originalAuthorPostState,
      },
      AUTHOR_ID_RELATION_KEY_ERROR
    );
  });

  test("rejects computed shared primary/local-FK transitions", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.sharedAccount.create({
            data: { id: 1, name: "Original" },
          });
          await client.sharedAccount.create({ data: { id: 2, name: "Final" } });
          await client.sharedProfile.create({
            data: { id: 1, label: "Profile" },
          });
        },
        act: (client) =>
          client.sharedProfile.update({
            where: { id: 1 },
            data: {
              id: { increment: 1 },
              account: { update: { name: "must not change" } },
            },
          }),
        snapshot: async (client) => ({
          accounts: await client.sharedAccount.findMany({
            orderBy: { id: "asc" },
          }),
          profiles: await client.sharedProfile.findMany(),
        }),
        expectedState: {
          accounts: [
            { id: 1, name: "Original" },
            { id: 2, name: "Final" },
          ],
          profiles: [{ id: 1, label: "Profile" }],
        },
      },
      ID_RELATION_KEY_ERROR
    );
  });

  // M12 — DELIBERATE CLASS CHANGE, the state contract unchanged. `authorId` is not just
  // a relation key of the target here: it is the foreign key the ENCLOSING `posts`
  // relation owns, so this payload is illegal on its own, with or without the sibling
  // `author: { update }` this file's rule needs. The general refusal answers first,
  // which is also where Prisma lands — its `PostUpdateWithoutAuthorInput` omits the key
  // outright, so the relation-key rule is never consulted for this shape. What the test
  // is FOR is unchanged and still asserted: the nested data is judged before any outer
  // effect, and the snapshot shows nothing written. CLASS IV keeps its own coverage —
  // any relation key of the target that the enclosing relation does NOT own (and the two
  // root-level scenarios above and below) still raise `NestedWriteError` here.
  //
  // PACKAGE N1 MOVED IT ONE LAYER FURTHER OUT, and Prisma's own reasoning is now the
  // MECHANISM rather than a coincidence: nested update data is built from the same
  // omitted-FK owner nested create data is, so `authorId` is not a key of this payload's
  // schema and the answer is `ValidationError: Unknown key: authorId` at the parse.
  // Previously it was the engine's `Relation 'posts' owns 'authorId'; omit it from
  // nested create and update data`, one construction step later — the same decision,
  // still before any statement, with a less specific sentence. That trade was already
  // made on the create side, and `nested-update-owned-fk.test.ts` owns the full account
  // including the one schema shape that still reaches the engine guard.
  test("recurses into nested update data before outer effects", async () => {
    await expectParity(
      {
        seed: seedAuthorsAndPost,
        act: (client) =>
          client.author.update({
            where: { id: 1 },
            data: {
              posts: {
                update: {
                  where: { id: 10 },
                  data: {
                    authorId: { increment: 1 },
                    author: { update: { name: "must not change" } },
                  },
                },
              },
            },
          }),
        snapshot: authorPostState,
        expectedState: originalAuthorPostState,
      },
      POSTS_OWN_AUTHOR_ID_PARSE_ERROR,
      "ValidationError"
    );
  });

  test("validates the taken top-level upsert update branch", async () => {
    await expectParity(
      {
        seed: seedAuthorsAndPost,
        act: (client) =>
          client.post.upsert({
            where: { id: 10 },
            create: { id: 10, title: "Create", score: 0, authorId: 1 },
            update: {
              authorId: { increment: 1 },
              author: { update: { name: "must not change" } },
            },
          }),
        snapshot: authorPostState,
        expectedState: originalAuthorPostState,
      },
      AUTHOR_ID_RELATION_KEY_ERROR
    );
  });

  test("does not validate an untaken top-level upsert update branch", async () => {
    await expectParity(
      {
        seed: async (client) => {
          await client.author.create({ data: { id: 1, name: "Author" } });
        },
        act: (client) =>
          client.post.upsert({
            where: { id: 99 },
            create: { id: 99, title: "Created", score: 0, authorId: 1 },
            update: {
              authorId: { increment: 1 },
              author: { update: { name: "untaken" } },
            },
          }),
        snapshot: authorPostState,
        expectedState: {
          authors: [{ id: 1, name: "Author" }],
          posts: [{ id: 99, title: "Created", score: 0, authorId: 1 }],
        },
      },
      undefined
    );
  });

  test("allows literal local-FK rebind and non-referenced arithmetic", async () => {
    await expectParity(
      {
        seed: seedAuthorsAndPost,
        act: (client) =>
          client.post.update({
            where: { id: 10 },
            data: {
              score: { increment: 1 },
              authorId: { set: 2 },
              author: { update: { name: "Updated final" } },
            },
          }),
        snapshot: authorPostState,
        expectedState: {
          authors: [
            { id: 1, name: "Original" },
            { id: 2, name: "Updated final" },
          ],
          posts: [{ id: 10, title: "Post", score: 1, authorId: 2 }],
        },
      },
      undefined
    );
  });
});
