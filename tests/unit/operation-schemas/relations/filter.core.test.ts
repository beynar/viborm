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
 * - The to-one shorthand `{ author: {...} }` === `{ author: { is: {...} } }`
 */

import { s } from "@schema";
import {
  optionalManyToOneSchemas,
  optionalOneToOneSchemas,
  requiredManyToOneSchemas,
  requiredOneToManySchemas,
} from "@tests/unit/operation-schemas/relations/fixtures";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

test("to-one filters reject non-record shorthand values", () => {
  expect(parse(requiredManyToOneSchemas.filter, 1).issues).toBeDefined();
});

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
      expectTypeOf<{
        isNot?: { name?: string };
      }>().toMatchTypeOf<FilterInput>();
    });

    test("type: is does not accept null for required relation", () => {
      type IsNull = { is: null };
      expectTypeOf<IsNull>().not.toMatchTypeOf<FilterInput>({} as FilterInput);
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
        expect(result.value.isNot).toEqual({
          email: { equals: "bob@example.com" },
        });
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
        expect(result.value.is?.posts?.some).toEqual({
          published: { equals: true },
        });
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
      expectTypeOf<{
        is?: { username?: string };
      }>().toMatchTypeOf<FilterInput>();
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
        expect(result.value).toMatchObject({
          isNot: { username: { equals: "bob" } },
        });
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
      expectTypeOf<{
        some?: { title?: string };
      }>().toMatchTypeOf<FilterInput>();
    });

    test("type: accepts every property", () => {
      expectTypeOf<{
        every?: { published?: boolean };
      }>().toMatchTypeOf<FilterInput>();
    });

    test("type: accepts none property", () => {
      expectTypeOf<{
        none?: { title?: string };
      }>().toMatchTypeOf<FilterInput>();
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
        expect(result.value.some?.author?.is).toEqual({
          name: { equals: "Alice" },
        });
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

// =============================================================================
// TO-ONE SHORTHAND (Prisma parity)
// =============================================================================

/**
 * A target model carrying a scalar field literally named `is` — the
 * documented collision case for the shorthand's disambiguation rule.
 */
const CollisionTarget = s.model({
  id: s.string().id(),
  is: s.string(),
  isNot: s.string(),
  label: s.string(),
});

const CollisionHolder = s.model({
  id: s.string().id(),
  targetId: s.string(),
  target: s
    .manyToOne(() => CollisionTarget)
    .fields("targetId")
    .references("id"),
});

const collisionRegistry = createSchemaRegistry({
  CollisionTarget,
  CollisionHolder,
});
const collisionFilter =
  collisionRegistry.proxy.CollisionHolder.relations.target.filter;

describe("ToOne Filter - shorthand desugaring (Post.author)", () => {
  const schema = requiredManyToOneSchemas.filter;
  type FilterInput = InferInput<typeof schema>;

  test("type: accepts a bare target where as the shorthand", () => {
    expectTypeOf<{ name?: string }>().toMatchTypeOf<FilterInput>();
  });

  test("type: the shorthand cannot carry `is`/`isNot`", () => {
    // The two spellings stay mutually exclusive at the type level, so the
    // explicit-only `{ is: null }` is still rejected for a required relation.
    expectTypeOf<{ is: null }>().not.toMatchTypeOf<FilterInput>(
      {} as FilterInput
    );
  });

  test("runtime: shorthand parses identically to the explicit `is` form", () => {
    const shorthand = parse(schema, { name: "Alice" });
    const explicit = parse(schema, { is: { name: "Alice" } });
    expect(shorthand.issues).toBeUndefined();
    expect(explicit.issues).toBeUndefined();
    if (!(shorthand.issues || explicit.issues)) {
      expect(shorthand.value).toEqual(explicit.value);
      expect(shorthand.value).toEqual({ is: { name: { equals: "Alice" } } });
    }
  });

  test("runtime: compound shorthand with several scalar keys", () => {
    const result = parse(schema, {
      name: "Alice",
      email: { contains: "@example.com" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({
        is: {
          name: { equals: "Alice" },
          email: { contains: "@example.com" },
        },
      });
    }
  });

  test("runtime: shorthand desugars at every nesting level", () => {
    const shorthand = parse(schema, { posts: { some: { published: true } } });
    const explicit = parse(schema, {
      is: { posts: { some: { published: true } } },
    });
    expect(shorthand.issues).toBeUndefined();
    if (!(shorthand.issues || explicit.issues)) {
      expect(shorthand.value).toEqual(explicit.value);
    }
  });

  test("runtime: shorthand carries AND/OR/NOT through to the target where", () => {
    const result = parse(schema, {
      OR: [{ name: "Alice" }, { name: "Bob" }],
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({
        is: {
          OR: [{ name: { equals: "Alice" } }, { name: { equals: "Bob" } }],
        },
      });
    }
  });

  test("runtime: `{}` reads as the vacuous explicit filter", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({});
    }
  });

  test("runtime: a mix of explicit and shorthand keys is rejected", () => {
    // Not every key is `is`/`isNot`, so the WHOLE object reads as a target
    // where — where `is` is not a field. Fail closed, do not silently split.
    const result = parse(schema, { is: { name: "Alice" }, email: "a@b.c" });
    expect(result.issues).toBeDefined();
  });

  test("runtime: a malformed explicit filter reports its own key error", () => {
    const result = parse(schema, { is: { nam: "Alice" } });
    expect(result.issues?.[0]?.message).toContain("nam");
  });

  test("runtime: isNot still works alongside the shorthand", () => {
    const result = parse(schema, { isNot: { name: "Bob" } });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({ isNot: { name: { equals: "Bob" } } });
    }
  });

  test("runtime: null is still rejected for a required relation", () => {
    const result = parse(schema, null);
    expect(result.issues).toBeDefined();
  });
});

describe("ToOne Filter - shorthand on an optional relation (Profile.user)", () => {
  const schema = optionalOneToOneSchemas.filter;

  test("runtime: bare null still normalizes to { is: null }", () => {
    const result = parse(schema, null);
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({ is: null });
    }
  });

  test("runtime: shorthand equals the explicit `is` form", () => {
    const shorthand = parse(schema, { username: "alice" });
    const explicit = parse(schema, { is: { username: "alice" } });
    expect(shorthand.issues).toBeUndefined();
    if (!(shorthand.issues || explicit.issues)) {
      expect(shorthand.value).toEqual(explicit.value);
    }
  });

  test("runtime: `{ is: null }` still means the relation is absent", () => {
    const result = parse(schema, { is: null });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({ is: null });
    }
  });
});

describe("ToOne Filter - `is`/`isNot` collision rule", () => {
  test("runtime: an is-only object always reads as the explicit filter", () => {
    // Target.is is a string scalar, but `{ is: "x" }` has no key outside
    // {is, isNot}, so it is the EXPLICIT form and "x" is not a where object.
    const result = parse(collisionFilter, { is: "x" });
    expect(result.issues).toBeDefined();
  });

  test("runtime: the collided field is reachable through the explicit form", () => {
    const result = parse(collisionFilter, { is: { is: "x" } });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({ is: { is: { equals: "x" } } });
    }
  });

  test("runtime: a shorthand with another key still reaches the collided field", () => {
    const result = parse(collisionFilter, { is: "x", label: "y" });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value).toEqual({
        is: { is: { equals: "x" }, label: { equals: "y" } },
      });
    }
  });
});
