/**
 * Vector Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all vector field variants:
 * - Raw (required)
 * - Nullable (with default null)
 *
 * Note: Vector fields are already arrays (number[]), so they don't support the array() modifier.
 *
 * For each variant, tests:
 * - base: The element/field type
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + shorthand transforms
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse } from "valibot";
import { vector } from "../../src/schema/fields/vector/field";
import type { InferVectorInput } from "../../src/schema/fields/vector/schemas";

// =============================================================================
// RAW VECTOR FIELD (required, no modifiers)
// =============================================================================

describe("Raw Vector Field", () => {
  const field = vector();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is number[]", () => {
      type Base = InferVectorInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<number[]>();
    });

    test("runtime: parses array of numbers", () => {
      expect(parse(schemas.base, [1, 2, 3])).toEqual([1, 2, 3]);
      expect(parse(schemas.base, [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
      expect(parse(schemas.base, [])).toEqual([]);
    });

    test("runtime: parses large arrays", () => {
      const largeArray = Array.from({ length: 384 }, (_, i) => i);
      expect(parse(schemas.base, largeArray)).toEqual(largeArray);
    });

    test("runtime: rejects non-array", () => {
      expect(() => parse(schemas.base, 42)).toThrow();
      expect(() => parse(schemas.base, "array")).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
      expect(() => parse(schemas.base, true)).toThrow();
    });

    test("runtime: rejects array with non-numbers", () => {
      expect(() => parse(schemas.base, [1, "2", 3])).toThrow();
      expect(() => parse(schemas.base, [1, null, 3])).toThrow();
      expect(() => parse(schemas.base, [1, undefined, 3])).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required number[]", () => {
      type Create = InferVectorInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<number[]>();
    });

    test("runtime: accepts number array", () => {
      expect(parse(schemas.create, [1, 2, 3])).toEqual([1, 2, 3]);
      expect(parse(schemas.create, [0.5, 1.5, 2.5])).toEqual([0.5, 1.5, 2.5]);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });

    test("runtime: rejects null", () => {
      expect(() => parse(schemas.create, null)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts number[] shorthand", () => {
      type Update = InferVectorInput<State, "update">;
      expectTypeOf<number[]>().toExtend<Update>();
    });

    test("type: update accepts set operation", () => {
      type Update = InferVectorInput<State, "update">;
      expectTypeOf<{ set: number[] }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      expect(parse(schemas.update, [1, 2, 3])).toEqual({ set: [1, 2, 3] });
      expect(parse(schemas.update, [0.1, 0.2])).toEqual({
        set: [0.1, 0.2],
      });
      expect(parse(schemas.update, [])).toEqual({ set: [] });
    });

    test("runtime: set operation passes through", () => {
      expect(parse(schemas.update, { set: [4, 5, 6] })).toEqual({
        set: [4, 5, 6],
      });
      expect(parse(schemas.update, { set: [0.9, 0.8, 0.7] })).toEqual({
        set: [0.9, 0.8, 0.7],
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts number[] shorthand", () => {
      type Filter = InferVectorInput<State, "filter">;
      expectTypeOf<number[]>().toExtend<Filter>();
    });

    test("type: filter accepts equals operation", () => {
      type Filter = InferVectorInput<State, "filter">;
      expectTypeOf<{ equals: number[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      expect(parse(schemas.filter, [1, 2, 3])).toEqual({
        equals: [1, 2, 3],
      });
      expect(parse(schemas.filter, [0.5, 0.6])).toEqual({
        equals: [0.5, 0.6],
      });
    });

    test("runtime: equals filter passes through", () => {
      expect(parse(schemas.filter, { equals: [1, 2, 3] })).toEqual({
        equals: [1, 2, 3],
      });
      expect(parse(schemas.filter, { equals: [0.1, 0.2, 0.3] })).toEqual({
        equals: [0.1, 0.2, 0.3],
      });
    });

    test("runtime: not filter with shorthand", () => {
      expect(parse(schemas.filter, { not: [1, 2, 3] })).toEqual({
        not: { equals: [1, 2, 3] },
      });
    });

    test("runtime: not filter with object", () => {
      expect(parse(schemas.filter, { not: { equals: [4, 5, 6] } })).toEqual({
        not: { equals: [4, 5, 6] },
      });
    });
  });
});

// =============================================================================
// NULLABLE VECTOR FIELD
// =============================================================================

describe("Nullable Vector Field", () => {
  const field = vector().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is number[] | null", () => {
      type Base = InferVectorInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<number[] | null>();
    });

    test("runtime: parses number array", () => {
      expect(parse(schemas.base, [1, 2, 3])).toEqual([1, 2, 3]);
      expect(parse(schemas.base, [0.1, 0.2])).toEqual([0.1, 0.2]);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferVectorInput<State, "create">;
      expectTypeOf<number[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts number array", () => {
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
    test("type: update accepts null", () => {
      type Update = InferVectorInput<State, "update">;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: number[] | null }>().toExtend<Update>();
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, [1, 2, 3])).toEqual({ set: [1, 2, 3] });
    });

    test("runtime: set null passes through", () => {
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });

    test("runtime: set array passes through", () => {
      expect(parse(schemas.update, { set: [4, 5, 6] })).toEqual({
        set: [4, 5, 6],
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferVectorInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });

    test("runtime: equals null passes through", () => {
      expect(parse(schemas.filter, { equals: null })).toEqual({
        equals: null,
      });
    });
  });
});

// =============================================================================
// DIMENSION PROPERTY (vector-specific)
// =============================================================================

describe("Dimension Property", () => {
  describe("dimension set via chain", () => {
    const field = vector().dimension(128);
    const state = field["~"].state;

    test("state: dimension is stored", () => {
      expect((state as any).dimension).toBe(128);
    });

    test("type: dimension is preserved in state", () => {
      type State = (typeof field)["~"]["state"];
      expectTypeOf<State & { dimension: number }>().toExtend<State>();
    });

    test("dimension can be chained with nullable", () => {
      const fieldWithNull = vector().dimension(256).nullable();
      expect((fieldWithNull["~"].state as any).dimension).toBe(256);
      expect(fieldWithNull["~"].state.nullable).toBe(true);
    });
  });

  describe("dimension with default value", () => {
    const field = vector().dimension(64).default([1, 2, 3, 4]);
    const state = field["~"].state;

    test("state: both dimension and default are stored", () => {
      expect((state as any).dimension).toBe(64);
      expect(state.hasDefault).toBe(true);
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const field = vector().default([0.1, 0.2, 0.3]);
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferVectorInput<State, "create">;
      expectTypeOf<number[] | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      expect(parse(schemas.create, [1, 2, 3])).toEqual([1, 2, 3]);
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const field = vector().default(() => {
      callCount++;
      return Array.from({ length: 3 }, (_, i) => callCount * (i + 1));
    });
    const schemas = field["~"].schemas;

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      expect(result).toEqual([
        (before + 1) * 1,
        (before + 1) * 2,
        (before + 1) * 3,
      ]);
    });
  });

  describe("default with dimension", () => {
    const field = vector()
      .dimension(128)
      .default(() => Array(128).fill(0));
    const schemas = field["~"].schemas;

    test("runtime: default function can use dimension", () => {
      const result = parse(schemas.create, undefined);
      expect(result).toHaveLength(128);
      expect(result.every((v) => v === 0)).toBe(true);
    });
  });
});

// =============================================================================
// MAP OPERATION
// =============================================================================

describe("Map Operation", () => {
  const field = vector().map("embedding_vector");
  const state = field["~"].state;

  test("state: columnName is stored", () => {
    expect(state.columnName).toBe("embedding_vector");
  });

  test("map can be chained with other modifiers", () => {
    const field2 = vector().map("vec").nullable().default([1, 2, 3]);
    expect(field2["~"].state.columnName).toBe("vec");
    expect(field2["~"].state.nullable).toBe(true);
    expect(field2["~"].state.hasDefault).toBe(true);
  });
});
