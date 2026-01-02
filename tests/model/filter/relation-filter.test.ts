/**
 * Relation Filter Schema Tests
 *
 * Tests the _filter.relation schema which includes all relation fields
 * with their filter schemas (some/every/none for toMany, is/isNot for toOne).
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, InferInput } from "@validation";
import {
  authorSchemas,
  postSchemas,
  simpleSchemas,
  type AuthorState,
  type PostState,
} from "../fixtures";

// =============================================================================
// TYPE TESTS - Author Model (has oneToMany)
// =============================================================================

describe("Relation Filter - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas._filter.relation>;

  test("type: includes relation field", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });

  test("type: all fields are optional (empty object matches)", () => {
    expectTypeOf<{
      some: any | undefined;
      every: any | undefined;
      none: any | undefined;
    }>().toMatchTypeOf<Input["posts"]>();
  });
});

// =============================================================================
// TYPE TESTS - Post Model (has manyToOne)
// =============================================================================

describe("Relation Filter - Types (Post Model)", () => {
  type Input = InferInput<typeof postSchemas._filter.relation>;

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
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts 'some' filter", () => {
    const result = parse(schema, {
      posts: { some: { title: "Hello" } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts 'every' filter", () => {
    const result = parse(schema, {
      posts: { every: { published: true } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts 'none' filter", () => {
    const result = parse(schema, {
      posts: { none: { title: "Draft" } },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne relation)
// =============================================================================

describe("Relation Filter - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas._filter.relation;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts 'is' filter", () => {
    const result = parse(schema, {
      author: { is: { name: "Alice" } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts 'isNot' filter", () => {
    const result = parse(schema, {
      author: { isNot: { name: "Admin" } },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no relations)
// =============================================================================

describe("Relation Filter - Simple Model Runtime (no relations)", () => {
  const schema = simpleSchemas._filter.relation;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects unknown relation key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { anyRelation: {} });
    expect(result.issues).toBeDefined();
  });
});
