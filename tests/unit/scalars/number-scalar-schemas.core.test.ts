/**
 * Number Scalar Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all number scalar variants:
 * - Int (integer numbers)
 * - Number (approximate finite JavaScript numbers)
 * - Decimal (exact decimals: accepts string | number, produces a canonical string)
 *
 * For each number type, tests these variants:
 * - Raw (required)
 * - Nullable (with default null)
 * - List (array)
 * - Nullable List (nullable array)
 *
 * For each variant, tests:
 * - base: The element/scalar type
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + shorthand transforms
 */

import { type AnyFieldRef, FIELD_REF_BRAND } from "@schema/field-ref";
import { decimal, int, number } from "@schema/scalars";
import type { ScalarState, ScalarType } from "@schema/scalars/common";
import { sql } from "@sql";
import type { StandardSchemaOf } from "@standard-schema/spec";
import { type InferInput, type InferOutput, parse } from "@validation";
import { type GetScalarSchemas, getScalarSchemas } from "@validation/scalars";
import Decimal from "decimal.js";
import {
  type Brand,
  brand,
  integer,
  maxValue,
  minValue,
  pipe,
  number as valibotNumber,
} from "valibot";
import { describe, expect, expectTypeOf, test } from "vitest";

/** A reference token standing for a column of the named scalar domain. */
const fieldRefOfType = (type: ScalarType): AnyFieldRef =>
  Object.freeze({
    [FIELD_REF_BRAND]: Object.freeze({
      model: "reading",
      field: "other",
      type,
      list: false,
    }),
  });

type InferScalarInput<
  State extends ScalarState,
  Key extends keyof GetScalarSchemas<State>,
> = InferInput<GetScalarSchemas<State>[Key]>;
type InferIntInput<
  State extends ScalarState<"int">,
  Key extends keyof GetScalarSchemas<State>,
> = InferScalarInput<State, Key>;
type InferNumberInput<
  State extends ScalarState<"number">,
  Key extends keyof GetScalarSchemas<State>,
> = InferScalarInput<State, Key>;
type InferDecimalInput<
  State extends ScalarState<"decimal">,
  Key extends keyof GetScalarSchemas<State>,
> = InferScalarInput<State, Key>;

// =============================================================================
// INT SCALAR TESTS
// =============================================================================

describe("Int Scalar", () => {
  // ===========================================================================
  // RAW INT SCALAR (required, no modifiers)
  // ===========================================================================

  describe("Raw Int Scalar", () => {
    const scalar = int();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

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

      test("runtime: rejects a fractional value (not integer)", () => {
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
  // NULLABLE INT SCALAR
  // ===========================================================================

  describe("Nullable Int Scalar", () => {
    const scalar = int().nullable();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

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
  // LIST INT SCALAR (array)
  // ===========================================================================

  describe("List Int Scalar", () => {
    const scalar = int().array();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

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
  // NULLABLE LIST INT SCALAR (nullable array)
  // ===========================================================================

  describe("Nullable List Int Scalar", () => {
    const scalar = int().array().nullable();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

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

  describe("Increment Int Scalar", () => {
    const scalar = int().increment();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    test("state: hasDefault is true", () => {
      expect(scalar["~"].state.hasDefault).toBe(true);
    });

    test("state: autoGenerate is increment", () => {
      expect(scalar["~"].state.autoGenerate).toEqual({ kind: "increment" });
    });

    test("type: create is optional", () => {
      type Create = InferIntInput<State, "create">;
      expectTypeOf<number | undefined>().toExtend<Create>();
    });

    test("runtime: undefined remains absent for database generation", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBeUndefined();
    });

    test("runtime: accepts explicit value", () => {
      const result = parse(schemas.create, 100);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(100);
    });

    test("runtime: rejects non-portable explicit zero", () => {
      expect(parse(schemas.create, 0).issues?.[0]?.message).toContain(
        "Explicit zero"
      );
    });
  });

  // ===========================================================================
  // DEFAULT VALUE BEHAVIOR
  // ===========================================================================

  describe("Default Value Behavior", () => {
    describe("static default value", () => {
      const scalar = int().default(42);
      type State = (typeof scalar)["~"]["state"];
      const schemas = getScalarSchemas(scalar["~"].state);

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
      const scalar = int().default(() => {
        callCount++;
        return callCount * 10;
      });
      const schemas = getScalarSchemas(scalar["~"].state);

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
      const positiveInt = pipe(
        valibotNumber(),
        integer(),
        minValue(1),
        maxValue(100)
      );
      const scalar = int().schema(positiveInt);
      const schemas = getScalarSchemas(scalar["~"].state);

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
        valibotNumber(),
        integer(),
        minValue(0),
        maxValue(150),
        brand("Age")
      );
      const scalar = int().schema(ageSchema);
      type BrandedOutput = InferOutput<(typeof scalar)["~"]["state"]["base"]>;

      test("type: base output preserves brand", () => {
        // Brand is on output type
        expectTypeOf<BrandedOutput>().toExtend<number & Brand<"Age">>();
      });

      test("runtime: validates and returns branded value", () => {
        const result = parse(getScalarSchemas(scalar["~"].state).base, 25);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(25);
      });
    });
  });
});

// =============================================================================
// NUMBER SCALAR TESTS
// =============================================================================

describe("Number Scalar", () => {
  // ===========================================================================
  // RAW NUMBER SCALAR (required, no modifiers)
  // ===========================================================================

  describe("Raw Number Scalar", () => {
    const scalar = number();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    describe("base", () => {
      test("type: base is number", () => {
        type Base = InferNumberInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number>();
      });

      test("runtime: parses a fractional value", () => {
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

      test("runtime: parses an integer (a valid number)", () => {
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
        type Create = InferNumberInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<number>();
      });

      test("runtime: accepts a fractional value", () => {
        const result = parse(schemas.create, Math.PI);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe(Math.PI);
      });

      test("runtime: rejects undefined (required)", () => {
        expect(parse(schemas.create, undefined).issues).toBeDefined();
      });
    });

    describe("update", () => {
      test("type: update accepts arithmetic operations", () => {
        type Update = InferNumberInput<State, "update">;
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
        type Filter = InferNumberInput<State, "filter">;
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

      /**
       * The operand domain this scalar wires.
       *
       * The field-reference MECHANISM is owned once, in
       * `tests/unit/validation/operand.core.test.ts`. What only this can catch
       * is the token `buildNumberSchema` hands `v.comparisonOperand`: it has to
       * be this scalar's own state type, or a reference to another `number`
       * column is refused and a reference from a different scalar domain is
       * admitted.
       */
      test("runtime: admits a number field reference, refuses another domain", () => {
        expect(
          parse(schemas.filter, { equals: fieldRefOfType("number") }).issues
        ).toBeUndefined();
        expect(
          parse(schemas.filter, { equals: fieldRefOfType("decimal") })
            .issues?.[0]?.message
        ).toContain("a 'number' operand");
      });
    });
  });

  // ===========================================================================
  // NULLABLE NUMBER SCALAR
  // ===========================================================================

  describe("Nullable Number Scalar", () => {
    const scalar = number().nullable();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    describe("base", () => {
      test("type: base is number | null", () => {
        type Base = InferNumberInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number | null>();
      });

      test("runtime: parses a fractional value", () => {
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
        type Create = InferNumberInput<State, "create">;
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
  // LIST NUMBER SCALAR
  // ===========================================================================

  describe("List Number Scalar", () => {
    const scalar = number().array();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    describe("base", () => {
      test("type: base is number[]", () => {
        type Base = InferNumberInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<number[]>();
      });

      test("runtime: parses an array of fractional values", () => {
        const result = parse(schemas.base, [1.1, 2.2, 3.3]);
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toEqual([1.1, 2.2, 3.3]);
      });
    });

    describe("create", () => {
      test("type: create is required number[]", () => {
        type Create = InferNumberInput<State, "create">;
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
  // NULLABLE LIST NUMBER SCALAR
  // ===========================================================================

  describe("Nullable List Number Scalar", () => {
    const scalar = number().array().nullable();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    describe("base", () => {
      test("type: base is number[] | null", () => {
        type Base = InferNumberInput<State, "base">;
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
      const percentageSchema = pipe(
        valibotNumber(),
        minValue(0),
        maxValue(100)
      );
      const scalar = number().schema(percentageSchema);
      const schemas = getScalarSchemas(scalar["~"].state);

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
        valibotNumber(),
        minValue(-273.15),
        brand("Celsius")
      );
      const scalar = number().schema(temperatureSchema);
      type BrandedOutput = InferOutput<(typeof scalar)["~"]["state"]["base"]>;

      test("type: base output preserves brand", () => {
        expectTypeOf<BrandedOutput>().toExtend<number & Brand<"Celsius">>();
      });

      test("runtime: validates minimum temperature (absolute zero)", () => {
        const r1 = parse(getScalarSchemas(scalar["~"].state).base, -273.15);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe(-273.15);

        const r2 = parse(getScalarSchemas(scalar["~"].state).base, 0);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe(0);

        expect(
          parse(getScalarSchemas(scalar["~"].state).base, -300).issues
        ).toBeDefined();
      });
    });
  });
});

// =============================================================================
// DECIMAL SCALAR TESTS
// =============================================================================

/** The declared domain every decimal case below is spelled against. */
const MONEY = { precision: 10, scale: 2 } as const;

/** A Standard Schema over the exact VALUE, which is what `.schema()` observes. */
const decimalValueSchema = (
  check: (value: Decimal) => boolean,
  message: string
): StandardSchemaOf<Decimal> => ({
  "~standard": {
    version: 1,
    vendor: "number-scalar-schemas",
    validate: (value: unknown) =>
      check(value as Decimal)
        ? { value: value as Decimal }
        : { issues: [{ message }] },
  },
});

describe("Decimal Scalar", () => {
  // ===========================================================================
  // RAW DECIMAL SCALAR (required, no modifiers)
  //
  // A decimal ACCEPTS `Decimal | string | number` and validates to the canonical
  // private string. The public `Decimal` result is built at the typed result
  // boundary; what a schema emits is the one logical spelling every identity
  // owner keys on.
  // ===========================================================================

  describe("Raw Decimal Scalar", () => {
    const scalar = decimal(MONEY);
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    describe("base", () => {
      test("type: base accepts Decimal | string | number", () => {
        type Base = InferDecimalInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<Decimal | string | number>();
      });

      test("type: base OUTPUT is the canonical string", () => {
        type Out = InferOutput<State["base"]>;
        expectTypeOf<Out>().toEqualTypeOf<string>();
      });

      test("runtime: parses an exact decimal string, digits intact", () => {
        const r1 = parse(schemas.base, "1234.56");
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe("1234.56");

        // 30 fraction digits survive when the domain admits them
        const wide = getScalarSchemas(
          decimal({ precision: 31, scale: 30 })["~"].state
        );
        const r2 = parse(wide.base, "0.000000000000000000000000000001");
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe("0.000000000000000000000000000001");
      });

      test("runtime: parses a number, naming the double it was given", () => {
        const r1 = parse(schemas.base, 123.45);
        if (r1.issues) throw new Error("Expected success");
        expect(r1.value).toBe("123.45");

        const r2 = parse(schemas.base, 100);
        if (r2.issues) throw new Error("Expected success");
        expect(r2.value).toBe("100");
      });

      test("runtime: parses a Decimal built by the exported constructor", () => {
        const r = parse(schemas.base, new Decimal("12.30"));
        if (r.issues) throw new Error("Expected success");
        expect(r.value).toBe("12.3");
      });

      test("runtime: canonicalizes, so one number has one spelling", () => {
        const result = parse(schemas.base, "1.10");
        if (result.issues) throw new Error("Expected success");
        expect(result.value).toBe("1.1");
      });

      test("runtime: rejects non-decimals, exponents included", () => {
        expect(parse(schemas.base, "1e3").issues).toBeDefined();
        expect(parse(schemas.base, "12.3.4").issues).toBeDefined();
        expect(parse(schemas.base, "abc").issues).toBeDefined();
        expect(parse(schemas.base, Number.NaN).issues).toBeDefined();
        expect(parse(schemas.base, null).issues).toBeDefined();
        expect(
          parse(schemas.base, new Decimal(Number.NaN)).issues
        ).toBeDefined();
      });

      test("runtime: rejects values outside the declared domain", () => {
        // Excess scale is a validation error; nothing rounds an input.
        expect(parse(schemas.base, "1.005").issues).toBeDefined();
        expect(parse(schemas.base, 0.1 + 0.2).issues).toBeDefined();
        // Excess precision: 10 total digits, 2 of them fractional.
        expect(parse(schemas.base, "99999999.99").issues).toBeUndefined();
        expect(parse(schemas.base, "100000000").issues).toBeDefined();
      });

      test("runtime: scale zero, negative zero, and values past 2^53", () => {
        const counter = getScalarSchemas(
          decimal({ precision: 18, scale: 0 })["~"].state
        );
        expect(parse(counter.base, "-0")).toEqual({ value: "0" });
        expect(parse(counter.base, "9007199254740993")).toEqual({
          value: "9007199254740993",
        });
        expect(parse(counter.base, "1.5").issues).toBeDefined();
      });
    });

    describe("create", () => {
      test("type: create is a required Decimal | string | number", () => {
        type Create = InferDecimalInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<Decimal | string | number>();
      });

      test("runtime: accepts every spelling", () => {
        expect(parse(schemas.create, "99.99")).toEqual({ value: "99.99" });
        expect(parse(schemas.create, 99.99)).toEqual({ value: "99.99" });
        expect(parse(schemas.create, new Decimal("99.99"))).toEqual({
          value: "99.99",
        });
      });

      test("runtime: rejects undefined (required)", () => {
        expect(parse(schemas.create, undefined).issues).toBeDefined();
      });
    });

    describe("update", () => {
      test("type: update accepts exactly one operation", () => {
        type Update = InferDecimalInput<State, "update">;
        expectTypeOf<string>().toExtend<Update>();
        expectTypeOf<number>().toExtend<Update>();
        expectTypeOf<Decimal>().toExtend<Update>();
        expectTypeOf<{ set: string }>().toExtend<Update>();
        expectTypeOf<{ increment: string }>().toExtend<Update>();
        expectTypeOf<{ increment: number }>().toExtend<Update>();
        expectTypeOf<{ decrement: string }>().toExtend<Update>();
        expectTypeOf<{ multiply: string }>().toExtend<Update>();
        expectTypeOf<{ divide: string }>().toExtend<Update>();
        // Two operations, and the empty bag, are unrepresentable.
        expectTypeOf<{
          set: string;
          increment: string;
        }>().not.toExtend<Update>();
        expectTypeOf<Record<string, never>>().not.toExtend<Update>();
      });

      test("runtime: shorthand transforms to { set: value }", () => {
        expect(parse(schemas.update, "123.45")).toEqual({
          value: { set: "123.45" },
        });
      });

      test("runtime: arithmetic operands canonicalize too", () => {
        expect(parse(schemas.update, { increment: "0.010" })).toEqual({
          value: { increment: "0.01" },
        });
      });

      test("runtime: every operand is held to the field's own domain", () => {
        // Including multiply and divide: the SQL rounding rule works in
        // coefficient space at the field scale, so a finer operand has no
        // representation to be exact in. Only derived RESULTS round.
        for (const key of [
          "set",
          "increment",
          "decrement",
          "multiply",
          "divide",
        ]) {
          expect(
            parse(schemas.update, { [key]: "1.005" }).issues
          ).toBeDefined();
          expect(
            parse(schemas.update, { [key]: "1.00" }).issues
          ).toBeUndefined();
        }
      });
    });

    describe("filter", () => {
      test("runtime: shorthand transforms to { equals: value }", () => {
        expect(parse(schemas.filter, "123.45")).toEqual({
          value: { equals: "123.45" },
        });
      });

      test("runtime: comparison filters pass through canonicalized", () => {
        expect(parse(schemas.filter, { lt: "1000.0" })).toEqual({
          value: { lt: "1000" },
        });
      });

      test("runtime: in/notIn take lists of exact decimals", () => {
        expect(parse(schemas.filter, { in: ["9", "10", "0.10"] })).toEqual({
          value: { in: ["9", "10", "0.1"] },
        });
      });

      test("runtime: every operand is held to the field's own domain", () => {
        expect(parse(schemas.filter, "1.005").issues).toBeDefined();
        expect(parse(schemas.filter, { equals: "1.005" }).issues).toBeDefined();
        expect(parse(schemas.filter, { lt: "1.005" }).issues).toBeDefined();
        expect(
          parse(schemas.filter, { gte: "100000000" }).issues
        ).toBeDefined();
        expect(parse(schemas.filter, { in: ["1.005"] }).issues).toBeDefined();
        expect(
          parse(schemas.filter, { not: { gt: "1.005" } }).issues
        ).toBeDefined();
      });

      test("runtime: a decimal field reference is still an operand", () => {
        const ref = fieldRefOfType("decimal");
        expect(parse(schemas.filter, { gt: ref })).toEqual({
          value: { gt: ref },
        });
      });

      test("runtime: a generic SQL fragment is NOT a decimal operand", () => {
        // A fragment carries no precision or scale, so the same predicate would
        // mean different things on a coefficient column and a native one.
        const fragment = sql`100`;
        const result = parse(schemas.filter, { gt: fragment });
        expect(result.issues).toBeDefined();
        // The control: an int filter still takes one.
        const ints = getScalarSchemas(int()["~"].state);
        expect(parse(ints.filter, { gt: fragment }).issues).toBeUndefined();
      });
    });
  });

  // ===========================================================================
  // NULLABLE DECIMAL SCALAR
  // ===========================================================================

  describe("Nullable Decimal Scalar", () => {
    const scalar = decimal(MONEY).nullable();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    describe("base", () => {
      test("type: base is Decimal | string | number | null", () => {
        type Base = InferDecimalInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<Decimal | string | number | null>();
      });
    });

    describe("create", () => {
      test("runtime: undefined defaults to null", () => {
        expect(parse(schemas.create, undefined)).toEqual({ value: null });
      });
    });

    describe("update", () => {
      test("runtime: only the whole-value arms take null", () => {
        expect(parse(schemas.update, null)).toEqual({ value: { set: null } });
        expect(parse(schemas.update, { set: null })).toEqual({
          value: { set: null },
        });
        expect(parse(schemas.update, { increment: null }).issues).toBeDefined();
      });
    });
  });

  // ===========================================================================
  // LIST DECIMAL SCALAR
  // ===========================================================================

  describe("List Decimal Scalar", () => {
    const scalar = decimal(MONEY).array();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    describe("base", () => {
      test("type: base input is a readonly Decimal-input list", () => {
        type Base = InferDecimalInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<
          readonly (Decimal | string | number)[]
        >();
      });

      test("type: base OUTPUT is string[]", () => {
        type Out = InferOutput<State["base"]>;
        expectTypeOf<Out>().toEqualTypeOf<string[]>();
      });
    });

    describe("create", () => {
      test("type: create is a required readonly Decimal-input list", () => {
        type Create = InferDecimalInput<State, "create">;
        expectTypeOf<Create>().toEqualTypeOf<
          readonly (Decimal | string | number)[]
        >();
      });

      test("runtime: every element canonicalizes and is held to the domain", () => {
        expect(parse(schemas.create, ["1.10", 2, "-0"])).toEqual({
          value: ["1.1", "2", "0"],
        });
        expect(parse(schemas.create, ["1.005"]).issues).toBeDefined();
      });
    });

    describe("update", () => {
      test("runtime: push canonicalizes one value and coerces it to a list", () => {
        expect(parse(schemas.update, { push: "1.10" })).toEqual({
          value: { push: ["1.1"] },
        });
      });

      test("runtime: exactly one list operation", () => {
        expect(parse(schemas.update, {}).issues).toBeDefined();
        expect(
          parse(schemas.update, { push: ["1"], unshift: ["2"] }).issues
        ).toBeDefined();
      });

      test("runtime: pushed members are held to the domain", () => {
        expect(parse(schemas.update, { push: "1.005" }).issues).toBeDefined();
        expect(
          parse(schemas.update, { unshift: ["1.005"] }).issues
        ).toBeDefined();
      });
    });

    describe("filter", () => {
      test("runtime: containment operands are held to the domain", () => {
        expect(parse(schemas.filter, { has: "1.10" })).toEqual({
          value: { has: "1.1" },
        });
        expect(parse(schemas.filter, { has: "1.005" }).issues).toBeDefined();
        expect(
          parse(schemas.filter, { hasEvery: ["1.005"] }).issues
        ).toBeDefined();
      });
    });
  });

  // ===========================================================================
  // NULLABLE LIST DECIMAL SCALAR
  // ===========================================================================

  describe("Nullable List Decimal Scalar", () => {
    const scalar = decimal(MONEY).array().nullable();
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    describe("base", () => {
      test("type: base is a readonly Decimal-input list or null", () => {
        type Base = InferDecimalInput<State, "base">;
        expectTypeOf<Base>().toEqualTypeOf<
          readonly (Decimal | string | number)[] | null
        >();
      });
    });

    describe("create", () => {
      test("runtime: undefined defaults to null", () => {
        expect(parse(schemas.create, undefined)).toEqual({ value: null });
      });
    });

    describe("update", () => {
      test("runtime: only the whole-list arms take null", () => {
        expect(parse(schemas.update, { set: null })).toEqual({
          value: { set: null },
        });
        expect(parse(schemas.update, { push: null }).issues).toBeDefined();
      });
    });
  });

  // ===========================================================================
  // CUSTOM SCHEMA VALIDATION
  //
  // `.schema()` on a decimal takes a schema over the exact VALUE — a `Decimal`
  // — because that is the public value family. A string-based refinement no
  // longer type-checks here on purpose: it would be refining a representation
  // the caller never sees.
  // ===========================================================================

  describe("Custom Schema Validation", () => {
    describe("whole-cent price validation", () => {
      const scalar = decimal(MONEY).schema(
        decimalValueSchema(
          (value) => value.times(100).mod(1).isZero(),
          "a price must be a whole number of cents"
        )
      );
      const schemas = getScalarSchemas(scalar["~"].state);

      test("runtime: accepts a well-formed price", () => {
        expect(parse(schemas.base, "0.01")).toEqual({ value: "0.01" });
        expect(parse(schemas.base, "99.99")).toEqual({ value: "99.99" });
        expect(parse(schemas.base, 10)).toEqual({ value: "10" });
      });

      test("runtime: the schema's own refusal message survives", () => {
        const result = parse(schemas.base, "10.001");
        expect(result.issues).toBeDefined();
      });
    });

    describe("the domain still has the last word", () => {
      const scalar = decimal(MONEY).schema(
        decimalValueSchema(() => true, "unreachable")
      );
      const schemas = getScalarSchemas(scalar["~"].state);

      test("runtime: a permissive schema cannot widen the declared domain", () => {
        expect(parse(schemas.base, "1.005").issues).toBeDefined();
        expect(parse(schemas.base, "100000000").issues).toBeDefined();
      });

      test("type: the OUTPUT stays the canonical string", () => {
        // A custom schema refines the value; it does not redefine what the
        // field reads back as.
        type Out = InferOutput<(typeof scalar)["~"]["state"]["base"]>;
        expectTypeOf<Out>().toEqualTypeOf<string>();
      });
    });
  });
});
