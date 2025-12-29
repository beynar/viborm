/**
 * Create Schema Tests
 *
 * Tests the combined create schema which merges scalar and relation
 * create schemas.
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

describe("Create Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.create>;

  test("type: includes all scalar fields", () => {
    expectTypeOf<Input>().toHaveProperty("id");
    expectTypeOf<Input>().toHaveProperty("name");
    expectTypeOf<Input>().toHaveProperty("email");
    expectTypeOf<Input>().toHaveProperty("age");
    expectTypeOf<Input>().toHaveProperty("active");
  });
});

// =============================================================================
// TYPE TESTS - Author Model (with relations)
// =============================================================================

describe("Create Schema - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas.create>;

  test("type: includes relation fields", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Create Schema - Simple Model Runtime", () => {
  const schema = simpleSchemas.create;

  test("runtime: accepts valid input with required fields", () => {
    const result = parse(schema, {
      id: "user-123",
      name: "Alice",
      email: "alice@example.com",
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all fields", () => {
    const result = parse(schema, {
      id: "user-123",
      name: "Alice",
      email: "alice@example.com",
      age: 25,
      active: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing required field", () => {
    const result = parse(schema, {
      id: "user-123",
      // missing name and email
    });
    console.dir(result, { depth: null });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("Create Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.create;

  test("runtime: accepts without relations", () => {
    const result = parse(schema, {
      id: "author-1",
      name: "Alice",
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with relation create", () => {
    const result = parse(schema, {
      id: "author-1",
      name: "Alice",
      posts: {
        create: { id: "post-1", title: "Hello", authorId: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with relation connect", () => {
    const result = parse(schema, {
      id: "author-1",
      name: "Alice",
      posts: {
        connect: [{ id: "post-1" }],
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Create Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.create;

  test("runtime: accepts with author connect", () => {
    const result = parse(schema, {
      id: "post-1",
      title: "Hello World",
      authorId: "author-1",
      author: {
        connect: { id: "author-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with author create", () => {
    const result = parse(schema, {
      id: "post-1",
      title: "Hello World",
      authorId: "author-1",
      author: {
        create: { id: "author-1", name: "Alice" },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});
