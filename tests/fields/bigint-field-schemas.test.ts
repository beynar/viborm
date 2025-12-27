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
  pipe,
  bigint,
  minValue,
  maxValue,
  brand,
  Brand,
} from "valibot";
import { parse, InferOutput } from "../../src/validation";
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
      const r1 = parse(schemas.base, 42n);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toBe(42n);

      const r2 = parse(schemas.base, 0n);
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toBe(0n);

      const r3 = parse(schemas.base, -100n);
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toBe(-100n);
    });

    test("runtime: parses large bigint", () => {
      const largeValue = 9007199254740993n; // Larger than Number.MAX_SAFE_INTEGER
      const result = parse(schemas.base, largeValue);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(largeValue);
    });

    test("runtime: rejects number", () => {
      expect(parse(schemas.base, 42).issues).toBeDefined();
    });

    test("runtime: rejects non-bigint", () => {
      expect(parse(schemas.base, "42").issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
      expect(parse(schemas.base, true).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required bigint", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<bigint>();
    });

    test("runtime: accepts bigint", () => {
      const result = parse(schemas.create, 123n);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(123n);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(parse(schemas.create, undefined).issues).toBeDefined();
    });

    test("runtime: rejects null", () => {
      expect(parse(schemas.create, null).issues).toBeDefined();
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
      const r1 = parse(schemas.update, 99n);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ set: 99n });

      const r2 = parse(schemas.update, 0n);
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ set: 0n });

      const r3 = parse(schemas.update, -5n);
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toEqual({ set: -5n });
    });

    test("runtime: set operation passes through", () => {
      const result = parse(schemas.update, { set: 42n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: 42n });
    });

    test("runtime: increment operation passes through", () => {
      const result = parse(schemas.update, { increment: 5n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ increment: 5n });
    });

    test("runtime: decrement operation passes through", () => {
      const result = parse(schemas.update, { decrement: 3n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ decrement: 3n });
    });

    test("runtime: multiply operation passes through", () => {
      const result = parse(schemas.update, { multiply: 2n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ multiply: 2n });
    });

    test("runtime: divide operation passes through", () => {
      const result = parse(schemas.update, { divide: 4n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ divide: 4n });
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
      const r1 = parse(schemas.filter, 50n);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ equals: 50n });

      const r2 = parse(schemas.filter, 0n);
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ equals: 0n });
    });

    test("runtime: equals filter passes through", () => {
      const result = parse(schemas.filter, { equals: 42n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: 42n });
    });

    test("runtime: in filter passes through", () => {
      const result = parse(schemas.filter, { in: [1n, 2n, 3n] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ in: [1n, 2n, 3n] });
    });

    test("runtime: notIn filter passes through", () => {
      const result = parse(schemas.filter, { notIn: [4n, 5n, 6n] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ notIn: [4n, 5n, 6n] });
    });

    test("runtime: comparison filters pass through", () => {
      const r1 = parse(schemas.filter, { lt: 100n });
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ lt: 100n });

      const r2 = parse(schemas.filter, { lte: 100n });
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ lte: 100n });

      const r3 = parse(schemas.filter, { gt: 0n });
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toEqual({ gt: 0n });

      const r4 = parse(schemas.filter, { gte: 0n });
      if (r4.issues) throw new Error("Expected success");
      expect(r4.value).toEqual({ gte: 0n });
    });

    test("runtime: not filter with shorthand", () => {
      const result = parse(schemas.filter, { not: 42n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: 42n } });
    });

    test("runtime: not filter with object", () => {
      const result = parse(schemas.filter, { not: { gt: 10n } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { gt: 10n } });
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
      const result = parse(schemas.base, 42n);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(42n);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<bigint | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts bigint", () => {
      const result = parse(schemas.create, 123n);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(123n);
    });

    test("runtime: accepts null", () => {
      const result = parse(schemas.create, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("update", () => {
    test("type: update accepts null", () => {
      type Update = InferBigIntInput<State, "update">;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: bigint | null }>().toExtend<Update>();
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: arithmetic operations still use non-null base", () => {
      const r1 = parse(schemas.update, { increment: 5n });
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ increment: 5n });

      const r2 = parse(schemas.update, { decrement: 3n });
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ decrement: 3n });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBigIntInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      const result = parse(schemas.filter, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
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
      const result = parse(schemas.base, [1n, 2n, 3n]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([1n, 2n, 3n]);
    });

    test("runtime: parses empty array", () => {
      const result = parse(schemas.base, []);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(parse(schemas.base, 42n).issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required bigint[]", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<bigint[]>();
    });

    test("runtime: accepts array", () => {
      const result = parse(schemas.create, [1n, 2n, 3n]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([1n, 2n, 3n]);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(parse(schemas.create, undefined).issues).toBeDefined();
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
      const result = parse(schemas.update, [1n, 2n, 3n]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [1n, 2n, 3n] });
    });

    test("runtime: set operation passes through", () => {
      const result = parse(schemas.update, { set: [4n, 5n, 6n] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [4n, 5n, 6n] });
    });

    test("runtime: push single element (coerced to array)", () => {
      const result = parse(schemas.update, { push: 7n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [7n] });
    });

    test("runtime: push array of elements", () => {
      const result = parse(schemas.update, { push: [8n, 9n] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [8n, 9n] });
    });

    test("runtime: unshift operation (coerced to array)", () => {
      const result = parse(schemas.update, { unshift: 0n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ unshift: [0n] });
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
      const result = parse(schemas.filter, [1n, 2n, 3n]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: [1n, 2n, 3n] });
    });

    test("runtime: has filter passes through", () => {
      const result = parse(schemas.filter, { has: 5n });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ has: 5n });
    });

    test("runtime: hasEvery filter passes through", () => {
      const result = parse(schemas.filter, { hasEvery: [1n, 2n] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ hasEvery: [1n, 2n] });
    });

    test("runtime: hasSome filter passes through", () => {
      const result = parse(schemas.filter, { hasSome: [3n, 4n] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ hasSome: [3n, 4n] });
    });

    test("runtime: isEmpty filter passes through", () => {
      const result = parse(schemas.filter, { isEmpty: true });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ isEmpty: true });
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
      const result = parse(schemas.base, [1n, 2n, 3n]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([1n, 2n, 3n]);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBigIntInput<State, "create">;
      expectTypeOf<bigint[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts array", () => {
      const result = parse(schemas.create, [1n, 2n, 3n]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([1n, 2n, 3n]);
    });

    test("runtime: accepts null", () => {
      const result = parse(schemas.create, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("update", () => {
    test("type: update accepts null and array operations", () => {
      type Update = InferBigIntInput<State, "update">;
      expectTypeOf<{ set: bigint[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: bigint }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      const result = parse(schemas.update, [1n, 2n, 3n]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [1n, 2n, 3n] });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: set null passes through", () => {
      const result = parse(schemas.update, { set: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBigIntInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      const result = parse(schemas.filter, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
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
    const result = parse(schemas.create, undefined);
    if (result.issues) throw new Error("Expected success");
    expect(result.value).toBe(0n);
  });

  test("runtime: accepts explicit value", () => {
    const result = parse(schemas.create, 100n);
    if (result.issues) throw new Error("Expected success");
    expect(result.value).toBe(100n);
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
      const result = parse(schemas.create, 100n);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(100n);
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(42n);
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe((before + 1n) * 10n);
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
      const r1 = parse(schemas.base, 50n);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toBe(50n);

      const r2 = parse(schemas.base, 1n);
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toBe(1n);

      const r3 = parse(schemas.base, 1000n);
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toBe(1000n);
    });

    test("runtime: rejects value below min", () => {
      expect(parse(schemas.base, 0n).issues).toBeDefined();
      expect(parse(schemas.base, -5n).issues).toBeDefined();
    });

    test("runtime: rejects value above max", () => {
      expect(parse(schemas.base, 1001n).issues).toBeDefined();
      expect(parse(schemas.base, 10000n).issues).toBeDefined();
    });

    test("runtime: create validates against custom schema", () => {
      const r1 = parse(schemas.create, 50n);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toBe(50n);

      expect(parse(schemas.create, 0n).issues).toBeDefined();
      expect(parse(schemas.create, 1001n).issues).toBeDefined();
    });

    test("runtime: update validates against custom schema", () => {
      const r1 = parse(schemas.update, 50n);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ set: 50n });

      expect(parse(schemas.update, 0n).issues).toBeDefined();
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(123n);
    });
  });
});
