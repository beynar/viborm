/**
 * Relation Update Schema Tests
 *
 * Tests the _update.relation schema which includes nested write operations
 * (connect, disconnect, update, create, etc.) for relations.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  authorSchemas,
  postSchemas,
  simpleSchemas,
  type AuthorState,
  type PostState,
} from "../fixtures";
import type { RelationUpdateInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Author Model (has oneToMany)
// =============================================================================

describe("Relation Update - Types (Author Model)", () => {
  type Input = RelationUpdateInput<AuthorState>;

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
  type Input = RelationUpdateInput<PostState>;

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
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts create nested write", () => {
    const result = safeParse(schema, {
      posts: {
        create: { id: "post-1", title: "Hello", authorId: "author-1" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts connect nested write", () => {
    const result = safeParse(schema, {
      posts: {
        connect: { id: "existing-post-id" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts disconnect nested write", () => {
    const result = safeParse(schema, {
      posts: {
        disconnect: { id: "post-to-disconnect" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts delete nested write", () => {
    const result = safeParse(schema, {
      posts: {
        delete: { id: "post-to-delete" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts update nested write (single object)", () => {
    const result = safeParse(schema, {
      posts: {
        update: {
          where: { id: "post-1" },
          data: { title: "Updated Title" },
        },
      },
    });
    expect(result.success).toBe(true);
    // Single object should be normalized to array
    if (result.success) {
      expect(Array.isArray(result.output.posts?.update)).toBe(true);
    }
  });

  test("runtime: accepts update nested write (array)", () => {
    const result = safeParse(schema, {
      posts: {
        update: [
          {
            where: { id: "post-1" },
            data: { title: "Updated Title" },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts updateMany nested write (single object)", () => {
    const result = safeParse(schema, {
      posts: {
        updateMany: {
          where: { published: false },
          data: { published: true },
        },
      },
    });
    expect(result.success).toBe(true);
    // Single object should be normalized to array
    if (result.success) {
      expect(Array.isArray(result.output.posts?.updateMany)).toBe(true);
    }
  });

  test("runtime: accepts deleteMany nested write (single object)", () => {
    const result = safeParse(schema, {
      posts: {
        deleteMany: { published: false },
      },
    });
    expect(result.success).toBe(true);
    // Single object should be normalized to array
    if (result.success) {
      expect(Array.isArray(result.output.posts?.deleteMany)).toBe(true);
    }
  });

  test("runtime: accepts set to replace all", () => {
    const result = safeParse(schema, {
      posts: {
        set: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne)
// =============================================================================

describe("Relation Update - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas._update.relation;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts connect nested write", () => {
    const result = safeParse(schema, {
      author: {
        connect: { id: "author-id" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts disconnect for optional relation", () => {
    const result = safeParse(schema, {
      author: {
        disconnect: true,
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts update nested write", () => {
    const result = safeParse(schema, {
      author: {
        update: { name: "Updated Name" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts create nested write", () => {
    const result = safeParse(schema, {
      author: {
        create: { id: "new-author", name: "New Author" },
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no relations)
// =============================================================================

describe("Relation Update - Simple Model Runtime (no relations)", () => {
  const schema = simpleSchemas._update.relation;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: rejects unknown relation key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = safeParse(schema, { anyRelation: {} });
    expect(result.success).toBe(false);
  });
});

