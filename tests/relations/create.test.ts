/**
 * Relation Create Schema Tests
 *
 * Tests create schemas for both to-one and to-many relations:
 * - ToOne Create: { create?, connect?, connectOrCreate? }
 * - ToMany Create: Same + single/array normalization
 *
 * Covers:
 * - Type inference with expectTypeOf
 * - Runtime validation with parse
 * - Output verification
 * - Array normalization for to-many relations
 * - Nested creation scenarios
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, type InferInput } from "../../src/validation";
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
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.create).toEqual({
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
        });
      }
    });

    test("runtime: accepts connect with unique identifier", () => {
      const input = { connect: { id: "author-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.connect).toEqual({ id: "author-1" });
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
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.connectOrCreate?.where).toEqual({ id: "author-1" });
        expect(result.value.connectOrCreate?.create).toEqual({
          id: "author-1",
          name: "Alice",
          email: "alice@example.com",
        });
      }
    });

    test("runtime: rejects create with missing required field", () => {
      const result = parse(schema, {
        create: {
          id: "author-1",
          // missing name and email
        },
      });
      expect(result.issues).toBeDefined();
    });

    test("runtime: accepts empty object (all properties optional)", () => {
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value).toEqual({});
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
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Check the expected properties are preserved
        expect(result.value.create?.id).toBe("user-1");
        expect(result.value.create?.username).toBe("alice");
      }
    });

    test("runtime: accepts connect for optional relation", () => {
      const input = { connect: { id: "user-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.connect).toEqual({ id: "user-1" });
      }
    });

    test("runtime: accepts empty object (relation remains unset)", () => {
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value).toEqual({});
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
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Single create is normalized to array
        expect(Array.isArray(result.value.create)).toBe(true);
        // Verify expected properties are preserved
        expect(result.value.create?.[0].id).toBe("post-1");
        expect(result.value.create?.[0].title).toBe("Hello World");
        expect(result.value.create?.[0].content).toBe("Content");
        expect(result.value.create?.[0].authorId).toBe("author-1");
      }
    });

    test("runtime: accepts array of create objects", () => {
      const input = {
        create: [
          { id: "post-1", title: "Post 1", content: "Content 1", authorId: "a1" },
          { id: "post-2", title: "Post 2", content: "Content 2", authorId: "a1" },
        ],
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.create).toHaveLength(2);
        expect(result.value.create?.[0].title).toBe("Post 1");
        expect(result.value.create?.[1].title).toBe("Post 2");
      }
    });

    test("runtime: accepts single connect object", () => {
      const input = { connect: { id: "post-1" } };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Single connect is normalized to array
        expect(Array.isArray(result.value.connect)).toBe(true);
        expect(result.value.connect?.[0]).toEqual({ id: "post-1" });
      }
    });

    test("runtime: accepts array of connect objects", () => {
      const input = {
        connect: [{ id: "post-1" }, { id: "post-2" }],
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Verify connect array is present
        expect(Array.isArray(result.value.connect)).toBe(true);
        expect(result.value.connect?.length).toBeGreaterThanOrEqual(1);
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
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Single connectOrCreate is normalized to array
        expect(Array.isArray(result.value.connectOrCreate)).toBe(true);
        expect(result.value.connectOrCreate?.[0].where).toEqual({ id: "post-1" });
        expect(result.value.connectOrCreate?.[0].create.title).toBe("Hello");
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
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.connectOrCreate).toHaveLength(2);
        expect(result.value.connectOrCreate?.[0].create.title).toBe("P1");
        expect(result.value.connectOrCreate?.[1].create.title).toBe("P2");
      }
    });

    test("runtime: accepts combined create and connect", () => {
      const input = {
        create: { id: "post-1", title: "New", content: "Post", authorId: "a1" },
        connect: { id: "existing-post" },
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.create?.[0].title).toBe("New");
        expect(result.value.connect?.[0]).toEqual({ id: "existing-post" });
      }
    });
  });

  describe("output normalization", () => {
    test("output: normalizes single create to array", () => {
      const result = parse(schema, {
        create: { id: "post-1", title: "Hello", content: "World", authorId: "a1" },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(result.value.create)).toBe(true);
        expect(result.value.create).toHaveLength(1);
      }
    });

    test("output: normalizes single connect to array", () => {
      const result = parse(schema, {
        connect: { id: "post-1" },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(result.value.connect)).toBe(true);
        expect(result.value.connect).toHaveLength(1);
      }
    });

    test("output: normalizes single connectOrCreate to array", () => {
      const result = parse(schema, {
        connectOrCreate: {
          where: { id: "post-1" },
          create: { id: "post-1", title: "T", content: "C", authorId: "a1" },
        },
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(Array.isArray(result.value.connectOrCreate)).toBe(true);
        expect(result.value.connectOrCreate).toHaveLength(1);
      }
    });

    test("output: preserves array create as-is", () => {
      const result = parse(schema, {
        create: [
          { id: "post-1", title: "P1", content: "C1", authorId: "a1" },
          { id: "post-2", title: "P2", content: "C2", authorId: "a1" },
        ],
      });
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.create).toHaveLength(2);
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
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        // Single create is normalized to array
        expect(Array.isArray(result.value.create)).toBe(true);
        // Verify expected properties are preserved
        expect(result.value.create?.[0].id).toBe("user-2");
        expect(result.value.create?.[0].username).toBe("subordinate");
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
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.create?.[0].username).toBe("subordinate");
        // Check nested relation
        const nestedCreate = result.value.create?.[0].subordinates?.create;
        expect(Array.isArray(nestedCreate)).toBe(true);
        expect(nestedCreate?.[0].username).toBe("sub-subordinate");
      }
    });
  });
});
