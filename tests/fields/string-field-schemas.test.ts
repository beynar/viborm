/**
 * String Field Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all string field variants:
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
 *
 * Also tests branded type preservation for each variant.
 */

import { describe, test, expect, expectTypeOf } from "vitest";
import {
  email,
  brand,
  Brand as BRAND,
  parse,
  InferOutput,
  pipe,
  string as stringValibot,
} from "valibot";
import { string } from "../../src/schema/fields/string/field";
import type { InferStringInput } from "../../src/schema/fields/string/schemas";

// =============================================================================
// RAW STRING FIELD (required, no modifiers)
// =============================================================================

describe("Raw String Field", () => {
  const field = string();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is string", () => {
      type Base = InferStringInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<string>();
    });

    test("runtime: parses string", () => {
      expect(parse(schemas.base, "hello")).toBe("hello");
    });

    test("runtime: rejects non-string", () => {
      expect(() => parse(schemas.base, 123)).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required string", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<string>();
    });

    test("runtime: accepts string", () => {
      expect(parse(schemas.create, "hello")).toBe("hello");
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });

    test("runtime: rejects null", () => {
      expect(() => parse(schemas.create, null)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts string or { set: string }", () => {
      type Update = InferStringInput<State, "update">;
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<{ set: string }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      expect(parse(schemas.update, "hello")).toEqual({ set: "hello" });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.update, { set: "hello" })).toEqual({ set: "hello" });
    });
  });

  describe("filter", () => {
    test("type: filter accepts string shorthand", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<string>().toExtend<Filter>();
    });

    test("type: filter accepts equals object", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ equals: string }>().toExtend<Filter>();
    });

    test("type: filter accepts contains/startsWith/endsWith", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ contains: string }>().toExtend<Filter>();
      expectTypeOf<{ startsWith: string }>().toExtend<Filter>();
      expectTypeOf<{ endsWith: string }>().toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      expect(parse(schemas.filter, "hello")).toEqual({ equals: "hello" });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.filter, { equals: "hello" })).toEqual({
        equals: "hello",
      });
      expect(parse(schemas.filter, { contains: "ell" })).toEqual({
        contains: "ell",
      });
    });
  });

  describe("branded type preservation", () => {
    const brandedField = string().schema(
      pipe(stringValibot(), email(), brand("email"))
    );
    type BrandedOutput = InferOutput<
      (typeof brandedField)["~"]["schemas"]["base"]
    >;
    type EmailBrand = string & BRAND<"email">;

    test("type: base output preserves brand", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand>();
    });

    test("runtime: validates custom schema", () => {
      const brandedSchemas = brandedField["~"].schemas;
      expect(parse(brandedSchemas.base, "test@example.com")).toBe(
        "test@example.com"
      );
      expect(() => parse(brandedSchemas.base, "not-an-email")).toThrow();
    });
  });
});

// =============================================================================
// NULLABLE STRING FIELD
// =============================================================================

describe("Nullable String Field", () => {
  const field = string().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is string | null", () => {
      type Base = InferStringInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<string | null>();
    });

    test("runtime: parses string", () => {
      expect(parse(schemas.base, "hello")).toBe("hello");
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts string", () => {
      expect(parse(schemas.create, "hello")).toBe("hello");
    });

    test("runtime: accepts null", () => {
      expect(parse(schemas.create, null)).toBe(null);
    });

    test("runtime: undefined defaults to null", () => {
      expect(parse(schemas.create, undefined)).toBe(null);
    });
  });

  describe("update", () => {
    test("type: update accepts string, null, or { set: string | null }", () => {
      type Update = InferStringInput<State, "update">;
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: string | null }>().toExtend<Update>();
    });

    test("runtime: shorthand string transforms to { set: value }", () => {
      expect(parse(schemas.update, "hello")).toEqual({ set: "hello" });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: object form passes through", () => {
      expect(parse(schemas.update, { set: "hello" })).toEqual({ set: "hello" });
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferStringInput<State, "filter">;
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

  describe("branded type preservation", () => {
    const brandedField = string()
      .schema(pipe(stringValibot(), email(), brand("email")))
      .nullable();
    type BrandedOutput = InferOutput<
      (typeof brandedField)["~"]["schemas"]["base"]
    >;
    type EmailBrand = string & BRAND<"email">;

    test("type: base output preserves brand with null", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand | null>();
    });

    test("runtime: validates custom schema or null", () => {
      const brandedSchemas = brandedField["~"].schemas;
      expect(parse(brandedSchemas.base, "test@example.com")).toBe(
        "test@example.com"
      );
      expect(parse(brandedSchemas.base, null)).toBe(null);
      expect(() => parse(brandedSchemas.base, "not-an-email")).toThrow();
    });
  });
});

// =============================================================================
// LIST STRING FIELD (array)
// =============================================================================

describe("List String Field", () => {
  const field = string().array();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is string[]", () => {
      type Base = InferStringInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<string[]>();
    });

    test("runtime: parses array of strings", () => {
      expect(parse(schemas.base, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });

    test("runtime: parses empty array", () => {
      expect(parse(schemas.base, [])).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      expect(() => parse(schemas.base, "hello")).toThrow();
      expect(() => parse(schemas.base, null)).toThrow();
    });
  });

  describe("create", () => {
    test("type: create is required string[]", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<string[]>();
    });

    test("runtime: accepts array", () => {
      expect(parse(schemas.create, ["a", "b"])).toEqual(["a", "b"]);
    });

    test("runtime: rejects undefined (required)", () => {
      expect(() => parse(schemas.create, undefined)).toThrow();
    });
  });

  describe("update", () => {
    test("type: update accepts array operations", () => {
      type Update = InferStringInput<State, "update">;
      expectTypeOf<{ set: string[] }>().toExtend<Update>();
      expectTypeOf<{ push: string }>().toExtend<Update>();
      expectTypeOf<{ push: string[] }>().toExtend<Update>();
      expectTypeOf<{ unshift: string }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, ["a", "b"])).toEqual({ set: ["a", "b"] });
    });

    test("runtime: set operation passes through", () => {
      expect(parse(schemas.update, { set: ["a", "b"] })).toEqual({
        set: ["a", "b"],
      });
    });

    test("runtime: push single element", () => {
      expect(parse(schemas.update, { push: "c" })).toEqual({ push: "c" });
    });

    test("runtime: push array of elements", () => {
      expect(parse(schemas.update, { push: ["c", "d"] })).toEqual({
        push: ["c", "d"],
      });
    });

    test("runtime: unshift operation", () => {
      expect(parse(schemas.update, { unshift: "a" })).toEqual({ unshift: "a" });
    });
  });

  describe("filter", () => {
    test("type: filter accepts array filters", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ has: string }>().toExtend<Filter>();
      expectTypeOf<{ hasEvery: string[] }>().toExtend<Filter>();
      expectTypeOf<{ hasSome: string[] }>().toExtend<Filter>();
      expectTypeOf<{ isEmpty: boolean }>().toExtend<Filter>();
      expectTypeOf<{ equals: string[] }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      console.log("schemas.filter", parse(schemas.filter, ["a", "b"]));
      expect(parse(schemas.filter, ["a", "b"])).toEqual({ equals: ["a", "b"] });
    });

    test("runtime: has filter passes through", () => {
      expect(parse(schemas.filter, { has: "a" })).toEqual({ has: "a" });
    });

    test("runtime: hasEvery filter passes through", () => {
      expect(parse(schemas.filter, { hasEvery: ["a", "b"] })).toEqual({
        hasEvery: ["a", "b"],
      });
    });

    test("runtime: isEmpty filter passes through", () => {
      expect(parse(schemas.filter, { isEmpty: true })).toEqual({
        isEmpty: true,
      });
    });
  });

  describe("branded type preservation", () => {
    const brandedField = string()
      .schema(pipe(stringValibot(), email(), brand("email")))
      .array();
    type BrandedOutput = InferOutput<
      (typeof brandedField)["~"]["schemas"]["base"]
    >;
    type EmailBrand = string & BRAND<"email">;

    test("type: base output preserves brand in array", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand[]>();
    });

    test("runtime: validates each element against custom schema", () => {
      const brandedSchemas = brandedField["~"].schemas;
      expect(parse(brandedSchemas.base, ["a@b.com", "c@d.com"])).toEqual([
        "a@b.com",
        "c@d.com",
      ]);
      expect(() =>
        parse(brandedSchemas.base, ["a@b.com", "not-an-email"])
      ).toThrow();
    });
  });
});

// =============================================================================
// NULLABLE LIST STRING FIELD (nullable array)
// =============================================================================

describe("Nullable List String Field", () => {
  const field = string().array().nullable();
  type State = (typeof field)["~"]["state"];
  const schemas = field["~"].schemas;

  describe("base", () => {
    test("type: base is string[] | null", () => {
      type Base = InferStringInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<string[] | null>();
    });

    test("runtime: parses array of strings", () => {
      expect(parse(schemas.base, ["a", "b"])).toEqual(["a", "b"]);
    });

    test("runtime: parses null", () => {
      expect(parse(schemas.base, null)).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts array", () => {
      expect(parse(schemas.create, ["a", "b"])).toEqual(["a", "b"]);
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
      type Update = InferStringInput<State, "update">;
      expectTypeOf<{ set: string[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: string }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      expect(parse(schemas.update, ["a", "b"])).toEqual({ set: ["a", "b"] });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      expect(parse(schemas.update, null)).toEqual({ set: null });
    });

    test("runtime: set null passes through", () => {
      expect(parse(schemas.update, { set: null })).toEqual({ set: null });
    });

    test("runtime: push operation", () => {
      expect(parse(schemas.update, { push: "c" })).toEqual({ push: "c" });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      expect(parse(schemas.filter, ["a", "b"])).toEqual({ equals: ["a", "b"] });
      expect(parse(schemas.filter, null)).toEqual({ equals: null });
    });

    test("runtime: equals null passes through", () => {
      expect(parse(schemas.filter, { equals: null })).toEqual({ equals: null });
    });
  });

  describe("branded type preservation", () => {
    const brandedField = string()
      .schema(pipe(stringValibot(), email(), brand("email")))
      .array()
      .nullable();
    type BrandedOutput = InferOutput<
      (typeof brandedField)["~"]["schemas"]["base"]
    >;
    type EmailBrand = string & BRAND<"email">;

    test("type: base output preserves brand in nullable array", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand[] | null>();
    });

    test("runtime: validates elements or accepts null", () => {
      const brandedSchemas = brandedField["~"].schemas;
      expect(parse(brandedSchemas.base, ["a@b.com"])).toEqual(["a@b.com"]);
      expect(parse(brandedSchemas.base, null)).toBe(null);
      expect(() => parse(brandedSchemas.base, ["not-an-email"])).toThrow();
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  describe("static default value", () => {
    const field = string().default("hello");
    type State = (typeof field)["~"]["state"];
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();
    });

    test("runtime: accepts value", () => {
      expect(parse(schemas.create, "world")).toBe("world");
    });

    test("runtime: undefined uses default", () => {
      expect(parse(schemas.create, undefined)).toBe("hello");
    });
  });

  describe("function default value", () => {
    let callCount = 0;
    const field = string().default(() => {
      callCount++;
      return `generated-${callCount}`;
    });
    const schemas = field["~"].schemas;

    test("type: create is optional", () => {
      type State = (typeof field)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();
    });

    test("runtime: undefined calls default function", () => {
      const before = callCount;
      const result = parse(schemas.create, undefined);
      expect(result).toBe(`generated-${before + 1}`);
    });
  });

  describe("auto-generated fields", () => {
    test("uuid: type is optional, runtime uses generator", () => {
      const field = string().uuid();
      type State = (typeof field)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      expect(typeof result).toBe("string");
      expect(result).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    test("ulid: type is optional, runtime uses generator", () => {
      const field = string().ulid();
      type State = (typeof field)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      expect(typeof result).toBe("string");
      expect(result).toHaveLength(26);
    });

    test("nanoid: type is optional, runtime uses generator", () => {
      const field = string().nanoid();
      type State = (typeof field)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      expect(typeof result).toBe("string");

      expect(result!.length).toBeGreaterThan(0);
    });

    test("cuid: type is optional, runtime uses generator", () => {
      const field = string().cuid();
      type State = (typeof field)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      expect(typeof result).toBe("string");
      expect(result!.length).toBeGreaterThan(0);
    });
  });
});
