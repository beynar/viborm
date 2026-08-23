import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { partitionModelData } from "@query-engine/builders/relation-mutation-parser";
import { s } from "@schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, it } from "vitest";

const NamedUser = s.model({
  id: s.string().id(),
  posts: s.toMany(() => NamedPost).name("author"),
  coAuthoredPosts: s.toMany(() => NamedPost).name("co_author"),
});

const NamedPost = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  coAuthorId: s.string(),
  author: s
    .toOne(() => NamedUser)
    .fields("authorId")
    .references("id")
    .name("author"),
  coAuthor: s
    .toOne(() => NamedUser)
    .fields("coAuthorId")
    .references("id")
    .name("co_author"),
});

prepareSchema({ NamedUser, NamedPost });

describe("named inverse relations", () => {
  it("chooses the FK matching the relation name", () => {
    const ctx = scopeFor(new PostgresAdapter(), NamedUser);
    const { relationPayloads } = partitionModelData(ctx, {
      posts: {
        create: { id: "post-1", title: "Post" },
      },
      coAuthoredPosts: {
        create: { id: "post-2", title: "Co-authored Post" },
      },
    });

    const posts = relationPayloads.posts;
    const coAuthoredPosts = relationPayloads.coAuthoredPosts;
    if (!(posts && coAuthoredPosts)) {
      throw new Error(
        "Expected both named relation payloads to be partitioned"
      );
    }

    const postsRelation = bindRelation(ctx, posts.relationRef);
    const coAuthoredPostsRelation = bindRelation(
      ctx,
      coAuthoredPosts.relationRef
    );
    if (
      postsRelation.position === "junction" ||
      coAuthoredPostsRelation.position === "junction"
    ) {
      throw new Error("Expected foreign-key relations");
    }

    expect(postsRelation.membership.foreignFields).toEqual(["authorId"]);
    expect(coAuthoredPostsRelation.membership.foreignFields).toEqual([
      "coAuthorId",
    ]);
  });
});
