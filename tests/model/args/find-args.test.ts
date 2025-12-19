/**
 * Find Args Schema Tests
 *
 * Tests the args schemas for find operations:
 * - findUnique: where (required), select, include
 * - findFirst: where, select, include, orderBy
 * - findMany: where, select, include, orderBy, take, skip, cursor
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import {
  simpleSchemas,
  authorSchemas,
  compoundIdSchemas,
  type SimpleState,
  type AuthorState,
} from "../fixtures";
import type {
  FindUniqueArgsInput,
  FindFirstArgsInput,
  FindManyArgsInput,
} from "../../../src/schema/model/schemas/args";

// =============================================================================
// FIND UNIQUE ARGS
// =============================================================================

describe("FindUnique Args - Types", () => {
  type Input = FindUniqueArgsInput<SimpleState>;

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
    const result = safeParse(schema, {
      where: { id: "user-123" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts where with unique field", () => {
    const result = safeParse(schema, {
      where: { email: "alice@example.com" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with select", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing where", () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(false);
  });

  test("runtime: ignores non-unique field in where (Valibot allows extra keys)", () => {
    // Valibot's partial/object allows extra keys by default
    const result = safeParse(schema, {
      where: { name: "Alice" }, // name is not unique but allowed
    });
    expect(result.success).toBe(true);
  });

  test("output: preserves where values correctly", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.where).toEqual({ id: "user-123" });
    }
  });

  test("output: preserves select values correctly", () => {
    const result = safeParse(schema, {
      where: { id: "user-123" },
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.select).toEqual({ id: true, name: true });
    }
  });
});

describe("FindUnique Args - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas.args.findUnique;

  test("runtime: accepts compound id in where", () => {
    const result = safeParse(schema, {
      where: {
        orgId_memberId: { orgId: "org-1", memberId: "member-1" },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("FindUnique Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.findUnique;

  test("runtime: accepts with include", () => {
    const result = safeParse(schema, {
      where: { id: "author-1" },
      include: { posts: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with nested include", () => {
    const result = safeParse(schema, {
      where: { id: "author-1" },
      include: {
        posts: {
          where: { published: true },
          take: 5,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// FIND FIRST ARGS
// =============================================================================

describe("FindFirst Args - Types", () => {
  type Input = FindFirstArgsInput<SimpleState>;

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
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with where", () => {
    const result = safeParse(schema, {
      where: { active: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with orderBy", () => {
    const result = safeParse(schema, {
      orderBy: { name: "asc" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with select", () => {
    const result = safeParse(schema, {
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts all options", () => {
    const result = safeParse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
  });

  test("output: preserves all fields correctly (with filter normalization)", () => {
    const input = {
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    };
    const result = safeParse(schema, input);
    expect(result.success).toBe(true);
    if (result.success) {
      // Filter values are normalized to { equals: value }
      expect(result.output.where).toEqual({ active: { equals: true } });
      expect(result.output.orderBy).toEqual({ name: "asc" });
      expect(result.output.select).toEqual({ id: true, name: true });
    }
  });
});

// =============================================================================
// FIND MANY ARGS
// =============================================================================

describe("FindMany Args - Types", () => {
  type Input = FindManyArgsInput<SimpleState>;

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
    const result = safeParse(schema, {});
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with where", () => {
    const result = safeParse(schema, {
      where: { active: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with take and skip", () => {
    const result = safeParse(schema, {
      take: 10,
      skip: 0,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with cursor", () => {
    const result = safeParse(schema, {
      cursor: { id: "last-seen-id" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with orderBy array", () => {
    const result = safeParse(schema, {
      orderBy: [{ name: "asc" }, { age: "desc" }],
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with distinct", () => {
    const result = safeParse(schema, {
      distinct: ["name"],
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts all options combined", () => {
    const result = safeParse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      take: 20,
      skip: 10,
      cursor: { id: "cursor-id" },
      select: { id: true, name: true },
    });
    expect(result.success).toBe(true);
  });

  test("output: preserves take and skip as numbers", () => {
    const result = safeParse(schema, {
      take: 20,
      skip: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.take).toBe(20);
      expect(result.output.skip).toBe(10);
    }
  });

  test("output: preserves cursor correctly", () => {
    const result = safeParse(schema, {
      cursor: { id: "cursor-id" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.cursor).toEqual({ id: "cursor-id" });
    }
  });

  test("output: preserves distinct array", () => {
    const result = safeParse(schema, {
      distinct: ["name", "email"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.distinct).toEqual(["name", "email"]);
    }
  });

  test("output: preserves orderBy array", () => {
    const result = safeParse(schema, {
      orderBy: [{ name: "asc" }, { age: "desc" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.orderBy).toEqual([{ name: "asc" }, { age: "desc" }]);
    }
  });
});

describe("FindMany Args - Author Model Runtime (with relations)", () => {
  const schema = authorSchemas.args.findMany;

  test("runtime: accepts with include and take/skip", () => {
    const result = safeParse(schema, {
      where: { name: { startsWith: "A" } },
      include: {
        posts: {
          where: { published: true },
          take: 5,
        },
      },
      take: 10,
    });
    expect(result.success).toBe(true);
  });
});
