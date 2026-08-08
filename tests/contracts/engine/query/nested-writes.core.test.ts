import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { bindRelation } from "@query-engine/builders/relation-data-builder";
import { partitionModelData } from "@query-engine/builders/relation-mutation-parser";
import { createQueryScope } from "@query-engine/context/query-scope";
import { s } from "@schema";
import { describe, expect, it } from "vitest";

const NamedUser = s.model({
  id: s.string().id(),
  posts: s.oneToMany(() => NamedPost).name("author"),
  coAuthoredPosts: s.oneToMany(() => NamedPost).name("co_author"),
});

const NamedPost = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  coAuthorId: s.string(),
  author: s
    .manyToOne(() => NamedUser)
    .fields("authorId")
    .references("id")
    .name("author"),
  coAuthor: s
    .manyToOne(() => NamedUser)
    .fields("coAuthorId")
    .references("id")
    .name("co_author"),
});

describe("named inverse relations", () => {
  it("chooses the FK matching the relation name", () => {
    const ctx = createQueryScope(new PostgresAdapter(), NamedUser);
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

    const postsRelation = bindRelation(ctx, posts.relationInfo);
    const coAuthoredPostsRelation = bindRelation(
      ctx,
      coAuthoredPosts.relationInfo
    );
    if (
      postsRelation.kind === "junction" ||
      coAuthoredPostsRelation.kind === "junction"
    ) {
      throw new Error("Expected foreign-key relations");
    }

    expect(postsRelation.foreignFields).toEqual(["authorId"]);
    expect(coAuthoredPostsRelation.foreignFields).toEqual(["coAuthorId"]);
  });
});
