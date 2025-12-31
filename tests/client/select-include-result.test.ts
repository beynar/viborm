/**
 * Type tests for InferSelectInclude result types
 * Tests that select/include properly infer result shapes
 */
import { describe, test, expectTypeOf } from "vitest";
import type { OperationResult } from "../../src/client/types.js";
import type { testUser } from "../schema.js";

// Test types directly using OperationResult
type UserModel = typeof testUser;

describe("InferSelectInclude result types", () => {
  describe("findFirst with select", () => {
    test("select with relation only returns selected fields", () => {
      type Args = {
        where: { id: string };
        select: { posts: true };
      };

      type Result = OperationResult<"findFirst", UserModel, Args>;

      // Result should be object | null
      type NonNullResult = NonNullable<Result>;

      // Should have posts
      expectTypeOf<NonNullResult>().toHaveProperty("posts");

      // posts should be the only key
      type ResultKeys = keyof NonNullResult;
      expectTypeOf<"posts">().toMatchTypeOf<ResultKeys>();
    });

    test("select with scalar fields returns only those fields", () => {
      type Args = {
        where: { id: string };
        select: { name: true; email: true };
      };

      type Result = NonNullable<OperationResult<"findFirst", UserModel, Args>>;

      // Should have name and email
      expectTypeOf<Result>().toHaveProperty("name");
      expectTypeOf<Result>().toHaveProperty("email");

      type ResultKeys = keyof Result;
      expectTypeOf<"name">().toMatchTypeOf<ResultKeys>();
      expectTypeOf<"email">().toMatchTypeOf<ResultKeys>();
    });

    test("select with multiple fields returns correct shape", () => {
      type Args = {
        where: { id: string };
        select: { id: true; name: true; posts: true };
      };

      type Result = NonNullable<OperationResult<"findFirst", UserModel, Args>>;

      // Should have id, name, and posts
      expectTypeOf<Result>().toHaveProperty("id");
      expectTypeOf<Result>().toHaveProperty("name");
      expectTypeOf<Result>().toHaveProperty("posts");

      // posts should be an array (oneToMany relation)
      type PostsType = Result["posts"];
      // Arrays extend readonly unknown[]
      expectTypeOf<PostsType>().toMatchTypeOf<readonly unknown[]>();
    });
  });

  describe("findFirst with include", () => {
    test("include adds relation to base result", () => {
      type Args = {
        where: { id: string };
        include: { posts: true };
      };

      type Result = NonNullable<OperationResult<"findFirst", UserModel, Args>>;

      // Should have all scalar fields
      expectTypeOf<Result>().toHaveProperty("id");
      expectTypeOf<Result>().toHaveProperty("name");
      expectTypeOf<Result>().toHaveProperty("email");
      expectTypeOf<Result>().toHaveProperty("age");
      expectTypeOf<Result>().toHaveProperty("bio");
      expectTypeOf<Result>().toHaveProperty("tags");
      expectTypeOf<Result>().toHaveProperty("createdAt");
      expectTypeOf<Result>().toHaveProperty("updatedAt");

      // Plus the included relation
      expectTypeOf<Result>().toHaveProperty("posts");
    });
  });

  describe("findFirst without select/include", () => {
    test("returns base model output with all scalar fields", () => {
      type Args = {
        where: { id: string };
      };

      type Result = NonNullable<OperationResult<"findFirst", UserModel, Args>>;

      // Should have all scalar fields
      expectTypeOf<Result>().toHaveProperty("id");
      expectTypeOf<Result>().toHaveProperty("name");
      expectTypeOf<Result>().toHaveProperty("email");
      expectTypeOf<Result>().toHaveProperty("age");
      expectTypeOf<Result>().toHaveProperty("bio");
      expectTypeOf<Result>().toHaveProperty("tags");
      expectTypeOf<Result>().toHaveProperty("createdAt");
      expectTypeOf<Result>().toHaveProperty("updatedAt");
    });
  });

  describe("no index signature pollution", () => {
    test("result type should not have [x: string]: never", () => {
      type Args = {
        where: { id: string };
        select: { posts: true };
      };

      type Result = NonNullable<OperationResult<"findFirst", UserModel, Args>>;

      // Result should be an exact object type, not have an index signature
      // If there was [x: string]: never, this would fail
      type Keys = keyof Result;

      // posts should be assignable to Keys
      expectTypeOf<"posts">().toMatchTypeOf<Keys>();
    });

    test("result type should not be a union of similar types", () => {
      type Args = {
        where: { id: string };
        select: { name: true };
      };

      type Result = OperationResult<"findFirst", UserModel, Args>;

      // Result should be { name: string } | null, not a union of multiple object types
      type NonNullResult = NonNullable<Result>;
      type Keys = keyof NonNullResult;

      // name should be assignable to Keys
      expectTypeOf<"name">().toMatchTypeOf<Keys>();
    });
  });

  describe("scalar output type inference", () => {
    test("datetime fields return Date type, not string", () => {
      type Args = {
        where: { id: string };
        select: { createdAt: true; updatedAt: true };
      };

      type Result = NonNullable<OperationResult<"findFirst", UserModel, Args>>;

      // createdAt and updatedAt should be Date, not string
      type CreatedAtType = Result["createdAt"];
      type UpdatedAtType = Result["updatedAt"];

      // Verify they are Date, not string
      expectTypeOf<CreatedAtType>().toMatchTypeOf<Date>();
      expectTypeOf<UpdatedAtType>().toMatchTypeOf<Date>();

      // Ensure they are NOT string
      expectTypeOf<string>().not.toMatchTypeOf<CreatedAtType>();
    });

    test("nullable fields return correct type with null", () => {
      type Args = {
        where: { id: string };
        select: { age: true; bio: true };
      };

      type Result = NonNullable<OperationResult<"findFirst", UserModel, Args>>;

      // age and bio are nullable in testUser
      type AgeType = Result["age"];
      type BioType = Result["bio"];

      // Should include null
      expectTypeOf<null>().toMatchTypeOf<AgeType>();
      expectTypeOf<null>().toMatchTypeOf<BioType>();
    });

    test("array fields return array type", () => {
      type Args = {
        where: { id: string };
        select: { tags: true };
      };

      type Result = NonNullable<OperationResult<"findFirst", UserModel, Args>>;

      // tags is string[] in testUser
      type TagsType = Result["tags"];

      expectTypeOf<TagsType>().toMatchTypeOf<string[]>();
    });
  });
});
