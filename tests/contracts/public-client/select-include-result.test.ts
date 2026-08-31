/**
 * Provider-backed tests for InferSelectInclude result types
 * Tests that select/include properly infer result shapes
 */

import type { OperationResult } from "@client/types";
import { createClient as PGliteCreateClient } from "@drivers/pglite";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";
import { clientUserPostSchema } from "@tests/fixtures/user-post-schema";
import {
  createStandardUserPostPosts,
  createStandardUserPostUsers,
} from "@tests/fixtures/user-post-seed";
import type { testUser } from "@tests/fixtures/schema.js";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

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

  describe("operation result branches", () => {
    test("top-level select and include has no mutation result shape", () => {
      type Args = {
        data: {
          id: string;
          name: string;
          email: string;
          tags: string[];
        };
        select: { id: true };
        include: { posts: true };
      };

      type Result = OperationResult<"create", UserModel, Args>;

      expectTypeOf<Result>().toEqualTypeOf<never>();
    });

    test("findMany select returns narrowed array element shape", () => {
      type Args = {
        select: { id: true; email: true };
      };

      type Result = OperationResult<"findMany", UserModel, Args>;
      type Element = Result[number];

      expectTypeOf<Element>().toHaveProperty("id");
      expectTypeOf<Element>().toHaveProperty("email");
      expectTypeOf<keyof Element>().toEqualTypeOf<"id" | "email">();
    });

    test("create include returns included relation shape", () => {
      type Args = {
        data: {
          id: string;
          name: string;
          email: string;
          tags: string[];
        };
        include: { posts: true };
      };

      type Result = OperationResult<"create", UserModel, Args>;

      expectTypeOf<Result>().toHaveProperty("id");
      expectTypeOf<Result>().toHaveProperty("posts");
      expectTypeOf<Result["posts"]>().toMatchTypeOf<readonly unknown[]>();
    });

    test("update select returns narrowed mutation result", () => {
      type Args = {
        where: { id: string };
        data: { name?: string };
        select: { name: true };
      };

      type Result = OperationResult<"update", UserModel, Args>;

      expectTypeOf<Result>().toHaveProperty("name");
      expectTypeOf<keyof Result>().toEqualTypeOf<"name">();
    });

    test("update select returns relation count result", () => {
      type Args = {
        where: { id: string };
        data: { name?: string };
        select: {
          _count: { select: { posts: true } };
          posts: { select: { id: true } };
        };
      };

      type Result = OperationResult<"update", UserModel, Args>;

      expectTypeOf<Result>().toHaveProperty("_count");
      expectTypeOf<Result["_count"]>().toHaveProperty("posts");
      expectTypeOf<Result["_count"]["posts"]>().toEqualTypeOf<number>();
      expectTypeOf<keyof Result>().toEqualTypeOf<"_count" | "posts">();
    });

    test("findUniqueOrThrow removes null from result", () => {
      type Args = {
        where: { id: string };
        select: { id: true };
      };

      type Result = OperationResult<"findUniqueOrThrow", UserModel, Args>;

      expectTypeOf<Result>().toHaveProperty("id");
      expectTypeOf<null>().not.toMatchTypeOf<Result>();
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

describe("nested write mutation result shaping", () => {
  let client: Awaited<
    ReturnType<
      typeof PGliteCreateClient<
        typeof clientUserPostSchema,
        { schema: typeof clientUserPostSchema }
      >
    >
  >;

  beforeAll(async () => {
    client = PGliteCreateClient({ schema: clientUserPostSchema });
    await syncLiveSchema(client);
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  beforeEach(async () => {
    await client.post.deleteMany();
    await client.user.deleteMany();
  });

  test("refetches included relations after nested update", async () => {
    const { alice } = await createStandardUserPostUsers(client);
    const { post1 } = await createStandardUserPostPosts(client, alice.id);

    const result = await client.user.update({
      where: { id: alice.id },
      data: {
        posts: {
          update: {
            where: { id: post1.id },
            data: { title: "First Post Updated" },
          },
        },
      },
      include: {
        posts: { orderBy: { id: "asc" } },
      },
    });

    expect(result.posts.map((post) => post.title)).toEqual([
      "First Post Updated",
      "Second Post",
      "Third Post",
    ]);
  });

  test("returns selected relations after nested updateMany", async () => {
    const { alice } = await createStandardUserPostUsers(client);
    await createStandardUserPostPosts(client, alice.id);

    const result = await client.user.update({
      where: { id: alice.id },
      data: {
        posts: {
          updateMany: {
            where: { published: false },
            data: {
              published: true,
              title: "Second Post Published",
            },
          },
        },
      },
      select: {
        id: true,
        posts: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            title: true,
            published: true,
          },
        },
      },
    });

    expect(result).toHaveProperty("id", alice.id);
    expect(result).toHaveProperty("posts");
    expect(result).not.toHaveProperty("email");
    expect(result.posts).toEqual([
      { id: "post-1", title: "First Post", published: true },
      { id: "post-2", title: "Second Post Published", published: true },
      { id: "post-3", title: "Third Post", published: true },
    ]);
  });

  test("refetches included relations after nested upsert", async () => {
    const { alice } = await createStandardUserPostUsers(client);
    await createStandardUserPostPosts(client, alice.id);

    const result = await client.user.update({
      where: { id: alice.id },
      data: {
        posts: {
          upsert: {
            where: { id: "post-4" },
            create: {
              id: "post-4",
              title: "Upserted Post",
              content: null,
              published: true,
              views: 10,
            },
            update: { title: "Should Not Update" },
          },
        },
      },
      include: {
        posts: { orderBy: { id: "asc" } },
      },
    });

    expect(result.posts.map((post) => post.id)).toEqual([
      "post-1",
      "post-2",
      "post-3",
      "post-4",
    ]);
    expect(result.posts[3]?.title).toBe("Upserted Post");
  });

  test("returns selected relation count after nested deleteMany", async () => {
    const { alice } = await createStandardUserPostUsers(client);
    await createStandardUserPostPosts(client, alice.id);

    const result = await client.user.update({
      where: { id: alice.id },
      data: {
        posts: {
          deleteMany: { published: false },
        },
      },
      select: {
        id: true,
        _count: { select: { posts: true } },
        posts: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    expect(result).toHaveProperty("id", alice.id);
    expect(result).not.toHaveProperty("email");
    expect(result._count.posts).toBe(2);
    expect(result.posts).toEqual([
      { id: "post-1", title: "First Post" },
      { id: "post-3", title: "Third Post" },
    ]);
  });
});
