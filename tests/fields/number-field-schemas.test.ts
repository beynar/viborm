/**
 * Number Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all number field variants:
 * - Int (integer numbers)
 * - Float (floating-point numbers)
 * - Decimal (decimal numbers, same as float at runtime)
 *
 * For each number type, tests these variants:
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
  number,
  minValue,
  maxValue,
  brand,
  integer,
  InferOutput,
  Brand,
} from "valibot";
import { int, float, decimal } from "../../src/schema/fields/number/field";
import type {
  InferIntInput,
  InferFloatInput,
  InferDecimalInput,
} from "../../src/schema/fields/number/schemas";

// =============================================================================
// INT FIELD TESTS
// =============================================================================

describe("Int Field", () => {
  // ===========================================================================
  // RAW INT FIELD (required, no modifiers)
  // ===========================================================================

  describe("Raw Int Field", () => {
    const field = int();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number", () => {
        type Base = InferIntInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number>();
      });

      test("runtime: parses integer", () => {
        expect(parse(schemas.base, 42)).toBe(42);
        expect(parse(schemas.base, 0)).toBe(0);
        expect(parse(schemas.base, -100)).toBe(-100);
      });

      test("runtime: rejects float (not integer)", () => {
        expect(() => parse(schemas.base, 3.14)).toThrow();
        expect(() => parse(schemas.base, 0.1)).toThrow();
      });

      test("runtime: rejects non-number", () => {
        expect(() => parse(schemas.base, "42")).toThrow();
        expect(() => parse(schemas.base, null)).toThrow();
        expect(() => parse(schemas.base, true)).toThrow();
      });
    });

    describe("create", () => {
      test("type: create is required number", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number>();
      });

      test("runtime: accepts integer", () => {
        expect(parse(schemas.create, 123)).toBe(123);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(() => parse(schemas.create, undefined)).toThrow();
      });

      test("runtime: rejects null", () => {
        expect(() => parse(schemas.create, null)).toThrow();
      });
    });

    describe("update", () => {
      test("type: update accepts number shorthand", () => {
        type Update = InferIntInput<State, "update">;
        expectTypeOf<number>().toExtend<Update>();
      });

      test("type: update accepts arithmetic operations", () => {
        type Update = InferIntInput<State, "update">;
        expectTypeOf<{ set: number }>().toExtend<Update>();
        expectTypeOf<{ increment: number }>().toExtend<Update>();
        expectTypeOf<{ decrement: number }>().toExtend<Update>();
        expectTypeOf<{ multiply: number }>().toExtend<Update>();
        expectTypeOf<{ divide: number }>().toExtend<Update>();
      });

      test("runtime: shorthand transforms to { set: value }", () => {
        expect(parse(schemas.update, 99)).toEqual({ set: 99 });
        expect(parse(schemas.update, 0)).toEqual({ set: 0 });
        expect(parse(schemas.update, -5)).toEqual({ set: -5 });
      });

      test("runtime: set operation passes through", () => {
        expect(parse(schemas.update, { set: 42 })).toEqual({ set: 42 });
      });

      test("runtime: increment operation passes through", () => {
        expect(parse(schemas.update, { increment: 5 })).toEqual({
          increment: 5,
        });
      });

      test("runtime: decrement operation passes through", () => {
        expect(parse(schemas.update, { decrement: 3 })).toEqual({
          decrement: 3,
        });
      });

      test("runtime: multiply operation passes through", () => {
        expect(parse(schemas.update, { multiply: 2 })).toEqual({ multiply: 2 });
      });

      test("runtime: divide operation passes through", () => {
        expect(parse(schemas.update, { divide: 4 })).toEqual({ divide: 4 });
      });
    });

    describe("filter", () => {
      test("type: filter accepts number shorthand", () => {
        type Filter = InferIntInput<State, "filter">;
        expectTypeOf<number>().toExtend<Filter>();
      });

      test("type: filter accepts comparison operations", () => {
        type Filter = InferIntInput<State, "filter">;
        expectTypeOf<{ equals: number }>().toExtend<Filter>();
        expectTypeOf<{ in: number[] }>().toExtend<Filter>();
        expectTypeOf<{ notIn: number[] }>().toExtend<Filter>();
        expectTypeOf<{ lt: number }>().toExtend<Filter>();
        expectTypeOf<{ lte: number }>().toExtend<Filter>();
        expectTypeOf<{ gt: number }>().toExtend<Filter>();
        expectTypeOf<{ gte: number }>().toExtend<Filter>();
      });

      test("runtime: shorthand transforms to { equals: value }", () => {
        expect(parse(schemas.filter, 50)).toEqual({ equals: 50 });
        expect(parse(schemas.filter, 0)).toEqual({ equals: 0 });
      });

      test("runtime: equals filter passes through", () => {
        expect(parse(schemas.filter, { equals: 42 })).toEqual({ equals: 42 });
      });

      test("runtime: in filter passes through", () => {
        expect(parse(schemas.filter, { in: [1, 2, 3] })).toEqual({
          in: [1, 2, 3],
        });
      });

      test("runtime: notIn filter passes through", () => {
        expect(parse(schemas.filter, { notIn: [4, 5, 6] })).toEqual({
          notIn: [4, 5, 6],
        });
      });

      test("runtime: comparison filters pass through", () => {
        expect(parse(schemas.filter, { lt: 100 })).toEqual({ lt: 100 });
        expect(parse(schemas.filter, { lte: 100 })).toEqual({ lte: 100 });
        expect(parse(schemas.filter, { gt: 0 })).toEqual({ gt: 0 });
        expect(parse(schemas.filter, { gte: 0 })).toEqual({ gte: 0 });
      });

      test("runtime: not filter with shorthand", () => {
        expect(parse(schemas.filter, { not: 42 })).toEqual({
          not: { equals: 42 },
        });
      });

      test("runtime: not filter with object", () => {
        expect(parse(schemas.filter, { not: { gt: 10 } })).toEqual({
          not: { gt: 10 },
        });
      });
    });
  });

  // ===========================================================================
  // NULLABLE INT FIELD
  // ===========================================================================

  describe("Nullable Int Field", () => {
    const field = int().nullable();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number | null", () => {
        type Base = InferIntInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number | null>();
      });

      test("runtime: parses integer", () => {
        expect(parse(schemas.base, 42)).toBe(42);
      });

      test("runtime: parses null", () => {
        expect(parse(schemas.base, null)).toBe(null);
      });
    });

    describe("create", () => {
      test("type: create is optional (has default null)", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<number | null | undefined>().toExtend<Create>();
      });

      test("runtime: accepts integer", () => {
        expect(parse(schemas.create, 123)).toBe(123);
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
        type Update = InferIntInput<State, "update">;
        expectTypeOf<null>().toExtend<Update>();
        expectTypeOf<{ set: number | null }>().toExtend<Update>();
      });

      test("runtime: shorthand null transforms to { set: null }", () => {
        expect(parse(schemas.update, null)).toEqual({ set: null });
      });

      test("runtime: arithmetic operations still use non-null base", () => {
        expect(parse(schemas.update, { increment: 5 })).toEqual({
          increment: 5,
        });
        expect(parse(schemas.update, { decrement: 3 })).toEqual({
          decrement: 3,
        });
      });
    });

    describe("filter", () => {
      test("type: filter accepts null", () => {
        type Filter = InferIntInput<State, "filter">;
        expectTypeOf<null>().toExtend<Filter>();
        expectTypeOf<{ equals: null }>().toExtend<Filter>();
      });

      test("runtime: shorthand null transforms to { equals: null }", () => {
        expect(parse(schemas.filter, null)).toEqual({ equals: null });
      });
    });
  });

  // ===========================================================================
  // LIST INT FIELD (array)
  // ===========================================================================

  describe("List Int Field", () => {
    const field = int().array();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number[]", () => {
        type Base = InferIntInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number[]>();
      });

      test("runtime: parses array of integers", () => {
        expect(parse(schemas.base, [1, 2, 3])).toEqual([1, 2, 3]);
      });

      test("runtime: parses empty array", () => {
        expect(parse(schemas.base, [])).toEqual([]);
      });

      test("runtime: rejects non-array", () => {
        expect(() => parse(schemas.base, 42)).toThrow();
        expect(() => parse(schemas.base, null)).toThrow();
      });
    });

    describe("create", () => {
      test("type: create is required number[]", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number[]>();
      });

      test("runtime: accepts array", () => {
        expect(parse(schemas.create, [1, 2, 3])).toEqual([1, 2, 3]);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(() => parse(schemas.create, undefined)).toThrow();
      });
    });

    describe("update", () => {
      test("type: update accepts array operations", () => {
        type Update = InferIntInput<State, "update">;
        expectTypeOf<{ set: number[] }>().toExtend<Update>();
        expectTypeOf<{ push: number }>().toExtend<Update>();
        expectTypeOf<{ push: number[] }>().toExtend<Update>();
        expectTypeOf<{ unshift: number }>().toExtend<Update>();
      });

      test("runtime: shorthand array transforms to { set: value }", () => {
        expect(parse(schemas.update, [1, 2, 3])).toEqual({ set: [1, 2, 3] });
      });

      test("runtime: set operation passes through", () => {
        expect(parse(schemas.update, { set: [4, 5, 6] })).toEqual({
          set: [4, 5, 6],
        });
      });

      test("runtime: push single element", () => {
        expect(parse(schemas.update, { push: 7 })).toEqual({ push: 7 });
      });

      test("runtime: push array of elements", () => {
        expect(parse(schemas.update, { push: [8, 9] })).toEqual({
          push: [8, 9],
        });
      });

      test("runtime: unshift operation", () => {
        expect(parse(schemas.update, { unshift: 0 })).toEqual({ unshift: 0 });
      });
    });

    describe("filter", () => {
      test("type: filter accepts array filters", () => {
        type Filter = InferIntInput<State, "filter">;
        expectTypeOf<{ has: number }>().toExtend<Filter>();
        expectTypeOf<{ hasEvery: number[] }>().toExtend<Filter>();
        expectTypeOf<{ hasSome: number[] }>().toExtend<Filter>();
        expectTypeOf<{ isEmpty: boolean }>().toExtend<Filter>();
        expectTypeOf<{ equals: number[] }>().toExtend<Filter>();
      });

      test("runtime: shorthand array transforms to { equals: value }", () => {
        expect(parse(schemas.filter, [1, 2, 3])).toEqual({ equals: [1, 2, 3] });
      });

      test("runtime: has filter passes through", () => {
        expect(parse(schemas.filter, { has: 5 })).toEqual({ has: 5 });
      });

      test("runtime: hasEvery filter passes through", () => {
        expect(parse(schemas.filter, { hasEvery: [1, 2] })).toEqual({
          hasEvery: [1, 2],
        });
      });

      test("runtime: hasSome filter passes through", () => {
        expect(parse(schemas.filter, { hasSome: [3, 4] })).toEqual({
          hasSome: [3, 4],
        });
      });

      test("runtime: isEmpty filter passes through", () => {
        expect(parse(schemas.filter, { isEmpty: true })).toEqual({
          isEmpty: true,
        });
      });
    });
  });

  // ===========================================================================
  // NULLABLE LIST INT FIELD (nullable array)
  // ===========================================================================

  describe("Nullable List Int Field", () => {
    const field = int().array().nullable();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number[] | null", () => {
        type Base = InferIntInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number[] | null>();
      });

      test("runtime: parses array of integers", () => {
        expect(parse(schemas.base, [1, 2, 3])).toEqual([1, 2, 3]);
      });

      test("runtime: parses null", () => {
        expect(parse(schemas.base, null)).toBe(null);
      });
    });

    describe("create", () => {
      test("type: create is optional (has default null)", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<number[] | null | undefined>().toExtend<Create>();
      });

      test("runtime: accepts array", () => {
        expect(parse(schemas.create, [1, 2, 3])).toEqual([1, 2, 3]);
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
        type Update = InferIntInput<State, "update">;
        expectTypeOf<{ set: number[] | null }>().toExtend<Update>();
        expectTypeOf<{ push: number }>().toExtend<Update>();
      });

      test("runtime: shorthand array transforms to { set: value }", () => {
        expect(parse(schemas.update, [1, 2, 3])).toEqual({ set: [1, 2, 3] });
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
        type Filter = InferIntInput<State, "filter">;
        expectTypeOf<null>().toExtend<Filter>();
        expectTypeOf<{ equals: null }>().toExtend<Filter>();
      });

      test("runtime: shorthand null transforms to { equals: null }", () => {
        expect(parse(schemas.filter, null)).toEqual({ equals: null });
      });
    });
  });

  // ===========================================================================
  // INCREMENT (AUTO-GENERATION)
  // ===========================================================================

  describe("Increment Int Field", () => {
    const field = int().increment();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("state: hasDefault is true", () => {
      expect(field["~"].state.hasDefault).toBe(true);
    });

    test("state: autoGenerate is increment", () => {
      expect(field["~"].state.autoGenerate).toBe("increment");
    });

    test("type: create is optional", () => {
      type Create = InferIntInput<State, "create">;
      expectTypeOf<number | undefined>().toExtend<Create>();
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toBe(0);
    });

    test("runtime: accepts explicit value", () => {
      expect(parse(schemas.create, 100)).toBe(100);
    });
  });

  // ===========================================================================
  // DEFAULT VALUE BEHAVIOR
  // ===========================================================================

  describe("Default Value Behavior", () => {
    describe("static default value", () => {
      const field = int().default(42);
      type State = (typeof field)["~"]["state"];
      const schemas = field["~"].schemas;

      test("type: create is optional", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<number | undefined>().toExtend<Create>();
      });

      test("runtime: accepts value", () => {
        expect(parse(schemas.create, 100)).toBe(100);
      });

      test("runtime: undefined uses default", () => {
        expect(parse(schemas.create, undefined)).toBe(42);
      });
    });

    describe("function default value", () => {
      let callCount = 0;
      const field = int().default(() => {
        callCount++;
        return callCount * 10;
      });
      const schemas = field["~"].schemas;

      test("runtime: undefined calls default function", () => {
        const before = callCount;
        const result = parse(schemas.create, undefined);
        expect(result).toBe((before + 1) * 10);
      });
    });
  });

  // ===========================================================================
  // CUSTOM SCHEMA VALIDATION
  // ===========================================================================

  describe("Custom Schema Validation", () => {
    describe("min/max validation", () => {
      const positiveInt = pipe(number(), integer(), minValue(1), maxValue(100));
      const field = int().schema(positiveInt);
      const schemas = field["~"].schemas;

      test("runtime: accepts valid value in range", () => {
        expect(parse(schemas.base, 50)).toBe(50);
        expect(parse(schemas.base, 1)).toBe(1);
        expect(parse(schemas.base, 100)).toBe(100);
      });

      test("runtime: rejects value below min", () => {
        expect(() => parse(schemas.base, 0)).toThrow();
        expect(() => parse(schemas.base, -5)).toThrow();
      });

      test("runtime: rejects value above max", () => {
        expect(() => parse(schemas.base, 101)).toThrow();
        expect(() => parse(schemas.base, 1000)).toThrow();
      });

      test("runtime: create validates against custom schema", () => {
        expect(parse(schemas.create, 50)).toBe(50);
        expect(() => parse(schemas.create, 0)).toThrow();
        expect(() => parse(schemas.create, 101)).toThrow();
      });

      test("runtime: update validates against custom schema", () => {
        expect(parse(schemas.update, 50)).toEqual({ set: 50 });
        expect(() => parse(schemas.update, 0)).toThrow();
      });
    });

    describe("branded type preservation", () => {
      const ageSchema = pipe(
        number(),
        integer(),
        minValue(0),
        maxValue(150),
        brand("Age")
      );
      const field = int().schema(ageSchema);
      type BrandedOutput = InferOutput<(typeof field)["~"]["schemas"]["base"]>;

      test("type: base output preserves brand", () => {
        // Brand is on output type
        expectTypeOf<BrandedOutput>().toExtend<number & Brand<"Age">>();
      });

      test("runtime: validates and returns branded value", () => {
        const result = parse(field["~"].schemas.base, 25);
        expect(result).toBe(25);
      });
    });
  });
});

// =============================================================================
// FLOAT FIELD TESTS
// =============================================================================

describe("Float Field", () => {
  // ===========================================================================
  // RAW FLOAT FIELD (required, no modifiers)
  // ===========================================================================

  describe("Raw Float Field", () => {
    const field = float();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number", () => {
        type Base = InferFloatInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number>();
      });

      test("runtime: parses float", () => {
        expect(parse(schemas.base, 3.14)).toBe(3.14);
        expect(parse(schemas.base, 0.001)).toBe(0.001);
        expect(parse(schemas.base, -2.5)).toBe(-2.5);
      });

      test("runtime: parses integer (valid float)", () => {
        expect(parse(schemas.base, 42)).toBe(42);
        expect(parse(schemas.base, 0)).toBe(0);
      });

      test("runtime: rejects non-number", () => {
        expect(() => parse(schemas.base, "3.14")).toThrow();
        expect(() => parse(schemas.base, null)).toThrow();
      });
    });

    describe("create", () => {
      test("type: create is required number", () => {
        type Create = InferFloatInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number>();
      });

      test("runtime: accepts float", () => {
        expect(parse(schemas.create, 3.14159)).toBe(3.14159);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(() => parse(schemas.create, undefined)).toThrow();
      });
    });

    describe("update", () => {
      test("type: update accepts arithmetic operations", () => {
        type Update = InferFloatInput<State, "update">;
        expectTypeOf<number>().toExtend<Update>();
        expectTypeOf<{ set: number }>().toExtend<Update>();
        expectTypeOf<{ increment: number }>().toExtend<Update>();
        expectTypeOf<{ decrement: number }>().toExtend<Update>();
        expectTypeOf<{ multiply: number }>().toExtend<Update>();
        expectTypeOf<{ divide: number }>().toExtend<Update>();
      });

      test("runtime: shorthand transforms to { set: value }", () => {
        expect(parse(schemas.update, 3.14)).toEqual({ set: 3.14 });
      });

      test("runtime: arithmetic operations pass through", () => {
        expect(parse(schemas.update, { increment: 0.5 })).toEqual({
          increment: 0.5,
        });
        expect(parse(schemas.update, { multiply: 2.5 })).toEqual({
          multiply: 2.5,
        });
      });
    });

    describe("filter", () => {
      test("type: filter accepts comparison operations", () => {
        type Filter = InferFloatInput<State, "filter">;
        expectTypeOf<number>().toExtend<Filter>();
        expectTypeOf<{ equals: number }>().toExtend<Filter>();
        expectTypeOf<{ lt: number }>().toExtend<Filter>();
        expectTypeOf<{ gt: number }>().toExtend<Filter>();
      });

      test("runtime: shorthand transforms to { equals: value }", () => {
        expect(parse(schemas.filter, 3.14)).toEqual({ equals: 3.14 });
      });

      test("runtime: comparison filters pass through", () => {
        expect(parse(schemas.filter, { lt: 10.5 })).toEqual({ lt: 10.5 });
        expect(parse(schemas.filter, { gte: 0.0 })).toEqual({ gte: 0.0 });
      });
    });
  });

  // ===========================================================================
  // NULLABLE FLOAT FIELD
  // ===========================================================================

  describe("Nullable Float Field", () => {
    const field = float().nullable();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number | null", () => {
        type Base = InferFloatInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number | null>();
      });

      test("runtime: parses float", () => {
        expect(parse(schemas.base, 3.14)).toBe(3.14);
      });

      test("runtime: parses null", () => {
        expect(parse(schemas.base, null)).toBe(null);
      });
    });

    describe("create", () => {
      test("type: create is optional (has default null)", () => {
        type Create = InferFloatInput<State, "create">;
        expectTypeOf<number | null | undefined>().toExtend<Create>();
      });

      test("runtime: undefined defaults to null", () => {
        expect(parse(schemas.create, undefined)).toBe(null);
      });
    });

    describe("update", () => {
      test("runtime: shorthand null transforms to { set: null }", () => {
        expect(parse(schemas.update, null)).toEqual({ set: null });
      });
    });

    describe("filter", () => {
      test("runtime: shorthand null transforms to { equals: null }", () => {
        expect(parse(schemas.filter, null)).toEqual({ equals: null });
      });
    });
  });

  // ===========================================================================
  // LIST FLOAT FIELD
  // ===========================================================================

  describe("List Float Field", () => {
    const field = float().array();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number[]", () => {
        type Base = InferFloatInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number[]>();
      });

      test("runtime: parses array of floats", () => {
        expect(parse(schemas.base, [1.1, 2.2, 3.3])).toEqual([1.1, 2.2, 3.3]);
      });
    });

    describe("create", () => {
      test("type: create is required number[]", () => {
        type Create = InferFloatInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number[]>();
      });
    });

    describe("update", () => {
      test("runtime: push operation", () => {
        expect(parse(schemas.update, { push: 4.4 })).toEqual({ push: 4.4 });
      });
    });

    describe("filter", () => {
      test("runtime: has filter", () => {
        expect(parse(schemas.filter, { has: 1.5 })).toEqual({ has: 1.5 });
      });
    });
  });

  // ===========================================================================
  // NULLABLE LIST FLOAT FIELD
  // ===========================================================================

  describe("Nullable List Float Field", () => {
    const field = float().array().nullable();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number[] | null", () => {
        type Base = InferFloatInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number[] | null>();
      });
    });

    describe("create", () => {
      test("runtime: undefined defaults to null", () => {
        expect(parse(schemas.create, undefined)).toBe(null);
      });
    });
  });

  // ===========================================================================
  // CUSTOM SCHEMA VALIDATION
  // ===========================================================================

  describe("Custom Schema Validation", () => {
    describe("percentage validation (0-100)", () => {
      const percentageSchema = pipe(number(), minValue(0), maxValue(100));
      const field = float().schema(percentageSchema);
      const schemas = field["~"].schemas;

      test("runtime: accepts valid percentage", () => {
        expect(parse(schemas.base, 0)).toBe(0);
        expect(parse(schemas.base, 50.5)).toBe(50.5);
        expect(parse(schemas.base, 100)).toBe(100);
      });

      test("runtime: rejects invalid percentage", () => {
        expect(() => parse(schemas.base, -0.1)).toThrow();
        expect(() => parse(schemas.base, 100.1)).toThrow();
      });
    });

    describe("branded type preservation", () => {
      const temperatureSchema = pipe(
        number(),
        minValue(-273.15),
        brand("Celsius")
      );
      const field = float().schema(temperatureSchema);
      type BrandedOutput = InferOutput<(typeof field)["~"]["schemas"]["base"]>;

      test("type: base output preserves brand", () => {
        expectTypeOf<BrandedOutput>().toExtend<number & Brand<"Celsius">>();
      });

      test("runtime: validates minimum temperature (absolute zero)", () => {
        expect(parse(field["~"].schemas.base, -273.15)).toBe(-273.15);
        expect(parse(field["~"].schemas.base, 0)).toBe(0);
        expect(() => parse(field["~"].schemas.base, -300)).toThrow();
      });
    });
  });
});

// =============================================================================
// DECIMAL FIELD TESTS
// =============================================================================

describe("Decimal Field", () => {
  // ===========================================================================
  // RAW DECIMAL FIELD (required, no modifiers)
  // ===========================================================================

  describe("Raw Decimal Field", () => {
    const field = decimal();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number", () => {
        type Base = InferDecimalInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number>();
      });

      test("runtime: parses decimal", () => {
        expect(parse(schemas.base, 123.456)).toBe(123.456);
        expect(parse(schemas.base, 0.001)).toBe(0.001);
      });

      test("runtime: parses integer", () => {
        expect(parse(schemas.base, 100)).toBe(100);
      });

      test("runtime: rejects non-number", () => {
        expect(() => parse(schemas.base, "123.45")).toThrow();
        expect(() => parse(schemas.base, null)).toThrow();
      });
    });

    describe("create", () => {
      test("type: create is required number", () => {
        type Create = InferDecimalInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number>();
      });

      test("runtime: accepts decimal", () => {
        expect(parse(schemas.create, 99.99)).toBe(99.99);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(() => parse(schemas.create, undefined)).toThrow();
      });
    });

    describe("update", () => {
      test("type: update accepts arithmetic operations", () => {
        type Update = InferDecimalInput<State, "update">;
        expectTypeOf<number>().toExtend<Update>();
        expectTypeOf<{ set: number }>().toExtend<Update>();
        expectTypeOf<{ increment: number }>().toExtend<Update>();
        expectTypeOf<{ decrement: number }>().toExtend<Update>();
        expectTypeOf<{ multiply: number }>().toExtend<Update>();
        expectTypeOf<{ divide: number }>().toExtend<Update>();
      });

      test("runtime: shorthand transforms to { set: value }", () => {
        expect(parse(schemas.update, 123.45)).toEqual({ set: 123.45 });
      });

      test("runtime: arithmetic operations pass through", () => {
        expect(parse(schemas.update, { increment: 0.01 })).toEqual({
          increment: 0.01,
        });
      });
    });

    describe("filter", () => {
      test("runtime: shorthand transforms to { equals: value }", () => {
        expect(parse(schemas.filter, 123.45)).toEqual({ equals: 123.45 });
      });

      test("runtime: comparison filters pass through", () => {
        expect(parse(schemas.filter, { lt: 1000.0 })).toEqual({ lt: 1000.0 });
      });
    });
  });

  // ===========================================================================
  // NULLABLE DECIMAL FIELD
  // ===========================================================================

  describe("Nullable Decimal Field", () => {
    const field = decimal().nullable();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number | null", () => {
        type Base = InferDecimalInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number | null>();
      });
    });

    describe("create", () => {
      test("runtime: undefined defaults to null", () => {
        expect(parse(schemas.create, undefined)).toBe(null);
      });
    });
  });

  // ===========================================================================
  // LIST DECIMAL FIELD
  // ===========================================================================

  describe("List Decimal Field", () => {
    const field = decimal().array();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number[]", () => {
        type Base = InferDecimalInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number[]>();
      });
    });

    describe("create", () => {
      test("type: create is required number[]", () => {
        type Create = InferDecimalInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number[]>();
      });
    });
  });

  // ===========================================================================
  // NULLABLE LIST DECIMAL FIELD
  // ===========================================================================

  describe("Nullable List Decimal Field", () => {
    const field = decimal().array().nullable();
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    describe("base", () => {
      test("type: base is number[] | null", () => {
        type Base = InferDecimalInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number[] | null>();
      });
    });

    describe("create", () => {
      test("runtime: undefined defaults to null", () => {
        expect(parse(schemas.create, undefined)).toBe(null);
      });
    });
  });

  // ===========================================================================
  // CUSTOM SCHEMA VALIDATION
  // ===========================================================================

  describe("Custom Schema Validation", () => {
    describe("positive price validation", () => {
      const priceSchema = pipe(number(), minValue(0.01));
      const field = decimal().schema(priceSchema);
      const schemas = field["~"].schemas;

      test("runtime: accepts valid price", () => {
        expect(parse(schemas.base, 0.01)).toBe(0.01);
        expect(parse(schemas.base, 99.99)).toBe(99.99);
        expect(parse(schemas.base, 1000.5)).toBe(1000.5);
      });

      test("runtime: rejects zero or negative price", () => {
        expect(() => parse(schemas.base, 0)).toThrow();
        expect(() => parse(schemas.base, -10)).toThrow();
      });
    });

    describe("branded type preservation", () => {
      const currencySchema = pipe(number(), minValue(0), brand("USD"));
      const field = decimal().schema(currencySchema);
      type BrandedOutput = InferOutput<(typeof field)["~"]["schemas"]["base"]>;

      test("type: base output preserves brand", () => {
        expectTypeOf<BrandedOutput>().toExtend<number & Brand<"USD">>();
      });

      test("runtime: validates and returns branded value", () => {
        const result = parse(field["~"].schemas.base, 19.99);
        expect(result).toBe(19.99);
      });
    });
  });
});
