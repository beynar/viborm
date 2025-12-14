/**
 * JSON Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all JSON field variants:
 * - Raw (required)
 * - Nullable (with default null)
 * - Custom schema (typed JSON)
 *
 * For each variant, tests:
 * - base: The element/field type
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates (no shorthand - must use { set: value })
 * - filter: Input type for filtering (no shorthand - must use { equals: value })
 *
 * Note: JSON fields do NOT support shorthand syntax because JSON values can be objects,
 * making it impossible to distinguish between operations and values. This matches Prisma's behavior.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { parse, object, string, number, array, InferOutput } from "valibot";
import { json } from "../../src/schema/fields/json/field";
import type { InferJsonInput } from "../../src/schema/fields/json/schemas";

// JSON value type
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// =============================================================================
// RAW JSON FIELD (required, no modifiers)
// =============================================================================

describe("Raw JSON Field", () => {
  const field = json();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is JsonValue", () => {
      type Base = InferJsonInput<State, "base">;
      expectTypeOf<null>().toExtend<Base>();
      expectTypeOf<boolean>().toExtend<Base>();
      expectTypeOf<number>().toExtend<Base>();
      expectTypeOf<string>().toExtend<Base>();
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });

    test("runtime: parses boolean", () => {
      expect(parse(schemas.base, true)).toBe(true);
      expect(parse(schemas.base, false)).toBe(false);
    });

    test("runtime: parses number", () => {
      expect(parse(schemas.base, 42)).toBe(42);
      expect(parse(schemas.base, 3.14)).toBe(3.14);
    });

    test("runtime: parses string", () => {
      expect(parse(schemas.base, "hello")).toBe("hello");
    });

    test("runtime: parses array", () => {
      expect(parse(schemas.base, [1, 2, 3])).toEqual([1, 2, 3]);
      expect(parse(schemas.base, ["a", "b"])).toEqual(["a", "b"]);
      expect(parse(schemas.base, [{ nested: true }])).toEqual([
        { nested: true },
      ]);
    });

    test("runtime: parses object", () => {
      const obj = { name: "test", value: 123 };
      expect(parse(schemas.base, obj)).toEqual(obj);
    });

    test("runtime: parses deeply nested structure", () => {
      const nested = {
        level1: {
          level2: {
            level3: [1, 2, { deep: true }],
          },
        },
      };
      expect(parse(schemas.base, nested)).toEqual(nested);
    });

    test("runtime: rejects undefined", () => {
      expect(() => parse(schemas.base, undefined)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required JsonValue", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<{ foo: string }>().toExtend<Create>();
    });

    test("runtime: accepts valid JSON", () => {
      expect(parse(schemas.create, { data: "test" })).toEqual({ data: "test" });
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });
  });

  describe("update", () => {
    // JSON does NOT support shorthand - must use { set: value }
    test("type: update accepts set operation", () => {
      type Update = InferJsonInput<State, "update">;
      expectTypeOf<{ set: { foo: string } }>().toExtend<Update>();
    });

    test("runtime: set operation passes through", () => {
      const data = { name: "test" };
      expect(parse(schemas.update, { set: data })).toEqual({ set: data });
    });

    test("runtime: set with primitive", () => {
      expect(parse(schemas.update, { set: 42 })).toEqual({ set: 42 });
      expect(parse(schemas.update, { set: "hello" })).toEqual({ set: "hello" });
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });

    test("runtime: set with array", () => {
      expect(parse(schemas.update, { set: [1, 2, 3] })).toEqual({
        set: [1, 2, 3],
      });
    });
  });

  describe("filter", () => {
    // JSON does NOT support shorthand - must use { equals: value }
    test("type: filter accepts equals", () => {
      type Filter = InferJsonInput<State, "filter">;
      expectTypeOf<{ equals: { foo: string } }>().toExtend<Filter>();
    });

    test("type: filter accepts JSON-specific operations", () => {
      type Filter = InferJsonInput<State, "filter">;
      expectTypeOf<{ path: string[] }>().toExtend<Filter>();
      expectTypeOf<{ string_contains: string }>().toExtend<Filter>();
      expectTypeOf<{ string_starts_with: string }>().toExtend<Filter>();
      expectTypeOf<{ string_ends_with: string }>().toExtend<Filter>();
    });

    test("runtime: equals filter passes through", () => {
      const data = { name: "test" };
      expect(parse(schemas.filter, { equals: data })).toEqual({ equals: data });
    });

    test("runtime: path filter passes through", () => {
      expect(parse(schemas.filter, { path: ["user", "name"] })).toEqual({
        path: ["user", "name"],
      });
    });

    test("runtime: string_contains filter passes through", () => {
      expect(parse(schemas.filter, { string_contains: "test" })).toEqual({
        string_contains: "test",
      });
    });

    test("runtime: string_starts_with filter passes through", () => {
      expect(parse(schemas.filter, { string_starts_with: "pre" })).toEqual({
        string_starts_with: "pre",
      });
    });

    test("runtime: string_ends_with filter passes through", () => {
      expect(parse(schemas.filter, { string_ends_with: "suf" })).toEqual({
        string_ends_with: "suf",
      });
    });

    test("runtime: array_contains filter passes through", () => {
      expect(parse(schemas.filter, { array_contains: { id: 1 } })).toEqual({
        array_contains: { id: 1 },
      });
    });

    test("runtime: array_starts_with filter passes through", () => {
      expect(parse(schemas.filter, { array_starts_with: [1, 2] })).toEqual({
        array_starts_with: [1, 2],
      });
    });

    test("runtime: array_ends_with filter passes through", () => {
      expect(parse(schemas.filter, { array_ends_with: "last" })).toEqual({
        array_ends_with: "last",
      });
    });

    test("runtime: not filter with equals", () => {
      expect(parse(schemas.filter, { not: { equals: { value: 42 } } })).toEqual(
        {
          not: { equals: { value: 42 } },
        }
      );
    });

    test("runtime: combined filters", () => {
      expect(
        parse(schemas.filter, {
          path: ["user"],
          string_contains: "test",
        })
      ).toEqual({
        path: ["user"],
        string_contains: "test",
      });
    });
  });
});

// =============================================================================
// NULLABLE JSON FIELD
// =============================================================================

describe("Nullable JSON Field", () => {
  const field = json().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is JsonValue | null", () => {
      type Base = InferJsonInput<State, "base">;
      expectTypeOf<null>().toExtend<Base>();
      expectTypeOf<{ foo: string }>().toExtend<Base>();
    });

    test("runtime: parses valid JSON", () => {
      expect(parse(schemas.base, { data: "test" })).toEqual({ data: "test" });
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<{ foo: string } | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts valid JSON", () => {
      expect(parse(schemas.create, { data: "test" })).toEqual({ data: "test" });
    });

    test("runtime: accepts null", () => {
      expect(parse(schemas.create, null)).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
    });
  });

  describe("update", () => {
    test("type: update accepts null in set", () => {
      type Update = InferJsonInput<State, "update">;
      expectTypeOf<{ set: null }>().toExtend<Update>();
      expectTypeOf<{ set: { foo: string } | null }>().toExtend<Update>();
    });

    test("runtime: set null passes through", () => {
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });

    test("runtime: set object passes through", () => {
      expect(parse(schemas.update, { set: { data: "test" } })).toEqual({
        set: { data: "test" },
      });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null in equals", () => {
      type Filter = InferJsonInput<State, "filter">;
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: equals null passes through", () => {
      expect(parse(schemas.filter, { equals: null })).toEqual({ equals: null });
    });
  });
});

// =============================================================================
// CUSTOM SCHEMA JSON FIELD
// =============================================================================

describe("Custom Schema JSON Field", () => {
  const UserSchema = object({
    name: string(),
    age: number(),
    tags: array(string()),
  });
  type User = InferOutput<typeof UserSchema>;

  const field = json().schema(UserSchema);
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  const validUser: User = { name: "Alice", age: 30, tags: ["dev", "admin"] };

  describe("base", () => {
    test("type: base is User type", () => {
      type Base = InferJsonInput<State, "base">;
      expectTypeOf<User>().toExtend<Base>();
    });

    test("runtime: parses valid user", () => {
      expect(parse(schemas.base, validUser)).toEqual(validUser);
    });

    test("runtime: rejects invalid user (missing field)", () => {
      expect(() => parse(schemas.base, { name: "Bob" })).toThrow();
    });

    test("runtime: rejects invalid user (wrong type)", () => {
      expect(() =>
        parse(schemas.base, { name: "Bob", age: "thirty", tags: [] })
      ).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required User", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<User>().toExtend<Create>();
    });

    test("runtime: accepts valid user", () => {
      expect(parse(schemas.create, validUser)).toEqual(validUser);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts User in set", () => {
      type Update = InferJsonInput<State, "update">;
      expectTypeOf<{ set: User }>().toExtend<Update>();
    });

    test("runtime: set valid user passes through", () => {
      expect(parse(schemas.update, { set: validUser })).toEqual({
        set: validUser,
      });
    });

    test("runtime: validates against custom schema", () => {
      expect(() =>
        parse(schemas.update, { set: { name: "Invalid" } })
      ).toThrow();
    });
  });

  describe("filter", () => {
    test("type: filter accepts User in equals", () => {
      type Filter = InferJsonInput<State, "filter">;
      expectTypeOf<{ equals: User }>().toExtend<Filter>();
    });

    test("runtime: equals valid user passes through", () => {
      expect(parse(schemas.filter, { equals: validUser })).toEqual({
        equals: validUser,
      });
    });

    test("runtime: JSON filters still work", () => {
      expect(parse(schemas.filter, { path: ["name"] })).toEqual({
        path: ["name"],
      });
    });
  });
});

// =============================================================================
// NULLABLE CUSTOM SCHEMA JSON FIELD
// =============================================================================

describe("Nullable Custom Schema JSON Field", () => {
  const ConfigSchema = object({
    theme: string(),
    notifications: object({
      email: object({ enabled: string() }),
    }),
  });
  type Config = InferOutput<typeof ConfigSchema>;

  const field = json().schema(ConfigSchema).nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  const validConfig: Config = {
    theme: "dark",
    notifications: { email: { enabled: "true" } },
  };

  describe("base", () => {
    test("type: base is Config | null", () => {
      type Base = InferJsonInput<State, "base">;
      expectTypeOf<Config>().toExtend<Base>();
      expectTypeOf<null>().toExtend<Base>();
    });

    test("runtime: parses valid config", () => {
      expect(parse(schemas.base, validConfig)).toEqual(validConfig);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<Config | null | undefined>().toExtend<Create>();
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const defaultData = { initialized: true, count: 0 };
    const field = json().default(defaultData);
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<{ foo: string } | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      const customData = { custom: true };
      expect(parse(schemas.create, customData)).toEqual(customData);
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toEqual(defaultData);
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const field = json().default(() => {
      callCount++;
      return { callNumber: callCount };
    });
    const schemas = field["~"].schemas;

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      expect(result).toEqual({ callNumber: before + 1 });
    });
  });
});
