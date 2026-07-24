/**
 * Point Scalar Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all point scalar variants:
 * - Raw (required)
 * - Nullable (with default null)
 *
 * Note: Point scalars don't support the array() modifier.
 *
 * For each variant, tests:
 * - base: The element/scalar type
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + spatial operations
 */

import type { ScalarState } from "@schema/scalars/common";
import { point } from "@schema/scalars/point/scalar";
import { type InferInput, parse } from "@validation";
import { type GetScalarSchemas, getScalarSchemas } from "@validation/scalars";
import { describe, expect, expectTypeOf, test } from "vitest";

type InferScalarInput<
  State extends ScalarState,
  Key extends keyof GetScalarSchemas<State>,
> = InferInput<GetScalarSchemas<State>[Key]>;
type InferPointInput<
  State extends ScalarState<"point">,
  Key extends keyof GetScalarSchemas<State>,
> = InferScalarInput<State, Key>;

// =============================================================================
// RAW POINT SCALAR (required, no modifiers)
// =============================================================================

describe("Raw Point Scalar", () => {
  const scalar = point();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

  describe("base", () => {
    test("type: base is { x: number; y: number }", () => {
      type Base = InferPointInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<{ x: number; y: number }>();
    });

    test("runtime: parses point object", () => {
      const result1 = parse(schemas.base, { x: 10, y: 20 });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ x: 10, y: 20 });

      const result2 = parse(schemas.base, { x: 0.5, y: -0.3 });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ x: 0.5, y: -0.3 });

      const result3 = parse(schemas.base, { x: 0, y: 0 });
      if (result3.issues) throw new Error("Expected success");
      expect(result3.value).toEqual({ x: 0, y: 0 });
    });

    test("runtime: rejects non-object", () => {
      expect(parse(schemas.base, 42).issues).toBeDefined();
      expect(parse(schemas.base, "point").issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
      expect(parse(schemas.base, true).issues).toBeDefined();
      expect(parse(schemas.base, [10, 20]).issues).toBeDefined();
    });

    test("runtime: rejects object missing x or y", () => {
      expect(parse(schemas.base, { x: 10 }).issues).toBeDefined();
      expect(parse(schemas.base, { y: 20 }).issues).toBeDefined();
      expect(parse(schemas.base, {}).issues).toBeDefined();
    });

    test("runtime: rejects object with non-number x or y", () => {
      expect(parse(schemas.base, { x: "10", y: 20 }).issues).toBeDefined();
      expect(parse(schemas.base, { x: 10, y: "20" }).issues).toBeDefined();
      expect(parse(schemas.base, { x: null, y: 20 }).issues).toBeDefined();
      expect(parse(schemas.base, { x: 10, y: undefined }).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required { x: number; y: number }", () => {
      type Create = InferPointInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<{ x: number; y: number }>();
    });

    test("runtime: accepts point object", () => {
      const result1 = parse(schemas.create, { x: 10, y: 20 });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ x: 10, y: 20 });

      const result2 = parse(schemas.create, { x: -180, y: 90 });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ x: -180, y: 90 });
    });

    test("runtime: rejects undefined (required)", () => {
      const result = parse(schemas.create, undefined);
      expect(result.issues).toBeDefined();
    });

    test("runtime: rejects null", () => {
      const result = parse(schemas.create, null);
      expect(result.issues).toBeDefined();
    });
  });

  describe("update", () => {
    test("type: update accepts point shorthand", () => {
      type Update = InferPointInput<State, "update">;
      expectTypeOf<{ x: number; y: number }>().toExtend<Update>();
    });

    test("type: update accepts set operation", () => {
      type Update = InferPointInput<State, "update">;
      expectTypeOf<{ set: { x: number; y: number } }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      const result1 = parse(schemas.update, { x: 10, y: 20 });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: { x: 10, y: 20 } });

      const result2 = parse(schemas.update, { x: 0.5, y: -0.3 });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: { x: 0.5, y: -0.3 } });
    });

    test("runtime: set operation passes through", () => {
      const result = parse(schemas.update, { set: { x: 4, y: 5 } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: { x: 4, y: 5 } });
    });
  });

  describe("filter", () => {
    test("type: filter accepts point shorthand", () => {
      type Filter = InferPointInput<State, "filter">;
      expectTypeOf<{ x: number; y: number }>().toExtend<Filter>();
    });

    test("type: filter accepts equals operation", () => {
      type Filter = InferPointInput<State, "filter">;
      expectTypeOf<{ equals: { x: number; y: number } }>().toExtend<Filter>();
    });

    test("type: filter rejects geospatial operations (engine throws on them)", () => {
      type Filter = InferPointInput<State, "filter">;
      expectTypeOf<{
        intersects: { x: number; y: number };
      }>().not.toExtend<Filter>();
      expectTypeOf<{
        within: { x: number; y: number };
      }>().not.toExtend<Filter>();
      expectTypeOf<{
        dWithin: { geometry: { x: number; y: number }; distance: number };
      }>().not.toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      const result = parse(schemas.filter, { x: 10, y: 20 });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: { x: 10, y: 20 } });
    });

    test("runtime: equals filter passes through", () => {
      const result = parse(schemas.filter, { equals: { x: 1, y: 2 } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: { x: 1, y: 2 } });
    });

    test("runtime: spatial filters are rejected", () => {
      expect(
        parse(schemas.filter, { intersects: { x: 10, y: 20 } }).issues
      ).toBeDefined();
      expect(
        parse(schemas.filter, { within: { x: 15, y: 25 } }).issues
      ).toBeDefined();
      expect(
        parse(schemas.filter, {
          dWithin: { geometry: { x: 10, y: 20 }, distance: 1000 },
        }).issues
      ).toBeDefined();
    });

    test("runtime: not filter with shorthand", () => {
      const result = parse(schemas.filter, { not: { x: 10, y: 20 } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: { x: 10, y: 20 } } });
    });

    test("runtime: not filter with object", () => {
      const result = parse(schemas.filter, {
        not: { equals: { x: 5, y: 5 } },
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: { x: 5, y: 5 } } });
    });
  });
});

// =============================================================================
// NULLABLE POINT SCALAR
// =============================================================================

describe("Nullable Point Scalar", () => {
  const scalar = point().nullable();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

  describe("base", () => {
    test("type: base is { x: number; y: number } | null", () => {
      type Base = InferPointInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<{ x: number; y: number } | null>();
    });

    test("runtime: parses point object", () => {
      const result = parse(schemas.base, { x: 10, y: 20 });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ x: 10, y: 20 });
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferPointInput<State, "create">;
      expectTypeOf<
        { x: number; y: number } | null | undefined
      >().toExtend<Create>();
    });

    test("runtime: accepts point object", () => {
      const result = parse(schemas.create, { x: 10, y: 20 });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ x: 10, y: 20 });
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
      type Update = InferPointInput<State, "update">;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{
        set: { x: number; y: number } | null;
      }>().toExtend<Update>();
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: shorthand point transforms to { set: value }", () => {
      const result = parse(schemas.update, { x: 10, y: 20 });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: { x: 10, y: 20 } });
    });

    test("runtime: set null passes through", () => {
      const result = parse(schemas.update, { set: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: set point passes through", () => {
      const result = parse(schemas.update, { set: { x: 4, y: 5 } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: { x: 4, y: 5 } });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferPointInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      const result = parse(schemas.filter, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
    });

    test("runtime: equals null passes through", () => {
      const result = parse(schemas.filter, { equals: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const scalar = point().default({ x: 0, y: 0 });
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

    test("type: create is optional", () => {
      type Create = InferPointInput<State, "create">;
      expectTypeOf<{ x: number; y: number } | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      const result = parse(schemas.create, { x: 10, y: 20 });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ x: 10, y: 20 });
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ x: 0, y: 0 });
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const scalar = point().default(() => {
      callCount++;
      return { x: callCount * 10, y: callCount * 20 };
    });
    const schemas = getScalarSchemas(scalar["~"].state);

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({
        x: (before + 1) * 10,
        y: (before + 1) * 20,
      });
    });
  });
});

// =============================================================================
// MAP OPERATION
// =============================================================================

describe("Map Operation", () => {
  const scalar = point().map("coordinates");
  const state = scalar["~"].state;

  test("state: columnName is stored", () => {
    expect(state.columnName).toBe("coordinates");
  });

  test("map can be chained with other modifiers", () => {
    const scalar2 = point().map("location").nullable().default({ x: 0, y: 0 });
    expect(scalar2["~"].state.columnName).toBe("location");
    expect(scalar2["~"].state.nullable).toBe(true);
    expect(scalar2["~"].state.hasDefault).toBe(true);
  });
});
