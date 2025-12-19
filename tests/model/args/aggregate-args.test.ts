/**
 * Aggregate Args Schema Tests
 *
 * Tests the args schemas for aggregate operations:
 * - count
 * - aggregate
 * - groupBy
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, safeParse } from "valibot";
import { simpleSchemas, authorSchemas, type SimpleState } from "../fixtures";
import type {
  CountArgsInput,
  AggregateArgsInput,
  GroupByArgsInput,
} from "../../../src/schema/model/schemas/args";

// =============================================================================
// COUNT ARGS
// =============================================================================

describe("Count Args - Types", () => {
  type Input = CountArgsInput<SimpleState>;

  test("type: has optional where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional cursor", () => {
    expectTypeOf<Input>().toHaveProperty("cursor");
  });

  test("type: has optional take", () => {
    expectTypeOf<Input>().toHaveProperty("take");
  });

  test("type: has optional skip", () => {
    expectTypeOf<Input>().toHaveProperty("skip");
  });
});

describe("Count Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.count;

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
      take: 100,
      skip: 10,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with cursor", () => {
    const result = safeParse(schema, {
      cursor: { id: "user-123" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts all options", () => {
    const result = safeParse(schema, {
      where: { active: true },
      cursor: { id: "user-123" },
      take: 100,
      skip: 10,
    });
    expect(result.success).toBe(true);
  });

  test("output: preserves count args correctly (with normalization)", () => {
    const result = safeParse(schema, {
      where: { active: true },
      take: 100,
      skip: 10,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Filter values are normalized to { equals: value }
      expect(result.output.where).toEqual({ active: { equals: true } });
      expect(result.output.take).toBe(100);
      expect(result.output.skip).toBe(10);
    }
  });
});

// =============================================================================
// AGGREGATE ARGS
// =============================================================================

describe("Aggregate Args - Types", () => {
  type Input = AggregateArgsInput<SimpleState>;

  test("type: has optional where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional orderBy", () => {
    expectTypeOf<Input>().toHaveProperty("orderBy");
  });

  test("type: has optional _count", () => {
    expectTypeOf<Input>().toHaveProperty("_count");
  });
});

describe("Aggregate Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.aggregate;

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

  test("runtime: accepts with _count true", () => {
    const result = safeParse(schema, {
      _count: true,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with _count select", () => {
    const result = safeParse(schema, {
      _count: { id: true, name: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with _avg", () => {
    const result = safeParse(schema, {
      _avg: { age: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with _sum", () => {
    const result = safeParse(schema, {
      _sum: { age: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with _min and _max", () => {
    const result = safeParse(schema, {
      _min: { age: true },
      _max: { age: true },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with orderBy", () => {
    const result = safeParse(schema, {
      orderBy: { name: "asc" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with take and skip", () => {
    const result = safeParse(schema, {
      take: 10,
      skip: 5,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts all aggregate options", () => {
    const result = safeParse(schema, {
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
    expect(result.success).toBe(true);
  });

  test("output: preserves aggregate options correctly (with normalization)", () => {
    const result = safeParse(schema, {
      where: { active: true },
      _count: true,
      _avg: { age: true },
      _sum: { age: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Filter values are normalized to { equals: value }
      expect(result.output.where).toEqual({ active: { equals: true } });
      expect(result.output._count).toBe(true);
      expect(result.output._avg).toEqual({ age: true });
      expect(result.output._sum).toEqual({ age: true });
    }
  });

  test("output: preserves _count as select object", () => {
    const result = safeParse(schema, {
      _count: { id: true, name: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output._count).toEqual({ id: true, name: true });
    }
  });
});

// =============================================================================
// GROUP BY ARGS
// =============================================================================

describe("GroupBy Args - Types", () => {
  type Input = GroupByArgsInput<SimpleState>;

  test("type: has required by", () => {
    expectTypeOf<Input>().toHaveProperty("by");
  });

  test("type: has optional where", () => {
    expectTypeOf<Input>().toHaveProperty("where");
  });

  test("type: has optional having", () => {
    expectTypeOf<Input>().toHaveProperty("having");
  });
});

describe("GroupBy Args - Simple Model Runtime", () => {
  const schema = simpleSchemas.args.groupBy;

  test("runtime: accepts with by as string", () => {
    const result = safeParse(schema, {
      by: "active",
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with by as array", () => {
    const result = safeParse(schema, {
      by: ["active", "name"],
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with where", () => {
    const result = safeParse(schema, {
      by: "active",
      where: { age: { gte: 18 } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with having", () => {
    const result = safeParse(schema, {
      by: "active",
      having: { age: { gte: 18 } },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with orderBy", () => {
    const result = safeParse(schema, {
      by: "active",
      orderBy: { active: "asc" },
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with _count", () => {
    const result = safeParse(schema, {
      by: "active",
      _count: true,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts with take and skip", () => {
    const result = safeParse(schema, {
      by: "active",
      take: 10,
      skip: 0,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: accepts all groupBy options", () => {
    const result = safeParse(schema, {
      by: ["active", "name"],
      where: { age: { gte: 18 } },
      having: { active: true },
      orderBy: { active: "asc" },
      take: 10,
      skip: 0,
      _count: true,
    });
    expect(result.success).toBe(true);
  });

  test("runtime: rejects missing by", () => {
    const result = safeParse(schema, {
      where: { active: true },
    });
    expect(result.success).toBe(false);
  });

  test("output: preserves by as string", () => {
    const result = safeParse(schema, {
      by: "active",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.by).toBe("active");
    }
  });

  test("output: preserves by as array", () => {
    const result = safeParse(schema, {
      by: ["active", "name"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.by).toEqual(["active", "name"]);
      expect(Array.isArray(result.output.by)).toBe(true);
    }
  });

  test("output: preserves all groupBy options correctly (with normalization)", () => {
    const result = safeParse(schema, {
      by: ["active"],
      where: { age: { gte: 18 } },
      having: { active: true },
      orderBy: { active: "asc" },
      take: 10,
      skip: 5,
      _count: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.by).toEqual(["active"]);
      // Filter values in where/having are preserved (gte is already an operator)
      expect(result.output.where).toEqual({ age: { gte: 18 } });
      // having with boolean is normalized
      expect(result.output.having).toEqual({ active: { equals: true } });
      expect(result.output.orderBy).toEqual({ active: "asc" });
      expect(result.output.take).toBe(10);
      expect(result.output.skip).toBe(5);
      expect(result.output._count).toBe(true);
    }
  });
});
