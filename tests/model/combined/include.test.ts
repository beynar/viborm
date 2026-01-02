/**
 * Include Schema Tests
 *
 * Tests the include schema which allows boolean or nested include
 * with where, orderBy, take, skip options for relations.
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
// TYPE TESTS - Simple Model (no relations)
// =============================================================================

describe("Include Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.include>;

  test("type: empty object matches (no relations)", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Author Model (with relations)
// =============================================================================

describe("Include Schema - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas.include>;

  test("type: includes relation fields", () => {
    expectTypeOf<Input>().toHaveProperty("posts");
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no relations)
// =============================================================================

describe("Include Schema - Simple Model Runtime", () => {
  const schema = simpleSchemas.include;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects unknown key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { anyRelation: true });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (oneToMany)
// =============================================================================

describe("Include Schema - Author Model Runtime (oneToMany)", () => {
  const schema = authorSchemas.include;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts boolean include", () => {
    const result = parse(schema, { posts: true });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested include with where", () => {
    const result = parse(schema, {
      posts: {
        where: { published: true },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested include with orderBy", () => {
    const result = parse(schema, {
      posts: {
        orderBy: { title: "asc" },
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested include with take", () => {
    const result = parse(schema, {
      posts: {
        take: 10,
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested include with skip", () => {
    const result = parse(schema, {
      posts: {
        skip: 5,
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested include with all options", () => {
    const result = parse(schema, {
      posts: {
        where: { published: true },
        orderBy: { title: "desc" },
        take: 10,
        skip: 0,
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested select within include", () => {
    const result = parse(schema, {
      posts: {
        select: {
          id: true,
          title: true,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne)
// =============================================================================

describe("Include Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.include;

  test("runtime: accepts boolean include for toOne", () => {
    const result = parse(schema, { author: true });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts nested select for toOne", () => {
    const result = parse(schema, {
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
