/**
 * Relation OrderBy Schema Tests
 *
 * Tests orderBy schemas for both to-one and to-many relations:
 * - ToOne OrderBy: Nested orderBy from the related model's fields
 * - ToMany OrderBy: _count aggregate ordering
 *
 * Covers:
 * - Type inference with expectTypeOf
 * - Runtime validation with parse
 * - Output verification
 * - Nested field ordering
 * - Aggregate count ordering
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
// TO-ONE ORDER BY
// =============================================================================

describe("ToOne OrderBy (Post.author)", () => {
  const schema = requiredManyToOneSchemas.orderBy;
  type OrderByInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts scalar field ordering", () => {
      expectTypeOf<{ name?: "asc" | "desc" }>().toMatchTypeOf<OrderByInput>();
    });

    test("type: accepts multiple field ordering", () => {
      expectTypeOf<{
        name?: "asc" | "desc";
        email?: "asc" | "desc";
      }>().toMatchTypeOf<OrderByInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts nested orderBy on related model fields", () => {
      const input = { name: "asc" };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.name).toBe("asc");
      }
    });

    test("runtime: accepts nested orderBy with desc", () => {
      const input = { id: "desc" };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.id).toBe("desc");
      }
    });

    test("runtime: accepts multiple fields ordering", () => {
      const input = {
        name: "asc",
        email: "desc",
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.name).toBe("asc");
        expect(result.value.email).toBe("desc");
      }
    });

    test("runtime: accepts empty object", () => {
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value).toEqual({});
      }
    });

    test("runtime: rejects invalid order value", () => {
      const result = parse(schema, { name: "invalid" });
      expect(result.issues).toBeDefined();
    });
  });
});

// =============================================================================
// TO-MANY ORDER BY
// =============================================================================

describe("ToMany OrderBy (Author.posts)", () => {
  const schema = requiredOneToManySchemas.orderBy;
  type OrderByInput = InferInput<typeof schema>;

  describe("type", () => {
    test("type: accepts _count property", () => {
      expectTypeOf<{ _count?: "asc" | "desc" }>().toMatchTypeOf<OrderByInput>();
    });
  });

  describe("runtime", () => {
    test("runtime: accepts _count ascending", () => {
      const input = { _count: "asc" };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value._count).toBe("asc");
      }
    });

    test("runtime: accepts _count descending", () => {
      const input = { _count: "desc" };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value._count).toBe("desc");
      }
    });

    test("runtime: accepts empty object", () => {
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value).toEqual({});
      }
    });

    test("runtime: rejects invalid _count value", () => {
      const result = parse(schema, { _count: "invalid" });
      expect(result.issues).toBeDefined();
    });
  });
});

// =============================================================================
// OPTIONAL RELATION ORDER BY
// =============================================================================

describe("Optional ToOne OrderBy (Profile.user)", () => {
  const schema = optionalOneToOneSchemas.orderBy;

  describe("runtime", () => {
    test("runtime: accepts nested field ordering for optional relation", () => {
      const input = { username: "asc" };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.username).toBe("asc");
      }
    });

    test("runtime: accepts multiple field ordering", () => {
      const input = {
        id: "desc",
        username: "asc",
      };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value.id).toBe("desc");
        expect(result.value.username).toBe("asc");
      }
    });
  });
});

// =============================================================================
// SELF-REFERENTIAL ORDER BY
// =============================================================================

describe("Self-Referential OrderBy (User.subordinates)", () => {
  const schema = selfRefOneToManySchemas.orderBy;

  describe("runtime", () => {
    test("runtime: accepts _count for self-referential relation", () => {
      const input = { _count: "asc" };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value._count).toBe("asc");
      }
    });

    test("runtime: accepts _count descending", () => {
      const input = { _count: "desc" };
      const result = parse(schema, input);
      expect(result.issues).toBeUndefined();
      if (!result.issues) {
        expect(result.value._count).toBe("desc");
      }
    });
  });
});
