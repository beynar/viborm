/**
 * ToMany Relation Schema Tests
 *
 * Tests schemas for oneToMany and manyToMany relations:
 * - Filter schemas (some, every, none)
 * - Create schemas (create, connect, connectOrCreate) - single or array
 * - Update schemas (create, createMany, connect, guarded disconnect, set, delete,
 *   connectOrCreate, update, updateMany, upsert, deleteMany)
 * - Select/Include schemas with pagination
 * - OrderBy schemas (_count)
 */

import { authorSchemas } from "@tests/unit/operation-schemas/fixtures";
import { parse } from "@validation";
import { describe, expect, test } from "vitest";

// Test-only view over generated relation output unions.
// Runtime assertions below still verify concrete transformed shapes.
type RelationOutput = any;

const relationOutput = (value: unknown): RelationOutput =>
  value as RelationOutput;

// =============================================================================
// TO-MANY FILTER SCHEMAS
// =============================================================================

describe("ToMany Filter - Author.posts (oneToMany)", () => {
  const schema = authorSchemas.relationFilter;

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
  const schema = authorSchemas.relationCreate;

  test("accepts single 'create' object", () => {
    const result = parse(schema, {
      posts: {
        create: {
          id: "post-1",
          title: "Hello",
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array of 'create' objects", () => {
    const result = parse(schema, {
      posts: {
        create: [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
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
          create: { id: "post-1", title: "New" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test.each([
    ["empty", {}],
    ["missing create", { where: { id: "post-1" } }],
    [
      "missing where",
      {
        create: { id: "post-1", title: "New", authorId: "author-1" },
      },
    ],
  ] as const)("rejects connectOrCreate envelope %s", (_, envelope) => {
    const result = parse(schema, {
      posts: {
        connectOrCreate: envelope,
      },
    });
    expect(result.issues).toBeDefined();
  });

  test("accepts array of 'connectOrCreate' objects", () => {
    const result = parse(schema, {
      posts: {
        connectOrCreate: [
          {
            where: { id: "post-1" },
            create: { id: "post-1", title: "First" },
          },
          {
            where: { id: "post-2" },
            create: { id: "post-2", title: "Second" },
          },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts combined create and connect", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "new-post", title: "New" },
        connect: { id: "existing-post" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: normalizes single create to array", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1", title: "Hello" },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(relationOutput(result.value).posts?.create)).toBe(
        true
      );
      expect(relationOutput(result.value).posts?.create).toHaveLength(1);
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
      expect(Array.isArray(relationOutput(result.value).posts?.connect)).toBe(
        true
      );
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
  const schema = authorSchemas.relationUpdate;

  // Create operations
  test("accepts single 'create'", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1", title: "New" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts array 'create'", () => {
    const result = parse(schema, {
      posts: {
        create: [
          { id: "post-1", title: "First" },
          { id: "post-2", title: "Second" },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'createMany'", () => {
    const result = parse(schema, {
      posts: {
        createMany: {
          data: [
            { id: "post-1", title: "First" },
            { id: "post-2", title: "Second" },
          ],
          skipDuplicates: true,
        },
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

  test("rejects single 'disconnect' for required membership", () => {
    const result = parse(schema, {
      posts: {
        disconnect: { id: "post-1" },
      },
    });
    expect(result.issues?.[0]?.message).toBe("Unknown key: disconnect");
    expect(result.issues?.[0]?.path).toEqual(["posts", "disconnect"]);
  });

  test("rejects array 'disconnect' for required membership", () => {
    const result = parse(schema, {
      posts: {
        disconnect: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues?.[0]?.message).toBe("Unknown key: disconnect");
    expect(result.issues?.[0]?.path).toEqual(["posts", "disconnect"]);
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

  test.each([
    ["empty", {}],
    ["missing create", { where: { id: "post-1" } }],
    [
      "missing where",
      {
        create: { id: "post-1", title: "New", authorId: "author-1" },
      },
    ],
  ] as const)("rejects connectOrCreate envelope %s", (_, envelope) => {
    const result = parse(schema, {
      posts: {
        connectOrCreate: envelope,
      },
    });
    expect(result.issues).toBeDefined();
  });

  test("accepts targeted 'update'", () => {
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

  test("accepts set-based 'updateMany'", () => {
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

  test("accepts 'deleteMany'", () => {
    const result = parse(schema, {
      posts: {
        deleteMany: { published: false },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'upsert'", () => {
    const result = parse(schema, {
      posts: {
        upsert: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "Created" },
          update: { title: "Updated" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test.each([
    ["update", { data: { title: "Updated" } }],
    ["updateMany", { where: { published: false } }],
    ["upsert", { where: { id: "post-1" }, update: { title: "Updated" } }],
  ] as const)("rejects malformed '%s'", (operation, envelope) => {
    const result = parse(schema, {
      posts: {
        [operation]: envelope,
      },
    });
    expect(result.issues).toBeDefined();
  });

  // Combined operations
  test("accepts combined operations in single update", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "new-post", title: "New" },
        connect: { id: "existing-post" },
        set: { id: "retained-post" },
        delete: { id: "old-post" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Output normalization tests
  test("output: normalizes single 'set' to array", () => {
    const result = parse(schema, {
      posts: {
        set: { id: "post-1" },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(Array.isArray(relationOutput(result.value).posts?.set)).toBe(true);
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

  test("accepts select with relation orderBy", () => {
    const result = parse(schema, {
      posts: {
        orderBy: { author: { name: "asc" } },
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
      expect(relationOutput(result.value).posts?.take).toBe(10);
      expect(relationOutput(result.value).posts?.skip).toBe(5);
      expect(relationOutput(result.value).posts?.orderBy).toEqual({
        title: "asc",
      });
      expect(relationOutput(result.value).posts?.select?.id).toBe(true);
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

  test("accepts with relation orderBy", () => {
    const result = parse(schema, {
      posts: {
        orderBy: { author: { name: "asc" } },
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
      expect(relationOutput(result.value).posts?.take).toBe(5);
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
      expect(relationOutput(result.value).posts?._count).toBe("desc");
    }
  });

  test("rejects scalar field ordering", () => {
    const result = parse(schema, {
      posts: { title: "asc" },
    });

    expect(result.issues).toBeDefined();
  });
});
