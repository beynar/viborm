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
import { parse } from "valibot";
import { dateTime } from "../../src/schema/fields/datetime/field";
import type { InferDateTimeInput } from "../../src/schema/fields/datetime/schemas";

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
      expect(parse(schemas.base, validDatetime)).toBe(validDatetime);
    });

    test("runtime: transforms Date object to ISO string", () => {
      expect(parse(schemas.base, validDate)).toBe(validDatetime);
    });

    test("runtime: rejects invalid datetime string", () => {
      expect(() => parse(schemas.base, invalidDatetime)).toThrow();
      expect(() => parse(schemas.base, invalidFormat)).toThrow();
    });

    test("runtime: rejects non-date/string", () => {
      expect(() => parse(schemas.base, 123)).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create accepts Date or string (required)", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();
    });

    test("runtime: accepts valid ISO datetime string", () => {
      expect(parse(schemas.create, validDatetime)).toBe(validDatetime);
    });

    test("runtime: accepts Date object and transforms to string", () => {
      expect(parse(schemas.create, validDate)).toBe(validDatetime);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });

    test("runtime: rejects null", () => {
      expect(() => parse(schemas.create, null)).toThrow();
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
      expect(parse(schemas.update, validDatetime)).toEqual({
        set: validDatetime,
      });
    });

    test("runtime: shorthand Date transforms to { set: isoString }", () => {
      expect(parse(schemas.update, validDate)).toEqual({
        set: validDatetime,
      });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.update, { set: validDatetime })).toEqual({
        set: validDatetime,
      });
    });

    test("runtime: object form with Date transforms value", () => {
      expect(parse(schemas.update, { set: validDate })).toEqual({
        set: validDatetime,
      });
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
      expect(parse(schemas.filter, validDatetime)).toEqual({
        equals: validDatetime,
      });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.filter, { equals: validDatetime })).toEqual({
        equals: validDatetime,
      });
      expect(parse(schemas.filter, { lt: validDatetime })).toEqual({
        lt: validDatetime,
      });
      expect(parse(schemas.filter, { gte: validDatetime })).toEqual({
        gte: validDatetime,
      });
    });

    test("runtime: in/notIn filters pass through", () => {
      expect(
        parse(schemas.filter, { in: [validDatetime, validDatetime2] })
      ).toEqual({
        in: [validDatetime, validDatetime2],
      });
    });

    test("runtime: not filter passes through", () => {
      expect(parse(schemas.filter, { not: validDatetime })).toEqual({
        not: { equals: validDatetime },
      });
      expect(parse(schemas.filter, { not: { equals: validDatetime } })).toEqual(
        {
          not: { equals: validDatetime },
        }
      );
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
      expect(parse(schemas.base, validDatetime)).toBe(validDatetime);
    });

    test("runtime: transforms Date to ISO string", () => {
      expect(parse(schemas.base, validDate)).toBe(validDatetime);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string | null | undefined>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();
    });

    test("runtime: accepts valid datetime string", () => {
      expect(parse(schemas.create, validDatetime)).toBe(validDatetime);
    });

    test("runtime: accepts Date object", () => {
      expect(parse(schemas.create, validDate)).toBe(validDatetime);
    });

    test("runtime: accepts null", () => {
      expect(parse(schemas.create, null)).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
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
      expect(parse(schemas.update, validDatetime)).toEqual({
        set: validDatetime,
      });
    });

    test("runtime: shorthand Date transforms to { set: isoString }", () => {
      expect(parse(schemas.update, validDate)).toEqual({
        set: validDatetime,
      });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.update, { set: validDatetime })).toEqual({
        set: validDatetime,
      });
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferDateTimeInput<State, "filter">;
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
      expect(parse(schemas.base, [validDatetime, validDatetime2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: transforms array of Date objects to ISO strings", () => {
      expect(parse(schemas.base, [validDate, validDate2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: transforms mixed array (Date + string)", () => {
      expect(parse(schemas.base, [validDate, validDatetime2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: parses empty array", () => {
      expect(parse(schemas.base, [])).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(() => parse(schemas.base, validDatetime)).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
    });

    test("runtime: rejects array with invalid datetime", () => {
      expect(() =>
        parse(schemas.base, [validDatetime, invalidDatetime])
      ).toThrow();
    });
  });

  describe("create", () => {
    test("type: create accepts (Date | string)[] (required)", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string[]>().toExtend<Create>();
      expectTypeOf<Date[]>().toExtend<Create>();
    });

    test("runtime: accepts array of strings", () => {
      expect(parse(schemas.create, [validDatetime, validDatetime2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: accepts array of Dates", () => {
      expect(parse(schemas.create, [validDate, validDate2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
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
      expect(parse(schemas.update, [validDatetime, validDatetime2])).toEqual({
        set: [validDatetime, validDatetime2],
      });
    });

    test("runtime: shorthand Date array transforms to { set: isoStrings }", () => {
      expect(parse(schemas.update, [validDate, validDate2])).toEqual({
        set: [validDatetime, validDatetime2],
      });
    });

    test("runtime: set operation passes through", () => {
      expect(
        parse(schemas.update, { set: [validDatetime, validDatetime2] })
      ).toEqual({
        set: [validDatetime, validDatetime2],
      });
    });

    test("runtime: push single element (string)", () => {
      expect(parse(schemas.update, { push: validDatetime })).toEqual({
        push: validDatetime,
      });
    });

    test("runtime: push single element (Date)", () => {
      expect(parse(schemas.update, { push: validDate })).toEqual({
        push: validDatetime,
      });
    });

    test("runtime: push array of elements", () => {
      expect(
        parse(schemas.update, { push: [validDatetime, validDatetime2] })
      ).toEqual({
        push: [validDatetime, validDatetime2],
      });
    });

    test("runtime: unshift operation", () => {
      expect(parse(schemas.update, { unshift: validDatetime })).toEqual({
        unshift: validDatetime,
      });
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
      expect(parse(schemas.filter, [validDatetime, validDatetime2])).toEqual({
        equals: [validDatetime, validDatetime2],
      });
    });

    test("runtime: has filter passes through", () => {
      expect(parse(schemas.filter, { has: validDatetime })).toEqual({
        has: validDatetime,
      });
    });

    test("runtime: hasEvery filter passes through", () => {
      expect(
        parse(schemas.filter, { hasEvery: [validDatetime, validDatetime2] })
      ).toEqual({
        hasEvery: [validDatetime, validDatetime2],
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
      expect(parse(schemas.base, [validDatetime, validDatetime2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: transforms array of Dates", () => {
      expect(parse(schemas.base, [validDate, validDate2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string[] | null | undefined>().toExtend<Create>();
      expectTypeOf<Date[]>().toExtend<Create>();
    });

    test("runtime: accepts string array", () => {
      expect(parse(schemas.create, [validDatetime, validDatetime2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: accepts Date array", () => {
      expect(parse(schemas.create, [validDate, validDate2])).toEqual([
        validDatetime,
        validDatetime2,
      ]);
    });

    test("runtime: accepts null", () => {
      expect(parse(schemas.create, null)).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
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
      expect(parse(schemas.update, [validDatetime, validDatetime2])).toEqual({
        set: [validDatetime, validDatetime2],
      });
    });

    test("runtime: shorthand Date array transforms to { set: isoStrings }", () => {
      expect(parse(schemas.update, [validDate, validDate2])).toEqual({
        set: [validDatetime, validDatetime2],
      });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: set null passes through", () => {
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });

    test("runtime: push operation with string", () => {
      expect(parse(schemas.update, { push: validDatetime })).toEqual({
        push: validDatetime,
      });
    });

    test("runtime: push operation with Date", () => {
      expect(parse(schemas.update, { push: validDate })).toEqual({
        push: validDatetime,
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferDateTimeInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      expect(parse(schemas.filter, [validDatetime, validDatetime2])).toEqual({
        equals: [validDatetime, validDatetime2],
      });
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
      expect(parse(schemas.create, validDatetime2)).toBe(validDatetime2);
    });

    test("runtime: accepts Date value", () => {
      expect(parse(schemas.create, validDate2)).toBe(validDatetime2);
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toBe(validDatetime);
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
      expect(result).toBe(
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
      expect(typeof result).toBe("string");
      // Should be a valid ISO datetime
      expect(() => new Date(result as string).toISOString()).not.toThrow();
    });

    test("updatedAt(): type is optional, runtime uses generator", () => {
      const field = dateTime().updatedAt();
      type State = (typeof field)["~"]["state"];
      type Create = InferDateTimeInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();
      expectTypeOf<Date>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      expect(typeof result).toBe("string");
      // Should be a valid ISO datetime
      expect(() => new Date(result as string).toISOString()).not.toThrow();
    });
  });
});
