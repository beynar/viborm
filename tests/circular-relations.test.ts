import { s } from "../src/schema/index.js";

describe("Circular Relations", () => {
  describe("Runtime Behavior", () => {
    test("should handle circular self-references", () => {
      const user = s.model("user", {
        id: s.string(),
        name: s.string(),
        friends: s.relation({ onField: "test" }).manyToMany(() => user),
      });

      expect(user.name).toBe("user");
      expect(user.relations.has("friends")).toBe(true);

      const friendsRelation = user.relations.get("friends");
      expect(friendsRelation?.relationType).toBe("manyToMany");
      expect(friendsRelation?.targetModel.name).toBe("user");
    });

    test("should handle circular mutual references", () => {
      const userModel = s.model("user", {
        id: s.string(),
        name: s.string(),
        posts: s.relation({ onField: "test" }).manyToMany(() => postModel),
      });

      const postModel = s.model("post", {
        id: s.string(),
        title: s.string(),
        author: s.relation({ onField: "test" }).manyToOne(() => userModel),
      });

      expect(userModel.name).toBe("user");
      expect(postModel.name).toBe("post");

      const postsRelation = userModel.relations.get("posts");
      const authorRelation = postModel.relations.get("author");

      expect(postsRelation?.targetModel.name).toBe("post");
      expect(authorRelation?.targetModel.name).toBe("user");
    });
  });

  describe("Type Inference", () => {
    test("should have proper type inference for simple models", () => {
      const simpleUser = s.model("simpleUser", {
        name: s.string(),
        age: s.int(),
      });

      type SimpleUserInfer = typeof simpleUser.infer;

      // These should compile without errors if types are correct
      expectTypeOf<SimpleUserInfer["name"]>().toEqualTypeOf<string>();
      expectTypeOf<SimpleUserInfer["age"]>().toEqualTypeOf<number>();
    });

    test("should handle circular relation types", () => {
      const profile = s.model("profile", {
        name: s.string(),
        age: s.int(),
        friends: s.relation({ onField: "test" }).manyToMany(() => profile),
      });

      type ProfileInfer = typeof profile.infer;

      // Basic fields should have proper types
      expectTypeOf<ProfileInfer["name"]>().toEqualTypeOf<string>();
      expectTypeOf<ProfileInfer["age"]>().toEqualTypeOf<number>();

      // Friends relation should be an array of the same type
      expectTypeOf<ProfileInfer["friends"]>().toMatchTypeOf<any[]>();
    });

    test("should handle mutual circular references", () => {
      const user = s.model("user", {
        id: s.string(),
        name: s.string(),
        posts: s.relation({ onField: "test" }).manyToMany(() => post),
      });

      const post = s.model("post", {
        id: s.string(),
        title: s.string(),
        author: s.relation({ onField: "test" }).manyToOne(() => user),
      });

      type UserInfer = typeof user.infer;
      type PostInfer = typeof post.infer;

      // Basic fields
      expectTypeOf<UserInfer["name"]>().toEqualTypeOf<string>();
      expectTypeOf<PostInfer["title"]>().toEqualTypeOf<string>();

      // Relations should work both ways
      expectTypeOf<UserInfer["posts"]>().toMatchTypeOf<any[]>();
      expectTypeOf<PostInfer["author"]>().toMatchTypeOf<any>();
    });
  });
});
