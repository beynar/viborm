/**
 * Relation Create Schema Tests
 *
 * Tests create schemas for both to-one and to-many relations:
 * - ToOne Create: { create?, connect?, connectOrCreate? }
 * - ToMany Create: Same + single/array normalization
 *
 * Covers:
 * - Type inference with expectTypeOf
 * - Runtime validation with safeParse
 * - Output verification
 * - Array normalization for to-many relations
 * - Nested creation scenarios
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
// TO-ONE CREATE (Required Relation)
// =============================================================================

describe("ToOne Create - Required (Post.author)", () => {
  const schema = requiredManyToOneSchemas.create;
  type CreateInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts create property", () => {
      expectTypeOf<{ create?: { id: string; name: string; email: string } }>().toMatchTypeOf<CreateInput>();
    });

    test("type: accepts connect property", () => {
      expectTypeOf<{ connect?: { id: string } }>().toMatchTypeOf<CreateInput>();
    });

    test("type: accepts connectOrCreate property", () => {
      expectTypeOf<{
        connectOrCreate?: {
          where: { id: string };
          create: { id: string; name: string; email: string };
        };
      }>().toMatchTypeOf<CreateInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts create with nested data", () => {
      const input = {
        create: {
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.create).toEqual({
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
        });
      }
    });

    test("runtime: accepts connect with unique identifier", () => {
      const input = { connect: { id: "author-1" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.connect).toEqual({ id: "author-1" });
      }
    });

    test("runtime: accepts connectOrCreate with where and create", () => {
      const input = {
        connectOrCreate: {
          where: { id: "author-1" },
          create: {
            id: "author-1",
            name: "Alice",
            email: "alice@example.com",
          },
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.connectOrCreate?.where).toEqual({ id: "author-1" });
        expect(result.output.connectOrCreate?.create).toEqual({
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
        });
      }
    });

    test("runtime: rejects create with missing required field", () => {
      const result = safeParse(schema, {
        create: {
          id: "author-1",
          // missing name and email
        },
      });
      expect(result.success).toBe(false);
    });

    test("runtime: accepts empty object (all properties optional)", () => {
      const result = safeParse(schema, {});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual({});
      }
    });
  });
});

// =============================================================================
// TO-ONE CREATE (Optional Relation)
// =============================================================================

describe("ToOne Create - Optional (Profile.user)", () => {
  const schema = optionalOneToOneSchemas.create;

  describe("runtime", () => {
    test("runtime: accepts create for optional relation", () => {
      const input = {
        create: {
          id: "user-1",
          username: "alice",
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Check the expected properties are preserved
        expect(result.output.create?.id).toBe("user-1");
        expect(result.output.create?.username).toBe("alice");
      }
    });

    test("runtime: accepts connect for optional relation", () => {
      const input = { connect: { id: "user-1" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.connect).toEqual({ id: "user-1" });
      }
    });

    test("runtime: accepts empty object (relation remains unset)", () => {
      const result = safeParse(schema, {});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output).toEqual({});
      }
    });
  });
});

// =============================================================================
// TO-MANY CREATE (Required Relation)
// =============================================================================

describe("ToMany Create - Required (Author.posts)", () => {
  const schema = requiredOneToManySchemas.create;
  type CreateInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts create as single object", () => {
      expectTypeOf<{
        create?: { id: string; title: string; content: string; authorId: string };
      }>().toMatchTypeOf<CreateInput>();
    });

    test("type: accepts create as array", () => {
      expectTypeOf<{
        create?: Array<{ id: string; title: string; content: string; authorId: string }>;
      }>().toMatchTypeOf<CreateInput>();
    });

    test("type: accepts connect as single object", () => {
      expectTypeOf<{ connect?: { id: string } }>().toMatchTypeOf<CreateInput>();
    });

    test("type: accepts connect as array", () => {
      expectTypeOf<{ connect?: Array<{ id: string }> }>().toMatchTypeOf<CreateInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts single create object", () => {
      const input = {
        create: {
          id: "post-1",
          title: "Hello World",
          content: "Content",
          authorId: "author-1",
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Single create is normalized to array
        expect(Array.isArray(result.output.create)).toBe(true);
        // Verify expected properties are preserved
        expect(result.output.create?.[0].id).toBe("post-1");
        expect(result.output.create?.[0].title).toBe("Hello World");
        expect(result.output.create?.[0].content).toBe("Content");
        expect(result.output.create?.[0].authorId).toBe("author-1");
      }
    });

    test("runtime: accepts array of create objects", () => {
      const input = {
        create: [
          { id: "post-1", title: "Post 1", content: "Content 1", authorId: "a1" },
          { id: "post-2", title: "Post 2", content: "Content 2", authorId: "a1" },
        ],
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.create).toHaveLength(2);
        expect(result.output.create?.[0].title).toBe("Post 1");
        expect(result.output.create?.[1].title).toBe("Post 2");
      }
    });

    test("runtime: accepts single connect object", () => {
      const input = { connect: { id: "post-1" } };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Single connect is normalized to array
        expect(Array.isArray(result.output.connect)).toBe(true);
        expect(result.output.connect?.[0]).toEqual({ id: "post-1" });
      }
    });

    test("runtime: accepts array of connect objects", () => {
      const input = {
        connect: [{ id: "post-1" }, { id: "post-2" }],
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Verify connect array is present
        expect(Array.isArray(result.output.connect)).toBe(true);
        expect(result.output.connect?.length).toBeGreaterThanOrEqual(1);
      }
    });

    test("runtime: accepts single connectOrCreate object", () => {
      const input = {
        connectOrCreate: {
          where: { id: "post-1" },
          create: {
            id: "post-1",
            title: "Hello",
            content: "World",
            authorId: "a1",
          },
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Single connectOrCreate is normalized to array
        expect(Array.isArray(result.output.connectOrCreate)).toBe(true);
        expect(result.output.connectOrCreate?.[0].where).toEqual({ id: "post-1" });
        expect(result.output.connectOrCreate?.[0].create.title).toBe("Hello");
      }
    });

    test("runtime: accepts array of connectOrCreate objects", () => {
      const input = {
        connectOrCreate: [
          {
            where: { id: "post-1" },
            create: { id: "post-1", title: "P1", content: "C1", authorId: "a1" },
          },
          {
            where: { id: "post-2" },
            create: { id: "post-2", title: "P2", content: "C2", authorId: "a1" },
          },
        ],
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.connectOrCreate).toHaveLength(2);
        expect(result.output.connectOrCreate?.[0].create.title).toBe("P1");
        expect(result.output.connectOrCreate?.[1].create.title).toBe("P2");
      }
    });

    test("runtime: accepts combined create and connect", () => {
      const input = {
        create: { id: "post-1", title: "New", content: "Post", authorId: "a1" },
        connect: { id: "existing-post" },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.create?.[0].title).toBe("New");
        expect(result.output.connect?.[0]).toEqual({ id: "existing-post" });
      }
    });
  });

  describe("output normalization", () => {
    test("output: normalizes single create to array", () => {
      const result = safeParse(schema, {
        create: { id: "post-1", title: "Hello", content: "World", authorId: "a1" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.create)).toBe(true);
        expect(result.output.create).toHaveLength(1);
      }
    });

    test("output: normalizes single connect to array", () => {
      const result = safeParse(schema, {
        connect: { id: "post-1" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.connect)).toBe(true);
        expect(result.output.connect).toHaveLength(1);
      }
    });

    test("output: normalizes single connectOrCreate to array", () => {
      const result = safeParse(schema, {
        connectOrCreate: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "T", content: "C", authorId: "a1" },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Array.isArray(result.output.connectOrCreate)).toBe(true);
        expect(result.output.connectOrCreate).toHaveLength(1);
      }
    });

    test("output: preserves array create as-is", () => {
      const result = safeParse(schema, {
        create: [
          { id: "post-1", title: "P1", content: "C1", authorId: "a1" },
          { id: "post-2", title: "P2", content: "C2", authorId: "a1" },
        ],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.create).toHaveLength(2);
      }
    });
  });
});

// =============================================================================
// SELF-REFERENTIAL CREATE
// =============================================================================

describe("ToMany Create - Self-Referential (User.subordinates)", () => {
  const schema = selfRefOneToManySchemas.create;

  describe("runtime", () => {
    test("runtime: accepts create for self-referential relation", () => {
      const input = {
        create: {
          id: "user-2",
          username: "subordinate",
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        // Single create is normalized to array
        expect(Array.isArray(result.output.create)).toBe(true);
        // Verify expected properties are preserved
        expect(result.output.create?.[0].id).toBe("user-2");
        expect(result.output.create?.[0].username).toBe("subordinate");
      }
    });

    test("runtime: accepts nested self-referential create", () => {
      const input = {
        create: {
          id: "user-2",
          username: "subordinate",
          subordinates: {
            create: {
              id: "user-3",
              username: "sub-subordinate",
            },
          },
        },
      };
      const result = safeParse(schema, input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.output.create?.[0].username).toBe("subordinate");
        // Check nested relation
        const nestedCreate = result.output.create?.[0].subordinates?.create;
        expect(Array.isArray(nestedCreate)).toBe(true);
        expect(nestedCreate?.[0].username).toBe("sub-subordinate");
      }
    });
  });
});
