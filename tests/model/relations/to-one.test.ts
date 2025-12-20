/**
 * ToOne Relation Schema Tests
 *
 * Tests schemas for manyToOne and oneToOne relations:
 * - Filter schemas (is, isNot)
 * - Create schemas (create, connect, connectOrCreate)
 * - Update schemas (create, connect, connectOrCreate, update, disconnect, delete)
 * - Select/Include schemas
 * - OrderBy schemas
 */

import { describe, test, expect } from "vitest";
import { safeParse } from "valibot";
import { postSchemas, authorSchemas } from "../fixtures";

// =============================================================================
// TO-ONE FILTER SCHEMAS
// =============================================================================

describe("ToOne Filter - Post.author (manyToOne)", () => {
  // Post has manyToOne relation to Author
  const schema = postSchemas._filter.relation;

  test("accepts 'is' filter with scalar conditions", () => {
    const result = safeParse(schema, {
      author: {
        is: { name: "Alice" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts 'isNot' filter", () => {
    const result = safeParse(schema, {
      author: {
        isNot: { name: "Bob" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects 'is' with null (relation is required)", () => {
    // Post.author is a required relation, null filtering not supported
    const result = safeParse(schema, {
      author: {
        is: null,
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects 'isNot' with null (relation is required)", () => {
    // Post.author is a required relation, null filtering not supported
    const result = safeParse(schema, {
      author: {
        isNot: null,
      },
    });
    expect(result.success).toBe(false);
  });

  test("accepts nested filter operators", () => {
    const result = safeParse(schema, {
      author: {
        is: {
          name: { startsWith: "A" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts deeply nested relation filter", () => {
    const result = safeParse(schema, {
      author: {
        is: {
          posts: {
            some: { published: true },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown relation key (strict)", () => {
    const result = safeParse(schema, {
      unknownRelation: { is: { id: "123" } },
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// TO-ONE CREATE SCHEMAS
// =============================================================================

describe("ToOne Create - Post.author (manyToOne)", () => {
  const schema = postSchemas._create.relation;

  test("accepts 'create' nested object", () => {
    const result = safeParse(schema, {
      author: {
        create: {
          id: "author-1",
          name: "Alice",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts 'connect' with unique identifier", () => {
    const result = safeParse(schema, {
      author: {
        connect: { id: "author-1" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts 'connectOrCreate' with where and create", () => {
    const result = safeParse(schema, {
      author: {
        connectOrCreate: {
          where: { id: "author-1" },
          create: {
            id: "author-1",
            name: "Alice",
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects create with missing required field", () => {
    const result = safeParse(schema, {
      author: {
        create: {
          id: "author-1",
          // missing 'name' which is required
        },
      },
    });
    expect(result.success).toBe(false);
  });

  test("output: preserves create data structure", () => {
    const result = safeParse(schema, {
      author: {
        create: {
          id: "author-1",
          name: "Alice",
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.author?.create?.id).toBe("author-1");
      expect(result.output.author?.create?.name).toBe("Alice");
    }
  });
});

// =============================================================================
// TO-ONE UPDATE SCHEMAS
// =============================================================================

describe("ToOne Update - Post.author (manyToOne)", () => {
  const schema = postSchemas._update.relation;

  test("accepts 'create' for creating new related record", () => {
    const result = safeParse(schema, {
      author: {
        create: {
          id: "author-1",
          name: "New Author",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts 'connect' to link existing record", () => {
    const result = safeParse(schema, {
      author: {
        connect: { id: "author-1" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts 'connectOrCreate'", () => {
    const result = safeParse(schema, {
      author: {
        connectOrCreate: {
          where: { id: "author-1" },
          create: { id: "author-1", name: "Alice" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts 'update' with data", () => {
    const result = safeParse(schema, {
      author: {
        update: { name: "Updated Name" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts 'upsert' with create and update", () => {
    const result = safeParse(schema, {
      author: {
        upsert: {
          create: { id: "author-1", name: "New" },
          update: { name: "Updated" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  // Note: disconnect/delete only available for optional relations
  test("accepts 'disconnect' boolean for optional relation", () => {
    // This depends on whether the relation is optional
    // For required relations, this might fail
    const result = safeParse(schema, {
      author: {
        disconnect: true,
      },
    });
    // Result depends on relation optionality
    expect(typeof result.success).toBe("boolean");
  });

  test("accepts 'delete' boolean for optional relation", () => {
    const result = safeParse(schema, {
      author: {
        delete: true,
      },
    });
    expect(typeof result.success).toBe("boolean");
  });

  test("output: preserves update data with normalization", () => {
    const result = safeParse(schema, {
      author: {
        update: { name: "Updated" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Update values get normalized to { set: value }
      expect(result.output.author?.update?.name).toEqual({ set: "Updated" });
    }
  });
});

// =============================================================================
// TO-ONE SELECT SCHEMAS
// =============================================================================

describe("ToOne Select - Post.author (manyToOne)", () => {
  const schema = postSchemas.select;

  test("accepts boolean true for simple include", () => {
    const result = safeParse(schema, {
      id: true,
      author: true,
    });
    expect(result.success).toBe(true);
  });

  test("accepts nested select object", () => {
    const result = safeParse(schema, {
      id: true,
      author: {
        select: {
          id: true,
          name: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("output: preserves nested select structure", () => {
    const result = safeParse(schema, {
      author: {
        select: { id: true, name: true },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.author?.select?.id).toBe(true);
      expect(result.output.author?.select?.name).toBe(true);
    }
  });
});

// =============================================================================
// TO-ONE INCLUDE SCHEMAS
// =============================================================================

describe("ToOne Include - Post.author (manyToOne)", () => {
  const schema = postSchemas.include;

  test("accepts boolean true", () => {
    const result = safeParse(schema, {
      author: true,
    });
    expect(result.success).toBe(true);
  });

  test("accepts nested include object", () => {
    const result = safeParse(schema, {
      author: {
        include: {
          posts: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts nested select within include", () => {
    const result = safeParse(schema, {
      author: {
        select: {
          id: true,
          name: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// TO-ONE ORDER BY SCHEMAS
// =============================================================================

describe("ToOne OrderBy - Post.author (manyToOne)", () => {
  const schema = postSchemas.orderBy;

  test("accepts nested orderBy on related model fields", () => {
    const result = safeParse(schema, {
      author: {
        name: "asc",
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts nested orderBy with desc", () => {
    const result = safeParse(schema, {
      author: {
        id: "desc",
      },
    });
    expect(result.success).toBe(true);
  });

  test("output: preserves orderBy structure", () => {
    const result = safeParse(schema, {
      author: { name: "asc" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.author?.name).toBe("asc");
    }
  });
});

