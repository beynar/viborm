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
 * - Runtime validation with safeParse
 * - Output verification (with transformation)
 * - Nested selection/inclusion
 * - Pagination options for to-many relations
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { safeParse, type InferInput } from "valibot";
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
      const result = safeParse(schema, true);
      expect(result.success).toBe(true);
      if (result.success) {
        // Boolean true transforms to { select: { ...all fields } }
        expect(result.output).toHaveProperty("select");
        expect(result.output.select).toHaveProperty("id", true);
        expect(result.output.select).toHaveProperty("name", true);
        expect(result.output.select).toHaveProperty("email", true);
        expect(result.output.select).not.toHaveProperty("posts", true);
      }
    });

    test("runtime: accepts boolean false - transforms to select false", () => {
      const result = safeParse(schema, false);
      expect(result.success).toBe(true);
      if (result.success) {
        // Boolean false transforms to { select: false }
        expect(result.output).toHaveProperty("select", false);
      }
    });

    test("runtime: accepts nested select object", () => {
      const input = {
        select: {
          id: true,
          name: true,
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.name).toBe(true);
      }
    });

    test("runtime: accepts empty object", () => {
      const result = safeParse(schema, {});
      expect(result.success).toBe(true);
      if (result.success) {
        // Empty object passes through without transformation (no boolean)
        expect(result.output).toEqual({});
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
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.name).toBe(true);
        expect(result.output.select?.email).toBe(false);
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
      const result = safeParse(schema, true);
      expect(result.success).toBe(true);
      console.dir(result, { depth: null });
      if (result.success) {
        // Boolean true transforms to { select: { ...all fields } }
        expect(result.output).toHaveProperty("select");
        expect(result.output.select).toHaveProperty("id", true);
        expect(result.output.select).toHaveProperty("name", true);
        expect(result.output.select).toHaveProperty("email", true);
      }
    });

    test("runtime: accepts nested select within include - preserves select", () => {
      const input = {
        select: {
          id: true,
          name: true,
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // When explicit select provided, it's preserved
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.name).toBe(true);
      }
    });

    test("runtime: accepts nested include - adds default select", () => {
      const input = {
        include: {
          posts: true,
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Include without select gets default select added
        expect(result.output).toHaveProperty("select");
        // Nested posts: true is also transformed
        expect(result.output.include?.posts).toHaveProperty("select");
      }
    });

    test("runtime: accepts combined select and include - preserves explicit select", () => {
      const input = {
        select: { id: true },
        include: { posts: true },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Explicit select is preserved
        expect(result.output.select?.id).toBe(true);
        // Nested posts: true is transformed
        expect(result.output.include?.posts).toHaveProperty("select");
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
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Top level gets select added
        expect(result.output).toHaveProperty("select");
        // Nested posts gets select added
        expect(result.output.include?.posts).toHaveProperty("select");
        // Deeply nested author: true transforms
        expect(result.output.include?.posts?.include?.author).toHaveProperty(
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
      const result = safeParse(schema, true);
      expect(result.success).toBe(true);
      if (result.success) {
        // Boolean true transforms to { select: { ...all Post fields } }
        expect(result.output).toHaveProperty("select");
        expect(result.output.select).toHaveProperty("id", true);
        expect(result.output.select).toHaveProperty("title", true);
        expect(result.output.select).toHaveProperty("content", true);
        expect(result.output.select).toHaveProperty("published", true);
        expect(result.output.select).toHaveProperty("authorId", true);
      }
    });

    test("runtime: accepts nested select object", () => {
      const input = {
        select: {
          id: true,
          title: true,
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.title).toBe(true);
      }
    });

    test("runtime: accepts select with where filter", () => {
      const input = {
        where: { published: true },
        select: { id: true },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Scalar filter values are transformed to { equals: value }
        expect(result.output.where?.published).toEqual({ equals: true });
        expect(result.output.select?.id).toBe(true);
      }
    });

    test("runtime: accepts select with pagination", () => {
      const input = {
        take: 10,
        skip: 5,
        select: { id: true },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.take).toBe(10);
        expect(result.output.skip).toBe(5);
        expect(result.output.select?.id).toBe(true);
      }
    });

    test("runtime: accepts select with orderBy", () => {
      const input = {
        orderBy: { title: "asc" },
        select: { id: true },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.orderBy?.title).toBe("asc");
        expect(result.output.select?.id).toBe(true);
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
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Scalar filter values are transformed to { equals: value }
        expect(result.output.where?.published).toEqual({ equals: true });
        expect(result.output.orderBy?.title).toBe("desc");
        expect(result.output.take).toBe(10);
        expect(result.output.skip).toBe(0);
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.title).toBe(true);
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
      const result = safeParse(schema, true);
      expect(result.success).toBe(true);
      if (result.success) {
        // Boolean true transforms to { select: { ...all Post fields } }
        expect(result.output).toHaveProperty("select");
        expect(result.output.select).toHaveProperty("id", true);
        expect(result.output.select).toHaveProperty("title", true);
      }
    });

    test("runtime: accepts with where filter - adds default select", () => {
      const input = { where: { published: true } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Scalar filter values are transformed to { equals: value }
        expect(result.output.where?.published).toEqual({ equals: true });
        // Default select is added
        expect(result.output).toHaveProperty("select");
      }
    });

    test("runtime: accepts with pagination - adds default select", () => {
      const input = { take: 10, skip: 5 };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.take).toBe(10);
        expect(result.output.skip).toBe(5);
        // Default select is added
        expect(result.output).toHaveProperty("select");
      }
    });

    test("runtime: accepts with orderBy - adds default select", () => {
      const input = { orderBy: { title: "asc" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.orderBy?.title).toBe("asc");
        // Default select is added
        expect(result.output).toHaveProperty("select");
      }
    });

    test("runtime: accepts with cursor - adds default select", () => {
      const input = { cursor: "cursor-value" };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.cursor).toBe("cursor-value");
        // Default select is added
        expect(result.output).toHaveProperty("select");
      }
    });

    test("runtime: accepts with nested include - transforms nested boolean", () => {
      const input = {
        include: {
          author: true,
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Default select is added
        expect(result.output).toHaveProperty("select");
        // Nested author: true transforms to { select: {...} }
        expect(result.output.include?.author).toHaveProperty("select");
      }
    });

    test("runtime: accepts with nested select - preserves explicit select", () => {
      const input = {
        select: {
          id: true,
          title: true,
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Explicit select is preserved
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.title).toBe(true);
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
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Scalar filter values are transformed to { equals: value }
        expect(result.output.where?.published).toEqual({ equals: true });
        expect(result.output.orderBy?.title).toBe("desc");
        expect(result.output.take).toBe(10);
        expect(result.output.skip).toBe(0);
        expect(result.output.cursor).toBe("cursor-123");
        // Explicit select is preserved
        expect(result.output.select?.id).toBe(true);
        // Nested author: true transforms
        expect(result.output.include?.author).toHaveProperty("select");
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
      const result = safeParse(selectSchema, true);
      expect(result.success).toBe(true);
      if (result.success) {
        // Boolean true transforms to { select: { ...all User fields } }
        expect(result.output).toHaveProperty("select");
        expect(result.output.select).toHaveProperty("id", true);
        expect(result.output.select).toHaveProperty("username", true);
      }
    });

    test("runtime: accepts nested select for optional relation", () => {
      const input = { select: { id: true, username: true } };
      const result = safeParse(selectSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.username).toBe(true);
      }
    });
  });

  describe("include runtime", () => {
    test("runtime: accepts boolean for optional relation - transforms", () => {
      const result = safeParse(includeSchema, true);
      expect(result.success).toBe(true);
      if (result.success) {
        // Boolean true transforms to { select: { ...all User fields } }
        expect(result.output).toHaveProperty("select");
        expect(result.output.select).toHaveProperty("id", true);
        expect(result.output.select).toHaveProperty("username", true);
      }
    });

    test("runtime: accepts nested include for optional relation - transforms", () => {
      const input = {
        include: {
          profile: true,
        },
      };
      const result = safeParse(includeSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Default select is added
        expect(result.output).toHaveProperty("select");
        // Nested profile: true transforms
        expect(result.output.include?.profile).toHaveProperty("select");
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
      const result = safeParse(selectSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.select?.id).toBe(true);
        expect(result.output.select?.username).toBe(true);
      }
    });

    test("runtime: accepts nested self-referential include - transforms", () => {
      const input = {
        include: {
          subordinates: true,
        },
      };
      const result = safeParse(includeSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Default select is added
        expect(result.output).toHaveProperty("select");
        // Nested subordinates: true transforms
        expect(result.output.include?.subordinates).toHaveProperty("select");
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
      const result = safeParse(includeSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Default select is added at each level
        expect(result.output).toHaveProperty("select");
        expect(result.output.include?.subordinates).toHaveProperty("select");
        // Deeply nested subordinates: true transforms
        expect(
          result.output.include?.subordinates?.include?.subordinates
        ).toHaveProperty("select");
      }
    });

    test("runtime: accepts select with pagination for self-ref", () => {
      const input = {
        take: 10,
        where: { username: { startsWith: "user" } },
        select: { id: true },
      };
      const result = safeParse(selectSchema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.take).toBe(10);
        expect(result.output.where?.username?.startsWith).toBe("user");
        expect(result.output.select?.id).toBe(true);
      }
    });
  });
});
