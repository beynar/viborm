/**
 * Aggregate Args Schema Tests
 *
 * Tests the args schemas for aggregate operations:
 * - count
 * - aggregate
 * - groupBy
 */

import { type InferInput, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";
import { authorSchemas, simpleSchemas } from "../fixtures";

// =============================================================================
// COUNT ARGS
// =============================================================================

describe("Count Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.count>;

  test("type: has optional where", () => {
    expectTypeOf<{ where?: { active?: boolean } }>().toMatchTypeOf<Input>();
  });

  test("type: has optional orderBy", () => {
    expectTypeOf<{
      orderBy?: { name?: "asc" | "desc" };
    }>().toMatchTypeOf<Input>();
  });

  test("type: has optional pagination", () => {
    expectTypeOf<{ cursor?: { id: string } }>().toMatchTypeOf<Input>();
    expectTypeOf<{ take?: number }>().toMatchTypeOf<Input>();
    expectTypeOf<{ skip?: number }>().toMatchTypeOf<Input>();
  });
});

describe("Count Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.count;

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
      take: 100,
      skip: 10,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with orderBy", () => {
    const result = parse(schema, {
      orderBy: { name: "asc" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with orderBy array", () => {
    const result = parse(schema, {
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects invalid pagination values", () => {
    expect(parse(schema, { take: 1.5 }).issues?.[0]?.message).toBe(
      "Expected integer"
    );
    expect(parse(schema, { skip: 1.5 }).issues?.[0]?.message).toBe(
      "Expected integer"
    );
    expect(parse(schema, { skip: -1 }).issues?.[0]?.message).toBe(
      "Transform failed: skip must be greater than or equal to 0"
    );
    expect(parse(schema, { take: Number.NaN }).issues?.[0]?.message).toBe(
      "Expected integer"
    );
    expect(
      parse(schema, { take: Number.POSITIVE_INFINITY }).issues?.[0]?.message
    ).toBe("Expected integer");
  });

  test("runtime: accepts with cursor", () => {
    const result = parse(schema, {
      cursor: { id: "user-123" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects invalid orderBy", () => {
    const result = parse(schema, {
      orderBy: { unknown: "asc" },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: accepts all options", () => {
    const result = parse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      cursor: { id: "user-123" },
      take: 100,
      skip: 10,
      select: { _all: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves count args correctly", () => {
    const result = parse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      take: 100,
      skip: 10,
      select: { _all: true },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      const value = result.value as {
        where: unknown;
        orderBy: unknown;
        take: number;
        skip: number;
        select: unknown;
      };
      // Filter values are normalized to { equals: value }
      expect(value.where).toEqual({ active: { equals: true } });
      expect(value.orderBy).toEqual({ name: "asc" });
      expect(value.take).toBe(100);
      expect(value.skip).toBe(10);
      expect(value.select).toEqual({ _all: true });
    }
  });
});

// =============================================================================
// AGGREGATE ARGS
// =============================================================================

describe("Aggregate Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.aggregate>;

  test("type: has optional where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional _count", () => {
    expectTypeOf<Input>().toHaveProperty("_count");
  });

  test("type: has optional order and pagination", () => {
    expectTypeOf<Input>().toHaveProperty("orderBy");
    expectTypeOf<Input>().toHaveProperty("cursor");
    expectTypeOf<Input>().toHaveProperty("take");
    expectTypeOf<Input>().toHaveProperty("skip");
  });
});

describe("Aggregate Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.aggregate;

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

  test("runtime: accepts with _count true", () => {
    const result = parse(schema, {
      _count: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with _count select", () => {
    const result = parse(schema, {
      _count: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with _avg", () => {
    const result = parse(schema, {
      _avg: { age: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with _sum", () => {
    const result = parse(schema, {
      _sum: { age: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with _min and _max", () => {
    const result = parse(schema, {
      _min: { age: true },
      _max: { age: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with orderBy", () => {
    const result = parse(schema, {
      orderBy: { name: "asc" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with take and skip", () => {
    const result = parse(schema, {
      take: 10,
      skip: 5,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all aggregate options", () => {
    const result = parse(schema, {
      where: { active: true },
      orderBy: { name: "asc" },
      take: 100,
      skip: 0,
      _count: true,
      _avg: { age: true },
      _sum: { age: true },
      _min: { age: true },
      _max: { age: true },
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves aggregate options correctly (with normalization)", () => {
    const result = parse(schema, {
      where: { active: true },
      _count: true,
      _avg: { age: true },
      _sum: { age: true },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      // Filter values are normalized to { equals: value }
      expect(result.value.where).toEqual({ active: { equals: true } });
      expect(result.value._count).toBe(true);
      expect(result.value._avg).toEqual({ age: true });
      expect(result.value._sum).toEqual({ age: true });
    }
  });

  test("output: preserves _count as select object", () => {
    const result = parse(schema, {
      _count: { id: true, name: true },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value._count).toEqual({ id: true, name: true });
    }
  });
});

// =============================================================================
// GROUP BY ARGS
// =============================================================================

describe("GroupBy Args - Types", () => {
  type Input = InferInput<typeof simpleSchemas.args.groupBy>;
  type AuthorInput = InferInput<typeof authorSchemas.args.groupBy>;

  test("type: has required by", () => {
    expectTypeOf<Input>().toHaveProperty("by");
  });

  test("type: has optional where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional having", () => {
    expectTypeOf<Input>().toHaveProperty("having");
  });

  test("type: accepts scalar field in by", () => {
    expectTypeOf<{ by: "id" }>().toMatchTypeOf<AuthorInput>();
  });

  test("type: accepts scalar field array in by", () => {
    expectTypeOf<{ by: ["id", "name"] }>().toMatchTypeOf<AuthorInput>();
  });

  test("type: rejects relation field in by", () => {
    expectTypeOf<{ by: "posts" }>().not.toMatchTypeOf<AuthorInput>();
  });

  test("type: rejects relation field array in by", () => {
    expectTypeOf<{ by: ["posts"] }>().not.toMatchTypeOf<AuthorInput>();
  });

  test("type: rejects mixed scalar and relation field array in by", () => {
    expectTypeOf<{ by: ["id", "posts"] }>().not.toMatchTypeOf<AuthorInput>();
  });
});

describe("GroupBy Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.groupBy;

  test("runtime: accepts with by as string", () => {
    const result = parse(schema, {
      by: "active",
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with by as array", () => {
    const result = parse(schema, {
      by: ["active", "name"],
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with where", () => {
    const result = parse(schema, {
      by: "active",
      where: { age: { gte: 18 } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with having", () => {
    const result = parse(schema, {
      by: "active",
      having: { age: { _avg: { gte: 18 } } },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with orderBy", () => {
    const result = parse(schema, {
      by: "active",
      orderBy: { active: "asc" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with _count", () => {
    const result = parse(schema, {
      by: "active",
      _count: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts with take and skip", () => {
    const result = parse(schema, {
      by: "active",
      take: 10,
      skip: 0,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all groupBy options", () => {
    const result = parse(schema, {
      by: ["active", "name"],
      where: { age: { gte: 18 } },
      having: { age: { _avg: { gte: 18 } } },
      orderBy: { active: "asc" },
      take: 10,
      skip: 0,
      _count: true,
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects missing by", () => {
    const result = parse(schema, {
      where: { active: true },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects relation field in by", () => {
    const result = parse(authorSchemas.args.groupBy, {
      by: "posts",
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects relation field array in by", () => {
    const result = parse(authorSchemas.args.groupBy, {
      by: ["posts"],
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects mixed scalar and relation field array in by", () => {
    const result = parse(authorSchemas.args.groupBy, {
      by: ["id", "posts"],
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves by as string", () => {
    const result = parse(schema, {
      by: "active",
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.by).toBe("active");
    }
  });

  test("output: preserves by as array", () => {
    const result = parse(schema, {
      by: ["active", "name"],
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.by).toEqual(["active", "name"]);
      expect(Array.isArray(result.value.by)).toBe(true);
    }
  });

  test("output: preserves all groupBy options correctly", () => {
    const result = parse(schema, {
      by: ["active"],
      where: { age: { gte: 18 } },
      having: { age: { _avg: { gte: 18 } }, name: { _count: { gt: 0 } } },
      orderBy: { active: "asc" },
      take: 10,
      skip: 5,
      _count: true,
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.by).toEqual(["active"]);
      expect(result.value.where).toEqual({ age: { gte: 18 } });
      // having uses Prisma-style aggregate filtering
      expect(result.value.having).toEqual({
        age: { _avg: { gte: 18 } },
        name: { _count: { gt: 0 } },
      });
      expect(result.value.orderBy).toEqual({ active: "asc" });
      expect(result.value.take).toBe(10);
      expect(result.value.skip).toBe(5);
      expect(result.value._count).toBe(true);
    }
  });
});

// =============================================================================
// GROUP BY HAVING - BOOLEAN COMBINATORS
// =============================================================================

describe("GroupBy Args - having AND/OR/NOT", () => {
  const schema = simpleSchemas.args.groupBy;

  test("type: accepts OR of aggregate conditions", () => {
    type Input = InferInput<typeof simpleSchemas.args.groupBy>;
    expectTypeOf<{
      by: "active";
      having: { OR: [{ age: { _avg: { gte: number } } }] };
    }>().toMatchTypeOf<Input>();
  });

  test("type: accepts NOT as a bare object", () => {
    type Input = InferInput<typeof simpleSchemas.args.groupBy>;
    expectTypeOf<{
      by: "active";
      having: { NOT: { age: { _avg: { gte: number } } } };
    }>().toMatchTypeOf<Input>();
  });

  test("runtime: accepts OR of aggregate conditions", () => {
    const result = parse(schema, {
      by: "active",
      having: {
        OR: [{ age: { _avg: { gte: 18 } } }, { name: { _count: { gt: 2 } } }],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts AND as an array and as a bare object", () => {
    const asArray = parse(schema, {
      by: "active",
      having: { AND: [{ age: { _avg: { gte: 18 } } }] },
    });
    expect(asArray.issues).toBeUndefined();

    const asObject = parse(schema, {
      by: "active",
      having: { AND: { age: { _avg: { gte: 18 } } } },
    });
    expect(asObject.issues).toBeUndefined();
  });

  test("runtime: accepts NOT as an array and as a bare object", () => {
    const asArray = parse(schema, {
      by: "active",
      having: { NOT: [{ age: { _avg: { gte: 18 } } }] },
    });
    expect(asArray.issues).toBeUndefined();

    const asObject = parse(schema, {
      by: "active",
      having: { NOT: { age: { _avg: { gte: 18 } } } },
    });
    expect(asObject.issues).toBeUndefined();
  });

  test("runtime: accepts AND nested inside OR (recursion)", () => {
    const result = parse(schema, {
      by: "active",
      having: {
        OR: [
          {
            AND: [
              { age: { _avg: { gte: 18 } } },
              { name: { _count: { gt: 2 } } },
            ],
          },
          { NOT: { age: { _min: { equals: null } } } },
        ],
      },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects OR that is not an array", () => {
    const result = parse(schema, {
      by: "active",
      having: { OR: { age: { _avg: { gte: 18 } } } },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: rejects an unknown key inside an OR arm", () => {
    const result = parse(schema, {
      by: "active",
      having: { OR: [{ nope: { _avg: { gte: 18 } } }] },
    });
    expect(result.issues).toBeDefined();
  });

  test("runtime: scalar entries still validate alongside combinators", () => {
    const result = parse(schema, {
      by: "active",
      having: { nope: { _count: { gt: 1 } } },
    });
    expect(result.issues).toBeDefined();
  });

  test("output: preserves the combinator tree", () => {
    const result = parse(schema, {
      by: "active",
      having: {
        OR: [{ age: { _avg: { gte: 18 } } }, { name: { _count: { gt: 2 } } }],
        NOT: { age: { _max: { lt: 99 } } },
      },
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.having).toEqual({
        OR: [{ age: { _avg: { gte: 18 } } }, { name: { _count: { gt: 2 } } }],
        NOT: { age: { _max: { lt: 99 } } },
      });
    }
  });
});
