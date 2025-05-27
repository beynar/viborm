import { describe, test, expect } from "vitest";
import { s } from "../src/schema/index.js";

describe("Why Function Wrapping Works for Recursive Schemas", () => {
  test("demonstrates the difference between direct and deferred evaluation", () => {
    // ❌ This would fail with circular reference errors if attempted:
    // const User = s.model("User", {
    //   posts: s.relation.many(() => Post) // ReferenceError: Cannot access 'Post' before initialization
    // });
    // const Post = s.model("Post", {
    //   author: s.relation(() => User)
    // });

    // ✅ Function wrapping works because of deferred evaluation:

    // Step 1: Function declarations are hoisted - they exist immediately
    console.log("Step 1: Function signatures are available");
    console.log("createUser exists:", typeof createUser === "function");
    console.log("createPost exists:", typeof createPost === "function");

    function createUser() {
      console.log("Step 3: createUser() is being executed");
      return s.model("User", {
        id: s.string(),
        posts: s.relation.many(() => {
          console.log("Step 5: Lazy getter for posts relation is called");
          return createPost(); // This call happens later!
        }),
      });
    }

    function createPost() {
      console.log("Step 4: createPost() is being executed");
      return s.model("Post", {
        id: s.string(),
        author: s.relation(() => {
          console.log("Step 6: Lazy getter for author relation is called");
          return createUser(); // This call happens later!
        }),
      });
    }

    // Step 2: Now we can safely call the functions
    console.log("Step 2: Calling createUser()");
    const User = createUser();
    const Post = createPost();

    // Verify they work
    expect(User.name).toBe("User");
    expect(Post.name).toBe("Post");
    expect(User.relations.has("posts")).toBe(true);
    expect(Post.relations.has("author")).toBe(true);
  });

  test("shows how TypeScript resolves function types before execution", () => {
    // TypeScript can infer these function types without executing them:
    const userFactory = () => s.model("User", { id: s.string() });
    const postFactory = () => s.model("Post", { id: s.string() });

    // TypeScript knows:
    // userFactory: () => Model<{ id: StringField }>
    // postFactory: () => Model<{ id: StringField }>

    // So this works even with circular references:
    const createUserWithPosts = () =>
      s.model("User", {
        id: s.string(),
        posts: s.relation.many(() => createPostWithAuthor()),
      });

    const createPostWithAuthor = () =>
      s.model("Post", {
        id: s.string(),
        author: s.relation(() => createUserWithPosts()),
      });

    const User = createUserWithPosts();
    const Post = createPostWithAuthor();

    expect(User.name).toBe("User");
    expect(Post.name).toBe("Post");
  });

  test("demonstrates the lazy getter mechanism", () => {
    let userCallCount = 0;
    let postCallCount = 0;

    const createUser = () => {
      userCallCount++;
      console.log(`createUser called ${userCallCount} times`);
      return s.model("User", {
        id: s.string(),
        posts: s.relation.many(() => createPost()),
      });
    };

    const createPost = () => {
      postCallCount++;
      console.log(`createPost called ${postCallCount} times`);
      return s.model("Post", {
        id: s.string(),
        author: s.relation(() => createUser()),
      });
    };

    // Initial model creation
    const User = createUser(); // userCallCount = 1
    const Post = createPost(); // postCallCount = 1

    console.log("After initial creation:");
    console.log("User calls:", userCallCount); // 1
    console.log("Post calls:", postCallCount); // 1

    // The lazy getters haven't been called yet!
    // They only get called when the relation is actually accessed
    expect(userCallCount).toBe(1);
    expect(postCallCount).toBe(1);

    // Verify the models work
    expect(User.name).toBe("User");
    expect(Post.name).toBe("Post");
  });
});
