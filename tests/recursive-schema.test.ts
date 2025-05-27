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
        author: s.relation.one(() => createUser()),
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

describe("Recursive Schema Support 2", () => {
  test("should support basic recursive schemas using factory pattern 2", () => {
    // Factory pattern that avoids circular type inference

    const User = s.model("User", {
      id: s.string(),
      email: s.string(),
      posts: s.relation.many(() => (() => Post)()),
    });

    const Post = s.model("Post", {
      id: s.string(),
      title: s.string(),
      author: s.relation.one(() => (() => User)()),
    });

    type userPost = typeof User.infer.posts.author.posts;

    // Verify the models were created correctly
    expect(User.name).toBe("User");
    expect(Post.name).toBe("Post");
    expect(User.relations.has("posts")).toBe(true);
    expect(Post.relations.has("author")).toBe(true);
  });
});

describe("Recursive Schema Support final", () => {
  test("should support basic recursive schemas without using factory pattern", () => {
    // Factory pattern that avoids circular type inference

    const User = s.model("User", {
      id: s.string(),
      email: s.string(),
      posts: s.relation.many(() => Post),
    });

    const Post = s.model("Post", {
      id: s.string(),
      title: s.string(),
      author: s.relation.one(() => User),
      parent: s.relation.one(() => Post),
    });

    type userPost = typeof User.infer.posts.author.posts;

    // Verify the models were created correctly
    expect(User.name).toBe("User");
    expect(Post.name).toBe("Post");
    expect(User.relations.has("posts")).toBe(true);
    expect(Post.relations.has("author")).toBe(true);
  });
});
