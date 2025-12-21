/**
 * Update Schema Tests
 *
 * Tests the combined update schema which merges scalar and relation
 * update schemas.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  simpleSchemas,
  authorSchemas,
  postSchemas,
  type SimpleState,
  type AuthorState,
} from "../fixtures";
import type { UpdateInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Update Schema - Types (Simple Model)", () => {
  type Input = UpdateInput<SimpleState>;

  test("type: includes all scalar fields", () => {
    expectTypeOf<Input>().toHaveProperty("id");
    expectTypeOf<Input>().toHaveProperty("name");
    expectTypeOf<Input>().toHaveProperty("email");
    expectTypeOf<Input>().toHaveProperty("age");
    expectTypeOf<Input>().toHaveProperty("active");
  });

  test("type: all fields are optional (empty object matches)", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Author Model (with relations)
// =============================================================================

describe("Update Schema - Types (Author Model)", () => {
  type Input = UpdateInput<AuthorState>;

  test("type: includes relation fields", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Update Schema - Simple Model Runtime", () => {
  const schema = simpleSchemas.update;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts single field update", () => {
    const result = safeParse(schema, { name: "Bob" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts multiple field updates", () => {
    const result = safeParse(schema, {
      name: "Bob",
      email: "bob@example.com",
      active: false,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts increment operation", () => {
    const result = safeParse(schema, { age: { increment: 1 } });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("Update Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.update;

  test("runtime: accepts scalar-only update", () => {
    const result = safeParse(schema, { name: "Updated Name" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation update with connect", () => {
    const result = safeParse(schema, {
      posts: {
        connect: [{ id: "post-1" }],
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation update with create", () => {
    const result = safeParse(schema, {
      posts: {
        create: { id: "post-1", title: "New Post", authorId: "author-1" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation update with disconnect", () => {
    const result = safeParse(schema, {
      posts: {
        disconnect: [{ id: "post-1" }],
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation update with delete", () => {
    const result = safeParse(schema, {
      posts: {
        delete: [{ id: "post-1" }],
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts combined scalar and relation update", () => {
    const result = safeParse(schema, {
      name: "Updated Name",
      posts: {
        create: { id: "post-1", title: "New Post", authorId: "author-1" },
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Update Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.update;

  test("runtime: accepts relation connect", () => {
    const result = safeParse(schema, {
      author: {
        connect: { id: "author-1" },
      },
    });

    expect(result.output).toMatchObject({
      author: {
        connect: { id: "author-1" },
      },
    });
  });

  test("runtime: accepts relation disconnect", () => {
    const result = safeParse(schema, {
      author: {
        disconnect: true,
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation update", () => {
    const result = safeParse(schema, {
      author: {
        update: { name: "Updated Author" },
      },
    });
    expect(result.success).toBe(true);
  });
});
