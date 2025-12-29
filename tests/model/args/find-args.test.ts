/**
 * Find Args Schema Tests
 *
 * Tests the args schemas for find operations:
 * - findUnique: where (required), select, include
 * - findFirst: where, select, include, orderBy
 * - findMany: where, select, include, orderBy, take, skip, cursor
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, InferInput } from "../../../src/validation";
import {
  simpleSchemas,
  authorSchemas,
  compoundIdSchemas,
  type SimpleState,
  type AuthorState,
} from "../fixtures";

// =============================================================================
// FIND UNIQUE ARGS
// =============================================================================

describe("FindUnique Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.findUnique>;

  test("type: has required where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional select", () => {
    expectTypeOf<Input>().toHaveProperty("select");
  });

  test("type: has optional include", () => {
    expectTypeOf<Input>().toHaveProperty("include");
  });
});

describe("FindUnique Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.findUnique;

  test("runtime: accepts where with id", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts where with unique field", () => {
    const result = parse(schema, {
      where: { email: "alice@example.com" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with select", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing where", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects non-unique field in where (strict schema)", () => {
    // Schema is strict - only unique fields are valid in whereUnique
    const result = parse(schema, {
      where: { name: "Alice" }, // name is not unique
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves where values correctly", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.where).toEqual({ id: "user-123" });
    }
  });

  test("output: preserves select values correctly", () => {
    const result = parse(schema, {
      where: { id: "user-123" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.select).toEqual({ id: true, name: true });
    }
  });
});

describe("FindUnique Args - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas.args.findUnique;
  console.log(compoundIdSchemas.args.findUnique);

  test("runtime: accepts compound id in where", () => {
    const result = parse(schema, {
      where: {
        orgId_memberId: { orgId: "org-1", memberId: "member-1" },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

describe("FindUnique Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.findUnique;

  test("runtime: accepts with include", () => {
    const result = parse(schema, {
      where: { id: "author-1" },
      include: { posts: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with nested include", () => {
    const result = parse(schema, {
      where: { id: "author-1" },
      include: {
        posts: {
          where: { published: true },
          take: 5,
        },
      },
    });
    expect(result.issues).toBeUndefined();
  });
});

// =============================================================================
// FIND FIRST ARGS
// =============================================================================

describe("FindFirst Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.findFirst>;

  test("type: has optional where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional orderBy", () => {
    expectTypeOf<Input>().toHaveProperty("orderBy");
  });
});

describe("FindFirst Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.findFirst;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with where", () => {
    const result = parse(schema, {
      where: { active: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with orderBy", () => {
    const result = parse(schema, {
      orderBy: { name: "asc" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with select", () => {
    const result = parse(schema, {
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all options", () => {
    const result = parse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves all fields correctly (with filter normalization)", () => {
    const input = {
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    };
    const result = parse(schema, input);
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      // Filter values are normalized to { equals: value }
      expect(result.value.where).toEqual({ active: { equals: true } });
      expect(result.value.orderBy).toEqual({ name: "asc" });
      expect(result.value.select).toEqual({ id: true, name: true });
    }
  });
});

// =============================================================================
// FIND MANY ARGS
// =============================================================================

describe("FindMany Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.findMany>;

  test("type: has optional where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional take", () => {
    expectTypeOf<Input>().toHaveProperty("take");
  });

  test("type: has optional skip", () => {
    expectTypeOf<Input>().toHaveProperty("skip");
  });

  test("type: has optional cursor", () => {
    expectTypeOf<Input>().toHaveProperty("cursor");
  });
});

describe("FindMany Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.findMany;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with where", () => {
    const result = parse(schema, {
      where: { active: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with take and skip", () => {
    const result = parse(schema, {
      take: 10,
      skip: 0,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with cursor", () => {
    const result = parse(schema, {
      cursor: { id: "last-seen-id" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with orderBy array", () => {
    const result = parse(schema, {
      orderBy: [{ name: "asc" }, { age: "desc" }],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with distinct", () => {
    const result = parse(schema, {
      distinct: ["name"],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all options combined", () => {
    const result = parse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      take: 20,
      skip: 10,
      cursor: { id: "cursor-id" },
      select: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves take and skip as numbers", () => {
    const result = parse(schema, {
      take: 20,
      skip: 10,
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.take).toBe(20);
      expect(result.value.skip).toBe(10);
    }
  });

  test("output: preserves cursor correctly", () => {
    const result = parse(schema, {
      cursor: { id: "cursor-id" },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.cursor).toEqual({ id: "cursor-id" });
    }
  });

  test("output: preserves distinct array", () => {
    const result = parse(schema, {
      distinct: ["name", "email"],
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.distinct).toEqual(["name", "email"]);
    }
  });

  test("output: preserves orderBy array", () => {
    const result = parse(schema, {
      orderBy: [{ name: "asc" }, { age: "desc" }],
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.orderBy).toEqual([{ name: "asc" }, { age: "desc" }]);
    }
  });
});

describe("FindMany Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.findMany;

  test("runtime: accepts with include and take/skip", () => {
    const result = parse(schema, {
      where: { name: { startsWith: "A" } },
      include: {
        posts: {
          where: { published: true },
          take: 5,
        },
      },
      take: 10,
    });
    expect(result.issues).toBeUndefined();
  });
});
