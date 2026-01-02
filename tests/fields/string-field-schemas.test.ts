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
  pipe,
  string as stringValibot,
} from "valibot";
import { string } from "@schema/fields/string/field";
import type { InferStringInput } from "@schema/fields/string/schemas";
import { InferOutput, parse, Prettify } from "@validation";

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
      const result = parse(schemas.base, "hello");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("hello");
    });

    test("runtime: rejects non-string", () => {
      const result1 = parse(schemas.base, 123);
      expect(result1.issues).toBeDefined();
      const result2 = parse(schemas.base, null);
      expect(result2.issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required string", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<string>();
    });

    test("runtime: accepts string", () => {
      const result = parse(schemas.create, "hello");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("hello");
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
    test("type: update accepts string or { set: string }", () => {
      type Update = InferStringInput<State, "update">;
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<{ set: string }>().toExtend<Update>();
    });

    test("runtime: shorthand transforms to { set: value }", () => {
      const result = parse(schemas.update, "hello");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: "hello" });
    });

    test("runtime: object form passes through", () => {
      const result = parse(schemas.update, { set: "hello" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: "hello" });
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

    test("type: filter accepts not with shorthand", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ not: string }>().toExtend<Filter>();
    });

    test("type: filter accepts not with filter object", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ not: { equals: string } }>().toExtend<Filter>();
      expectTypeOf<{ not: { contains: string } }>().toExtend<Filter>();
      expectTypeOf<{ not: { startsWith: string } }>().toExtend<Filter>();
    });

    test("runtime: shorthand transforms to { equals: value }", () => {
      const result = parse(schemas.filter, "hello");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: "hello" });
    });

    test("runtime: object form passes through", () => {
      const result1 = parse(schemas.filter, { equals: "hello" });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ equals: "hello" });
      const result2 = parse(schemas.filter, { contains: "ell" });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ contains: "ell" });
    });

    test("runtime: not with shorthand transforms to { not: { equals: value } }", () => {
      const result = parse(schemas.filter, { not: "hello" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: "hello" } });
    });

    test("runtime: not with equals filter", () => {
      const result = parse(schemas.filter, { not: { equals: "hello" } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: "hello" } });
    });

    test("runtime: not with contains filter", () => {
      const result = parse(schemas.filter, { not: { contains: "spam" } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { contains: "spam" } });
    });

    test("runtime: not with startsWith filter", () => {
      const result = parse(schemas.filter, { not: { startsWith: "admin" } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { startsWith: "admin" } });
    });

    test("runtime: not with endsWith filter", () => {
      const result = parse(schemas.filter, {
        not: { endsWith: "@blocked.com" },
      });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { endsWith: "@blocked.com" } });
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
      const result1 = parse(brandedSchemas.base, "test@example.com");
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toBe("test@example.com");
      const result2 = parse(brandedSchemas.base, "not-an-email");
      expect(result2.issues).toBeDefined();
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
      const result = parse(schemas.base, "hello");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("hello");
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts string", () => {
      const result = parse(schemas.create, "hello");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("hello");
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
    test("type: update accepts string, null, or { set: string | null }", () => {
      type Update = InferStringInput<State, "update">;
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: string | null }>().toExtend<Update>();
    });

    test("runtime: shorthand string transforms to { set: value }", () => {
      const result = parse(schemas.update, "hello");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: "hello" });
    });

    test("runtime: shorthand null transforms to { set: null }", () => {
      const result = parse(schemas.update, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: null });
    });

    test("runtime: object form passes through", () => {
      const result1 = parse(schemas.update, { set: "hello" });
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ set: "hello" });
      const result2 = parse(schemas.update, { set: null });
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ set: null });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = Prettify<InferStringInput<State, "filter">>;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("type: filter accepts not with shorthand", () => {
      type Filter = Prettify<InferStringInput<State, "filter">>;
      expectTypeOf<{ not: string | null }>().toExtend<Filter>();
    });

    test("type: filter accepts not with filter object", () => {
      type Filter = Prettify<InferStringInput<State, "filter">>;
      expectTypeOf<{ not: { equals: string | null } }>().toExtend<Filter>();
      expectTypeOf<{ not: { contains: string } }>().toExtend<Filter>();
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

    test("runtime: not with shorthand string transforms to { not: { equals: value } }", () => {
      const result = parse(schemas.filter, { not: "hello" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: "hello" } });
    });

    test("runtime: not with shorthand null transforms to { not: { equals: null } }", () => {
      const result = parse(schemas.filter, { not: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: null } });
    });

    test("runtime: not with equals filter", () => {
      const result = parse(schemas.filter, { not: { equals: "hello" } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: "hello" } });
    });

    test("runtime: not with contains filter", () => {
      const result = parse(schemas.filter, { not: { contains: "spam" } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { contains: "spam" } });
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
      const result1 = parse(brandedSchemas.base, "test@example.com");
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toBe("test@example.com");
      const result2 = parse(brandedSchemas.base, null);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toBe(null);
      const result3 = parse(brandedSchemas.base, "not-an-email");
      expect(result3.issues).toBeDefined();
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
      const result = parse(schemas.base, ["a", "b", "c"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(["a", "b", "c"]);
    });

    test("runtime: parses empty array", () => {
      const result = parse(schemas.base, []);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual([]);
    });

    test("runtime: rejects non-array", () => {
      const result1 = parse(schemas.base, "hello");
      expect(result1.issues).toBeDefined();
      const result2 = parse(schemas.base, null);
      expect(result2.issues).toBeDefined();
    });
  });

  describe("create", () => {
    test("type: create is required string[]", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<string[]>();
    });

    test("runtime: accepts array", () => {
      const result = parse(schemas.create, ["a", "b"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(["a", "b"]);
    });

    test("runtime: rejects undefined (required)", () => {
      const result = parse(schemas.create, undefined);
      expect(result.issues).toBeDefined();
    });
  });

  describe("update", () => {
    test("type: update accepts array operations", () => {
      type Update = Prettify<InferStringInput<State, "update">>;
      expectTypeOf<{ set: string[] }>().toExtend<Update>();
      expectTypeOf<{ push: string }>().toExtend<Update>();
      expectTypeOf<{ unshift: string[] }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      const result = parse(schemas.update, ["a", "b"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: ["a", "b"] });
    });

    test("runtime: set operation passes through", () => {
      const result = parse(schemas.update, { set: ["a", "b"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: ["a", "b"] });
    });

    test("runtime: push single element", () => {
      const result = parse(schemas.update, { push: "c" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ push: ["c"] });
    });

    test("runtime: push array of elements", () => {
      const result = parse(schemas.update, { push: ["c", "d"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ push: ["c", "d"] });
    });

    test("runtime: unshift operation", () => {
      const result = parse(schemas.update, { unshift: "a" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ unshift: ["a"] });
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

    test("type: filter accepts not with shorthand", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ not: string[] }>().toExtend<Filter>();
    });

    test("type: filter accepts not with filter object", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ not: { equals: string[] } }>().toExtend<Filter>();
      expectTypeOf<{ not: { has: string } }>().toExtend<Filter>();
      expectTypeOf<{ not: { hasEvery: string[] } }>().toExtend<Filter>();
      expectTypeOf<{ not: { isEmpty: boolean } }>().toExtend<Filter>();
    });

    test("runtime: shorthand array transforms to { equals: value }", () => {
      const result = parse(schemas.filter, ["a", "b"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: ["a", "b"] });
    });

    test("runtime: has filter passes through", () => {
      const result = parse(schemas.filter, { has: "a" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ has: "a" });
    });

    test("runtime: hasEvery filter passes through", () => {
      const result = parse(schemas.filter, { hasEvery: ["a", "b"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ hasEvery: ["a", "b"] });
    });

    test("runtime: isEmpty filter passes through", () => {
      const result = parse(schemas.filter, { isEmpty: true });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ isEmpty: true });
    });

    test("runtime: not with shorthand array transforms to { not: { equals: value } }", () => {
      const result = parse(schemas.filter, { not: ["a", "b"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: ["a", "b"] } });
    });

    test("runtime: not with equals filter", () => {
      const result = parse(schemas.filter, { not: { equals: ["a", "b"] } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: ["a", "b"] } });
    });

    test("runtime: not with has filter", () => {
      const result = parse(schemas.filter, { not: { has: "a" } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { has: "a" } });
    });

    test("runtime: not with hasEvery filter", () => {
      const result = parse(schemas.filter, { not: { hasEvery: ["a", "b"] } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { hasEvery: ["a", "b"] } });
    });

    test("runtime: not with isEmpty filter", () => {
      const result = parse(schemas.filter, { not: { isEmpty: true } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { isEmpty: true } });
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
      const result1 = parse(brandedSchemas.base, ["a@b.com", "c@d.com"]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual(["a@b.com", "c@d.com"]);
      const result2 = parse(brandedSchemas.base, ["a@b.com", "not-an-email"]);
      expect(result2.issues).toBeDefined();
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
      const result = parse(schemas.base, ["a", "b"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(["a", "b"]);
    });

    test("runtime: parses null", () => {
      const result = parse(schemas.base, null);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(null);
    });
  });

  describe("create", () => {
    test("type: create is optional (has default null)", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string[] | null | undefined>().toExtend<Create>();
    });

    test("runtime: accepts array", () => {
      const result = parse(schemas.create, ["a", "b"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual(["a", "b"]);
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
      type Update = InferStringInput<State, "update">;
      expectTypeOf<{ set: string[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: string[] }>().toExtend<Update>();
    });

    test("runtime: shorthand array transforms to { set: value }", () => {
      const result = parse(schemas.update, ["a", "b"]);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ set: ["a", "b"] });
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

    test("runtime: push operation", () => {
      const result = parse(schemas.update, { push: "c" });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ push: ["c"] });
    });
  });

  describe("filter", () => {
    test("type: filter accepts null", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });

    test("type: filter accepts not with shorthand", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ not: string[] | null }>().toExtend<Filter>();
    });

    test("type: filter accepts not with filter object", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ not: { equals: string[] | null } }>().toExtend<Filter>();
      expectTypeOf<{ not: { has: string } }>().toExtend<Filter>();
      expectTypeOf<{ not: { isEmpty: boolean } }>().toExtend<Filter>();
    });

    test("runtime: shorthand null transforms to { equals: null }", () => {
      const result1 = parse(schemas.filter, ["a", "b"]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual({ equals: ["a", "b"] });
      const result2 = parse(schemas.filter, null);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toEqual({ equals: null });
    });

    test("runtime: equals null passes through", () => {
      const result = parse(schemas.filter, { equals: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
    });

    test("runtime: not with shorthand array transforms to { not: { equals: value } }", () => {
      const result = parse(schemas.filter, { not: ["a", "b"] });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: ["a", "b"] } });
    });

    test("runtime: not with shorthand null transforms to { not: { equals: null } }", () => {
      const result = parse(schemas.filter, { not: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: null } });
    });

    test("runtime: not with equals filter", () => {
      const result = parse(schemas.filter, { not: { equals: ["a", "b"] } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { equals: ["a", "b"] } });
    });

    test("runtime: not with has filter", () => {
      const result = parse(schemas.filter, { not: { has: "a" } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { has: "a" } });
    });

    test("runtime: not with isEmpty filter", () => {
      const result = parse(schemas.filter, { not: { isEmpty: true } });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ not: { isEmpty: true } });
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
      const result1 = parse(brandedSchemas.base, ["a@b.com"]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual(["a@b.com"]);
      const result2 = parse(brandedSchemas.base, null);
      if (result2.issues) throw new Error("Expected success");
      expect(result2.value).toBe(null);
      const result3 = parse(brandedSchemas.base, ["not-an-email"]);
      expect(result3.issues).toBeDefined();
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
      const result = parse(schemas.create, "world");
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("world");
    });

    test("runtime: undefined uses default", () => {
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe("hello");
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
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toBe(`generated-${before + 1}`);
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
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      expect(result.value).toMatch(
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
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      expect(result.value).toHaveLength(26);
    });

    test("nanoid: type is optional, runtime uses generator", () => {
      const field = string().nanoid();
      type State = (typeof field)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      expect(result.value.length).toBeGreaterThan(0);
    });

    test("cuid: type is optional, runtime uses generator", () => {
      const field = string().cuid();
      type State = (typeof field)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = field["~"].schemas;
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      expect(result.value.length).toBeGreaterThan(0);
    });
  });
});
