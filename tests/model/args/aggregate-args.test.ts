/**
 * Aggregate Args Schema Tests
 *
 * Tests the args schemas for aggregate operations:
 * - count
 * - aggregate
 * - groupBy
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { simpleSchemas, authorSchemas, type SimpleState } from "../fixtures";
import type {
  CountArgsInput,
  AggregateArgsInput,
  GroupByArgsInput,
} from "../../../src/schema/model/schemas/args";
import { parse } from "../../../src/validation";

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

  test("runtime: accepts with cursor", () => {
    const result = parse(schema, {
      cursor: { id: "user-123" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts all options", () => {
    const result = parse(schema, {
      where: { active: true },
      cursor: { id: "user-123" },
      take: 100,
      skip: 10,
    });
    expect(result.issues).toBeUndefined();
  });

  test("output: preserves count args correctly (with normalization)", () => {
    const result = parse(schema, {
      where: { active: true },
      take: 100,
      skip: 10,
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      // Filter values are normalized to { equals: value }
      expect(result.value.where).toEqual({ active: { equals: true } });
      expect(result.value.take).toBe(100);
      expect(result.value.skip).toBe(10);
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
      having: { age: { gte: 18 } },
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
      having: { active: true },
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

  test("output: preserves all groupBy options correctly (with normalization)", () => {
    const result = parse(schema, {
      by: ["active"],
      where: { age: { gte: 18 } },
      having: { active: true },
      orderBy: { active: "asc" },
      take: 10,
      skip: 5,
      _count: true,
    });
    expect(result.issues).toBeUndefined();
    if (!result.issues) {
      expect(result.value.by).toEqual(["active"]);
      // Filter values in where/having are preserved (gte is already an operator)
      expect(result.value.where).toEqual({ age: { gte: 18 } });
      // having with boolean is normalized
      expect(result.value.having).toEqual({ active: { equals: true } });
      expect(result.value.orderBy).toEqual({ active: "asc" });
      expect(result.value.take).toBe(10);
      expect(result.value.skip).toBe(5);
      expect(result.value._count).toBe(true);
    }
  });
});
