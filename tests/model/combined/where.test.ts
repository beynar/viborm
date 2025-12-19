/**
 * Where Schema Tests
 *
 * Tests the combined where schema which merges scalar filters,
 * relation filters, and AND/OR/NOT logical operators.
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
import type { WhereInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Where Schema - Types (Simple Model)", () => {
  type Input = WhereInput<SimpleState>;

  test("type: includes scalar fields", () => {
    expectTypeOf<Input>().toHaveProperty("id");
    expectTypeOf<Input>().toHaveProperty("name");
    expectTypeOf<Input>().toHaveProperty("email");
    expectTypeOf<Input>().toHaveProperty("age");
    expectTypeOf<Input>().toHaveProperty("active");
  });

  test("type: includes AND/OR/NOT operators", () => {
    expectTypeOf<Input>().toHaveProperty("AND");
    expectTypeOf<Input>().toHaveProperty("OR");
    expectTypeOf<Input>().toHaveProperty("NOT");
  });

  test("type: all fields are optional (empty object matches)", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Author Model (with relations)
// =============================================================================

describe("Where Schema - Types (Author Model)", () => {
  type Input = WhereInput<AuthorState>;

  test("type: includes relation fields", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Where Schema - Simple Model Runtime", () => {
  const schema = simpleSchemas.where;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts scalar filter", () => {
    const result = safeParse(schema, { name: "Alice" });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts AND operator with array", () => {
    const result = safeParse(schema, {
      AND: [{ name: "Alice" }, { active: true }],
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts AND operator with single object", () => {
    const result = safeParse(schema, {
      AND: { name: "Alice" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts OR operator", () => {
    const result = safeParse(schema, {
      OR: [{ name: "Alice" }, { name: "Bob" }],
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts NOT operator with single object", () => {
    const result = safeParse(schema, {
      NOT: { active: false },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts NOT operator with array", () => {
    const result = safeParse(schema, {
      NOT: [{ name: "Admin" }, { name: "System" }],
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested AND/OR/NOT", () => {
    const result = safeParse(schema, {
      AND: [
        { OR: [{ name: "Alice" }, { name: "Bob" }] },
        { NOT: { active: false } },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts complex filter with operators", () => {
    const result = safeParse(schema, {
      name: { startsWith: "A" },
      age: { gte: 18 },
      AND: [{ active: true }],
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("Where Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.where;

  test("runtime: accepts relation filter (some)", () => {
    const result = safeParse(schema, {
      posts: { some: { title: "Hello" } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation filter (every)", () => {
    const result = safeParse(schema, {
      posts: { every: { published: true } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation filter (none)", () => {
    const result = safeParse(schema, {
      posts: { none: { published: false } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts combined scalar and relation filter", () => {
    const result = safeParse(schema, {
      name: "Alice",
      posts: { some: { published: true } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts relation filter in AND", () => {
    const result = safeParse(schema, {
      AND: [{ name: "Alice" }, { posts: { some: { title: "Hello" } } }],
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Where Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.where;

  test("runtime: accepts toOne relation filter (is)", () => {
    const result = safeParse(schema, {
      author: { is: { name: "Alice" } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts toOne relation filter (isNot)", () => {
    const result = safeParse(schema, {
      author: { isNot: { name: "Admin" } },
    });
    expect(result.success).toBe(true);
  });
});

