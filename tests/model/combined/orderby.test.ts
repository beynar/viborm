/**
 * OrderBy Schema Tests
 *
 * Tests the orderBy schema which allows asc/desc ordering on scalar fields
 * and nested ordering on relations.
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
import type { OrderByInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("OrderBy Schema - Types (Simple Model)", () => {
  type Input = OrderByInput<SimpleState>;

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
  type Input = OrderByInput<AuthorState>;

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
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts asc order", () => {
    const result = safeParse(schema, { name: "asc" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts desc order", () => {
    const result = safeParse(schema, { name: "desc" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts multiple fields", () => {
    const result = safeParse(schema, {
      name: "asc",
      age: "desc",
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects invalid order value", () => {
    const result = safeParse(schema, { name: "ascending" });
    expect(result.success).toBe(false);
  });

  test("runtime: rejects unknown field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = safeParse(schema, { unknownField: "asc" });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("OrderBy Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.orderBy;

  test("runtime: accepts scalar ordering", () => {
    const result = safeParse(schema, { name: "asc" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation count ordering", () => {
    const result = safeParse(schema, {
      posts: { _count: "desc" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts combined scalar and relation ordering", () => {
    const result = safeParse(schema, {
      name: "asc",
      posts: { _count: "desc" },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("OrderBy Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.orderBy;

  test("runtime: accepts scalar ordering", () => {
    const result = safeParse(schema, { title: "asc" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested ordering on toOne relation", () => {
    const result = safeParse(schema, {
      author: { name: "asc" },
    });
    expect(result.success).toBe(true);
  });
});

