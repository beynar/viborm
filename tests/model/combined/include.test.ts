/**
 * Include Schema Tests
 *
 * Tests the include schema which allows boolean or nested include
 * with where, orderBy, take, skip options for relations.
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
import type { IncludeInput } from "../../../src/schema/model/schemas/core";

// =============================================================================
// TYPE TESTS - Simple Model (no relations)
// =============================================================================

describe("Include Schema - Types (Simple Model)", () => {
  type Input = IncludeInput<SimpleState>;

  test("type: empty object matches (no relations)", () => {
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Author Model (with relations)
// =============================================================================

describe("Include Schema - Types (Author Model)", () => {
  type Input = IncludeInput<AuthorState>;

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
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: rejects unknown key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = safeParse(schema, { anyRelation: true });
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// RUNTIME TESTS - Author Model (oneToMany)
// =============================================================================

describe("Include Schema - Author Model Runtime (oneToMany)", () => {
  const schema = authorSchemas.include;

  test("runtime: accepts empty object", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts boolean include", () => {
    const result = safeParse(schema, { posts: true });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested include with where", () => {
    const result = safeParse(schema, {
      posts: {
        where: { published: true },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested include with orderBy", () => {
    const result = safeParse(schema, {
      posts: {
        orderBy: { title: "asc" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested include with take", () => {
    const result = safeParse(schema, {
      posts: {
        take: 10,
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested include with skip", () => {
    const result = safeParse(schema, {
      posts: {
        skip: 5,
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested include with all options", () => {
    const result = safeParse(schema, {
      posts: {
        where: { published: true },
        orderBy: { title: "desc" },
        take: 10,
        skip: 0,
      },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested select within include", () => {
    const result = safeParse(schema, {
      posts: {
        select: {
          id: true,
          title: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// RUNTIME TESTS - Post Model (manyToOne)
// =============================================================================

describe("Include Schema - Post Model Runtime (manyToOne)", () => {
  const schema = postSchemas.include;

  test("runtime: accepts boolean include for toOne", () => {
    const result = safeParse(schema, { author: true });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts nested select for toOne", () => {
    const result = safeParse(schema, {
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

