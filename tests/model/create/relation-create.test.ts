/**
 * Relation Create Schema Tests
 *
 * Tests the _create.relation schema which includes nested write operations
 * (connect, create, connectOrCreate) for relations.
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
import type { RelationCreateInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Author Model (has oneToMany)
// =============================================================================

describe("Relation Create - Types (Author Model)", () => {
  type Input = RelationCreateInput<AuthorState>;

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

describe("Relation Create - Types (Post Model)", () => {
  type Input = RelationCreateInput<PostState>;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("author");
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (oneToMany)
// =============================================================================

describe("Relation Create - Author Model Runtime (oneToMany)", () => {
  const schema = authorSchemas._create.relation;

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

  test("runtime: accepts createMany nested write", () => {
    const result = safeParse(schema, {
      posts: {
        createMany: {
          data: [
            { id: "post-1", title: "Hello", authorId: "author-1" },
            { id: "post-2", title: "World", authorId: "author-1" },
          ],
        },
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

  test("runtime: accepts connect array for toMany", () => {
    const result = safeParse(schema, {
      posts: {
        connect: [{ id: "post-1" }, { id: "post-2" }],
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne)
// =============================================================================

describe("Relation Create - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas._create.relation;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts create nested write", () => {
    const result = safeParse(schema, {
      author: {
        create: { id: "author-1", name: "Alice" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts connect nested write", () => {
    const result = safeParse(schema, {
      author: {
        connect: { id: "existing-author-id" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts connectOrCreate nested write", () => {
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
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no relations)
// =============================================================================

describe("Relation Create - Simple Model Runtime (no relations)", () => {
  const schema = simpleSchemas._create.relation;

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

