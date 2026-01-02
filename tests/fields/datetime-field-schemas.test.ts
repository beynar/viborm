/**
 * DateTime Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all datetime field variants:
 * - Raw (required)
 * - Nullable (with default null)
 * - List (array)
 * - Nullable List (nullable array)
 *
 * For each variant, tests:
 * - base: The element/field type (ISO datetime string)
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + shorthand transforms
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse } from "@validation";
import { dateTime } from "@schema/fields/datetime/field";
import type { InferDateTimeInput } from "@schema/fields/datetime/schemas";

// Test data - valid ISO datetime strings and Date objects
const validDatetime = "2024-01-15T10:30:00.000Z";
const validDatetime2 = "2024-06-20T15:45:30.500Z";
const validDate = new Date("2024-01-15T10:30:00.000Z");
const validDate2 = new Date("2024-06-20T15:45:30.500Z");
const invalidDatetime = "not-a-date";
const invalidFormat = "2024/01/15"; // wrong format

// =============================================================================
// RAW DATETIME FIELD (required, no modifiers)
// =============================================================================

describe("Raw DateTime Field", () => {
  const field = dateTime();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base input accepts Date or string", () => {
      type Base = InferDateTimeInput<State, "base">;
      expectTypeOf<string>().toExtend<Base>();
      expectTypeOf<Date>().toExtend<Base>();
    });

    test("runtime: parses valid ISO datetime string", () => {
      const result = parse(schemas.base, validDatetime);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
    });

    test("runtime: transforms Date object to ISO string", () => {
      const result = parse(schemas.base, validDate);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
    });

    test("runtime: rejects invalid datetime string", () => {
      expect(parse(schemas.base, invalidDatetime).issues).toBeDefined();
      expect(parse(schemas.base, invalidFormat).issues).toBeDefined();
    });

    test("runtime: rejects non-date/string", () => {
      expect(parse(schemas.base, 123).issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create accepts Date or string (required)", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();
    });

    test("runtime: accepts valid ISO datetime string", () => {
      const result = parse(schemas.create, validDatetime);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
    });

    test("runtime: accepts Date object and transforms to string", () => {
      const result = parse(schemas.create, validDate);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(parse(schemas.create, undefined).issues).toBeDefined();
    });

    test("runtime: rejects null", () => {
      expect(parse(schemas.create, null).issues).toBeDefined();
    });
  });

  describe("update", () => {
    test("type: update accepts Date, string, or { set: ... }", () => {
      type Update = InferDateTimeInput<State, "update">;
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<Date>().toExtend<Update>();
      expectTypeOf<{ set: string }>().toExtend<Update>();
      expectTypeOf<{ set: Date }>().toExtend<Update>();
    });

    test("runtime: shorthand string transforms to { set: value }", () => {
      const result = parse(schemas.update, validDatetime);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: validDatetime });
    });

    test("runtime: shorthand Date transforms to { set: isoString }", () => {
      const result = parse(schemas.update, validDate);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: validDatetime });
    });

    test("runtime: object form passes through", () => {
      const result = parse(schemas.update, { set: validDatetime });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: validDatetime });
    });

    test("runtime: object form with Date transforms value", () => {
      const result = parse(schemas.update, { set: validDate });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: validDatetime });
    });
  });

  describe("filter", () => {
    test("type: filter accepts string shorthand", () => {
      type Filter = InferDateTimeInput<State, "filter">;
      expectTypeOf<string>().toExtend<Filter>();
    });

    test("type: filter accepts equals object", () => {
      type Filter = InferDateTimeInput<State, "filter">;
      expectTypeOf<{ equals: string }>().toExtend<Filter>();
    });

    test("type: filter accepts comparison operators", () => {
      type Filter = InferDateTimeInput<State, "filter">;
      expectTypeOf<{ lt: string }>().toExtend<Filter>();
      expectTypeOf<{ lte: string }>().toExtend<Filter>();
      expectTypeOf<{ gt: string }>().toExtend<Filter>();
      expectTypeOf<{ gte: string }>().toExtend<Filter>();
    });

    test("type: filter accepts in/notIn operators", () => {
      type Filter = InferDateTimeInput<State, "filter">;
      expectTypeOf<{ in: string[] }>().toExtend<Filter>();
      expectTypeOf<{ notIn: string[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      const result = parse(schemas.filter, validDatetime);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: validDatetime });
    });

    test("runtime: object form passes through", () => {
      const r1 = parse(schemas.filter, { equals: validDatetime });
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ equals: validDatetime });

      const r2 = parse(schemas.filter, { lt: validDatetime });
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ lt: validDatetime });

      const r3 = parse(schemas.filter, { gte: validDatetime });
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toEqual({ gte: validDatetime });
    });

    test("runtime: in/notIn filters pass through", () => {
      const result = parse(schemas.filter, {
        in: [validDatetime, validDatetime2],
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ in: [validDatetime, validDatetime2] });
    });

    test("runtime: not filter passes through", () => {
      const r1 = parse(schemas.filter, { not: validDatetime });
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ not: { equals: validDatetime } });

      const r2 = parse(schemas.filter, { not: { equals: validDatetime } });
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ not: { equals: validDatetime } });
    });
  });
});

// =============================================================================
// NULLABLE DATETIME FIELD
// =============================================================================

describe("Nullable DateTime Field", () => {
  const field = dateTime().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base accepts Date, string, or null", () => {
      type Base = InferDateTimeInput<State, "base">;
      expectTypeOf<string>().toExtend<Base>();
      expectTypeOf<Date>().toExtend<Base>();
      expectTypeOf<null>().toExtend<Base>();
    });

    test("runtime: parses valid ISO datetime string", () => {
      const result = parse(schemas.base, validDatetime);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
    });

    test("runtime: transforms Date to ISO string", () => {
      const result = parse(schemas.base, validDate);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string | null | undefined>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();
    });

    test("runtime: accepts valid datetime string", () => {
      const result = parse(schemas.create, validDatetime);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
    });

    test("runtime: accepts Date object", () => {
      const result = parse(schemas.create, validDate);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
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
    test("type: update accepts Date, string, null, or { set: ... }", () => {
      type Update = InferDateTimeInput<State, "update">;
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<Date>().toExtend<Update>();
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: string | null }>().toExtend<Update>();
      expectTypeOf<{ set: Date }>().toExtend<Update>();
    });

    test("runtime: shorthand string transforms to { set: value }", () => {
      const result = parse(schemas.update, validDatetime);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: validDatetime });
    });

    test("runtime: shorthand Date transforms to { set: isoString }", () => {
      const result = parse(schemas.update, validDate);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: validDatetime });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: object form passes through", () => {
      const r1 = parse(schemas.update, { set: validDatetime });
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ set: validDatetime });

      const r2 = parse(schemas.update, { set: null });
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferDateTimeInput<State, "filter">;
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
// LIST DATETIME FIELD (array)
// =============================================================================

describe("List DateTime Field", () => {
  const field = dateTime().array();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base accepts (Date | string)[]", () => {
      type Base = InferDateTimeInput<State, "base">;
      expectTypeOf<string[]>().toExtend<Base>();
      expectTypeOf<Date[]>().toExtend<Base>();
      expectTypeOf<(Date | string)[]>().toExtend<Base>();
    });

    test("runtime: parses array of ISO datetime strings", () => {
      const result = parse(schemas.base, [validDatetime, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
    });

    test("runtime: transforms array of Date objects to ISO strings", () => {
      const result = parse(schemas.base, [validDate, validDate2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
    });

    test("runtime: transforms mixed array (Date + string)", () => {
      const result = parse(schemas.base, [validDate, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
    });

    test("runtime: parses empty array", () => {
      const result = parse(schemas.base, []);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(parse(schemas.base, validDatetime).issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
    });

    test("runtime: rejects array with invalid datetime", () => {
      expect(
        parse(schemas.base, [validDatetime, invalidDatetime]).issues
      ).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create accepts (Date | string)[] (required)", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string[]>().toExtend<Create>();
      expectTypeOf<Date[]>().toExtend<Create>();
    });

    test("runtime: accepts array of strings", () => {
      const result = parse(schemas.create, [validDatetime, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
    });

    test("runtime: accepts array of Dates", () => {
      const result = parse(schemas.create, [validDate, validDate2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(parse(schemas.create, undefined).issues).toBeDefined();
    });
  });

  describe("update", () => {
    test("type: update accepts array operations with Date or string", () => {
      type Update = InferDateTimeInput<State, "update">;
      expectTypeOf<{ set: string[] }>().toExtend<Update>();
      expectTypeOf<{ set: Date[] }>().toExtend<Update>();
      expectTypeOf<{ push: string }>().toExtend<Update>();
      expectTypeOf<{ push: Date }>().toExtend<Update>();
      expectTypeOf<{ push: string[] }>().toExtend<Update>();
      expectTypeOf<{ unshift: string }>().toExtend<Update>();
    });

    test("runtime: shorthand string array transforms to { set: value }", () => {
      const result = parse(schemas.update, [validDatetime, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [validDatetime, validDatetime2] });
    });

    test("runtime: shorthand Date array transforms to { set: isoStrings }", () => {
      const result = parse(schemas.update, [validDate, validDate2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [validDatetime, validDatetime2] });
    });

    test("runtime: set operation passes through", () => {
      const result = parse(schemas.update, {
        set: [validDatetime, validDatetime2],
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [validDatetime, validDatetime2] });
    });

    test("runtime: push single element (string, coerced to array)", () => {
      const result = parse(schemas.update, { push: validDatetime });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [validDatetime] });
    });

    test("runtime: push single element (Date, coerced to array)", () => {
      const result = parse(schemas.update, { push: validDate });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [validDatetime] });
    });

    test("runtime: push array of elements", () => {
      const result = parse(schemas.update, {
        push: [validDatetime, validDatetime2],
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({
        push: [validDatetime, validDatetime2],
      });
    });

    test("runtime: unshift operation (coerced to array)", () => {
      const result = parse(schemas.update, { unshift: validDatetime });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ unshift: [validDatetime] });
    });
  });

  describe("filter", () => {
    test("type: filter accepts array filters", () => {
      type Filter = InferDateTimeInput<State, "filter">;
      expectTypeOf<{ has: string }>().toExtend<Filter>();
      expectTypeOf<{ hasEvery: string[] }>().toExtend<Filter>();
      expectTypeOf<{ hasSome: string[] }>().toExtend<Filter>();
      expectTypeOf<{ isEmpty: boolean }>().toExtend<Filter>();
      expectTypeOf<{ equals: string[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      const result = parse(schemas.filter, [validDatetime, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: [validDatetime, validDatetime2] });
    });

    test("runtime: has filter passes through", () => {
      const result = parse(schemas.filter, { has: validDatetime });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ has: validDatetime });
    });

    test("runtime: hasEvery filter passes through", () => {
      const result = parse(schemas.filter, {
        hasEvery: [validDatetime, validDatetime2],
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({
        hasEvery: [validDatetime, validDatetime2],
      });
    });

    test("runtime: isEmpty filter passes through", () => {
      const result = parse(schemas.filter, { isEmpty: true });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ isEmpty: true });
    });
  });
});

// =============================================================================
// NULLABLE LIST DATETIME FIELD (nullable array)
// =============================================================================

describe("Nullable List DateTime Field", () => {
  const field = dateTime().array().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base accepts (Date | string)[] or null", () => {
      type Base = InferDateTimeInput<State, "base">;
      expectTypeOf<string[]>().toExtend<Base>();
      expectTypeOf<Date[]>().toExtend<Base>();
      expectTypeOf<null>().toExtend<Base>();
    });

    test("runtime: parses array of datetime strings", () => {
      const result = parse(schemas.base, [validDatetime, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
    });

    test("runtime: transforms array of Dates", () => {
      const result = parse(schemas.base, [validDate, validDate2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string[] | null | undefined>().toExtend<Create>();
      expectTypeOf<Date[]>().toExtend<Create>();
    });

    test("runtime: accepts string array", () => {
      const result = parse(schemas.create, [validDatetime, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
    });

    test("runtime: accepts Date array", () => {
      const result = parse(schemas.create, [validDate, validDate2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([validDatetime, validDatetime2]);
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
    test("type: update accepts null, Date/string arrays, and operations", () => {
      type Update = InferDateTimeInput<State, "update">;
      expectTypeOf<{ set: string[] | null }>().toExtend<Update>();
      expectTypeOf<{ set: Date[] }>().toExtend<Update>();
      expectTypeOf<{ push: string }>().toExtend<Update>();
      expectTypeOf<{ push: Date }>().toExtend<Update>();
    });

    test("runtime: shorthand string array transforms to { set: value }", () => {
      const result = parse(schemas.update, [validDatetime, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [validDatetime, validDatetime2] });
    });

    test("runtime: shorthand Date array transforms to { set: isoStrings }", () => {
      const result = parse(schemas.update, [validDate, validDate2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [validDatetime, validDatetime2] });
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

    test("runtime: push operation with string (coerced to array)", () => {
      const result = parse(schemas.update, { push: validDatetime });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [validDatetime] });
    });

    test("runtime: push operation with Date (coerced to array)", () => {
      const result = parse(schemas.update, { push: validDate });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: [validDatetime] });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferDateTimeInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      const result = parse(schemas.filter, [validDatetime, validDatetime2]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: [validDatetime, validDatetime2] });
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
  describe("static default value (string)", () => {
    const field = dateTime().default(validDatetime);
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional, accepts Date or string", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();
    });

    test("runtime: accepts string value", () => {
      const result = parse(schemas.create, validDatetime2);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime2);
    });

    test("runtime: accepts Date value", () => {
      const result = parse(schemas.create, validDate2);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime2);
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(validDatetime);
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const field = dateTime().default(() => {
      callCount++;
      return `2024-01-${String(callCount).padStart(2, "0")}T00:00:00.000Z`;
    });
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type State = (typeof field)["~"]["state"];
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();
    });

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(
        `2024-01-${String(before + 1).padStart(2, "0")}T00:00:00.000Z`
      );
    });
  });

  describe("auto-generated fields", () => {
    test("now(): type is optional, runtime uses generator", () => {
      const field = dateTime().now();
      type State = (typeof field)["~"]["state"];
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      // Should be a valid ISO datetime
      expect(() =>
        new Date(result.value as string).toISOString()
      ).not.toThrow();
    });

    test("updatedAt(): type is optional, runtime uses generator", () => {
      const field = dateTime().updatedAt();
      type State = (typeof field)["~"]["state"];
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      // Should be a valid ISO datetime
      expect(() =>
        new Date(result.value as string).toISOString()
      ).not.toThrow();
    });
  });
});
