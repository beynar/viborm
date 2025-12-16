/**
 * Point Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all point field variants:
 * - Raw (required)
 * - Nullable (with default null)
 *
 * Note: Point fields don't support the array() modifier.
 *
 * For each variant, tests:
 * - base: The element/field type
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + spatial operations
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse } from "valibot";
import { point } from "../../src/schema/fields/point/field";
import type { InferPointInput } from "../../src/schema/fields/point/schemas";

// =============================================================================
// RAW POINT FIELD (required, no modifiers)
// =============================================================================

describe("Raw Point Field", () => {
  const field = point();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is { x: number; y: number }", () => {
      type Base = InferPointInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<{ x: number; y: number }>();
    });

    test("runtime: parses point object", () => {
      expect(parse(schemas.base, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
      expect(parse(schemas.base, { x: 0.5, y: -0.3 })).toEqual({
        x: 0.5,
        y: -0.3,
      });
      expect(parse(schemas.base, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    });

    test("runtime: rejects non-object", () => {
      expect(() => parse(schemas.base, 42)).toThrow();
      expect(() => parse(schemas.base, "point")).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
      expect(() => parse(schemas.base, true)).toThrow();
      expect(() => parse(schemas.base, [10, 20])).toThrow();
    });

    test("runtime: rejects object missing x or y", () => {
      expect(() => parse(schemas.base, { x: 10 })).toThrow();
      expect(() => parse(schemas.base, { y: 20 })).toThrow();
      expect(() => parse(schemas.base, {})).toThrow();
    });

    test("runtime: rejects object with non-number x or y", () => {
      expect(() => parse(schemas.base, { x: "10", y: 20 })).toThrow();
      expect(() => parse(schemas.base, { x: 10, y: "20" })).toThrow();
      expect(() => parse(schemas.base, { x: null, y: 20 })).toThrow();
      expect(() => parse(schemas.base, { x: 10, y: undefined })).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required { x: number; y: number }", () => {
      type Create = InferPointInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<{ x: number; y: number }>();
    });

    test("runtime: accepts point object", () => {
      expect(parse(schemas.create, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
      expect(parse(schemas.create, { x: -180, y: 90 })).toEqual({
        x: -180,
        y: 90,
      });
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });

    test("runtime: rejects null", () => {
      expect(() => parse(schemas.create, null)).toThrow();
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
      expect(parse(schemas.update, { x: 10, y: 20 })).toEqual({
        set: { x: 10, y: 20 },
      });
      expect(parse(schemas.update, { x: 0.5, y: -0.3 })).toEqual({
        set: { x: 0.5, y: -0.3 },
      });
    });

    test("runtime: set operation passes through", () => {
      expect(parse(schemas.update, { set: { x: 4, y: 5 } })).toEqual({
        set: { x: 4, y: 5 },
      });
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

    test("type: filter accepts spatial operations", () => {
      type Filter = InferPointInput<State, "filter">;
      expectTypeOf<{
        intersects: { x: number; y: number };
      }>().toExtend<Filter>();
      expectTypeOf<{ contains: { x: number; y: number } }>().toExtend<Filter>();
      expectTypeOf<{ within: { x: number; y: number } }>().toExtend<Filter>();
      expectTypeOf<{ crosses: { x: number; y: number } }>().toExtend<Filter>();
      expectTypeOf<{ overlaps: { x: number; y: number } }>().toExtend<Filter>();
      expectTypeOf<{ touches: { x: number; y: number } }>().toExtend<Filter>();
      expectTypeOf<{ covers: { x: number; y: number } }>().toExtend<Filter>();
    });

    test("type: filter accepts dWithin operation", () => {
      type Filter = InferPointInput<State, "filter">;
      expectTypeOf<{
        dWithin: { geometry: { x: number; y: number }; distance: number };
      }>().toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      expect(parse(schemas.filter, { x: 10, y: 20 })).toEqual({
        equals: { x: 10, y: 20 },
      });
    });

    test("runtime: equals filter passes through", () => {
      expect(parse(schemas.filter, { equals: { x: 1, y: 2 } })).toEqual({
        equals: { x: 1, y: 2 },
      });
    });

    test("runtime: spatial filters pass through", () => {
      expect(parse(schemas.filter, { intersects: { x: 10, y: 20 } })).toEqual({
        intersects: { x: 10, y: 20 },
      });
      expect(parse(schemas.filter, { contains: { x: 5, y: 5 } })).toEqual({
        contains: { x: 5, y: 5 },
      });
      expect(parse(schemas.filter, { within: { x: 15, y: 25 } })).toEqual({
        within: { x: 15, y: 25 },
      });
      expect(parse(schemas.filter, { crosses: { x: 0, y: 0 } })).toEqual({
        crosses: { x: 0, y: 0 },
      });
      expect(parse(schemas.filter, { overlaps: { x: 1, y: 1 } })).toEqual({
        overlaps: { x: 1, y: 1 },
      });
      expect(parse(schemas.filter, { touches: { x: 2, y: 2 } })).toEqual({
        touches: { x: 2, y: 2 },
      });
      expect(parse(schemas.filter, { covers: { x: 3, y: 3 } })).toEqual({
        covers: { x: 3, y: 3 },
      });
    });

    test("runtime: dWithin filter passes through", () => {
      expect(
        parse(schemas.filter, {
          dWithin: { geometry: { x: 10, y: 20 }, distance: 1000 },
        })
      ).toEqual({
        dWithin: { geometry: { x: 10, y: 20 }, distance: 1000 },
      });
    });

    test("runtime: not filter with shorthand", () => {
      expect(parse(schemas.filter, { not: { x: 10, y: 20 } })).toEqual({
        not: { equals: { x: 10, y: 20 } },
      });
    });

    test("runtime: not filter with object", () => {
      expect(
        parse(schemas.filter, { not: { intersects: { x: 5, y: 5 } } })
      ).toEqual({
        not: { intersects: { x: 5, y: 5 } },
      });
    });
  });
});

// =============================================================================
// NULLABLE POINT FIELD
// =============================================================================

describe("Nullable Point Field", () => {
  const field = point().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is { x: number; y: number } | null", () => {
      type Base = InferPointInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<{ x: number; y: number } | null>();
    });

    test("runtime: parses point object", () => {
      expect(parse(schemas.base, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
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
      expect(parse(schemas.create, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
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
      type Update = InferPointInput<State, "update">;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{
        set: { x: number; y: number } | null;
      }>().toExtend<Update>();
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: shorthand point transforms to { set: value }", () => {
      expect(parse(schemas.update, { x: 10, y: 20 })).toEqual({
        set: { x: 10, y: 20 },
      });
    });

    test("runtime: set null passes through", () => {
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });

    test("runtime: set point passes through", () => {
      expect(parse(schemas.update, { set: { x: 4, y: 5 } })).toEqual({
        set: { x: 4, y: 5 },
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferPointInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });

    test("runtime: equals null passes through", () => {
      expect(parse(schemas.filter, { equals: null })).toEqual({ equals: null });
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const field = point().default({ x: 0, y: 0 });
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferPointInput<State, "create">;
      expectTypeOf<{ x: number; y: number } | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      expect(parse(schemas.create, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toEqual({ x: 0, y: 0 });
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const field = point().default(() => {
      callCount++;
      return { x: callCount * 10, y: callCount * 20 };
    });
    const schemas = field["~"].schemas;

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      expect(result).toEqual({
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
  const field = point().map("coordinates");
  const state = field["~"].state;

  test("state: columnName is stored", () => {
    expect(state.columnName).toBe("coordinates");
  });

  test("map can be chained with other modifiers", () => {
    const field2 = point().map("location").nullable().default({ x: 0, y: 0 });
    expect(field2["~"].state.columnName).toBe("location");
    expect(field2["~"].state.nullable).toBe(true);
    expect(field2["~"].state.hasDefault).toBe(true);
  });
});
