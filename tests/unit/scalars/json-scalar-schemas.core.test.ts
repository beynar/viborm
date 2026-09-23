/**
 * JSON Scalar Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all JSON scalar variants:
 * - Raw (required)
 * - Nullable (with default null)
 * - Custom schema (typed JSON)
 *
 * For each variant, tests:
 * - base: The element/scalar type
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates (shorthand - accepts raw value, coerces to { set: value })
 * - filter: Input type for filtering (no shorthand - must use { equals: value })
 *
 * Note: JSON update scalars support shorthand syntax - raw values are automatically coerced to { set: value }.
 * This allows convenient updates like: update({ data: { foo: "bar" } }) instead of update({ data: { set: { foo: "bar" } } }).
 */

import { DbNull, JsonNull, type JsonNullSentinel } from "@schema/json-null";
import type { ScalarState } from "@schema/scalars/common";
import { json } from "@schema/scalars/json/scalar";
import { type InferInput, parse } from "@validation";
import { type GetScalarSchemas, getScalarSchemas } from "@validation/scalars";
import { array, type InferOutput, number, object, string } from "valibot";
import { describe, expect, expectTypeOf, test } from "vitest";

type InferScalarInput<
  State extends ScalarState,
  Key extends keyof GetScalarSchemas<State>,
> = InferInput<GetScalarSchemas<State>[Key]>;
type InferJsonInput<
  State extends ScalarState<"json">,
  Key extends keyof GetScalarSchemas<State>,
> = InferScalarInput<State, Key>;

// JSON value type
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// =============================================================================
// RAW JSON SCALAR (required, no modifiers)
// =============================================================================

describe("Raw JSON Scalar", () => {
  const scalar = json();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

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
    });

    // A bare top-level null no longer says WHICH null it means, so the write
    // slot takes a named sentinel instead. This field is not nullable, so only
    // the JSON null value is storable.
    test("type: update refuses a bare null and takes JsonNull", () => {
      type Update = InferJsonInput<State, "update">;
      expectTypeOf<null>().not.toExtend<Update>();
      expectTypeOf<JsonNullSentinel<"JsonNull">>().toExtend<Update>();
      expectTypeOf<JsonNullSentinel<"DbNull">>().not.toExtend<Update>();
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
    });

    test("runtime: a bare null is refused, JsonNull is not", () => {
      const refused = parse(schemas.update, null);
      expect(refused.issues?.[0]?.message).toContain("null is ambiguous");

      const jsonNull = parse(schemas.update, JsonNull);
      if (jsonNull.issues) throw new Error("Expected success");
      expect(jsonNull.value).toEqual({ set: JsonNull });
    });

    test("runtime: DbNull is refused on a non-nullable JSON field", () => {
      const result = parse(schemas.update, DbNull);
      expect(result.issues?.[0]?.message).toContain("DbNull is not supported");
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

    test("runtime: a path alone states no operation", () => {
      // `path` SCOPES a filter; it does not state one. A filter that carries
      // only a path used to lower to TRUE, which is how
      // `deleteMany({ where: { data: { path: ['a'] } } })` removed every row.
      const result = parse(schemas.filter, { path: ["user", "name"] });
      expect(result.issues?.[0]?.message).toBe(
        "Filter must contain at least one operation."
      );
    });

    test("runtime: a path beside an operation passes through", () => {
      const result = parse(schemas.filter, {
        path: ["user", "name"],
        equals: "Ada",
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ path: ["user", "name"], equals: "Ada" });
    });

    test("runtime: a string path is parsed into segments", () => {
      const result = parse(schemas.filter, {
        path: "$.user.name",
        equals: "A",
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ path: ["user", "name"], equals: "A" });
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

  /**
   * ADMISSION owns both JSON path spellings and the whole string grammar, so a
   * prepared filter carries segments and nothing else. The grammar is
   * deliberately small — '$', '.key', '[N]' — and everything outside it is
   * REFUSED rather than half-supported, because SQLite's path grammar has no
   * escape syntax inside a quoted label and a larger grammar could not stay
   * portable.
   *
   * `tests/contracts/engine/query/parity-admission.core.test.ts` pins the same
   * refusals through a compiled statement, in the `layer-query-engine`
   * project — outside this coverage scope. These are the same facts asked of
   * the schema that owns them.
   */
  describe("filter path grammar", () => {
    const refusal = (path: unknown): string =>
      parse(schemas.filter, { path, equals: "x" }).issues?.[0]?.message ?? "";

    test("a path string must start with '$'", () => {
      expect(refusal("status")).toBe(
        "JSON filter has an unsupported path string 'status': a path string must start with '$'. The supported grammar is '$', '$.key', '$.key[0]' and nothing else; use the array form (path: ['a', 'b']) for keys containing '.', '[' or ']'."
      );
    });

    test.each([
      ["$.", "an object key may not be empty"],
      ["$.a.", "an object key may not be empty"],
      ["$.*", "wildcards are not supported"],
      ["$.a.b*c", "wildcards are not supported"],
      ["$[0", "an unclosed '['"],
      ["$[last]", "'[last]' is not a non-negative integer array index"],
      ["$.a[]", "'[]' is not a non-negative integer array index"],
      ["$.a[-1]", "'[-1]' is not a non-negative integer array index"],
      ["$status", "unexpected 's'"],
    ] as const)("%s is refused: %s", (path, reason) => {
      expect(refusal(path)).toBe(
        `JSON filter has an unsupported path string '${path}': ${reason}. The supported grammar is '$', '$.key', '$.key[0]' and nothing else; use the array form (path: ['a', 'b']) for keys containing '.', '[' or ']'.`
      );
    });

    test("the root '$' alone is an empty segment list", () => {
      const result = parse(schemas.filter, { path: "$", equals: "x" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value.path).toEqual([]);
    });

    test("array indices are parsed into their own segments", () => {
      const result = parse(schemas.filter, {
        path: "$.pet.toys[0][12].name",
        equals: "x",
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value.path).toEqual(["pet", "toys", "0", "12", "name"]);
    });

    test("a path that is neither a string nor an array is refused", () => {
      expect(refusal(7)).toBe("Expected string or array of strings");
    });

    test.each([
      'quoted"key',
      "back\\slash",
    ] as const)("the array form refuses a segment carrying %s", (segment) => {
      expect(refusal([segment])).toBe(
        "JSON filter requires a portable JSON path; segments containing '\"' or '\\' are not supported."
      );
    });

    test("the string form refuses a non-portable segment by the same rule", () => {
      // The string grammar admits `"` inside a key, so the ONE portability
      // rule has to be asked of the parsed segments too, not only of the
      // array spelling.
      expect(refusal('$."a b"')).toBe(
        "JSON filter requires a portable JSON path; segments containing '\"' or '\\' are not supported."
      );
    });

    test("segment values are stringified before the portability rule", () => {
      const result = parse(schemas.filter, { path: [0, "a"], equals: "x" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value.path).toEqual(["0", "a"]);
    });
  });

  /**
   * `mode: "insensitive"` governs `string_contains`/`string_starts_with`/
   * `string_ends_with` and nothing else: `equals` and `array_*` compare whole
   * JSON values, not text, so folding them would be meaningless. An inert mode
   * is refused rather than accepted and ignored.
   */
  describe("filter mode", () => {
    const INERT =
      "JSON filter sets mode: 'insensitive' but has no string_contains/string_starts_with/string_ends_with operation for it to apply to.";

    test("a mode beside a string operator governs it", () => {
      const result = parse(schemas.filter, {
        mode: "insensitive",
        string_contains: "x",
      });
      expect(result.issues).toBeUndefined();
    });

    test("a mode beside a whole-value operator is refused", () => {
      expect(
        parse(schemas.filter, { mode: "insensitive", equals: "x" }).issues?.[0]
          ?.message
      ).toBe(INERT);
    });

    test("a nested not inherits the mode, so it justifies it", () => {
      const result = parse(schemas.filter, {
        mode: "insensitive",
        not: { string_contains: "x" },
      });
      expect(result.issues).toBeUndefined();
    });

    test("a sentinel not inherits nothing, so the mode stays inert", () => {
      // `not: DbNull` case-folds nothing and cannot carry a string operator,
      // so a mode declared beside it governs exactly nothing.
      expect(
        parse(schemas.filter, { mode: "insensitive", not: DbNull }).issues?.[0]
          ?.message
      ).toBe(INERT);
    });

    test("mode: 'default' states nothing and is never inert", () => {
      const result = parse(schemas.filter, { mode: "default", equals: "x" });
      expect(result.issues).toBeUndefined();
    });
  });
});

// =============================================================================
// NULLABLE JSON SCALAR
// =============================================================================

describe("Nullable JSON Scalar", () => {
  const scalar = json().nullable();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

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
      expectTypeOf<{ foo: string } | undefined>().toExtend<Create>();
    });

    // Both nulls are storable here, and each has to be named
    test("type: create takes DbNull and JsonNull, not a bare null", () => {
      type Create = InferJsonInput<State, "create">;
      expectTypeOf<null>().not.toExtend<Create>();
      expectTypeOf<JsonNullSentinel<"DbNull">>().toExtend<Create>();
      expectTypeOf<JsonNullSentinel<"JsonNull">>().toExtend<Create>();
      expectTypeOf<JsonNullSentinel<"AnyNull">>().not.toExtend<Create>();
    });

    test("runtime: accepts valid JSON", () => {
      const result = parse(schemas.create, { data: "test" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ data: "test" });
    });

    test("runtime: refuses a bare null, accepts both sentinels", () => {
      const refused = parse(schemas.create, null);
      expect(refused.issues?.[0]?.message).toContain("null is ambiguous");

      const dbNull = parse(schemas.create, DbNull);
      if (dbNull.issues) throw new Error("Expected success");
      expect(dbNull.value).toBe(DbNull);

      const jsonNull = parse(schemas.create, JsonNull);
      if (jsonNull.issues) throw new Error("Expected success");
      expect(jsonNull.value).toBe(JsonNull);
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
      expectTypeOf<{ foo: string }>().toExtend<Update>();
      expectTypeOf<null>().not.toExtend<Update>();
      expectTypeOf<JsonNullSentinel<"DbNull">>().toExtend<Update>();
      expectTypeOf<JsonNullSentinel<"JsonNull">>().toExtend<Update>();
    });

    test("runtime: a bare null is refused; sentinels coerce to set", () => {
      const refused = parse(schemas.update, null);
      expect(refused.issues?.[0]?.message).toContain("null is ambiguous");

      const dbNull = parse(schemas.update, DbNull);
      if (dbNull.issues) throw new Error("Expected success");
      expect(dbNull.value).toEqual({ set: DbNull });

      const jsonNull = parse(schemas.update, JsonNull);
      if (jsonNull.issues) throw new Error("Expected success");
      expect(jsonNull.value).toEqual({ set: JsonNull });
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
// CUSTOM SCHEMA JSON SCALAR
// =============================================================================

describe("Custom Schema JSON Scalar", () => {
  const UserSchema = object({
    name: string(),
    age: number(),
    tags: array(string()),
  });
  type User = InferOutput<typeof UserSchema>;

  const scalar = json().schema(UserSchema);
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

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
      const result = parse(schemas.filter, {
        path: ["name"],
        equals: validUser,
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ path: ["name"], equals: validUser });
    });
  });
});

// =============================================================================
// NULLABLE CUSTOM SCHEMA JSON SCALAR
// =============================================================================

describe("Nullable Custom Schema JSON Scalar", () => {
  const ConfigSchema = object({
    theme: string(),
    notifications: object({
      email: object({ enabled: string() }),
    }),
  });
  type Config = InferOutput<typeof ConfigSchema>;

  const scalar = json().schema(ConfigSchema).nullable();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

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
      expectTypeOf<Config | undefined>().toExtend<Create>();
      expectTypeOf<JsonNullSentinel<"DbNull">>().toExtend<Create>();
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
    const scalar = json().default(defaultData);
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

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
    const scalar = json().default(() => {
      callCount++;
      return { callNumber: callCount };
    });
    const schemas = getScalarSchemas(scalar["~"].state);

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ callNumber: before + 1 });
    });
  });
});
