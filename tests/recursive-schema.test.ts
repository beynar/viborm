import { describe, test, expect } from "vitest";
import { s, Model } from "../src/schema/index.js";

describe("Recursive Schema Support", () => {
  test("should support basic recursive schemas using factory pattern", () => {
    // Factory pattern that avoids circular type inference
    const createUser = () =>
      s.model("User", {
        id: s.string(),
        email: s.string(),
        posts: s.relation.many(() => createPost()),
      });

    const createPost = () =>
      s.model("Post", {
        id: s.string(),
        title: s.string(),
        author: s.relation(() => createUser()),
      });

    const User = createUser();
    const Post = createPost();

    type userPost = typeof User.infer.posts.author.posts;

    // Verify the models were created correctly
    expect(User.name).toBe("User");
    expect(Post.name).toBe("Post");
    expect(User.relations.has("posts")).toBe(true);
    expect(Post.relations.has("author")).toBe(true);
  });
});
