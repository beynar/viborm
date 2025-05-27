import { describe, test, expect, expectTypeOf } from "vitest";
import { s } from "../src/schema/index.js";

describe("Recursive Schema Support with Standard Relationship Types", () => {
  test("should support all four standard database relationship types", () => {
    // Define models that demonstrate all relationship types

    const User = s.model("User", {
      id: s.string(),
      email: s.string(),

      // oneToOne: User has one Profile
      profile: s.relation.oneToOne(() => Profile),

      // oneToMany: User has many Posts
      posts: s.relation.oneToMany(() => Post),

      // manyToMany: User has many Roles (through junction table)
      roles: s.relation.manyToMany(() => Role),
    });

    const Profile = s.model("Profile", {
      id: s.string(),
      bio: s.string(),

      // manyToOne: Profile belongs to one User
      user: s.relation.manyToOne(() => User),
    });

    const Post = s.model("Post", {
      id: s.string(),
      title: s.string(),

      // manyToOne: Post belongs to one User (author)
      author: s.relation.manyToOne(() => User),

      // oneToOne: Post has one featured Image
      featuredImage: s.relation.oneToOne(() => Image),

      // oneToMany: Post has many Comments
      comments: s.relation.oneToMany(() => Comment),

      // manyToMany: Post has many Tags
      tags: s.relation.manyToMany(() => Tag),
    });

    const Comment = s.model("Comment", {
      id: s.string(),
      content: s.string(),

      // manyToOne: Comment belongs to one Post
      post: s.relation.manyToOne(() => Post),

      // manyToOne: Comment belongs to one User (author)
      author: s.relation.manyToOne(() => User),

      // Self-referential oneToMany: Comment has many replies
      replies: s.relation.oneToMany(() => Comment),

      // Self-referential manyToOne: Comment belongs to one parent comment
      parent: s.relation.manyToOne(() => Comment),
    });

    const Image = s.model("Image", {
      id: s.string(),
      url: s.string(),

      // manyToOne: Image belongs to one Post (if it's a featured image)
      post: s.relation.manyToOne(() => Post),
    });

    const Role = s.model("Role", {
      id: s.string(),
      name: s.string(),

      // manyToMany: Role has many Users
      users: s.relation.manyToMany(() => User),
    });

    const Tag = s.model("Tag", {
      id: s.string(),
      name: s.string(),

      // manyToMany: Tag has many Posts
      posts: s.relation.manyToMany(() => Post),
    });

    // Verify the models were created correctly
    expect(User.name).toBe("User");
    expect(Post.name).toBe("Post");
    expect(Profile.name).toBe("Profile");
    expect(Comment.name).toBe("Comment");
    expect(Image.name).toBe("Image");
    expect(Role.name).toBe("Role");
    expect(Tag.name).toBe("Tag");

    // Verify relationships exist
    expect(User.relations.has("profile")).toBe(true);
    expect(User.relations.has("posts")).toBe(true);
    expect(User.relations.has("roles")).toBe(true);

    expect(Profile.relations.has("user")).toBe(true);
    expect(Post.relations.has("author")).toBe(true);
    expect(Post.relations.has("featuredImage")).toBe(true);
    expect(Post.relations.has("comments")).toBe(true);
    expect(Post.relations.has("tags")).toBe(true);

    // Verify relationship types
    expect(User.relations.get("profile")?.relationType).toBe("oneToOne");
    expect(User.relations.get("posts")?.relationType).toBe("oneToMany");
    expect(User.relations.get("roles")?.relationType).toBe("manyToMany");
    expect(Profile.relations.get("user")?.relationType).toBe("manyToOne");

    // Test relationship type checking methods
    const userProfileRelation = User.relations.get("profile")!;
    const userPostsRelation = User.relations.get("posts")!;
    const userRolesRelation = User.relations.get("roles")!;
    const profileUserRelation = Profile.relations.get("user")!;

    expect(userProfileRelation.isToOne).toBe(true);
    expect(userProfileRelation.isToMany).toBe(false);
    expect(userProfileRelation.requiresJunctionTable).toBe(false);

    expect(userPostsRelation.isToOne).toBe(false);
    expect(userPostsRelation.isToMany).toBe(true);
    expect(userPostsRelation.requiresJunctionTable).toBe(false);

    expect(userRolesRelation.isToOne).toBe(false);
    expect(userRolesRelation.isToMany).toBe(true);
    expect(userRolesRelation.requiresJunctionTable).toBe(true);

    expect(profileUserRelation.isToOne).toBe(true);
    expect(profileUserRelation.isToMany).toBe(false);
    expect(profileUserRelation.requiresJunctionTable).toBe(false);
  });

  test("should support legacy relation syntax for backward compatibility", () => {
    const User = s.model("User", {
      id: s.string(),
      email: s.string(),
      posts: s.relation.many(() => Post), // Legacy: should map to oneToMany
    });

    const Post = s.model("Post", {
      id: s.string(),
      title: s.string(),
      author: s.relation.one(() => User), // Legacy: should map to manyToOne
    });

    // Verify legacy mappings work
    expect(User.relations.get("posts")?.relationType).toBe("oneToMany");
    expect(Post.relations.get("author")?.relationType).toBe("manyToOne");
  });

  test("should enforce junction table restrictions", () => {
    const User = s.model("User", {
      id: s.string(),
      roles: s.relation.manyToMany(() => Role),
    });

    const Role = s.model("Role", {
      id: s.string(),
      users: s.relation.manyToMany(() => User),
    });

    const userRolesRelation = User.relations.get("roles")!;

    // Should allow junction table configuration for manyToMany
    expect(() => {
      userRolesRelation.junctionTable("user_roles");
    }).not.toThrow();

    // Should throw for non-manyToMany relations
    const Profile = s.model("Profile", {
      id: s.string(),
      user: s.relation.manyToOne(() => User),
    });

    const profileUserRelation = Profile.relations.get("user")!;

    expect(() => {
      profileUserRelation.junctionTable("should_fail");
    }).toThrow(
      "Junction tables can only be configured for manyToMany relations"
    );
  });

  test("should provide correct type inference for different relationship types", () => {
    // Simple models to test type inference without circular references
    const SimpleUser = s.model("SimpleUser", {
      id: s.string(),
      name: s.string(),
    });

    const SimplePost = s.model("SimplePost", {
      id: s.string(),
      title: s.string(),
      author: s.relation.manyToOne(() => SimpleUser),
    });

    const SimpleProfile = s.model("SimpleProfile", {
      id: s.string(),
      bio: s.string(),
      user: s.relation.manyToOne(() => SimpleUser),
    });

    const SimpleTag = s.model("SimpleTag", {
      id: s.string(),
      name: s.string(),
    });

    // Create models with different relation types
    const TestUser = s.model("TestUser", {
      id: s.string(),
      oneToOneProfile: s.relation.oneToOne(() => SimpleProfile),
      oneToManyPosts: s.relation.oneToMany(() => SimplePost),
      manyToManyTags: s.relation.manyToMany(() => SimpleTag),
    });

    const TestProfile = s.model("TestProfile", {
      id: s.string(),
      manyToOneUser: s.relation.manyToOne(() => SimpleUser),
    });

    // Test that relationships have correct return types (arrays vs single objects)
    const userOneToOneRelation = TestUser.relations.get("oneToOneProfile")!;
    const userOneToManyRelation = TestUser.relations.get("oneToManyPosts")!;
    const userManyToManyRelation = TestUser.relations.get("manyToManyTags")!;
    const profileManyToOneRelation =
      TestProfile.relations.get("manyToOneUser")!;

    // Verify return type characteristics
    expect(userOneToOneRelation.isToOne).toBe(true);
    expect(userOneToManyRelation.isToMany).toBe(true);
    expect(userManyToManyRelation.isToMany).toBe(true);
    expect(profileManyToOneRelation.isToOne).toBe(true);
  });
});
