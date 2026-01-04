/**
 * Relation Update Schema Tests
 *
 * Tests the _update.relation schema which includes nested write operations
 * (connect, disconnect, update, create, etc.) for relations.
 */

import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";
import { authorSchemas, postSchemas, simpleSchemas } from "../fixtures";

// =============================================================================
// TYPE TESTS - Author Model (has oneToMany)
// =============================================================================

describe("Relation Update - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas._update.relation>;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });

  test("type: all relations are optional", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Post Model (has manyToOne)
// =============================================================================

describe("Relation Update - Types (Post Model)", () => {
  type Input = InferInput<typeof postSchemas._update.relation>;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("author");
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (oneToMany)
// =============================================================================

describe("Relation Update - Author Model Runtime (oneToMany)", () => {
  const schema = authorSchemas._update.relation;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts create nested write", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1", title: "Hello", authorId: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts connect nested write", () => {
    const result = parse(schema, {
      posts: {
        connect: { id: "existing-post-id" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts disconnect nested write", () => {
    const result = parse(schema, {
      posts: {
        disconnect: { id: "post-to-disconnect" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts delete nested write", () => {
    const result = parse(schema, {
      posts: {
        delete: { id: "post-to-delete" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts update nested write (single object)", () => {
    const result = parse(schema, {
      posts: {
        update: {
          where: { id: "post-1" },
          data: { title: "Updated Title" },
        },
      },
    });
    expect(result.issues).toBeUndefined();
    // Single object should be normalized to array
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.update)).toBe(true);
    }
  });

  test("runtime: accepts update nested write (array)", () => {
    const result = parse(schema, {
      posts: {
        update: [
          {
            where: { id: "post-1" },
            data: { title: "Updated Title" },
          },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts updateMany nested write (single object)", () => {
    const result = parse(schema, {
      posts: {
        updateMany: {
          where: { published: false },
          data: { published: true },
        },
      },
    });
    expect(result.issues).toBeUndefined();
    // Single object should be normalized to array
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.updateMany)).toBe(true);
    }
  });

  test("runtime: accepts deleteMany nested write (single object)", () => {
    const result = parse(schema, {
      posts: {
        deleteMany: { published: false },
      },
    });
    expect(result.issues).toBeUndefined();
    // Single object should be normalized to array
    if (!result.issues) {
      expect(Array.isArray(result.value.posts?.deleteMany)).toBe(true);
    }
  });

  test("runtime: accepts set to replace all", () => {
    const result = parse(schema, {
      posts: {
        set: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne)
// =============================================================================

describe("Relation Update - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas._update.relation;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts connect nested write", () => {
    const result = parse(schema, {
      author: {
        connect: { id: "author-id" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts disconnect for optional relation", () => {
    const result = parse(schema, {
      author: {
        disconnect: true,
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts update nested write", () => {
    const result = parse(schema, {
      author: {
        update: { name: "Updated Name" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts create nested write", () => {
    const result = parse(schema, {
      author: {
        create: { id: "new-author", name: "New Author" },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no relations)
// =============================================================================

describe("Relation Update - Simple Model Runtime (no relations)", () => {
  const schema = simpleSchemas._update.relation;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects unknown relation key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { anyRelation: {} });
    expect(result.issues).toBeDefined();
  });
});
