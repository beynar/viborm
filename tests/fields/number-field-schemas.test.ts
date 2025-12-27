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
  pipe,
  number,
  minValue,
  maxValue,
  brand,
  integer,
  Brand,
} from "valibot";
import { parse, InferOutput } from "../../src/validation";
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
        const r1 = parse(schemas.base, 42);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(42);

        const r2 = parse(schemas.base, 0);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(0);

        const r3 = parse(schemas.base, -100);
        if (r3.issues) throw new Error("Expected success");
        expect(r3.value).toBe(-100);
      });

      test("runtime: rejects float (not integer)", () => {
        expect(parse(schemas.base, 3.14).issues).toBeDefined();
        expect(parse(schemas.base, 0.1).issues).toBeDefined();
      });

      test("runtime: rejects non-number", () => {
        expect(parse(schemas.base, "42").issues).toBeDefined();
        expect(parse(schemas.base, null).issues).toBeDefined();
        expect(parse(schemas.base, true).issues).toBeDefined();
      });
    });

    describe("create", () => {
      test("type: create is required number", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number>();
      });

      test("runtime: accepts integer", () => {
        const result = parse(schemas.create, 123);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(123);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(parse(schemas.create, undefined).issues).toBeDefined();
      });

      test("runtime: rejects null", () => {
        expect(parse(schemas.create, null).issues).toBeDefined();
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
        const r1 = parse(schemas.update, 99);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toEqual({ set: 99 });

        const r2 = parse(schemas.update, 0);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toEqual({ set: 0 });

        const r3 = parse(schemas.update, -5);
        if (r3.issues) throw new Error("Expected success");
        expect(r3.value).toEqual({ set: -5 });
      });

      test("runtime: set operation passes through", () => {
        const result = parse(schemas.update, { set: 42 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ set: 42 });
      });

      test("runtime: increment operation passes through", () => {
        const result = parse(schemas.update, { increment: 5 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ increment: 5 });
      });

      test("runtime: decrement operation passes through", () => {
        const result = parse(schemas.update, { decrement: 3 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ decrement: 3 });
      });

      test("runtime: multiply operation passes through", () => {
        const result = parse(schemas.update, { multiply: 2 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ multiply: 2 });
      });

      test("runtime: divide operation passes through", () => {
        const result = parse(schemas.update, { divide: 4 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ divide: 4 });
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
        const r1 = parse(schemas.filter, 50);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toEqual({ equals: 50 });

        const r2 = parse(schemas.filter, 0);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toEqual({ equals: 0 });
      });

      test("runtime: equals filter passes through", () => {
        const result = parse(schemas.filter, { equals: 42 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ equals: 42 });
      });

      test("runtime: in filter passes through", () => {
        const result = parse(schemas.filter, { in: [1, 2, 3] });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ in: [1, 2, 3] });
      });

      test("runtime: notIn filter passes through", () => {
        const result = parse(schemas.filter, { notIn: [4, 5, 6] });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ notIn: [4, 5, 6] });
      });

      test("runtime: comparison filters pass through", () => {
        const r1 = parse(schemas.filter, { lt: 100 });
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toEqual({ lt: 100 });

        const r2 = parse(schemas.filter, { lte: 100 });
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toEqual({ lte: 100 });

        const r3 = parse(schemas.filter, { gt: 0 });
        if (r3.issues) throw new Error("Expected success");
        expect(r3.value).toEqual({ gt: 0 });

        const r4 = parse(schemas.filter, { gte: 0 });
        if (r4.issues) throw new Error("Expected success");
        expect(r4.value).toEqual({ gte: 0 });
      });

      test("runtime: not filter with shorthand", () => {
        const result = parse(schemas.filter, { not: 42 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ not: { equals: 42 } });
      });

      test("runtime: not filter with object", () => {
        const result = parse(schemas.filter, { not: { gt: 10 } });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ not: { gt: 10 } });
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
        const result = parse(schemas.base, 42);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(42);
      });

      test("runtime: parses null", () => {
        const result = parse(schemas.base, null);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(null);
      });
    });

    describe("create", () => {
      test("type: create is optional (has default null)", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<number | null | undefined>().toExtend<Create>();
      });

      test("runtime: accepts integer", () => {
        const result = parse(schemas.create, 123);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(123);
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
        type Update = InferIntInput<State, "update">;
        expectTypeOf<null>().toExtend<Update>();
        expectTypeOf<{ set: number | null }>().toExtend<Update>();
      });

      test("runtime: shorthand null transforms to { set: null }", () => {
        const result = parse(schemas.update, null);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ set: null });
      });

      test("runtime: arithmetic operations still use non-null base", () => {
        const r1 = parse(schemas.update, { increment: 5 });
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toEqual({ increment: 5 });

        const r2 = parse(schemas.update, { decrement: 3 });
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toEqual({ decrement: 3 });
      });
    });

    describe("filter", () => {
      test("type: filter accepts null", () => {
        type Filter = InferIntInput<State, "filter">;
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
        const result = parse(schemas.base, [1, 2, 3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual([1, 2, 3]);
      });

      test("runtime: parses empty array", () => {
        const result = parse(schemas.base, []);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual([]);
      });

      test("runtime: rejects non-array", () => {
        expect(parse(schemas.base, 42).issues).toBeDefined();
        expect(parse(schemas.base, null).issues).toBeDefined();
      });
    });

    describe("create", () => {
      test("type: create is required number[]", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number[]>();
      });

      test("runtime: accepts array", () => {
        const result = parse(schemas.create, [1, 2, 3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual([1, 2, 3]);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(parse(schemas.create, undefined).issues).toBeDefined();
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
        const result = parse(schemas.update, [1, 2, 3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ set: [1, 2, 3] });
      });

      test("runtime: set operation passes through", () => {
        const result = parse(schemas.update, { set: [4, 5, 6] });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ set: [4, 5, 6] });
      });

      test("runtime: push single element (coerced to array)", () => {
        const result = parse(schemas.update, { push: 7 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toMatchObject({ push: [7] });
      });

      test("runtime: push array of elements", () => {
        const result = parse(schemas.update, { push: [8, 9] });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toMatchObject({ push: [8, 9] });
      });

      test("runtime: unshift operation (coerced to array)", () => {
        const result = parse(schemas.update, { unshift: 0 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toMatchObject({ unshift: [0] });
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
        const result = parse(schemas.filter, [1, 2, 3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ equals: [1, 2, 3] });
      });

      test("runtime: has filter passes through", () => {
        const result = parse(schemas.filter, { has: 5 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ has: 5 });
      });

      test("runtime: hasEvery filter passes through", () => {
        const result = parse(schemas.filter, { hasEvery: [1, 2] });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ hasEvery: [1, 2] });
      });

      test("runtime: hasSome filter passes through", () => {
        const result = parse(schemas.filter, { hasSome: [3, 4] });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ hasSome: [3, 4] });
      });

      test("runtime: isEmpty filter passes through", () => {
        const result = parse(schemas.filter, { isEmpty: true });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ isEmpty: true });
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
        const result = parse(schemas.base, [1, 2, 3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual([1, 2, 3]);
      });

      test("runtime: parses null", () => {
        const result = parse(schemas.base, null);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(null);
      });
    });

    describe("create", () => {
      test("type: create is optional (has default null)", () => {
        type Create = InferIntInput<State, "create">;
        expectTypeOf<number[] | null | undefined>().toExtend<Create>();
      });

      test("runtime: accepts array", () => {
        const result = parse(schemas.create, [1, 2, 3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual([1, 2, 3]);
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
        type Update = InferIntInput<State, "update">;
        expectTypeOf<{ set: number[] | null }>().toExtend<Update>();
        expectTypeOf<{ push: number }>().toExtend<Update>();
      });

      test("runtime: shorthand array transforms to { set: value }", () => {
        const result = parse(schemas.update, [1, 2, 3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ set: [1, 2, 3] });
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
        type Filter = InferIntInput<State, "filter">;
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
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(0);
    });

    test("runtime: accepts explicit value", () => {
      const result = parse(schemas.create, 100);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(100);
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
        const result = parse(schemas.create, 100);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(100);
      });

      test("runtime: undefined uses default", () => {
        const result = parse(schemas.create, undefined);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(42);
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
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe((before + 1) * 10);
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
        const r1 = parse(schemas.base, 50);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(50);

        const r2 = parse(schemas.base, 1);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(1);

        const r3 = parse(schemas.base, 100);
        if (r3.issues) throw new Error("Expected success");
        expect(r3.value).toBe(100);
      });

      test("runtime: rejects value below min", () => {
        expect(parse(schemas.base, 0).issues).toBeDefined();
        expect(parse(schemas.base, -5).issues).toBeDefined();
      });

      test("runtime: rejects value above max", () => {
        expect(parse(schemas.base, 101).issues).toBeDefined();
        expect(parse(schemas.base, 1000).issues).toBeDefined();
      });

      test("runtime: create validates against custom schema", () => {
        const r1 = parse(schemas.create, 50);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(50);

        expect(parse(schemas.create, 0).issues).toBeDefined();
        expect(parse(schemas.create, 101).issues).toBeDefined();
      });

      test("runtime: update validates against custom schema", () => {
        const r1 = parse(schemas.update, 50);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toEqual({ set: 50 });

        expect(parse(schemas.update, 0).issues).toBeDefined();
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
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(25);
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
        const r1 = parse(schemas.base, 3.14);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(3.14);

        const r2 = parse(schemas.base, 0.001);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(0.001);

        const r3 = parse(schemas.base, -2.5);
        if (r3.issues) throw new Error("Expected success");
        expect(r3.value).toBe(-2.5);
      });

      test("runtime: parses integer (valid float)", () => {
        const r1 = parse(schemas.base, 42);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(42);

        const r2 = parse(schemas.base, 0);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(0);
      });

      test("runtime: rejects non-number", () => {
        expect(parse(schemas.base, "3.14").issues).toBeDefined();
        expect(parse(schemas.base, null).issues).toBeDefined();
      });
    });

    describe("create", () => {
      test("type: create is required number", () => {
        type Create = InferFloatInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number>();
      });

      test("runtime: accepts float", () => {
        const result = parse(schemas.create, 3.14159);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(3.14159);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(parse(schemas.create, undefined).issues).toBeDefined();
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
        const result = parse(schemas.update, 3.14);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ set: 3.14 });
      });

      test("runtime: arithmetic operations pass through", () => {
        const r1 = parse(schemas.update, { increment: 0.5 });
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toEqual({ increment: 0.5 });

        const r2 = parse(schemas.update, { multiply: 2.5 });
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toEqual({ multiply: 2.5 });
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
        const result = parse(schemas.filter, 3.14);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ equals: 3.14 });
      });

      test("runtime: comparison filters pass through", () => {
        const r1 = parse(schemas.filter, { lt: 10.5 });
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toEqual({ lt: 10.5 });

        const r2 = parse(schemas.filter, { gte: 0.0 });
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toEqual({ gte: 0.0 });
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
        const result = parse(schemas.base, 3.14);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(3.14);
      });

      test("runtime: parses null", () => {
        const result = parse(schemas.base, null);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(null);
      });
    });

    describe("create", () => {
      test("type: create is optional (has default null)", () => {
        type Create = InferFloatInput<State, "create">;
        expectTypeOf<number | null | undefined>().toExtend<Create>();
      });

      test("runtime: undefined defaults to null", () => {
        const result = parse(schemas.create, undefined);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(null);
      });
    });

    describe("update", () => {
      test("runtime: shorthand null transforms to { set: null }", () => {
        const result = parse(schemas.update, null);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ set: null });
      });
    });

    describe("filter", () => {
      test("runtime: shorthand null transforms to { equals: null }", () => {
        const result = parse(schemas.filter, null);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ equals: null });
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
        const result = parse(schemas.base, [1.1, 2.2, 3.3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual([1.1, 2.2, 3.3]);
      });
    });

    describe("create", () => {
      test("type: create is required number[]", () => {
        type Create = InferFloatInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number[]>();
      });
    });

    describe("update", () => {
      test("runtime: push operation (coerced to array)", () => {
        const result = parse(schemas.update, { push: 4.4 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toMatchObject({ push: [4.4] });
      });
    });

    describe("filter", () => {
      test("runtime: has filter", () => {
        const result = parse(schemas.filter, { has: 1.5 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ has: 1.5 });
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
        const result = parse(schemas.create, undefined);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(null);
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
        const r1 = parse(schemas.base, 0);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(0);

        const r2 = parse(schemas.base, 50.5);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(50.5);

        const r3 = parse(schemas.base, 100);
        if (r3.issues) throw new Error("Expected success");
        expect(r3.value).toBe(100);
      });

      test("runtime: rejects invalid percentage", () => {
        expect(parse(schemas.base, -0.1).issues).toBeDefined();
        expect(parse(schemas.base, 100.1).issues).toBeDefined();
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
        const r1 = parse(field["~"].schemas.base, -273.15);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(-273.15);

        const r2 = parse(field["~"].schemas.base, 0);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(0);

        expect(parse(field["~"].schemas.base, -300).issues).toBeDefined();
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
        const r1 = parse(schemas.base, 123.456);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(123.456);

        const r2 = parse(schemas.base, 0.001);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(0.001);
      });

      test("runtime: parses integer", () => {
        const result = parse(schemas.base, 100);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(100);
      });

      test("runtime: rejects non-number", () => {
        expect(parse(schemas.base, "123.45").issues).toBeDefined();
        expect(parse(schemas.base, null).issues).toBeDefined();
      });
    });

    describe("create", () => {
      test("type: create is required number", () => {
        type Create = InferDecimalInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number>();
      });

      test("runtime: accepts decimal", () => {
        const result = parse(schemas.create, 99.99);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(99.99);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(parse(schemas.create, undefined).issues).toBeDefined();
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
        const result = parse(schemas.update, 123.45);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ set: 123.45 });
      });

      test("runtime: arithmetic operations pass through", () => {
        const result = parse(schemas.update, { increment: 0.01 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ increment: 0.01 });
      });
    });

    describe("filter", () => {
      test("runtime: shorthand transforms to { equals: value }", () => {
        const result = parse(schemas.filter, 123.45);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ equals: 123.45 });
      });

      test("runtime: comparison filters pass through", () => {
        const result = parse(schemas.filter, { lt: 1000.0 });
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual({ lt: 1000.0 });
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
        const result = parse(schemas.create, undefined);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(null);
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
        const result = parse(schemas.create, undefined);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(null);
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
        const r1 = parse(schemas.base, 0.01);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(0.01);

        const r2 = parse(schemas.base, 99.99);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(99.99);

        const r3 = parse(schemas.base, 1000.5);
        if (r3.issues) throw new Error("Expected success");
        expect(r3.value).toBe(1000.5);
      });

      test("runtime: rejects zero or negative price", () => {
        expect(parse(schemas.base, 0).issues).toBeDefined();
        expect(parse(schemas.base, -10).issues).toBeDefined();
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
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(19.99);
      });
    });
  });
});
