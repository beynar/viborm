/**
 * Select Schema Tests
 *
 * Tests the select schema which allows boolean selection of scalar fields
 * and nested selection of relations.
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
import type { SelectInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model
// =============================================================================

describe("Select Schema - Types (Simple Model)", () => {
  type Input = SelectInput<SimpleState>;

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
  type Input = SelectInput<AuthorState>;

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
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts boolean selection", () => {
    const result = safeParse(schema, {
      id: true,
      name: true,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts false to exclude fields", () => {
    const result = safeParse(schema, {
      id: true,
      email: false, // exclude email
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts all fields selected", () => {
    const result = safeParse(schema, {
      id: true,
      name: true,
      email: true,
      age: true,
      active: true,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects unknown field (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = safeParse(schema, {
      id: true,
      unknownField: true,
    });
    expect(result.success).toBe(false);
  });

  test("runtime: rejects non-boolean value", () => {
    const result = safeParse(schema, {
      id: "true", // string instead of boolean
    });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (with relations)
// =============================================================================

describe("Select Schema - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.select;

  test("runtime: accepts boolean for relation", () => {
    const result = safeParse(schema, {
      id: true,
      posts: true,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested select for relation", () => {
    const result = safeParse(schema, {
      id: true,
      posts: {
        select: {
          id: true,
          title: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts combined scalar and relation select", () => {
    const result = safeParse(schema, {
      id: true,
      name: true,
      posts: {
        select: {
          title: true,
          published: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Select Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.select;

  test("runtime: accepts boolean for toOne relation", () => {
    const result = safeParse(schema, {
      id: true,
      title: true,
      author: true,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested select for toOne relation", () => {
    const result = safeParse(schema, {
      id: true,
      title: true,
      author: {
        select: {
          id: true,
          name: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

