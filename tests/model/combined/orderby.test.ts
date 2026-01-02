/**
 * OrderBy Schema Tests
 *
 * Tests the orderBy schema which allows asc/desc ordering on scalar fields
 * and nested ordering on relations.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, InferInput } from "@validation";
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

describe("OrderBy Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.orderBy>;

  test("type: includes scalar fields", () => {
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

describe("OrderBy Schema - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas.orderBy>;

  test("type: includes relation fields", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("OrderBy Schema - Simple Model Runtime", () => {
  const schema = simpleSchemas.orderBy;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts asc order", () => {
    const result = parse(schema, { name: "asc" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts desc order", () => {
    const result = parse(schema, { name: "desc" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts multiple fields", () => {
    const result = parse(schema, {
      name: "asc",
      age: "desc",
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects invalid order value", () => {
    const result = parse(schema, { name: "ascending" });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects unknown field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { unknownField: "asc" });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("OrderBy Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.orderBy;

  test("runtime: accepts scalar ordering", () => {
    const result = parse(schema, { name: "asc" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation count ordering", () => {
    const result = parse(schema, {
      posts: { _count: "desc" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts combined scalar and relation ordering", () => {
    const result = parse(schema, {
      name: "asc",
      posts: { _count: "desc" },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("OrderBy Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.orderBy;

  test("runtime: accepts scalar ordering", () => {
    const result = parse(schema, { title: "asc" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested ordering on toOne relation", () => {
    const result = parse(schema, {
      author: { name: "asc" },
    });
    expect(result.issues).toBeUndefined();
  });
});
