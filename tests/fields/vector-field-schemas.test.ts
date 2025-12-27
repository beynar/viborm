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
import { parse } from "../../src/validation";
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
      const result1 = parse(schemas.base, [1, 2, 3]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual([1, 2, 3]);

      const result2 = parse(schemas.base, [0.1, 0.2, 0.3]);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual([0.1, 0.2, 0.3]);

      const result3 = parse(schemas.base, []);
      if (result3.issues) throw new Error("Expected success");
      expect(result3.value).toEqual([]);
    });

    test("runtime: parses large arrays", () => {
      const largeArray = Array.from({ length: 384 }, (_, i) => i);
      const result = parse(schemas.base, largeArray);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(largeArray);
    });

    test("runtime: rejects non-array", () => {
      expect(parse(schemas.base, 42).issues).toBeDefined();
      expect(parse(schemas.base, "array").issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
      expect(parse(schemas.base, true).issues).toBeDefined();
    });

    test("runtime: rejects array with non-numbers", () => {
      expect(parse(schemas.base, [1, "2", 3]).issues).toBeDefined();
      expect(parse(schemas.base, [1, null, 3]).issues).toBeDefined();
      expect(parse(schemas.base, [1, undefined, 3]).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required number[]", () => {
      type Create = InferVectorInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<number[]>();
    });

    test("runtime: accepts number array", () => {
      const result1 = parse(schemas.create, [1, 2, 3]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual([1, 2, 3]);

      const result2 = parse(schemas.create, [0.5, 1.5, 2.5]);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual([0.5, 1.5, 2.5]);
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
    test("type: update accepts number[] shorthand", () => {
      type Update = InferVectorInput<State, "update">;
      expectTypeOf<number[]>().toExtend<Update>();
    });

    test("type: update accepts set operation", () => {
      type Update = InferVectorInput<State, "update">;
      expectTypeOf<{ set: number[] }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      const result1 = parse(schemas.update, [1, 2, 3]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: [1, 2, 3] });

      const result2 = parse(schemas.update, [0.1, 0.2]);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: [0.1, 0.2] });

      const result3 = parse(schemas.update, []);
      if (result3.issues) throw new Error("Expected success");
      expect(result3.value).toEqual({ set: [] });
    });

    test("runtime: set operation passes through", () => {
      const result1 = parse(schemas.update, { set: [4, 5, 6] });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: [4, 5, 6] });

      const result2 = parse(schemas.update, { set: [0.9, 0.8, 0.7] });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: [0.9, 0.8, 0.7] });
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
      const result1 = parse(schemas.filter, [1, 2, 3]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ equals: [1, 2, 3] });

      const result2 = parse(schemas.filter, [0.5, 0.6]);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ equals: [0.5, 0.6] });
    });

    test("runtime: equals filter passes through", () => {
      const result1 = parse(schemas.filter, { equals: [1, 2, 3] });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ equals: [1, 2, 3] });

      const result2 = parse(schemas.filter, { equals: [0.1, 0.2, 0.3] });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ equals: [0.1, 0.2, 0.3] });
    });

    test("runtime: not filter with shorthand", () => {
      const result = parse(schemas.filter, { not: [1, 2, 3] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: [1, 2, 3] } });
    });

    test("runtime: not filter with object", () => {
      const result = parse(schemas.filter, { not: { equals: [4, 5, 6] } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: [4, 5, 6] } });
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
      const result1 = parse(schemas.base, [1, 2, 3]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual([1, 2, 3]);

      const result2 = parse(schemas.base, [0.1, 0.2]);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual([0.1, 0.2]);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferVectorInput<State, "create">;
      expectTypeOf<number[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts number array", () => {
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
    test("type: update accepts null", () => {
      type Update = InferVectorInput<State, "update">;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: number[] | null }>().toExtend<Update>();
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      const result = parse(schemas.update, [1, 2, 3]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [1, 2, 3] });
    });

    test("runtime: set null passes through", () => {
      const result = parse(schemas.update, { set: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: set array passes through", () => {
      const result = parse(schemas.update, { set: [4, 5, 6] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [4, 5, 6] });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferVectorInput<State, "filter">;
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
      const result = parse(schemas.create, [1, 2, 3]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([1, 2, 3]);
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([0.1, 0.2, 0.3]);
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toHaveLength(128);
      expect(result.value.every((v) => v === 0)).toBe(true);
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
