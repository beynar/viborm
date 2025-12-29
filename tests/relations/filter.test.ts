/**
 * Relation Filter Schema Tests
 *
 * Tests filter schemas for both to-one and to-many relations:
 * - ToOne Filter: { is?, isNot? } - with null support for optional relations
 * - ToMany Filter: { some?, every?, none? }
 *
 * Covers:
 * - Type inference with expectTypeOf
 * - Runtime validation with parse
 * - Output verification
 * - Optional vs required relation differences
 * - Nested filtering
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, type InferInput } from "../../src/validation";
import {
  requiredManyToOneSchemas,
  requiredOneToManySchemas,
  optionalOneToOneSchemas,
  optionalManyToOneSchemas,
} from "./fixtures";

// =============================================================================
// TO-ONE FILTER (Required Relation)
// =============================================================================

describe("ToOne Filter - Required (Post.author)", () => {
  const schema = requiredManyToOneSchemas.filter;
  type FilterInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts is property", () => {
      expectTypeOf<{ is?: { name?: string } }>().toMatchTypeOf<FilterInput>();
    });

    test("type: accepts isNot property", () => {
      expectTypeOf<{ isNot?: { name?: string } }>().toMatchTypeOf<FilterInput>();
    });

    test("type: is does not accept null for required relation", () => {
      type IsNull = { is: null };
      expectTypeOf<IsNull>().not.toMatchTypeOf<FilterInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts is with scalar conditions", () => {
      const input = { is: { name: "Alice" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.is).toEqual({ name: { equals: "Alice" } });
      }
    });

    test("runtime: accepts isNot with scalar conditions", () => {
      const input = { isNot: { name: "Bob" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.isNot).toEqual({ name: { equals: "Bob" } });
      }
    });

    test("runtime: accepts is with nested filter operators", () => {
      const input = {
        is: {
          name: { startsWith: "A" },
          email: { contains: "@example.com" },
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.is?.name).toEqual({ startsWith: "A" });
        expect(result.value.is?.email).toEqual({ contains: "@example.com" });
      }
    });

    test("runtime: accepts empty is object", () => {
      const input = { is: {} };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.is).toEqual({});
      }
    });

    test("runtime: accepts combined is and isNot", () => {
      const input = {
        is: { name: "Alice" },
        isNot: { email: "bob@example.com" },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.is).toEqual({ name: { equals: "Alice" } });
        expect(result.value.isNot).toEqual({ email: { equals: "bob@example.com" } });
      }
    });

    test("runtime: rejects is with null (required relation)", () => {
      const result = parse(schema, { is: null });
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts deeply nested relation filter", () => {
      const input = {
        is: {
          posts: {
            some: { published: true },
          },
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.is?.posts?.some).toEqual({ published: { equals: true } });
      }
    });
  });
});

// =============================================================================
// TO-ONE FILTER (Optional Relation)
// =============================================================================

describe("ToOne Filter - Optional (Profile.user)", () => {
  const schema = optionalOneToOneSchemas.filter;
  type FilterInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts is property", () => {
      expectTypeOf<{ is?: { username?: string } }>().toMatchTypeOf<FilterInput>();
    });

    test("type: accepts is with null for optional relation", () => {
      expectTypeOf<{ is?: null }>().toMatchTypeOf<FilterInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts is with null (optional relation)", () => {
      const input = { is: null };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.is).toBeNull();
      }
    });

    test("runtime: accepts is with scalar conditions", () => {
      const input = { is: { username: "alice" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.is).toEqual({ username: { equals: "alice" } });
      }
    });

    test("runtime: accepts isNot with scalar conditions", () => {
      const input = { isNot: { username: "bob" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.isNot).toEqual({ username: { equals: "bob" } });
      }
    });
  });
});

// =============================================================================
// TO-MANY FILTER (Required Relation)
// =============================================================================

describe("ToMany Filter - Required (Author.posts)", () => {
  const schema = requiredOneToManySchemas.filter;
  type FilterInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts some property", () => {
      expectTypeOf<{ some?: { title?: string } }>().toMatchTypeOf<FilterInput>();
    });

    test("type: accepts every property", () => {
      expectTypeOf<{ every?: { published?: boolean } }>().toMatchTypeOf<FilterInput>();
    });

    test("type: accepts none property", () => {
      expectTypeOf<{ none?: { title?: string } }>().toMatchTypeOf<FilterInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts some filter", () => {
      const input = { some: { published: true } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.some).toEqual({ published: { equals: true } });
      }
    });

    test("runtime: accepts every filter", () => {
      const input = { every: { published: true } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.every).toEqual({ published: { equals: true } });
      }
    });

    test("runtime: accepts none filter", () => {
      const input = { none: { published: false } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.none).toEqual({ published: { equals: false } });
      }
    });

    test("runtime: accepts empty some object (any records exist)", () => {
      const input = { some: {} };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.some).toEqual({});
      }
    });

    test("runtime: accepts nested filter operators in some", () => {
      const input = {
        some: {
          title: { contains: "hello" },
          published: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.some?.title).toEqual({ contains: "hello" });
        // Scalar values are transformed to { equals: value }
        expect(result.value.some?.published).toEqual({ equals: true });
      }
    });

    test("runtime: accepts combined some/every/none", () => {
      const input = {
        some: { published: true },
        every: { title: { startsWith: "Post" } },
        none: { content: { contains: "draft" } },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.some).toEqual({ published: { equals: true } });
        expect(result.value.every?.title).toEqual({ startsWith: "Post" });
        expect(result.value.none?.content).toEqual({ contains: "draft" });
      }
    });

    test("runtime: accepts deeply nested relation filter", () => {
      const input = {
        some: {
          author: {
            is: { name: "Alice" },
          },
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.some?.author?.is).toEqual({ name: { equals: "Alice" } });
      }
    });
  });
});

// =============================================================================
// SELF-REFERENTIAL FILTER
// =============================================================================

describe("ToMany Filter - Self-Referential (User.manager)", () => {
  const schema = optionalManyToOneSchemas.filter;

  describe("runtime", () => {
    test("runtime: accepts is with null (optional self-ref)", () => {
      const input = { is: null };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.is).toBeNull();
      }
    });

    test("runtime: accepts is with self-referential conditions", () => {
      const input = {
        is: {
          username: "manager",
          manager: {
            is: null,
          },
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar values are transformed to { equals: value }
        expect(result.value.is?.username).toEqual({ equals: "manager" });
        expect(result.value.is?.manager?.is).toBeNull();
      }
    });
  });
});
