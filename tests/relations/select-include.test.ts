/**
 * Relation Select & Include Schema Tests
 *
 * Tests select and include schemas for both to-one and to-many relations:
 * - ToOne Select: true or { select }
 * - ToMany Select: true or { where, orderBy, take, skip, select }
 * - ToOne Include: true or { select, include }
 * - ToMany Include: true or { where, orderBy, take, skip, cursor, select, include }
 *
 * Note: Boolean values are transformed to explicit select objects:
 * - `true` becomes `{ select: { field1: true, field2: true, ... } }`
 * - `false` becomes `{ select: false }`
 *
 * Covers:
 * - Type inference with expectTypeOf
 * - Runtime validation with parse
 * - Output verification (with transformation)
 * - Nested selection/inclusion
 * - Pagination options for to-many relations
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, type InferInput } from "@validation";
import {
  requiredManyToOneSchemas,
  requiredOneToManySchemas,
  optionalOneToOneSchemas,
  selfRefOneToManySchemas,
} from "./fixtures";

// =============================================================================
// TO-ONE SELECT
// =============================================================================

describe("ToOne Select (Post.author)", () => {
  const schema = requiredManyToOneSchemas.select;
  type SelectInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts boolean true", () => {
      expectTypeOf<true>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts boolean false", () => {
      expectTypeOf<false>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts nested select object", () => {
      expectTypeOf<{
        select?: { id?: boolean; name?: boolean };
      }>().toMatchTypeOf<SelectInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts boolean true - transforms to select object", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all fields } }
        expect(result.value).toHaveProperty("select");
        expect(result.value.select).toHaveProperty("id", true);
        expect(result.value.select).toHaveProperty("name", true);
        expect(result.value.select).toHaveProperty("email", true);
        expect(result.value.select).not.toHaveProperty("posts", true);
      }
    });

    test("runtime: accepts boolean false - transforms to select false", () => {
      const result = parse(schema, false);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean false transforms to { select: false }
        expect(result.value).toHaveProperty("select", false);
      }
    });

    test("runtime: accepts nested select object", () => {
      const input = {
        select: {
          id: true,
          name: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();

      if (!result.issues) {
        expect(result.value.select?.id).toBe(true);
        expect(result.value.select?.name).toBe(true);
      }
    });

    test("runtime: accepts empty object", () => {
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Empty object passes through without transformation (no boolean)
        expect(result.value).toEqual({});
      }
    });

    test("runtime: preserves nested select structure with false values", () => {
      const input = {
        select: {
          id: true,
          name: true,
          email: false,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.select?.id).toBe(true);
        expect(result.value.select?.name).toBe(true);
        expect(result.value.select?.email).toBe(false);
      }
    });
  });
});

// =============================================================================
// TO-ONE INCLUDE
// =============================================================================

describe("ToOne Include (Post.author)", () => {
  const schema = requiredManyToOneSchemas.include;
  type IncludeInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts boolean true", () => {
      expectTypeOf<true>().toMatchTypeOf<IncludeInput>();
    });

    test("type: accepts nested select object", () => {
      expectTypeOf<{
        select?: { id?: boolean };
      }>().toMatchTypeOf<IncludeInput>();
    });

    test("type: accepts nested include object", () => {
      expectTypeOf<{
        include?: { posts?: boolean };
      }>().toMatchTypeOf<IncludeInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts boolean true - transforms to select object", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      console.dir(result, { depth: null });
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all fields } }
        expect(result.value).toHaveProperty("select");
        expect(result.value.select).toHaveProperty("id", true);
        expect(result.value.select).toHaveProperty("name", true);
        expect(result.value.select).toHaveProperty("email", true);
      }
    });

    test("runtime: accepts nested select within include - preserves select", () => {
      const input = {
        select: {
          id: true,
          name: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // When explicit select provided, it's preserved
        expect(result.value.select?.id).toBe(true);
        expect(result.value.select?.name).toBe(true);
      }
    });

    test("runtime: accepts nested include - adds default select", () => {
      const input = {
        include: {
          posts: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Include without select gets default select added
        expect(result.value).toHaveProperty("select");
        // Nested posts: true is also transformed
        expect(result.value.include?.posts).toHaveProperty("select");
      }
    });

    test("runtime: accepts combined select and include - preserves explicit select", () => {
      const input = {
        select: { id: true },
        include: { posts: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Explicit select is preserved
        expect(result.value.select?.id).toBe(true);
        // Nested posts: true is transformed
        expect(result.value.include?.posts).toHaveProperty("select");
      }
    });

    test("runtime: accepts deeply nested include - all booleans transform", () => {
      const input = {
        include: {
          posts: {
            include: {
              author: true,
            },
          },
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Top level gets select added
        expect(result.value).toHaveProperty("select");
        // Nested posts gets select added
        expect(result.value.include?.posts).toHaveProperty("select");
        // Deeply nested author: true transforms
        expect(result.value.include?.posts?.include?.author).toHaveProperty(
          "select"
        );
      }
    });
  });
});

// =============================================================================
// TO-MANY SELECT
// =============================================================================

describe("ToMany Select (Author.posts)", () => {
  const schema = requiredOneToManySchemas.select;
  type SelectInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts boolean true", () => {
      expectTypeOf<true>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts nested select with where", () => {
      expectTypeOf<{
        where?: { published?: boolean };
        select?: { id?: boolean };
      }>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts pagination options", () => {
      expectTypeOf<{
        take?: number;
        skip?: number;
      }>().toMatchTypeOf<SelectInput>();
    });

    test("type: accepts orderBy option", () => {
      expectTypeOf<{
        orderBy?: { title?: "asc" | "desc" };
      }>().toMatchTypeOf<SelectInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts boolean true - transforms to select object", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all Post fields } }
        expect(result.value).toHaveProperty("select");
        expect(result.value.select).toHaveProperty("id", true);
        expect(result.value.select).toHaveProperty("title", true);
        expect(result.value.select).toHaveProperty("content", true);
        expect(result.value.select).toHaveProperty("published", true);
        expect(result.value.select).toHaveProperty("authorId", true);
      }
    });

    test("runtime: accepts nested select object", () => {
      const input = {
        select: {
          id: true,
          title: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.select?.id).toBe(true);
        expect(result.value.select?.title).toBe(true);
      }
    });

    test("runtime: accepts select with where filter", () => {
      const input = {
        where: { published: true },
        select: { id: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar filter values are transformed to { equals: value }
        expect(result.value.where?.published).toEqual({ equals: true });
        expect(result.value.select?.id).toBe(true);
      }
    });

    test("runtime: accepts select with pagination", () => {
      const input = {
        take: 10,
        skip: 5,
        select: { id: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.take).toBe(10);
        expect(result.value.skip).toBe(5);
        expect(result.value.select?.id).toBe(true);
      }
    });

    test("runtime: accepts select with orderBy", () => {
      const input = {
        orderBy: { title: "asc" },
        select: { id: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.orderBy?.title).toBe("asc");
        expect(result.value.select?.id).toBe(true);
      }
    });

    test("runtime: accepts all options combined", () => {
      const input = {
        where: { published: true },
        orderBy: { title: "desc" },
        take: 10,
        skip: 0,
        select: { id: true, title: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar filter values are transformed to { equals: value }
        expect(result.value.where?.published).toEqual({ equals: true });
        expect(result.value.orderBy?.title).toBe("desc");
        expect(result.value.take).toBe(10);
        expect(result.value.skip).toBe(0);
        expect(result.value.select?.id).toBe(true);
        expect(result.value.select?.title).toBe(true);
      }
    });
  });
});

// =============================================================================
// TO-MANY INCLUDE
// =============================================================================

describe("ToMany Include (Author.posts)", () => {
  const schema = requiredOneToManySchemas.include;
  type IncludeInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts boolean true", () => {
      expectTypeOf<true>().toMatchTypeOf<IncludeInput>();
    });

    test("type: accepts nested options", () => {
      expectTypeOf<{
        where?: { published?: boolean };
        orderBy?: { title?: "asc" | "desc" };
        take?: number;
        skip?: number;
        select?: { id?: boolean };
        include?: { author?: boolean };
      }>().toMatchTypeOf<IncludeInput>();
    });

    test("type: accepts cursor option", () => {
      expectTypeOf<{ cursor?: string }>().toMatchTypeOf<IncludeInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts boolean true - transforms to select object", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all Post fields } }
        expect(result.value).toHaveProperty("select");
        expect(result.value.select).toHaveProperty("id", true);
        expect(result.value.select).toHaveProperty("title", true);
      }
    });

    test("runtime: accepts with where filter - adds default select", () => {
      const input = { where: { published: true } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar filter values are transformed to { equals: value }
        expect(result.value.where?.published).toEqual({ equals: true });
        // Default select is added
        expect(result.value).toHaveProperty("select");
      }
    });

    test("runtime: accepts with pagination - adds default select", () => {
      const input = { take: 10, skip: 5 };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.take).toBe(10);
        expect(result.value.skip).toBe(5);
        // Default select is added
        expect(result.value).toHaveProperty("select");
      }
    });

    test("runtime: accepts with orderBy - adds default select", () => {
      const input = { orderBy: { title: "asc" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.orderBy?.title).toBe("asc");
        // Default select is added
        expect(result.value).toHaveProperty("select");
      }
    });

    test("runtime: accepts with cursor - adds default select", () => {
      const input = { cursor: "cursor-value" };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.cursor).toBe("cursor-value");
        // Default select is added
        expect(result.value).toHaveProperty("select");
      }
    });

    test("runtime: accepts with nested include - transforms nested boolean", () => {
      const input = {
        include: {
          author: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Default select is added
        expect(result.value).toHaveProperty("select");
        // Nested author: true transforms to { select: {...} }
        expect(result.value.include?.author).toHaveProperty("select");
      }
    });

    test("runtime: accepts with nested select - preserves explicit select", () => {
      const input = {
        select: {
          id: true,
          title: true,
        },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Explicit select is preserved
        expect(result.value.select?.id).toBe(true);
        expect(result.value.select?.title).toBe(true);
      }
    });

    test("runtime: accepts all options combined - transforms nested boolean", () => {
      const input = {
        where: { published: true },
        orderBy: { title: "desc" },
        take: 10,
        skip: 0,
        cursor: "cursor-123",
        select: { id: true },
        include: { author: true },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Scalar filter values are transformed to { equals: value }
        expect(result.value.where?.published).toEqual({ equals: true });
        expect(result.value.orderBy?.title).toBe("desc");
        expect(result.value.take).toBe(10);
        expect(result.value.skip).toBe(0);
        expect(result.value.cursor).toBe("cursor-123");
        // Explicit select is preserved
        expect(result.value.select?.id).toBe(true);
        // Nested author: true transforms
        expect(result.value.include?.author).toHaveProperty("select");
      }
    });
  });
});

// =============================================================================
// OPTIONAL RELATION SELECT/INCLUDE
// =============================================================================

describe("Optional Relation Select/Include (Profile.user)", () => {
  const selectSchema = optionalOneToOneSchemas.select;
  const includeSchema = optionalOneToOneSchemas.include;

  describe("select runtime", () => {
    test("runtime: accepts boolean for optional relation - transforms", () => {
      const result = parse(selectSchema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all User fields } }
        expect(result.value).toHaveProperty("select");
        expect(result.value.select).toHaveProperty("id", true);
        expect(result.value.select).toHaveProperty("username", true);
      }
    });

    test("runtime: accepts nested select for optional relation", () => {
      const input = { select: { id: true, username: true } };
      const result = parse(selectSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.select?.id).toBe(true);
        expect(result.value.select?.username).toBe(true);
      }
    });
  });

  describe("include runtime", () => {
    test("runtime: accepts boolean for optional relation - transforms", () => {
      const result = parse(includeSchema, true);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Boolean true transforms to { select: { ...all User fields } }
        expect(result.value).toHaveProperty("select");
        expect(result.value.select).toHaveProperty("id", true);
        expect(result.value.select).toHaveProperty("username", true);
      }
    });

    test("runtime: accepts nested include for optional relation - transforms", () => {
      const input = {
        include: {
          profile: true,
        },
      };
      const result = parse(includeSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Default select is added
        expect(result.value).toHaveProperty("select");
        // Nested profile: true transforms
        expect(result.value.include?.profile).toHaveProperty("select");
      }
    });
  });
});

// =============================================================================
// SELF-REFERENTIAL SELECT/INCLUDE
// =============================================================================

describe("Self-Referential Select/Include (User.subordinates)", () => {
  const selectSchema = selfRefOneToManySchemas.select;
  const includeSchema = selfRefOneToManySchemas.include;

  describe("runtime", () => {
    test("runtime: accepts nested self-referential select", () => {
      const input = {
        select: {
          id: true,
          username: true,
        },
      };
      const result = parse(selectSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.select?.id).toBe(true);
        expect(result.value.select?.username).toBe(true);
      }
    });

    test("runtime: accepts nested self-referential include - transforms", () => {
      const input = {
        include: {
          subordinates: true,
        },
      };
      const result = parse(includeSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Default select is added
        expect(result.value).toHaveProperty("select");
        // Nested subordinates: true transforms
        expect(result.value.include?.subordinates).toHaveProperty("select");
      }
    });

    test("runtime: accepts deeply nested self-referential include - all transform", () => {
      const input = {
        include: {
          subordinates: {
            include: {
              subordinates: true,
            },
          },
        },
      };
      const result = parse(includeSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Default select is added at each level
        expect(result.value).toHaveProperty("select");
        expect(result.value.include?.subordinates).toHaveProperty("select");
        // Deeply nested subordinates: true transforms
        expect(
          result.value.include?.subordinates?.include?.subordinates
        ).toHaveProperty("select");
      }
    });

    test("runtime: accepts select with pagination for self-ref", () => {
      const input = {
        take: 10,
        where: { username: { startsWith: "user" } },
        select: { id: true },
      };
      const result = parse(selectSchema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.take).toBe(10);
        expect(result.value.where?.username?.startsWith).toBe("user");
        expect(result.value.select?.id).toBe(true);
      }
    });
  });
});
