/**
 * BigInt Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all bigint field variants:
 * - Raw (required)
 * - Nullable (with default null)
 * - List (array)
 * - Nullable List (nullable array)
 *
 * For each variant, tests:
 * - base: The element/field type
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + shorthand transforms
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import {
  parse,
  pipe,
  bigint,
  minValue,
  maxValue,
  brand,
  InferOutput,
  Brand,
} from "valibot";
import { bigInt } from "../../src/schema/fields/bigint/field";
import type { InferBigIntInput } from "../../src/schema/fields/bigint/schemas";

// =============================================================================
// RAW BIGINT FIELD (required, no modifiers)
// =============================================================================

describe("Raw BigInt Field", () => {
  const field = bigInt();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is bigint", () => {
      type Base = InferBigIntInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<bigint>();
    });

    test("runtime: parses bigint", () => {
      expect(parse(schemas.base, 42n)).toBe(42n);
      expect(parse(schemas.base, 0n)).toBe(0n);
      expect(parse(schemas.base, -100n)).toBe(-100n);
    });

    test("runtime: parses large bigint", () => {
      const largeValue = 9007199254740993n; // Larger than Number.MAX_SAFE_INTEGER
      expect(parse(schemas.base, largeValue)).toBe(largeValue);
    });

    test("runtime: rejects number", () => {
      expect(() => parse(schemas.base, 42)).toThrow();
    });

    test("runtime: rejects non-bigint", () => {
      expect(() => parse(schemas.base, "42")).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
      expect(() => parse(schemas.base, true)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required bigint", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<bigint>();
    });

    test("runtime: accepts bigint", () => {
      expect(parse(schemas.create, 123n)).toBe(123n);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });

    test("runtime: rejects null", () => {
      expect(() => parse(schemas.create, null)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts bigint shorthand", () => {
      type Update = InferBigIntInput<State, "update">;
      expectTypeOf<bigint>().toExtend<Update>();
    });

    test("type: update accepts arithmetic operations", () => {
      type Update = InferBigIntInput<State, "update">;
      expectTypeOf<{ set: bigint }>().toExtend<Update>();
      expectTypeOf<{ increment: bigint }>().toExtend<Update>();
      expectTypeOf<{ decrement: bigint }>().toExtend<Update>();
      expectTypeOf<{ multiply: bigint }>().toExtend<Update>();
      expectTypeOf<{ divide: bigint }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      expect(parse(schemas.update, 99n)).toEqual({ set: 99n });
      expect(parse(schemas.update, 0n)).toEqual({ set: 0n });
      expect(parse(schemas.update, -5n)).toEqual({ set: -5n });
    });

    test("runtime: set operation passes through", () => {
      expect(parse(schemas.update, { set: 42n })).toEqual({ set: 42n });
    });

    test("runtime: increment operation passes through", () => {
      expect(parse(schemas.update, { increment: 5n })).toEqual({
        increment: 5n,
      });
    });

    test("runtime: decrement operation passes through", () => {
      expect(parse(schemas.update, { decrement: 3n })).toEqual({
        decrement: 3n,
      });
    });

    test("runtime: multiply operation passes through", () => {
      expect(parse(schemas.update, { multiply: 2n })).toEqual({ multiply: 2n });
    });

    test("runtime: divide operation passes through", () => {
      expect(parse(schemas.update, { divide: 4n })).toEqual({ divide: 4n });
    });
  });

  describe("filter", () => {
    test("type: filter accepts bigint shorthand", () => {
      type Filter = InferBigIntInput<State, "filter">;
      expectTypeOf<bigint>().toExtend<Filter>();
    });

    test("type: filter accepts comparison operations", () => {
      type Filter = InferBigIntInput<State, "filter">;
      expectTypeOf<{ equals: bigint }>().toExtend<Filter>();
      expectTypeOf<{ in: bigint[] }>().toExtend<Filter>();
      expectTypeOf<{ notIn: bigint[] }>().toExtend<Filter>();
      expectTypeOf<{ lt: bigint }>().toExtend<Filter>();
      expectTypeOf<{ lte: bigint }>().toExtend<Filter>();
      expectTypeOf<{ gt: bigint }>().toExtend<Filter>();
      expectTypeOf<{ gte: bigint }>().toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      expect(parse(schemas.filter, 50n)).toEqual({ equals: 50n });
      expect(parse(schemas.filter, 0n)).toEqual({ equals: 0n });
    });

    test("runtime: equals filter passes through", () => {
      expect(parse(schemas.filter, { equals: 42n })).toEqual({ equals: 42n });
    });

    test("runtime: in filter passes through", () => {
      expect(parse(schemas.filter, { in: [1n, 2n, 3n] })).toEqual({
        in: [1n, 2n, 3n],
      });
    });

    test("runtime: notIn filter passes through", () => {
      expect(parse(schemas.filter, { notIn: [4n, 5n, 6n] })).toEqual({
        notIn: [4n, 5n, 6n],
      });
    });

    test("runtime: comparison filters pass through", () => {
      expect(parse(schemas.filter, { lt: 100n })).toEqual({ lt: 100n });
      expect(parse(schemas.filter, { lte: 100n })).toEqual({ lte: 100n });
      expect(parse(schemas.filter, { gt: 0n })).toEqual({ gt: 0n });
      expect(parse(schemas.filter, { gte: 0n })).toEqual({ gte: 0n });
    });

    test("runtime: not filter with shorthand", () => {
      expect(parse(schemas.filter, { not: 42n })).toEqual({
        not: { equals: 42n },
      });
    });

    test("runtime: not filter with object", () => {
      expect(parse(schemas.filter, { not: { gt: 10n } })).toEqual({
        not: { gt: 10n },
      });
    });
  });
});

// =============================================================================
// NULLABLE BIGINT FIELD
// =============================================================================

describe("Nullable BigInt Field", () => {
  const field = bigInt().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is bigint | null", () => {
      type Base = InferBigIntInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<bigint | null>();
    });

    test("runtime: parses bigint", () => {
      expect(parse(schemas.base, 42n)).toBe(42n);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<bigint | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts bigint", () => {
      expect(parse(schemas.create, 123n)).toBe(123n);
    });

    test("runtime: accepts null", () => {
      expect(parse(schemas.create, null)).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
    });
  });

  describe("update", () => {
    test("type: update accepts null", () => {
      type Update = InferBigIntInput<State, "update">;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: bigint | null }>().toExtend<Update>();
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: arithmetic operations still use non-null base", () => {
      expect(parse(schemas.update, { increment: 5n })).toEqual({
        increment: 5n,
      });
      expect(parse(schemas.update, { decrement: 3n })).toEqual({
        decrement: 3n,
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBigIntInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });
  });
});

// =============================================================================
// LIST BIGINT FIELD (array)
// =============================================================================

describe("List BigInt Field", () => {
  const field = bigInt().array();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is bigint[]", () => {
      type Base = InferBigIntInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<bigint[]>();
    });

    test("runtime: parses array of bigints", () => {
      expect(parse(schemas.base, [1n, 2n, 3n])).toEqual([1n, 2n, 3n]);
    });

    test("runtime: parses empty array", () => {
      expect(parse(schemas.base, [])).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(() => parse(schemas.base, 42n)).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required bigint[]", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<bigint[]>();
    });

    test("runtime: accepts array", () => {
      expect(parse(schemas.create, [1n, 2n, 3n])).toEqual([1n, 2n, 3n]);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts array operations", () => {
      type Update = InferBigIntInput<State, "update">;
      expectTypeOf<{ set: bigint[] }>().toExtend<Update>();
      expectTypeOf<{ push: bigint }>().toExtend<Update>();
      expectTypeOf<{ push: bigint[] }>().toExtend<Update>();
      expectTypeOf<{ unshift: bigint }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, [1n, 2n, 3n])).toEqual({
        set: [1n, 2n, 3n],
      });
    });

    test("runtime: set operation passes through", () => {
      expect(parse(schemas.update, { set: [4n, 5n, 6n] })).toEqual({
        set: [4n, 5n, 6n],
      });
    });

    test("runtime: push single element", () => {
      expect(parse(schemas.update, { push: 7n })).toEqual({ push: 7n });
    });

    test("runtime: push array of elements", () => {
      expect(parse(schemas.update, { push: [8n, 9n] })).toEqual({
        push: [8n, 9n],
      });
    });

    test("runtime: unshift operation", () => {
      expect(parse(schemas.update, { unshift: 0n })).toEqual({ unshift: 0n });
    });
  });

  describe("filter", () => {
    test("type: filter accepts array filters", () => {
      type Filter = InferBigIntInput<State, "filter">;
      expectTypeOf<{ has: bigint }>().toExtend<Filter>();
      expectTypeOf<{ hasEvery: bigint[] }>().toExtend<Filter>();
      expectTypeOf<{ hasSome: bigint[] }>().toExtend<Filter>();
      expectTypeOf<{ isEmpty: boolean }>().toExtend<Filter>();
      expectTypeOf<{ equals: bigint[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      expect(parse(schemas.filter, [1n, 2n, 3n])).toEqual({
        equals: [1n, 2n, 3n],
      });
    });

    test("runtime: has filter passes through", () => {
      expect(parse(schemas.filter, { has: 5n })).toEqual({ has: 5n });
    });

    test("runtime: hasEvery filter passes through", () => {
      expect(parse(schemas.filter, { hasEvery: [1n, 2n] })).toEqual({
        hasEvery: [1n, 2n],
      });
    });

    test("runtime: hasSome filter passes through", () => {
      expect(parse(schemas.filter, { hasSome: [3n, 4n] })).toEqual({
        hasSome: [3n, 4n],
      });
    });

    test("runtime: isEmpty filter passes through", () => {
      expect(parse(schemas.filter, { isEmpty: true })).toEqual({
        isEmpty: true,
      });
    });
  });
});

// =============================================================================
// NULLABLE LIST BIGINT FIELD (nullable array)
// =============================================================================

describe("Nullable List BigInt Field", () => {
  const field = bigInt().array().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is bigint[] | null", () => {
      type Base = InferBigIntInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<bigint[] | null>();
    });

    test("runtime: parses array of bigints", () => {
      expect(parse(schemas.base, [1n, 2n, 3n])).toEqual([1n, 2n, 3n]);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<bigint[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts array", () => {
      expect(parse(schemas.create, [1n, 2n, 3n])).toEqual([1n, 2n, 3n]);
    });

    test("runtime: accepts null", () => {
      expect(parse(schemas.create, null)).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
    });
  });

  describe("update", () => {
    test("type: update accepts null and array operations", () => {
      type Update = InferBigIntInput<State, "update">;
      expectTypeOf<{ set: bigint[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: bigint }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, [1n, 2n, 3n])).toEqual({
        set: [1n, 2n, 3n],
      });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: set null passes through", () => {
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBigIntInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });
  });
});

// =============================================================================
// INCREMENT (AUTO-GENERATION)
// =============================================================================

describe("Increment BigInt Field", () => {
  const field = bigInt().increment();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  test("state: hasDefault is true", () => {
    expect(field["~"].state.hasDefault).toBe(true);
  });

  test("state: autoGenerate is increment", () => {
    expect(field["~"].state.autoGenerate).toBe("increment");
  });

  test("type: create is optional", () => {
    type Create = InferBigIntInput<State, "create">;
    expectTypeOf<bigint | undefined>().toExtend<Create>();
  });

  test("runtime: undefined uses default", () => {
    expect(parse(schemas.create, undefined)).toBe(0n);
  });

  test("runtime: accepts explicit value", () => {
    expect(parse(schemas.create, 100n)).toBe(100n);
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const field = bigInt().default(42n);
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<bigint | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      expect(parse(schemas.create, 100n)).toBe(100n);
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toBe(42n);
    });
  });

  describe("function default value", () => {
    let callCount = 0n;
    const field = bigInt().default(() => {
      callCount++;
      return callCount * 10n;
    });
    const schemas = field["~"].schemas;

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      expect(result).toBe((before + 1n) * 10n);
    });
  });
});

// =============================================================================
// CUSTOM SCHEMA VALIDATION
// =============================================================================

describe("Custom Schema Validation", () => {
  describe("min/max validation", () => {
    const positiveBigInt = pipe(bigint(), minValue(1n), maxValue(1000n));
    const field = bigInt().schema(positiveBigInt);
    const schemas = field["~"].schemas;

    test("runtime: accepts valid value in range", () => {
      expect(parse(schemas.base, 50n)).toBe(50n);
      expect(parse(schemas.base, 1n)).toBe(1n);
      expect(parse(schemas.base, 1000n)).toBe(1000n);
    });

    test("runtime: rejects value below min", () => {
      expect(() => parse(schemas.base, 0n)).toThrow();
      expect(() => parse(schemas.base, -5n)).toThrow();
    });

    test("runtime: rejects value above max", () => {
      expect(() => parse(schemas.base, 1001n)).toThrow();
      expect(() => parse(schemas.base, 10000n)).toThrow();
    });

    test("runtime: create validates against custom schema", () => {
      expect(parse(schemas.create, 50n)).toBe(50n);
      expect(() => parse(schemas.create, 0n)).toThrow();
      expect(() => parse(schemas.create, 1001n)).toThrow();
    });

    test("runtime: update validates against custom schema", () => {
      expect(parse(schemas.update, 50n)).toEqual({ set: 50n });
      expect(() => parse(schemas.update, 0n)).toThrow();
    });
  });

  describe("branded type preservation", () => {
    const userIdSchema = pipe(bigint(), minValue(1n), brand("UserId"));
    const field = bigInt().schema(userIdSchema);
    type BrandedOutput = InferOutput<(typeof field)["~"]["schemas"]["base"]>;

    test("type: base output preserves brand", () => {
      // Brand is on output type
      expectTypeOf<BrandedOutput>().toExtend<bigint & Brand<"UserId">>();
    });

    test("runtime: validates and returns branded value", () => {
      const result = parse(field["~"].schemas.base, 123n);
      expect(result).toBe(123n);
    });
  });
});

