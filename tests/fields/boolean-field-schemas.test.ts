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
import { parse } from "../../src/validation";
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
      const result = parse(schemas.base, true);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(true);
    });

    test("runtime: parses false", () => {
      const result = parse(schemas.base, false);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(false);
    });

    test("runtime: rejects non-boolean", () => {
      expect(parse(schemas.base, "true").issues).toBeDefined();
      expect(parse(schemas.base, 1).issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required boolean", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<boolean>();
    });

    test("runtime: accepts true", () => {
      const result = parse(schemas.create, true);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(true);
    });

    test("runtime: accepts false", () => {
      const result = parse(schemas.create, false);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(false);
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
    test("type: update accepts boolean or { set: boolean }", () => {
      type Update = InferBooleanInput<State, "update">;
      expectTypeOf<boolean>().toExtend<Update>();
      expectTypeOf<{ set: boolean }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      const result1 = parse(schemas.update, true);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: true });

      const result2 = parse(schemas.update, false);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: false });
    });

    test("runtime: object form passes through", () => {
      const result1 = parse(schemas.update, { set: true });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: true });

      const result2 = parse(schemas.update, { set: false });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: false });
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
      const result1 = parse(schemas.filter, true);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ equals: true });

      const result2 = parse(schemas.filter, false);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ equals: false });
    });

    test("runtime: object form passes through", () => {
      const result1 = parse(schemas.filter, { equals: true });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ equals: true });

      const result2 = parse(schemas.filter, { equals: false });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ equals: false });
    });

    test("runtime: not filter passes through", () => {
      const result1 = parse(schemas.filter, { not: true });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ not: { equals: true } });

      const result2 = parse(schemas.filter, { not: { equals: false } });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ not: { equals: false } });
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
      const result = parse(schemas.base, true);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(true);
    });

    test("runtime: parses false", () => {
      const result = parse(schemas.base, false);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(false);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<boolean | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts true", () => {
      const result = parse(schemas.create, true);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(true);
    });

    test("runtime: accepts false", () => {
      const result = parse(schemas.create, false);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(false);
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
    test("type: update accepts boolean, null, or { set: boolean | null }", () => {
      type Update = InferBooleanInput<State, "update">;
      expectTypeOf<boolean>().toExtend<Update>();
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: boolean | null }>().toExtend<Update>();
    });

    test("runtime: shorthand boolean transforms to { set: value }", () => {
      const result1 = parse(schemas.update, true);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: true });

      const result2 = parse(schemas.update, false);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: false });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: object form passes through", () => {
      const result1 = parse(schemas.update, { set: true });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: true });

      const result2 = parse(schemas.update, { set: null });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBooleanInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      const result = parse(schemas.filter, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
    });

    test("runtime: object form with null passes through", () => {
      const result = parse(schemas.filter, { equals: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
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
      const result = parse(schemas.base, [true, false, true]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([true, false, true]);
    });

    test("runtime: parses empty array", () => {
      const result = parse(schemas.base, []);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(parse(schemas.base, true).issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required boolean[]", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<boolean[]>();
    });

    test("runtime: accepts array", () => {
      const result = parse(schemas.create, [true, false]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([true, false]);
    });

    test("runtime: rejects undefined (required)", () => {
      const result = parse(schemas.create, undefined);
      expect(result.issues).toBeDefined();
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
      const result = parse(schemas.update, [true, false]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [true, false] });
    });

    test("runtime: set operation passes through", () => {
      const result = parse(schemas.update, { set: [true, false] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [true, false] });
    });

    test("runtime: push single element (coerced to array)", () => {
      const result = parse(schemas.update, { push: true });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [true] });
    });

    test("runtime: push array of elements", () => {
      const result = parse(schemas.update, { push: [true, false] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [true, false] });
    });

    test("runtime: unshift operation (coerced to array)", () => {
      const result = parse(schemas.update, { unshift: false });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ unshift: [false] });
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
      const result = parse(schemas.filter, [true, false]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: [true, false] });
    });

    test("runtime: has filter passes through", () => {
      const result = parse(schemas.filter, { has: true });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ has: true });
    });

    test("runtime: hasEvery filter passes through", () => {
      const result = parse(schemas.filter, { hasEvery: [true, false] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ hasEvery: [true, false] });
    });

    test("runtime: isEmpty filter passes through", () => {
      const result = parse(schemas.filter, { isEmpty: true });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ isEmpty: true });
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
      const result = parse(schemas.base, [true, false]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([true, false]);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<boolean[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts array", () => {
      const result = parse(schemas.create, [true, false]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([true, false]);
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
      type Update = InferBooleanInput<State, "update">;
      expectTypeOf<{ set: boolean[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: boolean }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      const result = parse(schemas.update, [true, false]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [true, false] });
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

    test("runtime: push operation (coerced to array)", () => {
      const result = parse(schemas.update, { push: true });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [true] });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferBooleanInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      const result1 = parse(schemas.filter, [true, false]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ equals: [true, false] });

      const result2 = parse(schemas.filter, null);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ equals: null });
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
    const field = boolean().default(true);
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferBooleanInput<State, "create">;
      expectTypeOf<boolean | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      const result = parse(schemas.create, false);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(false);
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(true);
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe((before + 1) % 2 === 0);
    });
  });
});
