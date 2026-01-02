/**
 * ToMany Relation Schema Tests
 *
 * Tests schemas for oneToMany and manyToMany relations:
 * - Filter schemas (some, every, none)
 * - Create schemas (create, connect, connectOrCreate) - single or array
 * - Update schemas (create, connect, disconnect, set, delete, update, updateMany, deleteMany, upsert)
 * - Select/Include schemas with pagination
 * - OrderBy schemas (_count)
 */

import { describe, test, expect } from "vitest";
import { parse } from "@validation";
import { authorSchemas } from "../fixtures";

// =============================================================================
// TO-MANY FILTER SCHEMAS
// =============================================================================

describe("ToMany Filter - Author.posts (oneToMany)", () => {
  const schema = authorSchemas._filter.relation;

  test("accepts 'some' filter", () => {
    const result = parse(schema, {
      posts: {
        some: { published: true },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'every' filter", () => {
    const result = parse(schema, {
      posts: {
        every: { published: true },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'none' filter", () => {
    const result = parse(schema, {
      posts: {
        none: { published: false },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts empty object for 'some' (any records exist)", () => {
    const result = parse(schema, {
      posts: {
        some: {},
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts nested filter operators in some", () => {
    const result = parse(schema, {
      posts: {
        some: {
          title: { contains: "hello" },
          published: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts deeply nested relation in filter", () => {
    const result = parse(schema, {
      posts: {
        some: {
          author: {
            is: { name: "Alice" },
          },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts combined some/every/none in AND", () => {
    const result = parse(authorSchemas.where, {
      AND: [
        { posts: { some: { published: true } } },
        { posts: { none: { title: { contains: "draft" } } } },
      ],
    });
    expect(result.issues).toBeUndefined();
  });

  test("rejects unknown relation key (strict)", () => {
    const result = parse(schema, {
      unknownRelation: { some: {} },
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// TO-MANY CREATE SCHEMAS
// =============================================================================

describe("ToMany Create - Author.posts (oneToMany)", () => {
  const schema = authorSchemas._create.relation;

  test("accepts single 'create' object", () => {
    const result = parse(schema, {
      posts: {
        create: {
          id: "post-1",
          title: "Hello",
          authorId: "author-1",
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array of 'create' objects", () => {
    const result = parse(schema, {
      posts: {
        create: [
          { id: "post-1", title: "First", authorId: "author-1" },
          { id: "post-2", title: "Second", authorId: "author-1" },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts single 'connect' object", () => {
    const result = parse(schema, {
      posts: {
        connect: { id: "post-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array of 'connect' objects", () => {
    const result = parse(schema, {
      posts: {
        connect: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts single 'connectOrCreate' object", () => {
    const result = parse(schema, {
      posts: {
        connectOrCreate: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "New", authorId: "author-1" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array of 'connectOrCreate' objects", () => {
    const result = parse(schema, {
      posts: {
        connectOrCreate: [
          {
            where: { id: "post-1" },
            create: { id: "post-1", title: "First", authorId: "author-1" },
          },
          {
            where: { id: "post-2" },
            create: { id: "post-2", title: "Second", authorId: "author-1" },
          },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts combined create and connect", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "new-post", title: "New", authorId: "author-1" },
        connect: { id: "existing-post" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: normalizes single create to array", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1", title: "Hello", authorId: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.create)).toBe(true);
      expect(result.value.posts?.create).toHaveLength(1);
    }
  });

  test("output: normalizes single connect to array", () => {
    const result = parse(schema, {
      posts: {
        connect: { id: "post-1" },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.connect)).toBe(true);
    }
  });

  test("rejects create with missing required field", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1" }, // missing title, authorId
      },
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// TO-MANY UPDATE SCHEMAS
// =============================================================================

describe("ToMany Update - Author.posts (oneToMany)", () => {
  const schema = authorSchemas._update.relation;

  // Create operations
  test("accepts single 'create'", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1", title: "New", authorId: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'create'", () => {
    const result = parse(schema, {
      posts: {
        create: [
          { id: "post-1", title: "First", authorId: "author-1" },
          { id: "post-2", title: "Second", authorId: "author-1" },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Connect operations
  test("accepts single 'connect'", () => {
    const result = parse(schema, {
      posts: {
        connect: { id: "post-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'connect'", () => {
    const result = parse(schema, {
      posts: {
        connect: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Disconnect operations
  test("accepts single 'disconnect'", () => {
    const result = parse(schema, {
      posts: {
        disconnect: { id: "post-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'disconnect'", () => {
    const result = parse(schema, {
      posts: {
        disconnect: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Set operations (replace all)
  test("accepts single 'set'", () => {
    const result = parse(schema, {
      posts: {
        set: { id: "post-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'set'", () => {
    const result = parse(schema, {
      posts: {
        set: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts empty array 'set' (unlink all)", () => {
    const result = parse(schema, {
      posts: {
        set: [],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Delete operations
  test("accepts single 'delete'", () => {
    const result = parse(schema, {
      posts: {
        delete: { id: "post-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'delete'", () => {
    const result = parse(schema, {
      posts: {
        delete: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Update operations
  test("accepts single 'update' with where and data", () => {
    const result = parse(schema, {
      posts: {
        update: {
          where: { id: "post-1" },
          data: { title: "Updated" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'update'", () => {
    const result = parse(schema, {
      posts: {
        update: [
          { where: { id: "post-1" }, data: { title: "First Updated" } },
          { where: { id: "post-2" }, data: { title: "Second Updated" } },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // UpdateMany operations
  test("accepts single 'updateMany' with filter", () => {
    const result = parse(schema, {
      posts: {
        updateMany: {
          where: { published: false },
          data: { published: true },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'updateMany'", () => {
    const result = parse(schema, {
      posts: {
        updateMany: [
          { where: { published: false }, data: { published: true } },
          { where: { title: { contains: "draft" } }, data: { title: "Final" } },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // DeleteMany operations
  test("accepts single 'deleteMany' with filter", () => {
    const result = parse(schema, {
      posts: {
        deleteMany: { published: false },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'deleteMany'", () => {
    const result = parse(schema, {
      posts: {
        deleteMany: [{ published: false }, { title: { contains: "temp" } }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts empty 'deleteMany' (delete all)", () => {
    const result = parse(schema, {
      posts: {
        deleteMany: {},
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Upsert operations
  test("accepts single 'upsert'", () => {
    const result = parse(schema, {
      posts: {
        upsert: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "New", authorId: "author-1" },
          update: { title: "Updated" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'upsert'", () => {
    const result = parse(schema, {
      posts: {
        upsert: [
          {
            where: { id: "post-1" },
            create: { id: "post-1", title: "First", authorId: "author-1" },
            update: { title: "First Updated" },
          },
          {
            where: { id: "post-2" },
            create: { id: "post-2", title: "Second", authorId: "author-1" },
            update: { title: "Second Updated" },
          },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Combined operations
  test("accepts combined operations in single update", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "new-post", title: "New", authorId: "author-1" },
        connect: { id: "existing-post" },
        disconnect: { id: "old-post" },
        update: { where: { id: "post-1" }, data: { title: "Updated" } },
        deleteMany: { published: false },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Output normalization tests
  test("output: normalizes single 'update' to array", () => {
    const result = parse(schema, {
      posts: {
        update: { where: { id: "post-1" }, data: { title: "Updated" } },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.update)).toBe(true);
    }
  });

  test("output: normalizes single 'updateMany' to array", () => {
    const result = parse(schema, {
      posts: {
        updateMany: { where: { published: false }, data: { published: true } },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.updateMany)).toBe(true);
    }
  });

  test("output: normalizes single 'deleteMany' to array", () => {
    const result = parse(schema, {
      posts: {
        deleteMany: { published: false },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.deleteMany)).toBe(true);
    }
  });

  test("output: normalizes single 'upsert' to array", () => {
    const result = parse(schema, {
      posts: {
        upsert: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "New", authorId: "author-1" },
          update: { title: "Updated" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.upsert)).toBe(true);
    }
  });

  test("output: normalizes single 'set' to array", () => {
    const result = parse(schema, {
      posts: {
        set: { id: "post-1" },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.set)).toBe(true);
    }
  });
});

// =============================================================================
// TO-MANY SELECT SCHEMAS
// =============================================================================

describe("ToMany Select - Author.posts (oneToMany)", () => {
  const schema = authorSchemas.select;

  test("accepts boolean true", () => {
    const result = parse(schema, {
      id: true,
      posts: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts nested select object", () => {
    const result = parse(schema, {
      id: true,
      posts: {
        select: {
          id: true,
          title: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts select with where filter", () => {
    const result = parse(schema, {
      posts: {
        where: { published: true },
        select: { id: true, title: true },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts select with pagination", () => {
    const result = parse(schema, {
      posts: {
        take: 5,
        skip: 0,
        select: { id: true },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts select with orderBy", () => {
    const result = parse(schema, {
      posts: {
        orderBy: { title: "asc" },
        select: { title: true },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves select with all options", () => {
    const result = parse(schema, {
      posts: {
        where: { published: true },
        orderBy: { title: "asc" },
        take: 10,
        skip: 5,
        select: { id: true, title: true },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.posts?.take).toBe(10);
      expect(result.value.posts?.skip).toBe(5);
      expect(result.value.posts?.orderBy).toEqual({ title: "asc" });
      expect(result.value.posts?.select?.id).toBe(true);
    }
  });
});

// =============================================================================
// TO-MANY INCLUDE SCHEMAS
// =============================================================================

describe("ToMany Include - Author.posts (oneToMany)", () => {
  const schema = authorSchemas.include;

  test("accepts boolean true", () => {
    const result = parse(schema, {
      posts: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts with where filter", () => {
    const result = parse(schema, {
      posts: {
        where: { published: true },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts with pagination", () => {
    const result = parse(schema, {
      posts: {
        take: 10,
        skip: 0,
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts with orderBy", () => {
    const result = parse(schema, {
      posts: {
        orderBy: { title: "desc" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts with nested include", () => {
    const result = parse(schema, {
      posts: {
        include: {
          author: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts with all options combined", () => {
    const result = parse(schema, {
      posts: {
        where: { published: true },
        orderBy: { title: "asc" },
        take: 5,
        skip: 2,
        include: {
          author: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves all include options", () => {
    const result = parse(schema, {
      posts: {
        where: { published: true },
        take: 5,
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.posts?.take).toBe(5);
    }
  });
});

// =============================================================================
// TO-MANY ORDER BY SCHEMAS
// =============================================================================

describe("ToMany OrderBy - Author.posts (oneToMany)", () => {
  const schema = authorSchemas.orderBy;

  test("accepts _count ascending", () => {
    const result = parse(schema, {
      posts: {
        _count: "asc",
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts _count descending", () => {
    const result = parse(schema, {
      posts: {
        _count: "desc",
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves _count order", () => {
    const result = parse(schema, {
      posts: { _count: "desc" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.posts?._count).toBe("desc");
    }
  });
});
