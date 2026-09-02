/**
 * Include Schema Tests
 *
 * Tests the include schema which allows boolean or nested include
 * with where, orderBy, take, skip options for relations.
 */

import {
  authorSchemas,
  postSchemas,
  simpleSchemas,
} from "@tests/unit/operation-schemas/fixtures";
import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

// =============================================================================
// TYPE TESTS - Simple Model (no relations)
// =============================================================================

describe("Include Schema - Types (Simple Model)", () => {
  type Input = InferInput<typeof simpleSchemas.include>;

  test("type: empty object matches (no relations)", () => {
    // biome-ignore lint/complexity/noBannedTypes: the empty object type is the subject of this type assertion.
    expectTypeOf<{}>().toMatchTypeOf<Input>();
  });
});

// =============================================================================
// TYPE TESTS - Author Model (with relations)
// =============================================================================

describe("Include Schema - Types (Author Model)", () => {
  type Input = InferInput<typeof authorSchemas.include>;

  test("type: includes relation fields", () => {
    expectTypeOf<{ posts?: true }>().toMatchTypeOf<Input>();
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

// =============================================================================
// _count: true SHORTHAND (Prisma sugar for "count every list relation")
// =============================================================================

describe("Include Schema - _count: true shorthand", () => {
  test("type: accepts the boolean shorthand", () => {
    type Input = InferInput<typeof authorSchemas.include>;
    expectTypeOf<{ _count: true }>().toMatchTypeOf<Input>();
  });

  test("type: still accepts the explicit object form", () => {
    type Input = InferInput<typeof authorSchemas.include>;
    expectTypeOf<{
      _count: { select: { posts: true } };
    }>().toMatchTypeOf<Input>();
  });

  test("runtime: desugars to every to-many relation", () => {
    const result = parse(authorSchemas.include, { _count: true });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value._count).toEqual({ select: { posts: true } });
    }
  });

  test("runtime: a model whose only relation is to-one expands to nothing", () => {
    // Prisma counts LIST relations only — `post.author` is manyToOne, so the
    // shorthand expands to `{ select: {} }` (the explicit empty object form).
    const result = parse(postSchemas.include, { _count: true });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value._count).toEqual({ select: {} });
    }
  });

  test("runtime: each parse gets its own desugared object", () => {
    const first = parse(authorSchemas.include, { _count: true });
    const second = parse(authorSchemas.include, { _count: true });
    expect(first.issues).toBeUndefined();
    expect(second.issues).toBeUndefined();
    if (!(first.issues || second.issues)) {
      expect(first.value._count).not.toBe(second.value._count);
    }
  });

  test("runtime: rejects false (Prisma has no _count: false)", () => {
    const result = parse(authorSchemas.include, { _count: false });
    expect(result.issues).toBeDefined();
  });
});
