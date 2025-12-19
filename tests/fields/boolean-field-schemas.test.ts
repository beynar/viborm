/**
 * Boolean Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all boolean field variants:
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
import { parse } from "valibot";
import { boolean } from "../../src/schema/fields/boolean/field";
import type { InferBooleanInput } from "../../src/schema/fields/boolean/schemas";

// =============================================================================
// RAW BOOLEAN FIELD (required, no modifiers)
// =============================================================================

describe("Raw Boolean Field", () => {
  const field = boolean();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is boolean", () => {
      type Base = InferBooleanInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<boolean>();
    });

    test("runtime: parses true", () => {
      expect(parse(schemas.base, true)).toBe(true);
    });

    test("runtime: parses false", () => {
      expect(parse(schemas.base, false)).toBe(false);
    });

    test("runtime: rejects non-boolean", () => {
      expect(() => parse(schemas.base, "true")).toThrow();
      expect(() => parse(schemas.base, 1)).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required boolean", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<boolean>();
    });

    test("runtime: accepts true", () => {
      expect(parse(schemas.create, true)).toBe(true);
    });

    test("runtime: accepts false", () => {
      expect(parse(schemas.create, false)).toBe(false);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });

    test("runtime: rejects null", () => {
      expect(() => parse(schemas.create, null)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts boolean or { set: boolean }", () => {
      type Update = InferBooleanInput<State, "update">;
      expectTypeOf<boolean>().toExtend<Update>();
      expectTypeOf<{ set: boolean }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      expect(parse(schemas.update, true)).toEqual({ set: true });
      expect(parse(schemas.update, false)).toEqual({ set: false });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.update, { set: true })).toEqual({ set: true });
      expect(parse(schemas.update, { set: false })).toEqual({ set: false });
    });
  });

  describe("filter", () => {
    test("type: filter accepts boolean shorthand", () => {
      type Filter = InferBooleanInput<State, "filter">;
      expectTypeOf<boolean>().toExtend<Filter>();
    });

    test("type: filter accepts equals object", () => {
      type Filter = InferBooleanInput<State, "filter">;
      expectTypeOf<{ equals: boolean }>().toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      expect(parse(schemas.filter, true)).toEqual({ equals: true });
      expect(parse(schemas.filter, false)).toEqual({ equals: false });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.filter, { equals: true })).toEqual({ equals: true });
      expect(parse(schemas.filter, { equals: false })).toEqual({
        equals: false,
      });
    });

    test("runtime: not filter passes through", () => {
      expect(parse(schemas.filter, { not: true })).toEqual({
        not: { equals: true },
      });
      expect(parse(schemas.filter, { not: { equals: false } })).toEqual({
        not: { equals: false },
      });
    });
  });
});

// =============================================================================
// NULLABLE BOOLEAN FIELD
// =============================================================================

describe("Nullable Boolean Field", () => {
  const field = boolean().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is boolean | null", () => {
      type Base = InferBooleanInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<boolean | null>();
    });

    test("runtime: parses true", () => {
      expect(parse(schemas.base, true)).toBe(true);
    });

    test("runtime: parses false", () => {
      expect(parse(schemas.base, false)).toBe(false);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<boolean | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts true", () => {
      expect(parse(schemas.create, true)).toBe(true);
    });

    test("runtime: accepts false", () => {
      expect(parse(schemas.create, false)).toBe(false);
    });

    test("runtime: accepts null", () => {
      expect(parse(schemas.create, null)).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
    });
  });

  describe("update", () => {
    test("type: update accepts boolean, null, or { set: boolean | null }", () => {
      type Update = InferBooleanInput<State, "update">;
      expectTypeOf<boolean>().toExtend<Update>();
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: boolean | null }>().toExtend<Update>();
    });

    test("runtime: shorthand boolean transforms to { set: value }", () => {
      expect(parse(schemas.update, true)).toEqual({ set: true });
      expect(parse(schemas.update, false)).toEqual({ set: false });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.update, { set: true })).toEqual({ set: true });
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBooleanInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });

    test("runtime: object form with null passes through", () => {
      expect(parse(schemas.filter, { equals: null })).toEqual({ equals: null });
    });
  });
});

// =============================================================================
// LIST BOOLEAN FIELD (array)
// =============================================================================

describe("List Boolean Field", () => {
  const field = boolean().array();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is boolean[]", () => {
      type Base = InferBooleanInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<boolean[]>();
    });

    test("runtime: parses array of booleans", () => {
      expect(parse(schemas.base, [true, false, true])).toEqual([
        true,
        false,
        true,
      ]);
    });

    test("runtime: parses empty array", () => {
      expect(parse(schemas.base, [])).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(() => parse(schemas.base, true)).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required boolean[]", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<boolean[]>();
    });

    test("runtime: accepts array", () => {
      expect(parse(schemas.create, [true, false])).toEqual([true, false]);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts array operations", () => {
      type Update = InferBooleanInput<State, "update">;
      expectTypeOf<{ set: boolean[] }>().toExtend<Update>();
      expectTypeOf<{ push: boolean }>().toExtend<Update>();
      expectTypeOf<{ push: boolean[] }>().toExtend<Update>();
      expectTypeOf<{ unshift: boolean }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, [true, false])).toEqual({
        set: [true, false],
      });
    });

    test("runtime: set operation passes through", () => {
      expect(parse(schemas.update, { set: [true, false] })).toEqual({
        set: [true, false],
      });
    });

    test("runtime: push single element", () => {
      expect(parse(schemas.update, { push: true })).toEqual({ push: true });
    });

    test("runtime: push array of elements", () => {
      expect(parse(schemas.update, { push: [true, false] })).toEqual({
        push: [true, false],
      });
    });

    test("runtime: unshift operation", () => {
      expect(parse(schemas.update, { unshift: false })).toEqual({
        unshift: false,
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts array filters", () => {
      type Filter = InferBooleanInput<State, "filter">;
      expectTypeOf<{ has: boolean }>().toExtend<Filter>();
      expectTypeOf<{ hasEvery: boolean[] }>().toExtend<Filter>();
      expectTypeOf<{ hasSome: boolean[] }>().toExtend<Filter>();
      expectTypeOf<{ isEmpty: boolean }>().toExtend<Filter>();
      expectTypeOf<{ equals: boolean[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      expect(parse(schemas.filter, [true, false])).toEqual({
        equals: [true, false],
      });
    });

    test("runtime: has filter passes through", () => {
      expect(parse(schemas.filter, { has: true })).toEqual({ has: true });
    });

    test("runtime: hasEvery filter passes through", () => {
      expect(parse(schemas.filter, { hasEvery: [true, false] })).toEqual({
        hasEvery: [true, false],
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
// NULLABLE LIST BOOLEAN FIELD (nullable array)
// =============================================================================

describe("Nullable List Boolean Field", () => {
  const field = boolean().array().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is boolean[] | null", () => {
      type Base = InferBooleanInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<boolean[] | null>();
    });

    test("runtime: parses array of booleans", () => {
      expect(parse(schemas.base, [true, false])).toEqual([true, false]);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<boolean[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts array", () => {
      expect(parse(schemas.create, [true, false])).toEqual([true, false]);
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
      type Update = InferBooleanInput<State, "update">;
      expectTypeOf<{ set: boolean[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: boolean }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, [true, false])).toEqual({
        set: [true, false],
      });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: set null passes through", () => {
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });

    test("runtime: push operation", () => {
      expect(parse(schemas.update, { push: true })).toEqual({ push: true });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBooleanInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, [true, false])).toEqual({
        equals: [true, false],
      });
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
    const field = boolean().default(true);
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<boolean | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      expect(parse(schemas.create, false)).toBe(false);
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toBe(true);
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const field = boolean().default(() => {
      callCount++;
      return callCount % 2 === 0;
    });
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type State = (typeof field)["~"]["state"];
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<boolean | undefined>().toExtend<Create>();
    });

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      expect(result).toBe((before + 1) % 2 === 0);
    });
  });
});
