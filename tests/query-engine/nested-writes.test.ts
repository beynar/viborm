/**
 * Nested Writes Unit Tests
 *
 * Tests for the relation-data-builder and nested-writes functionality.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createQueryScope } from "@query-engine";
import {
  getFkDirection,
  needsTransaction,
  separateData,
} from "@query-engine/builders/relation-data-builder";
import { s } from "@schema";
import { describe, expect, it } from "vitest";

// =============================================================================
// TEST MODELS
// =============================================================================

// Simple User model with single ID
const User = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
});

// Post model with FK to User (author field with FK on Post side)
const Post = s
  .model({
    id: s.string().id().ulid(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    authorId: s.string(),
    author: s
      .manyToOne(() => User)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");

// User model with posts relation (FK on Post side)
const UserWithPosts = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.oneToMany(() => Post),
});

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

// =============================================================================
// TEST SETUP
// =============================================================================

const adapter = new PostgresAdapter();
// =============================================================================
// SEPARATE DATA TESTS
// =============================================================================

describe("separateData", () => {
  it("separates scalar fields from relation fields", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      name: "Alice",
      email: "alice@example.com",
      posts: {
        create: { title: "Hello", content: "World" },
      },
    };

    const { scalarData, relations } = separateData(ctx, data);

    expect(scalarData).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(Object.keys(relations)).toContain("posts");
    expect(relations.posts?.create).toBeDefined();
  });

  it("handles data with only scalar fields", () => {
    const ctx = createQueryScope(adapter, User);

    const data = {
      name: "Alice",
      email: "alice@example.com",
    };

    const { scalarData, relations } = separateData(ctx, data);

    expect(scalarData).toEqual(data);
    expect(Object.keys(relations)).toHaveLength(0);
  });

  it("handles connect mutation", () => {
    const ctx = createQueryScope(adapter, Post);

    const data = {
      title: "Hello",
      author: {
        connect: { id: "user-123" },
      },
    };

    const { scalarData, relations } = separateData(ctx, data);

    expect(scalarData).toEqual({ title: "Hello" });
    expect(relations.author?.connect).toEqual({ id: "user-123" });
  });

  it("handles disconnect mutation", () => {
    const ctx = createQueryScope(adapter, Post);

    const data = {
      title: "Hello",
      author: {
        disconnect: true,
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.author?.disconnect).toBe(true);
  });

  it("handles connectOrCreate mutation", () => {
    const ctx = createQueryScope(adapter, Post);

    const data = {
      title: "Hello",
      author: {
        connectOrCreate: {
          where: { id: "user-123" },
          create: { name: "Alice", email: "alice@example.com" },
        },
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.author?.connectOrCreate).toBeDefined();
    expect(relations.author?.connectOrCreate).toHaveProperty("where");
    expect(relations.author?.connectOrCreate).toHaveProperty("create");
  });

  it("handles delete mutation", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      name: "Alice",
      posts: {
        delete: { id: "post-123" },
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.posts?.delete).toEqual({ id: "post-123" });
  });

  it("handles set mutation for to-many", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      name: "Alice",
      posts: {
        set: [{ id: "post-123" }, { id: "post-456" }],
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.posts?.set).toHaveLength(2);
  });

  it("handles update mutation for to-many", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      name: "Alice",
      posts: {
        update: {
          where: { id: "post-123" },
          data: { title: "Updated" },
        },
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.posts?.update).toEqual([
      {
        where: { id: "post-123" },
        data: { title: "Updated" },
      },
    ]);
  });

  it("handles updateMany mutation for to-many", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      name: "Alice",
      posts: {
        updateMany: {
          where: { published: false },
          data: { published: true },
        },
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.posts?.updateMany).toEqual([
      {
        where: { published: false },
        data: { published: true },
      },
    ]);
  });

  it("handles deleteMany mutation for to-many", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      name: "Alice",
      posts: {
        deleteMany: { published: false },
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.posts?.deleteMany).toEqual([{ published: false }]);
  });

  it("skips undefined values", () => {
    const ctx = createQueryScope(adapter, User);

    const data = {
      name: "Alice",
      email: undefined,
    };

    const { scalarData } = separateData(ctx, data);

    expect(scalarData).toEqual({ name: "Alice" });
    expect("email" in scalarData).toBe(false);
  });
});

// =============================================================================
// NEEDS TRANSACTION TESTS
// =============================================================================

describe("needsTransaction", () => {
  it("returns true when create is present", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);
    const data = {
      posts: {
        create: { title: "Hello" },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(needsTransaction(relations)).toBe(true);
  });

  it("returns true when connectOrCreate is present", () => {
    const ctx = createQueryScope(adapter, Post);
    const data = {
      author: {
        connectOrCreate: {
          where: { id: "user-123" },
          create: { name: "Alice", email: "alice@example.com" },
        },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(needsTransaction(relations)).toBe(true);
  });

  it("returns true when delete is present", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);
    const data = {
      posts: {
        delete: { id: "post-123" },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(needsTransaction(relations)).toBe(true);
  });

  it("returns true when set is present", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);
    const data = {
      posts: {
        set: [{ id: "post-123" }],
      },
    };

    const { relations } = separateData(ctx, data);
    expect(needsTransaction(relations)).toBe(true);
  });

  it("returns true for simple connect when current holds FK", () => {
    const ctx = createQueryScope(adapter, Post);
    const data = {
      author: {
        connect: { id: "user-123" },
      },
    };

    const { relations } = separateData(ctx, data);
    // Connect verifies the target exists before mutating the parent.
    expect(needsTransaction(relations)).toBe(true);
  });

  it("returns true for connect when related holds FK", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);
    const data = {
      posts: {
        connect: { id: "post-123" },
      },
    };

    const { relations } = separateData(ctx, data);
    // UserWithPosts doesn't have FK, posts have the FK
    expect(needsTransaction(relations)).toBe(true);
  });
});

// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

describe("error handling", () => {
  it("handles empty data gracefully", () => {
    const ctx = createQueryScope(adapter, User);

    const { scalarData, relations } = separateData(ctx, {});

    expect(scalarData).toEqual({});
    expect(Object.keys(relations)).toHaveLength(0);
  });

  it("ignores null relation value", () => {
    const ctx = createQueryScope(adapter, Post);

    const data = {
      title: "Hello",
      author: null,
    };

    const { relations } = separateData(ctx, data);

    expect(Object.keys(relations)).toHaveLength(0);
  });

  it("handles array of creates", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      name: "Alice",
      posts: {
        create: [{ title: "Post 1" }, { title: "Post 2" }, { title: "Post 3" }],
      },
    };

    const { relations } = separateData(ctx, data);

    expect(Array.isArray(relations.posts?.create)).toBe(true);
    expect((relations.posts?.create as unknown[])?.length).toBe(3);
  });

  it("handles array of connects", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      posts: {
        connect: [{ id: "post-1" }, { id: "post-2" }],
      },
    };

    const { relations } = separateData(ctx, data);

    expect(Array.isArray(relations.posts?.connect)).toBe(true);
    expect((relations.posts?.connect as unknown[])?.length).toBe(2);
  });

  it("handles createMany mutation", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      name: "Alice",
      posts: {
        createMany: {
          data: [{ title: "Post 1" }, { title: "Post 2" }, { title: "Post 3" }],
        },
      },
    };

    const { scalarData, relations } = separateData(ctx, data);

    expect(scalarData).toEqual({ name: "Alice" });
    expect(relations.posts?.createMany).toBeDefined();
    expect(relations.posts?.createMany?.data).toHaveLength(3);
    expect(relations.posts?.createMany?.data).toEqual([
      { title: "Post 1" },
      { title: "Post 2" },
      { title: "Post 3" },
    ]);
  });

  it("handles createMany with skipDuplicates", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);

    const data = {
      posts: {
        createMany: {
          data: [{ title: "Post 1" }],
          skipDuplicates: true,
        },
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.posts?.createMany?.skipDuplicates).toBe(true);
  });
});

// =============================================================================
// NEEDS TRANSACTION WITH CREATEMANY TESTS
// =============================================================================

describe("needsTransaction with createMany", () => {
  it("returns true when createMany is present", () => {
    const ctx = createQueryScope(adapter, UserWithPosts);
    const data = {
      posts: {
        createMany: {
          data: [{ title: "Hello" }],
        },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(needsTransaction(relations)).toBe(true);
  });
});

// =============================================================================
// NAMED INVERSE RELATION TESTS
// =============================================================================

describe("named inverse relations", () => {
  it("chooses the FK matching the relation name", () => {
    const ctx = createQueryScope(adapter, NamedUser);
    const { relations } = separateData(ctx, {
      posts: {
        create: { id: "post-1", title: "Post" },
      },
      coAuthoredPosts: {
        create: { id: "post-2", title: "Co-authored Post" },
      },
    });

    const postsMutation = relations.posts;
    const coAuthoredMutation = relations.coAuthoredPosts;

    if (!(postsMutation && coAuthoredMutation)) {
      throw new Error("Expected both named relation mutations to be parsed");
    }

    const postsDirection = getFkDirection(ctx, postsMutation.relationInfo);
    const coAuthoredDirection = getFkDirection(
      ctx,
      coAuthoredMutation.relationInfo
    );

    expect(postsDirection.fkFields).toEqual(["authorId"]);
    expect(coAuthoredDirection.fkFields).toEqual(["coAuthorId"]);
  });
});
