/**
 * Update Schema Tests
 *
 * Tests the combined update schema which merges scalar and relation
 * update schemas.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, InferInput } from "../../../src/validation";
import {
  simpleSchemas,
  authorSchemas,
  postSchemas,
  type SimpleState,
  type AuthorState,
} from "../fixtures";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Update Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.update>;

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
  type Input = InferInput<typeof authorSchemas.update>;

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
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts single field update", () => {
    const result = parse(schema, { name: "Bob" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts multiple field updates", () => {
    const result = parse(schema, {
      name: "Bob",
      email: "bob@example.com",
      active: false,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts increment operation", () => {
    const result = parse(schema, { age: { increment: 1 } });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("Update Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.update;

  test("runtime: accepts scalar-only update", () => {
    const result = parse(schema, { name: "Updated Name" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation update with connect", () => {
    const result = parse(schema, {
      posts: {
        connect: [{ id: "post-1" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation update with create", () => {
    const result = parse(schema, {
      posts: {
        create: { id: "post-1", title: "New Post", authorId: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation update with disconnect", () => {
    const result = parse(schema, {
      posts: {
        disconnect: [{ id: "post-1" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation update with delete", () => {
    const result = parse(schema, {
      posts: {
        delete: [{ id: "post-1" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts combined scalar and relation update", () => {
    const result = parse(schema, {
      name: "Updated Name",
      posts: {
        create: { id: "post-1", title: "New Post", authorId: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Update Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.update;

  test("runtime: accepts relation connect", () => {
    const result = parse(schema, {
      author: {
        connect: { id: "author-1" },
      },
    });
    if (result.issues) throw new Error("Expected success");
    expect(result.value).toMatchObject({
      author: {
        connect: { id: "author-1" },
      },
    });
  });

  test("runtime: accepts relation disconnect", () => {
    console.dir(schema, { depth: null });
    const result = parse(schema, {
      author: {
        disconnect: true,
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation update", () => {
    const result = parse(schema, {
      author: {
        update: { name: "Updated Author" },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});
