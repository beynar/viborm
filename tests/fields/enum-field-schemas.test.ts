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

import { enumField } from "@schema/fields/enum/field";
import type { InferEnumInput } from "@schema/fields/enum/schemas";
import { type Prettify, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

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
      const r1 = parse(schemas.base, "pending");
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toBe("pending");

      const r2 = parse(schemas.base, "active");
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toBe("active");

      const r3 = parse(schemas.base, "completed");
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toBe("completed");
    });

    test("runtime: rejects invalid value", () => {
      expect(parse(schemas.base, "invalid").issues).toBeDefined();
      expect(parse(schemas.base, "").issues).toBeDefined();
    });

    test("runtime: rejects non-string", () => {
      expect(parse(schemas.base, 42).issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
      expect(parse(schemas.base, true).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required enum value", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<StatusType>();
    });

    test("runtime: accepts valid enum value", () => {
      const result = parse(schemas.create, "active");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("active");
    });

    test("runtime: rejects undefined (required)", () => {
      const result = parse(schemas.create, undefined);
      expect(result.issues).toBeDefined();
    });

    test("runtime: rejects null", () => {
      const result = parse(schemas.create, null);
      expect(result.issues).toBeDefined();
    });

    test("runtime: rejects invalid value", () => {
      const result = parse(schemas.create, "invalid");
      expect(result.issues).toBeDefined();
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
      const r1 = parse(schemas.update, "pending");
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ set: "pending" });

      const r2 = parse(schemas.update, "active");
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ set: "active" });

      const r3 = parse(schemas.update, "completed");
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toEqual({ set: "completed" });
    });

    test("runtime: set operation passes through", () => {
      const result = parse(schemas.update, { set: "active" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: "active" });
    });

    test("runtime: rejects invalid value", () => {
      expect(parse(schemas.update, "invalid").issues).toBeDefined();
      expect(parse(schemas.update, { set: "invalid" }).issues).toBeDefined();
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
      const result = parse(schemas.filter, "active");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: "active" });
    });

    test("runtime: equals filter passes through", () => {
      const result = parse(schemas.filter, { equals: "pending" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: "pending" });
    });

    test("runtime: in filter passes through", () => {
      const result = parse(schemas.filter, { in: ["active", "completed"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ in: ["active", "completed"] });
    });

    test("runtime: notIn filter passes through", () => {
      const result = parse(schemas.filter, { notIn: ["pending"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ notIn: ["pending"] });
    });

    test("runtime: not filter with shorthand", () => {
      const result = parse(schemas.filter, { not: "pending" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: "pending" } });
    });

    test("runtime: not filter with object", () => {
      const result = parse(schemas.filter, { not: { in: ["pending"] } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ not: { in: ["pending"] } });
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
      const result = parse(schemas.base, "active");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("active");
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<StatusType | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts valid enum value", () => {
      const result = parse(schemas.create, "active");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("active");
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
      type Update = Prettify<InferEnumInput<State, "update">>;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: StatusType | null }>().toExtend<Update>();
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: shorthand enum value transforms to { set: value }", () => {
      const result = parse(schemas.update, "active");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: "active" });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferEnumInput<State, "filter">;
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
      const result = parse(schemas.base, ["active", "pending"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(["active", "pending"]);
    });

    test("runtime: parses empty array", () => {
      const result = parse(schemas.base, []);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(parse(schemas.base, "active").issues).toBeDefined();
      expect(parse(schemas.base, null).issues).toBeDefined();
    });

    test("runtime: rejects array with invalid value", () => {
      expect(parse(schemas.base, ["active", "invalid"]).issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required enum[]", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<StatusType[]>();
    });

    test("runtime: accepts array", () => {
      const result = parse(schemas.create, ["active", "completed"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(["active", "completed"]);
    });

    test("runtime: rejects undefined (required)", () => {
      const result = parse(schemas.create, undefined);
      expect(result.issues).toBeDefined();
    });
  });

  describe("update", () => {
    test("type: update accepts array operations", () => {
      type Update = Prettify<InferEnumInput<State, "update">>;
      expectTypeOf<{ set: StatusType[] }>().toExtend<Update>();
      expectTypeOf<{ push: StatusType }>().toExtend<Update>();
      expectTypeOf<{ push: StatusType[] }>().toExtend<Update>();
      expectTypeOf<{ unshift: StatusType }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      const result = parse(schemas.update, ["active", "pending"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: ["active", "pending"] });
    });

    test("runtime: set operation passes through", () => {
      const result = parse(schemas.update, { set: ["completed"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: ["completed"] });
    });

    test("runtime: push single element (coerced to array)", () => {
      const result = parse(schemas.update, { push: "active" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: ["active"] });
    });

    test("runtime: push array of elements", () => {
      const result = parse(schemas.update, { push: ["active", "pending"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ push: ["active", "pending"] });
    });

    test("runtime: unshift operation (coerced to array)", () => {
      const result = parse(schemas.update, { unshift: "pending" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toMatchObject({ unshift: ["pending"] });
    });
  });

  describe("filter", () => {
    test("type: filter accepts array filters", () => {
      type Filter = Prettify<InferEnumInput<State, "filter">>;
      expectTypeOf<{ has: StatusType }>().toExtend<Filter>();
      expectTypeOf<{ hasEvery: StatusType[] }>().toExtend<Filter>();
      expectTypeOf<{ hasSome: StatusType[] }>().toExtend<Filter>();
      expectTypeOf<{ isEmpty: boolean }>().toExtend<Filter>();
      expectTypeOf<{ equals: StatusType[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      const result = parse(schemas.filter, ["active", "pending"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: ["active", "pending"] });
    });

    test("runtime: has filter passes through", () => {
      const result = parse(schemas.filter, { has: "active" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ has: "active" });
    });

    test("runtime: hasEvery filter passes through", () => {
      const result = parse(schemas.filter, {
        hasEvery: ["active", "pending"],
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ hasEvery: ["active", "pending"] });
    });

    test("runtime: hasSome filter passes through", () => {
      const result = parse(schemas.filter, {
        hasSome: ["completed", "pending"],
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ hasSome: ["completed", "pending"] });
    });

    test("runtime: isEmpty filter passes through", () => {
      const result = parse(schemas.filter, { isEmpty: true });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ isEmpty: true });
    });
  });
});

// =============================================================================
// NULLABLE LIST ENUM FIELD (nullable array)
// =============================================================================

// Note: Nullable List Enum has issues with the VibSchema implementation - skipping for now
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
      const result = parse(schemas.base, ["active", "pending"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(["active", "pending"]);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferEnumInput<State, "create">;
      expectTypeOf<StatusType[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts array", () => {
      const result = parse(schemas.create, ["active", "completed"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(["active", "completed"]);
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
      type Update = InferEnumInput<State, "update">;
      expectTypeOf<{ set: StatusType[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: StatusType }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      const result = parse(schemas.update, ["active", "pending"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: ["active", "pending"] });
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
      type Filter = InferEnumInput<State, "filter">;
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
      const result = parse(schemas.create, "active");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("active");
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("pending");
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(values[(before + 1) % values.length]);
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
    const r1 = parse(schemas.base, "admin");
    if (r1.issues) throw new Error("Expected success");
    expect(r1.value).toBe("admin");

    const r2 = parse(schemas.base, "user");
    if (r2.issues) throw new Error("Expected success");
    expect(r2.value).toBe("user");

    const r3 = parse(schemas.base, "guest");
    if (r3.issues) throw new Error("Expected success");
    expect(r3.value).toBe("guest");
  });

  test("runtime: rejects Status values", () => {
    expect(parse(schemas.base, "pending").issues).toBeDefined();
    expect(parse(schemas.base, "active").issues).toBeDefined();
  });
});
