/**
 * Select Schema Tests
 *
 * Tests the select schema which allows boolean selection of scalar fields
 * and nested selection of relations.
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

describe("Select Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.select>;

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

describe("Select Schema - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas.select>;

  test("type: includes relation fields", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model
// =============================================================================

describe("Select Schema - Simple Model Runtime", () => {
  const schema = simpleSchemas.select;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts boolean selection", () => {
    const result = parse(schema, {
      id: true,
      name: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts false to exclude fields", () => {
    const result = parse(schema, {
      id: true,
      email: false, // exclude email
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all fields selected", () => {
    const result = parse(schema, {
      id: true,
      name: true,
      email: true,
      age: true,
      active: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects unknown field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, {
      id: true,
      unknownField: true,
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects non-boolean value", () => {
    const result = parse(schema, {
      id: "true", // string instead of boolean
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("Select Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.select;

  test("runtime: accepts boolean for relation", () => {
    const result = parse(schema, {
      id: true,
      posts: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested select for relation", () => {
    const result = parse(schema, {
      id: true,
      posts: {
        select: {
          id: true,
          title: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts combined scalar and relation select", () => {
    const result = parse(schema, {
      id: true,
      name: true,
      posts: {
        select: {
          title: true,
          published: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Select Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.select;

  test("runtime: accepts boolean for toOne relation", () => {
    const result = parse(schema, {
      id: true,
      title: true,
      author: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested select for toOne relation", () => {
    const result = parse(schema, {
      id: true,
      title: true,
      author: {
        select: {
          id: true,
          name: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});
