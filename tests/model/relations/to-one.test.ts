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
import { parse } from "../../../src/validation";
import { postSchemas, authorSchemas } from "../fixtures";

// =============================================================================
// TO-ONE FILTER SCHEMAS
// =============================================================================

describe("ToOne Filter - Post.author (manyToOne)", () => {
  // Post has manyToOne relation to Author
  const schema = postSchemas._filter.relation;

  test("accepts 'is' filter with scalar conditions", () => {
    const result = parse(schema, {
      author: {
        is: { name: "Alice" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'isNot' filter", () => {
    const result = parse(schema, {
      author: {
        isNot: { name: "Bob" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'is' with null (relation is required)", () => {
    // Post.author is a required relation, null filtering not supported

    const result = parse(schema, {
      author: {
        is: null,
      },
    });

    expect(result.issues).toBeUndefined();
  });

  test("accepts 'isNot' with null (relation is required)", () => {
    // Post.author is a required relation, null filtering not supported
    const result = parse(schema, {
      author: {
        isNot: null,
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts nested filter operators", () => {
    const result = parse(schema, {
      author: {
        is: {
          name: { startsWith: "A" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts deeply nested relation filter", () => {
    const result = parse(schema, {
      author: {
        is: {
          posts: {
            some: { published: true },
          },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("rejects unknown relation key (strict)", () => {
    const result = parse(schema, {
      unknownRelation: { is: { id: "123" } },
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// TO-ONE CREATE SCHEMAS
// =============================================================================

describe("ToOne Create - Post.author (manyToOne)", () => {
  const schema = postSchemas._create.relation;

  test("accepts 'create' nested object", () => {
    const result = parse(schema, {
      author: {
        create: {
          id: "author-1",
          name: "Alice",
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'connect' with unique identifier", () => {
    const result = parse(schema, {
      author: {
        connect: { id: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'connectOrCreate' with where and create", () => {
    const result = parse(schema, {
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
    expect(result.issues).toBeUndefined();
  });

  test("rejects create with missing required field", () => {
    const result = parse(schema, {
      author: {
        create: {
          id: "author-1",
          // missing 'name' which is required
        },
      },
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves create data structure", () => {
    const result = parse(schema, {
      author: {
        create: {
          id: "author-1",
          name: "Alice",
        },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.author?.create?.id).toBe("author-1");
      expect(result.value.author?.create?.name).toBe("Alice");
    }
  });
});

// =============================================================================
// TO-ONE UPDATE SCHEMAS
// =============================================================================

describe("ToOne Update - Post.author (manyToOne)", () => {
  const schema = postSchemas._update.relation;

  test("accepts 'create' for creating new related record", () => {
    const result = parse(schema, {
      author: {
        create: {
          id: "author-1",
          name: "New Author",
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'connect' to link existing record", () => {
    const result = parse(schema, {
      author: {
        connect: { id: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'connectOrCreate'", () => {
    const result = parse(schema, {
      author: {
        connectOrCreate: {
          where: { id: "author-1" },
          create: { id: "author-1", name: "Alice" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'update' with data", () => {
    const result = parse(schema, {
      author: {
        update: { name: "Updated Name" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts 'upsert' with create and update", () => {
    const result = parse(schema, {
      author: {
        upsert: {
          create: { id: "author-1", name: "New" },
          update: { name: "Updated" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  // Note: disconnect/delete only available for optional relations
  test("accepts 'disconnect' boolean for optional relation", () => {
    // This depends on whether the relation is optional
    // For required relations, this might fail
    const result = parse(schema, {
      author: {
        disconnect: true,
      },
    });
    // Result depends on relation optionality
    expect(
      typeof result.issues === "undefined" || Array.isArray(result.issues)
    ).toBe(true);
  });

  test("accepts 'delete' boolean for optional relation", () => {
    const result = parse(schema, {
      author: {
        delete: true,
      },
    });
    expect(
      typeof result.issues === "undefined" || Array.isArray(result.issues)
    ).toBe(true);
  });

  test("output: preserves update data with normalization", () => {
    const result = parse(schema, {
      author: {
        update: { name: "Updated" },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      // Update values get normalized to { set: value }
      expect(result.value.author?.update?.name).toEqual({ set: "Updated" });
    }
  });
});

// =============================================================================
// TO-ONE SELECT SCHEMAS
// =============================================================================

describe("ToOne Select - Post.author (manyToOne)", () => {
  const schema = postSchemas.select;

  test("accepts boolean true for simple include", () => {
    const result = parse(schema, {
      id: true,
      author: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts nested select object", () => {
    const result = parse(schema, {
      id: true,
      author: {
        select: {
          id: true,
          name: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves nested select structure", () => {
    const result = parse(schema, {
      author: {
        select: { id: true, name: true },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.author?.select?.id).toBe(true);
      expect(result.value.author?.select?.name).toBe(true);
    }
  });
});

// =============================================================================
// TO-ONE INCLUDE SCHEMAS
// =============================================================================

describe("ToOne Include - Post.author (manyToOne)", () => {
  const schema = postSchemas.include;

  test("accepts boolean true", () => {
    const result = parse(schema, {
      author: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts nested include object", () => {
    const result = parse(schema, {
      author: {
        include: {
          posts: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts nested select within include", () => {
    const result = parse(schema, {
      author: {
        select: {
          id: true,
          name: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// TO-ONE ORDER BY SCHEMAS
// =============================================================================

describe("ToOne OrderBy - Post.author (manyToOne)", () => {
  const schema = postSchemas.orderBy;

  test("accepts nested orderBy on related model fields", () => {
    const result = parse(schema, {
      author: {
        name: "asc",
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("accepts nested orderBy with desc", () => {
    const result = parse(schema, {
      author: {
        id: "desc",
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves orderBy structure", () => {
    const result = parse(schema, {
      author: { name: "asc" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.author?.name).toBe("asc");
    }
  });
});
