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
 * - update: Input type for updates (shorthand - accepts raw value, coerces to { set: value })
 * - filter: Input type for filtering (no shorthand - must use { equals: value })
 *
 * Note: JSON update fields support shorthand syntax - raw values are automatically coerced to { set: value }.
 * This allows convenient updates like: update({ data: { foo: "bar" } }) instead of update({ data: { set: { foo: "bar" } } }).
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import { object, string, number, array, InferOutput } from "valibot";
import { parse } from "@validation";
import { json } from "@schema/fields/json/field";
import type { InferJsonInput } from "@schema/fields/json/schemas";

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
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });

    test("runtime: parses boolean", () => {
      const r1 = parse(schemas.base, true);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toBe(true);

      const r2 = parse(schemas.base, false);
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toBe(false);
    });

    test("runtime: parses number", () => {
      const r1 = parse(schemas.base, 42);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toBe(42);

      const r2 = parse(schemas.base, 3.14);
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toBe(3.14);
    });

    test("runtime: parses string", () => {
      const result = parse(schemas.base, "hello");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("hello");
    });

    test("runtime: parses array", () => {
      const r1 = parse(schemas.base, [1, 2, 3]);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual([1, 2, 3]);

      const r2 = parse(schemas.base, ["a", "b"]);
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual(["a", "b"]);

      const r3 = parse(schemas.base, [{ nested: true }]);
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toEqual([{ nested: true }]);
    });

    test("runtime: parses object", () => {
      const obj = { name: "test", value: 123 };
      const result = parse(schemas.base, obj);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(obj);
    });

    test("runtime: parses deeply nested structure", () => {
      const nested = {
        level1: {
          level2: {
            level3: [1, 2, { deep: true }],
          },
        },
      };
      const result = parse(schemas.base, nested);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(nested);
    });

    test("runtime: rejects undefined", () => {
      const result = parse(schemas.base, undefined);
      expect(result.issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required JsonValue", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<{ foo: string }>().toExtend<Create>();
    });

    test("runtime: accepts valid JSON", () => {
      const result = parse(schemas.create, { data: "test" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ data: "test" });
    });

    test("runtime: rejects undefined (required)", () => {
      const result = parse(schemas.create, undefined);
      expect(result.issues).toBeDefined();
    });
  });

  describe("update", () => {
    // JSON update supports shorthand - raw values are coerced to { set: value }
    test("type: update accepts raw value (shorthand)", () => {
      type Update = InferJsonInput<State, "update">;
      expectTypeOf<{ foo: string }>().toExtend<Update>();
      expectTypeOf<number>().toExtend<Update>();
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<null>().toExtend<Update>();
    });

    test("runtime: raw object value coerces to set", () => {
      const data = { name: "test" };
      const result = parse(schemas.update, data);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: data });
    });

    test("runtime: raw primitive values coerce to set", () => {
      const r1 = parse(schemas.update, 42);
      if (r1.issues) throw new Error("Expected success");
      expect(r1.value).toEqual({ set: 42 });

      const r2 = parse(schemas.update, "hello");
      if (r2.issues) throw new Error("Expected success");
      expect(r2.value).toEqual({ set: "hello" });

      const r3 = parse(schemas.update, null);
      if (r3.issues) throw new Error("Expected success");
      expect(r3.value).toEqual({ set: null });
    });

    test("runtime: raw array value coerces to set", () => {
      const result = parse(schemas.update, [1, 2, 3]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: [1, 2, 3] });
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
      const result = parse(schemas.filter, { equals: data });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: data });
    });

    test("runtime: path filter passes through", () => {
      const result = parse(schemas.filter, { path: ["user", "name"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ path: ["user", "name"] });
    });

    test("runtime: string_contains filter passes through", () => {
      const result = parse(schemas.filter, { string_contains: "test" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ string_contains: "test" });
    });

    test("runtime: string_starts_with filter passes through", () => {
      const result = parse(schemas.filter, { string_starts_with: "pre" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ string_starts_with: "pre" });
    });

    test("runtime: string_ends_with filter passes through", () => {
      const result = parse(schemas.filter, { string_ends_with: "suf" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ string_ends_with: "suf" });
    });

    test("runtime: array_contains filter passes through", () => {
      const result = parse(schemas.filter, { array_contains: { id: 1 } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ array_contains: { id: 1 } });
    });

    test("runtime: array_starts_with filter passes through", () => {
      const result = parse(schemas.filter, { array_starts_with: [1, 2] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ array_starts_with: [1, 2] });
    });

    test("runtime: array_ends_with filter passes through", () => {
      const result = parse(schemas.filter, { array_ends_with: "last" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ array_ends_with: "last" });
    });

    test("runtime: not filter with equals", () => {
      const result = parse(schemas.filter, {
        not: { equals: { value: 42 } },
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: { value: 42 } } });
    });

    test("runtime: combined filters", () => {
      const result = parse(schemas.filter, {
        path: ["user"],
        string_contains: "test",
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({
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
      const result = parse(schemas.base, { data: "test" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ data: "test" });
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<{ foo: string } | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts valid JSON", () => {
      const result = parse(schemas.create, { data: "test" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ data: "test" });
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
    test("type: update accepts raw value (shorthand)", () => {
      type Update = InferJsonInput<State, "update">;
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ foo: string }>().toExtend<Update>();
    });

    test("runtime: raw null value coerces to set", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: raw object value coerces to set", () => {
      const result = parse(schemas.update, { data: "test" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: { data: "test" } });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null in equals", () => {
      type Filter = InferJsonInput<State, "filter">;
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: equals null passes through", () => {
      const result = parse(schemas.filter, { equals: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
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
      const result = parse(schemas.base, validUser);

      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(validUser);
    });

    test("runtime: rejects invalid user (missing field)", () => {
      const result = parse(schemas.base, { name: "Bob" });
      expect(result.issues).toBeDefined();
    });

    test("runtime: rejects invalid user (wrong type)", () => {
      const result = parse(schemas.base, {
        name: "Bob",
        age: "thirty",
        tags: [],
      });
      expect(result.issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required User", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<User>().toExtend<Create>();
    });

    test("runtime: accepts valid user", () => {
      const result = parse(schemas.create, validUser);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(validUser);
    });

    test("runtime: rejects undefined (required)", () => {
      const result = parse(schemas.create, undefined);
      expect(result.issues).toBeDefined();
    });
  });

  describe("update", () => {
    test("type: update accepts raw User value (shorthand)", () => {
      type Update = InferJsonInput<State, "update">;
      expectTypeOf<User>().toExtend<Update>();
    });

    test("runtime: raw valid user value coerces to set", () => {
      const result = parse(schemas.update, validUser);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: validUser });
    });

    test("runtime: validates against custom schema", () => {
      const result = parse(schemas.update, { name: "Invalid" });
      expect(result.issues).toBeDefined();
    });
  });

  describe("filter", () => {
    test("type: filter accepts User in equals", () => {
      type Filter = InferJsonInput<State, "filter">;
      expectTypeOf<{ equals: User }>().toExtend<Filter>();
    });

    test("runtime: equals valid user passes through", () => {
      const result = parse(schemas.filter, { equals: validUser });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: validUser });
    });

    test("runtime: JSON filters still work", () => {
      const result = parse(schemas.filter, { path: ["name"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ path: ["name"] });
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
      const result = parse(schemas.base, validConfig);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(validConfig);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<Config | null | undefined>().toExtend<Create>();
    });

    test("runtime: undefined defaults to null", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
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
      const result = parse(schemas.create, customData);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(customData);
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(defaultData);
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ callNumber: before + 1 });
    });
  });
});
