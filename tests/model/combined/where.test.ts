/**
 * Where Schema Tests
 *
 * Tests the combined where schema which merges scalar filters,
 * relation filters, and AND/OR/NOT logical operators.
 */

import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";
import { authorSchemas, postSchemas, simpleSchemas } from "../fixtures";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Where Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.where>;

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
  type Input = InferInput<typeof authorSchemas.where>;

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
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts scalar filter", () => {
    const result = parse(schema, { name: "Alice" });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts AND operator with array", () => {
    const result = parse(schema, {
      AND: [{ name: "Alice" }, { active: true }],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts AND operator with single object", () => {
    const result = parse(schema, {
      AND: { name: "Alice" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts OR operator", () => {
    const result = parse(schema, {
      OR: [{ name: "Alice" }, { name: "Bob" }],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts NOT operator with single object", () => {
    const result = parse(schema, {
      NOT: { active: false },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts NOT operator with array", () => {
    const result = parse(schema, {
      NOT: [{ name: "Admin" }, { name: "System" }],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested AND/OR/NOT", () => {
    const result = parse(schema, {
      AND: [
        { OR: [{ name: "Alice" }, { name: "Bob" }] },
        { NOT: { active: false } },
      ],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts complex filter with operators", () => {
    const result = parse(schema, {
      name: { startsWith: "A" },
      age: { gte: 18 },
      AND: [{ active: true }],
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("Where Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.where;

  test("runtime: accepts relation filter (some)", () => {
    const result = parse(schema, {
      posts: { some: { title: "Hello" } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation filter (every)", () => {
    const result = parse(schema, {
      posts: { every: { published: true } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation filter (none)", () => {
    const result = parse(schema, {
      posts: { none: { published: false } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts combined scalar and relation filter", () => {
    const result = parse(schema, {
      name: "Alice",
      posts: { some: { published: true } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts relation filter in AND", () => {
    const result = parse(schema, {
      AND: [{ name: "Alice" }, { posts: { some: { title: "Hello" } } }],
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Where Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.where;

  test("runtime: accepts toOne relation filter (is)", () => {
    const result = parse(schema, {
      author: { is: { name: "Alice" } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts toOne relation filter (isNot)", () => {
    const result = parse(schema, {
      author: { isNot: { name: "Admin" } },
    });
    expect(result.issues).toBeUndefined();
  });
});
