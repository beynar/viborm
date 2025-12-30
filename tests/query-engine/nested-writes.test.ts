/**
 * Nested Writes Unit Tests
 *
 * Tests for the relation-data-builder and nested-writes functionality.
 */
import { describe, it, expect } from "vitest";
import { s } from "../../src/schema/index.js";
import {
  separateData,
  needsTransaction,
  canUseSubqueryOnly,
} from "../../src/query-engine/builders/relation-data-builder.js";
import {
  createQueryContext,
  createModelRegistry,
} from "../../src/query-engine/index.js";
import { PostgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter.js";

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
    author: s.manyToOne(() => User, {
      fields: ["authorId"],
      references: ["id"],
    }),
  })
  .map("posts");

// User model with posts relation (FK on Post side)
const UserWithPosts = s.model({
  id: s.string().id().ulid(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.oneToMany(() => Post, {
    fields: ["id"],
    references: ["authorId"],
  }),
});

// Model with compound ID
const CompoundUser = s
  .model({
    email: s.string(),
    orgId: s.string(),
    name: s.string(),
  })
  .id(["email", "orgId"]);

// =============================================================================
// TEST SETUP
// =============================================================================

const adapter = new PostgresAdapter();
const registry = createModelRegistry({
  User,
  Post,
  UserWithPosts,
  CompoundUser,
});

// =============================================================================
// SEPARATE DATA TESTS
// =============================================================================

describe("separateData", () => {
  it("separates scalar fields from relation fields", () => {
    const ctx = createQueryContext(adapter, UserWithPosts, registry);

    const data = {
      name: "Alice",
      email: "alice@example.com",
      posts: {
        create: { title: "Hello", content: "World" },
      },
    };

    const { scalar, relations } = separateData(ctx, data);

    expect(scalar).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(Object.keys(relations)).toContain("posts");
    expect(relations.posts?.create).toBeDefined();
  });

  it("handles data with only scalar fields", () => {
    const ctx = createQueryContext(adapter, User, registry);

    const data = {
      name: "Alice",
      email: "alice@example.com",
    };

    const { scalar, relations } = separateData(ctx, data);

    expect(scalar).toEqual(data);
    expect(Object.keys(relations)).toHaveLength(0);
  });

  it("handles connect mutation", () => {
    const ctx = createQueryContext(adapter, Post, registry);

    const data = {
      title: "Hello",
      author: {
        connect: { id: "user-123" },
      },
    };

    const { scalar, relations } = separateData(ctx, data);

    expect(scalar).toEqual({ title: "Hello" });
    expect(relations.author?.connect).toEqual({ id: "user-123" });
  });

  it("handles disconnect mutation", () => {
    const ctx = createQueryContext(adapter, Post, registry);

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
    const ctx = createQueryContext(adapter, Post, registry);

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
    const ctx = createQueryContext(adapter, UserWithPosts, registry);

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
    const ctx = createQueryContext(adapter, UserWithPosts, registry);

    const data = {
      name: "Alice",
      posts: {
        set: [{ id: "post-123" }, { id: "post-456" }],
      },
    };

    const { relations } = separateData(ctx, data);

    expect(relations.posts?.set).toHaveLength(2);
  });

  it("skips undefined values", () => {
    const ctx = createQueryContext(adapter, User, registry);

    const data = {
      name: "Alice",
      email: undefined,
    };

    const { scalar } = separateData(ctx, data);

    expect(scalar).toEqual({ name: "Alice" });
    expect("email" in scalar).toBe(false);
  });
});

// =============================================================================
// NEEDS TRANSACTION TESTS
// =============================================================================

describe("needsTransaction", () => {
  it("returns true when create is present", () => {
    const ctx = createQueryContext(adapter, UserWithPosts, registry);
    const data = {
      posts: {
        create: { title: "Hello" },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(needsTransaction(relations)).toBe(true);
  });

  it("returns true when connectOrCreate is present", () => {
    const ctx = createQueryContext(adapter, Post, registry);
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
    const ctx = createQueryContext(adapter, UserWithPosts, registry);
    const data = {
      posts: {
        delete: { id: "post-123" },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(needsTransaction(relations)).toBe(true);
  });

  it("returns true when set is present", () => {
    const ctx = createQueryContext(adapter, UserWithPosts, registry);
    const data = {
      posts: {
        set: [{ id: "post-123" }],
      },
    };

    const { relations } = separateData(ctx, data);
    expect(needsTransaction(relations)).toBe(true);
  });

  it("returns false for simple connect when current holds FK", () => {
    const ctx = createQueryContext(adapter, Post, registry);
    const data = {
      author: {
        connect: { id: "user-123" },
      },
    };

    const { relations } = separateData(ctx, data);
    // Post has authorId FK, so connect can use subquery
    expect(needsTransaction(relations)).toBe(false);
  });

  it("returns true for connect when related holds FK", () => {
    const ctx = createQueryContext(adapter, UserWithPosts, registry);
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
// CAN USE SUBQUERY ONLY TESTS
// =============================================================================

describe("canUseSubqueryOnly", () => {
  it("returns true for simple connect (FK on current model)", () => {
    const ctx = createQueryContext(adapter, Post, registry);
    const data = {
      author: {
        connect: { id: "user-123" },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(canUseSubqueryOnly(relations)).toBe(true);
  });

  it("returns false when create is needed", () => {
    const ctx = createQueryContext(adapter, UserWithPosts, registry);
    const data = {
      posts: {
        create: { title: "Hello" },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(canUseSubqueryOnly(relations)).toBe(false);
  });

  it("returns false when connectOrCreate is needed", () => {
    const ctx = createQueryContext(adapter, Post, registry);
    const data = {
      author: {
        connectOrCreate: {
          where: { id: "user-123" },
          create: { name: "Alice", email: "alice@example.com" },
        },
      },
    };

    const { relations } = separateData(ctx, data);
    expect(canUseSubqueryOnly(relations)).toBe(false);
  });
});

// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

describe("error handling", () => {
  it("handles empty data gracefully", () => {
    const ctx = createQueryContext(adapter, User, registry);

    const { scalar, relations } = separateData(ctx, {});

    expect(scalar).toEqual({});
    expect(Object.keys(relations)).toHaveLength(0);
  });

  it("ignores null relation value", () => {
    const ctx = createQueryContext(adapter, Post, registry);

    const data = {
      title: "Hello",
      author: null,
    };

    const { relations } = separateData(ctx, data);

    expect(Object.keys(relations)).toHaveLength(0);
  });

  it("handles array of creates", () => {
    const ctx = createQueryContext(adapter, UserWithPosts, registry);

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
    const ctx = createQueryContext(adapter, UserWithPosts, registry);

    const data = {
      posts: {
        connect: [{ id: "post-1" }, { id: "post-2" }],
      },
    };

    const { relations } = separateData(ctx, data);

    expect(Array.isArray(relations.posts?.connect)).toBe(true);
    expect((relations.posts?.connect as unknown[])?.length).toBe(2);
  });
});
