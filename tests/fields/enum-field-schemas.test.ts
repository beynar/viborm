/**
 * Enum Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all enum field variants:
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
import { parse, pipe, picklist, brand, InferOutput, Brand } from "valibot";
import { enumField } from "../../src/schema/fields/enum/field";
import type { InferEnumInput } from "../../src/schema/fields/enum/schemas";

// Test enum values
const Status = ["pending", "active", "completed"] as const;
type StatusType = (typeof Status)[number];

const Role = ["admin", "user", "guest"] as const;
type RoleType = (typeof Role)[number];

// =============================================================================
// RAW ENUM FIELD (required, no modifiers)
// =============================================================================

describe("Raw Enum Field", () => {
  const field = enumField([...Status]);
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is union of enum values", () => {
      type Base = InferEnumInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<StatusType>();
    });

    test("runtime: parses valid enum value", () => {
      expect(parse(schemas.base, "pending")).toBe("pending");
      expect(parse(schemas.base, "active")).toBe("active");
      expect(parse(schemas.base, "completed")).toBe("completed");
    });

    test("runtime: rejects invalid value", () => {
      expect(() => parse(schemas.base, "invalid")).toThrow();
      expect(() => parse(schemas.base, "")).toThrow();
    });

    test("runtime: rejects non-string", () => {
      expect(() => parse(schemas.base, 42)).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
      expect(() => parse(schemas.base, true)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required enum value", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<StatusType>();
    });

    test("runtime: accepts valid enum value", () => {
      expect(parse(schemas.create, "active")).toBe("active");
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });

    test("runtime: rejects null", () => {
      expect(() => parse(schemas.create, null)).toThrow();
    });

    test("runtime: rejects invalid value", () => {
      expect(() => parse(schemas.create, "invalid")).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts enum shorthand", () => {
      type Update = InferEnumInput<State, "update">;
      expectTypeOf<StatusType>().toExtend<Update>();
    });

    test("type: update accepts set operation", () => {
      type Update = InferEnumInput<State, "update">;
      expectTypeOf<{ set: StatusType }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      expect(parse(schemas.update, "pending")).toEqual({ set: "pending" });
      expect(parse(schemas.update, "active")).toEqual({ set: "active" });
      expect(parse(schemas.update, "completed")).toEqual({ set: "completed" });
    });

    test("runtime: set operation passes through", () => {
      expect(parse(schemas.update, { set: "active" })).toEqual({
        set: "active",
      });
    });

    test("runtime: rejects invalid value", () => {
      expect(() => parse(schemas.update, "invalid")).toThrow();
      expect(() => parse(schemas.update, { set: "invalid" })).toThrow();
    });
  });

  describe("filter", () => {
    test("type: filter accepts enum shorthand", () => {
      type Filter = InferEnumInput<State, "filter">;
      expectTypeOf<StatusType>().toExtend<Filter>();
    });

    test("type: filter accepts comparison operations", () => {
      type Filter = InferEnumInput<State, "filter">;
      expectTypeOf<{ equals: StatusType }>().toExtend<Filter>();
      expectTypeOf<{ in: StatusType[] }>().toExtend<Filter>();
      expectTypeOf<{ notIn: StatusType[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      expect(parse(schemas.filter, "active")).toEqual({ equals: "active" });
    });

    test("runtime: equals filter passes through", () => {
      expect(parse(schemas.filter, { equals: "pending" })).toEqual({
        equals: "pending",
      });
    });

    test("runtime: in filter passes through", () => {
      expect(parse(schemas.filter, { in: ["active", "completed"] })).toEqual({
        in: ["active", "completed"],
      });
    });

    test("runtime: notIn filter passes through", () => {
      expect(parse(schemas.filter, { notIn: ["pending"] })).toEqual({
        notIn: ["pending"],
      });
    });

    test("runtime: not filter with shorthand", () => {
      expect(parse(schemas.filter, { not: "pending" })).toEqual({
        not: { equals: "pending" },
      });
    });

    test("runtime: not filter with object", () => {
      expect(parse(schemas.filter, { not: { in: ["pending"] } })).toEqual({
        not: { in: ["pending"] },
      });
    });
  });
});

// =============================================================================
// NULLABLE ENUM FIELD
// =============================================================================

describe("Nullable Enum Field", () => {
  const field = enumField([...Status]).nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is enum | null", () => {
      type Base = InferEnumInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<StatusType | null>();
    });

    test("runtime: parses valid enum value", () => {
      expect(parse(schemas.base, "active")).toBe("active");
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<StatusType | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts valid enum value", () => {
      expect(parse(schemas.create, "active")).toBe("active");
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
      type Update = InferEnumInput<State, "update">;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: StatusType | null }>().toExtend<Update>();
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: shorthand enum value transforms to { set: value }", () => {
      expect(parse(schemas.update, "active")).toEqual({ set: "active" });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferEnumInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });
  });
});

// =============================================================================
// LIST ENUM FIELD (array)
// =============================================================================

describe("List Enum Field", () => {
  const field = enumField([...Status]).array();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is enum[]", () => {
      type Base = InferEnumInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<StatusType[]>();
    });

    test("runtime: parses array of enum values", () => {
      expect(parse(schemas.base, ["active", "pending"])).toEqual([
        "active",
        "pending",
      ]);
    });

    test("runtime: parses empty array", () => {
      expect(parse(schemas.base, [])).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(() => parse(schemas.base, "active")).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
    });

    test("runtime: rejects array with invalid value", () => {
      expect(() => parse(schemas.base, ["active", "invalid"])).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required enum[]", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<StatusType[]>();
    });

    test("runtime: accepts array", () => {
      expect(parse(schemas.create, ["active", "completed"])).toEqual([
        "active",
        "completed",
      ]);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts array operations", () => {
      type Update = InferEnumInput<State, "update">;
      expectTypeOf<{ set: StatusType[] }>().toExtend<Update>();
      expectTypeOf<{ push: StatusType }>().toExtend<Update>();
      expectTypeOf<{ push: StatusType[] }>().toExtend<Update>();
      expectTypeOf<{ unshift: StatusType }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, ["active", "pending"])).toEqual({
        set: ["active", "pending"],
      });
    });

    test("runtime: set operation passes through", () => {
      expect(parse(schemas.update, { set: ["completed"] })).toEqual({
        set: ["completed"],
      });
    });

    test("runtime: push single element", () => {
      expect(parse(schemas.update, { push: "active" })).toEqual({
        push: "active",
      });
    });

    test("runtime: push array of elements", () => {
      expect(parse(schemas.update, { push: ["active", "pending"] })).toEqual({
        push: ["active", "pending"],
      });
    });

    test("runtime: unshift operation", () => {
      expect(parse(schemas.update, { unshift: "pending" })).toEqual({
        unshift: "pending",
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts array filters", () => {
      type Filter = InferEnumInput<State, "filter">;
      expectTypeOf<{ has: StatusType }>().toExtend<Filter>();
      expectTypeOf<{ hasEvery: StatusType[] }>().toExtend<Filter>();
      expectTypeOf<{ hasSome: StatusType[] }>().toExtend<Filter>();
      expectTypeOf<{ isEmpty: boolean }>().toExtend<Filter>();
      expectTypeOf<{ equals: StatusType[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      expect(parse(schemas.filter, ["active", "pending"])).toEqual({
        equals: ["active", "pending"],
      });
    });

    test("runtime: has filter passes through", () => {
      expect(parse(schemas.filter, { has: "active" })).toEqual({
        has: "active",
      });
    });

    test("runtime: hasEvery filter passes through", () => {
      expect(
        parse(schemas.filter, { hasEvery: ["active", "pending"] })
      ).toEqual({
        hasEvery: ["active", "pending"],
      });
    });

    test("runtime: hasSome filter passes through", () => {
      expect(
        parse(schemas.filter, { hasSome: ["completed", "pending"] })
      ).toEqual({
        hasSome: ["completed", "pending"],
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
// NULLABLE LIST ENUM FIELD (nullable array)
// =============================================================================

describe("Nullable List Enum Field", () => {
  const field = enumField([...Status])
    .array()
    .nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is enum[] | null", () => {
      type Base = InferEnumInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<StatusType[] | null>();
    });

    test("runtime: parses array of enum values", () => {
      expect(parse(schemas.base, ["active", "pending"])).toEqual([
        "active",
        "pending",
      ]);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<StatusType[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts array", () => {
      expect(parse(schemas.create, ["active", "completed"])).toEqual([
        "active",
        "completed",
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
    test("type: update accepts null and array operations", () => {
      type Update = InferEnumInput<State, "update">;
      expectTypeOf<{ set: StatusType[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: StatusType }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, ["active", "pending"])).toEqual({
        set: ["active", "pending"],
      });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: set null passes through", () => {
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferEnumInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const field = enumField([...Status]).default("pending");
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<StatusType | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      expect(parse(schemas.create, "active")).toBe("active");
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toBe("pending");
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const values = [...Status];
    const field = enumField(values).default(() => {
      callCount++;
      return values[callCount % values.length] as StatusType;
    });
    const schemas = field["~"].schemas;

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      expect(result).toBe(values[(before + 1) % values.length]);
    });
  });
});

// =============================================================================
// DIFFERENT ENUM VALUES
// =============================================================================

describe("Different Enum Values", () => {
  const field = enumField([...Role]);
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  test("type: base is union of Role values", () => {
    type Base = InferEnumInput<State, "base">;
    expectTypeOf<Base>().toEqualTypeOf<RoleType>();
  });

  test("runtime: parses all Role values", () => {
    expect(parse(schemas.base, "admin")).toBe("admin");
    expect(parse(schemas.base, "user")).toBe("user");
    expect(parse(schemas.base, "guest")).toBe("guest");
  });

  test("runtime: rejects Status values", () => {
    expect(() => parse(schemas.base, "pending")).toThrow();
    expect(() => parse(schemas.base, "active")).toThrow();
  });
});

// =============================================================================
// CUSTOM SCHEMA VALIDATION (BRANDED TYPES)
// =============================================================================

describe("Custom Schema Validation", () => {
  describe("branded enum type", () => {
    const brandedStatus = pipe(picklist([...Status]), brand("Status"));
    const field = enumField([...Status]).schema(brandedStatus);
    type BrandedOutput = InferOutput<(typeof field)["~"]["schemas"]["base"]>;

    test("type: base output preserves brand", () => {
      expectTypeOf<BrandedOutput>().toExtend<StatusType & Brand<"Status">>();
    });

    test("runtime: validates and returns branded value", () => {
      const result = parse(field["~"].schemas.base, "active");
      expect(result).toBe("active");
    });

    test("runtime: rejects invalid value", () => {
      expect(() => parse(field["~"].schemas.base, "invalid")).toThrow();
    });
  });
});
