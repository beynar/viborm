/**
 * Relation Filter Schema Tests
 *
 * Tests the _filter.relation schema which includes all relation fields
 * with their filter schemas (some/every/none for toMany, is/isNot for toOne).
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
import type { RelationFilterInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Author Model (has oneToMany)
// =============================================================================

describe("Relation Filter - Types (Author Model)", () => {
  type Input = RelationFilterInput<AuthorState>;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });

  test("type: all fields are optional (empty object matches)", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Post Model (has manyToOne)
// =============================================================================

describe("Relation Filter - Types (Post Model)", () => {
  type Input = RelationFilterInput<PostState>;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("author");
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (oneToMany relation)
// =============================================================================

describe("Relation Filter - Author Model Runtime (oneToMany)", () => {
  const schema = authorSchemas._filter.relation;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts 'some' filter", () => {
    const result = safeParse(schema, {
      posts: { some: { title: "Hello" } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts 'every' filter", () => {
    const result = safeParse(schema, {
      posts: { every: { published: true } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts 'none' filter", () => {
    const result = safeParse(schema, {
      posts: { none: { title: "Draft" } },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Relation Filter - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas._filter.relation;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts 'is' filter", () => {
    const result = safeParse(schema, {
      author: { is: { name: "Alice" } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts 'isNot' filter", () => {
    const result = safeParse(schema, {
      author: { isNot: { name: "Admin" } },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no relations)
// =============================================================================

describe("Relation Filter - Simple Model Runtime (no relations)", () => {
  const schema = simpleSchemas._filter.relation;

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
