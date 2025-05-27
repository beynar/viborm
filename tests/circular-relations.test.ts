import { s } from "../src/schema/index.js";

describe("Circular Relations", () => {
  describe("Runtime Behavior", () => {
    test("should handle circular self-references", () => {
      const user = s.model("user", {
        id: s.string(),
        name: s.string(),
        get friends() {
          return s.relation(() => [user]);
        },
      });

      expect(user.name).toBe("user");
      expect(user.relations.has("friends")).toBe(true);

      const friendsRelation = user.relations.get("friends");
      expect(friendsRelation?.relationType).toBe("many");
      expect(friendsRelation?.targetModel.name).toBe("user");
    });

    test("should handle circular mutual references", () => {
      const userModel = s.model("user", {
        id: s.string(),
        name: s.string(),
        get posts() {
          return s.relation(() => [postModel]);
        },
      });

      const postModel = s.model("post", {
        id: s.string(),
        title: s.string(),
        get author() {
          return s.relation(() => userModel);
        },
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
        get friends() {
          return s.relation(() => [profile]);
        },
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
        get posts() {
          return s.relation(() => [post]);
        },
      });

      const post = s.model("post", {
        id: s.string(),
        title: s.string(),
        get author() {
          return s.relation(() => user);
        },
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

  describe("Comparison with Zod", () => {
    test("should work as simply as Zod but without z.lazy()", () => {
      // This is the key test - BaseORM should be simpler than Zod
      // because ALL relations are automatically lazy

      const profileModel = s.model("profile", {
        name: s.string(),
        age: s.int(),
        get friends() {
          return s.relation(() => [profileModel]); // No s.lazy() needed!
        },
      });

      // Should work at runtime
      expect(profileModel.name).toBe("profile");
      expect(profileModel.relations.has("friends")).toBe(true);

      const friendsRelation = profileModel.relations.get("friends");
      expect(friendsRelation?.relationType).toBe("many");
      expect(friendsRelation?.targetModel.name).toBe("profile");

      // Should have proper types
      type ProfileType = typeof profileModel.infer;
      expectTypeOf<ProfileType["name"]>().toEqualTypeOf<string>();
      expectTypeOf<ProfileType["age"]>().toEqualTypeOf<number>();
    });
  });
});
