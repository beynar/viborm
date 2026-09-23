/**
 * String Scalar Schema Type & Runtime Tests
 *
 * Systematically tests type inference AND runtime validation for all string scalar variants:
 * - Raw (required)
 * - Nullable (with default null)
 * - List (array)
 * - Nullable List (nullable array)
 *
 * For each variant, tests:
 * - base: The element/scalar type
 * - create: Input type for creation + runtime validation
 * - update: Input type for updates + shorthand transforms
 * - filter: Input type for filtering + shorthand transforms
 *
 * Also tests branded type preservation for each variant.
 */

import { s } from "@schema";
import type { ScalarState } from "@schema/scalars/common";
import { string } from "@schema/scalars/string/scalar";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  createSchemaRegistry,
  type InferInput,
  type InferOutput,
  type Prettify,
  parse,
} from "@validation";
import {
  type GetScalarSchemas,
  getScalarSchemas,
  getScalarsSchemas,
} from "@validation/scalars";
import {
  type Brand as BRAND,
  brand,
  email,
  pipe,
  string as stringValibot,
} from "valibot";
import { describe, expect, expectTypeOf, test } from "vitest";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InferScalarInput<
  State extends ScalarState,
  Key extends keyof GetScalarSchemas<State>,
> = InferInput<GetScalarSchemas<State>[Key]>;
type InferStringInput<
  State extends ScalarState<"string">,
  Key extends keyof GetScalarSchemas<State>,
> = InferScalarInput<State, Key>;

// =============================================================================
// RAW STRING SCALAR (required, no modifiers)
// =============================================================================

describe("Raw String Scalar", () => {
  const scalar = string();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

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
    const brandedScalar = string().schema(
      pipe(stringValibot(), email(), brand("email"))
    );
    type BrandedOutput = InferOutput<
      (typeof brandedScalar)["~"]["state"]["base"]
    >;
    type EmailBrand = string & BRAND<"email">;

    test("type: base output preserves brand", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand>();
    });

    test("runtime: validates custom schema", () => {
      const brandedSchemas = getScalarSchemas(brandedScalar["~"].state);
      const result1 = parse(brandedSchemas.base, "test@example.com");
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toBe("test@example.com");
      const result2 = parse(brandedSchemas.base, "not-an-email");
      expect(result2.issues).toBeDefined();
    });
  });
});

// =============================================================================
// NULLABLE STRING SCALAR
// =============================================================================

describe("Nullable String Scalar", () => {
  const scalar = string().nullable();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

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
    const brandedScalar = string()
      .schema(pipe(stringValibot(), email(), brand("email")))
      .nullable();
    type BrandedOutput = InferOutput<
      (typeof brandedScalar)["~"]["state"]["base"]
    >;
    type EmailBrand = string & BRAND<"email">;

    test("type: base output preserves brand with null", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand | null>();
    });

    test("runtime: validates custom schema or null", () => {
      const brandedSchemas = getScalarSchemas(brandedScalar["~"].state);
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
// LIST STRING SCALAR (array)
// =============================================================================

describe("List String Scalar", () => {
  const scalar = string().array();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

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
    const brandedScalar = string()
      .schema(pipe(stringValibot(), email(), brand("email")))
      .array();
    type BrandedOutput = InferOutput<
      (typeof brandedScalar)["~"]["state"]["base"]
    >;
    type EmailBrand = string & BRAND<"email">;

    test("type: base output preserves brand in array", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand[]>();
    });

    test("runtime: validates each element against custom schema", () => {
      const brandedSchemas = getScalarSchemas(brandedScalar["~"].state);
      const result1 = parse(brandedSchemas.base, ["a@b.com", "c@d.com"]);
      if (result1.issues) throw new Error("Expected success");
      expect(result1.value).toEqual(["a@b.com", "c@d.com"]);
      const result2 = parse(brandedSchemas.base, ["a@b.com", "not-an-email"]);
      expect(result2.issues).toBeDefined();
    });
  });
});

// =============================================================================
// NULLABLE LIST STRING SCALAR (nullable array)
// =============================================================================

describe("Nullable List String Scalar", () => {
  const scalar = string().array().nullable();
  type State = (typeof scalar)["~"]["state"];
  const schemas = getScalarSchemas(scalar["~"].state);

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
    const brandedScalar = string()
      .schema(pipe(stringValibot(), email(), brand("email")))
      .array()
      .nullable();
    type BrandedOutput = InferOutput<
      (typeof brandedScalar)["~"]["state"]["base"]
    >;
    type EmailBrand = string & BRAND<"email">;

    test("type: base output preserves brand in nullable array", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand[] | null>();
    });

    test("runtime: validates elements or accepts null", () => {
      const brandedSchemas = getScalarSchemas(brandedScalar["~"].state);
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
    const scalar = string().default("hello");
    type State = (typeof scalar)["~"]["state"];
    const schemas = getScalarSchemas(scalar["~"].state);

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
    const scalar = string().default(() => {
      callCount++;
      return `generated-${callCount}`;
    });
    const schemas = getScalarSchemas(scalar["~"].state);

    test("type: create is optional", () => {
      type State = (typeof scalar)["~"]["state"];
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

  describe("auto-generated scalars", () => {
    test("uuid: type is optional, runtime uses generator", () => {
      const scalar = string().uuid();
      type State = (typeof scalar)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = getScalarSchemas(scalar["~"].state);
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      expect(result.value).toMatch(CANONICAL_UUID);
    });

    test("ulid: type is optional, runtime uses generator", () => {
      const scalar = string().ulid();
      type State = (typeof scalar)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = getScalarSchemas(scalar["~"].state);
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      expect(result.value).toHaveLength(26);
    });

    test("nanoid: type is optional, runtime uses generator", () => {
      const scalar = string().nanoid();
      type State = (typeof scalar)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = getScalarSchemas(scalar["~"].state);
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      expect(result.value.length).toBeGreaterThan(0);
    });

    test("cuid: type is optional, runtime uses generator", () => {
      const scalar = string().cuid();
      type State = (typeof scalar)["~"]["state"];
      type Create = InferStringInput<State, "create">;
      expectTypeOf<string | undefined>().toExtend<Create>();

      const schemas = getScalarSchemas(scalar["~"].state);
      const result = parse(schemas.create, undefined);
      if (result.issues) throw new Error("Expected success");
      expect(typeof result.value).toBe("string");
      expect(result.value.length).toBeGreaterThan(0);
    });
  });
});

describe("a declared identifier domain", () => {
  const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const CUID = "tz4a98xxat96iws9zmbrgj3a";

  /** The value a schema admitted, or `undefined` when it refused. */
  const admitted = (schema: StandardSchemaV1, value: unknown): unknown => {
    const result = parse(schema, value);
    return result.issues ? undefined : result.value;
  };

  test("create, update and filter admit only the domain's values", () => {
    const schemas = getScalarSchemas(string().uuid("usr")["~"].state);
    expect(admitted(schemas.create, `usr-${UUID}`)).toBe(`usr-${UUID}`);
    expect(admitted(schemas.create, UUID)).toBeUndefined();
    // The update schema normalizes the shorthand into `{ set }`.
    expect(admitted(schemas.update, `usr-${UUID}`)).toEqual({
      set: `usr-${UUID}`,
    });
    expect(admitted(schemas.update, UUID)).toBeUndefined();
    expect(admitted(schemas.filter, { equals: `usr-${UUID}` })).toEqual({
      equals: `usr-${UUID}`,
    });
    expect(admitted(schemas.filter, { equals: "nope" })).toBeUndefined();
  });

  test("an alias normalizes once, on the way in", () => {
    const schemas = getScalarSchemas(string().uuid("usr")["~"].state);
    expect(admitted(schemas.create, `usr-${UUID.toUpperCase()}`)).toBe(
      `usr-${UUID}`
    );
    const ulid = getScalarSchemas(string().ulid()["~"].state);
    expect(admitted(ulid.create, "01arz3ndektsv4rrffq69g5fav")).toBe(
      "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    );
  });

  test("the refusal names the domain it expected", () => {
    const schemas = getScalarSchemas(string().nanoid(8, "n")["~"].state);
    const result = parse(schemas.create, "bad");
    expect(result.issues?.[0]?.message).toBe(
      "Expected a nanoid value of length 8 prefixed 'n-'"
    );
  });

  test("a compact format's filter drops the four text predicates", () => {
    const compact = getScalarSchemas(string().uuid()["~"].state);
    expect(admitted(compact.filter, { contains: "a0ee" })).toBeUndefined();
    expect(admitted(compact.filter, { startsWith: "a0ee" })).toBeUndefined();
    expect(admitted(compact.filter, { endsWith: "0a11" })).toBeUndefined();
    expect(admitted(compact.filter, { mode: "insensitive" })).toBeUndefined();
    // Everything the column can answer exactly is still there.
    expect(admitted(compact.filter, { in: [UUID], notIn: [] })).toEqual({
      in: [UUID],
      notIn: [],
    });
    expect(admitted(compact.filter, { lt: UUID, gte: UUID })).toEqual({
      lt: UUID,
      gte: UUID,
    });
  });

  test("a SET operand is an identifier too, admitted and folded", () => {
    // `in` / `notIn` members are values of the field exactly as `equals`'s
    // operand is. Built from a module-level list schema they could carry no
    // domain, so an out-of-domain member was admitted here and refused later as
    // an engine error, and an ALIAS was never folded — which hashed one
    // identifier to two cache keys.
    const compact = getScalarSchemas(string().uuid("usr")["~"].state);
    expect(
      admitted(compact.filter, { in: [`usr-${UUID.toUpperCase()}`] })
    ).toEqual({ in: [`usr-${UUID}`] });
    expect(admitted(compact.filter, { in: ["nope"] })).toBeUndefined();
    expect(admitted(compact.filter, { notIn: ["nope"] })).toBeUndefined();
    expect(admitted(compact.filter, { not: { in: [`usr-${UUID}`] } })).toEqual({
      not: { in: [`usr-${UUID}`] },
    });

    const text = getScalarSchemas(string().cuid()["~"].state);
    expect(admitted(text.filter, { in: [CUID] })).toEqual({ in: [CUID] });
    expect(admitted(text.filter, { in: ["NOT-A-CUID"] })).toBeUndefined();

    // A field with no domain keeps the list it always had.
    const plain = getScalarSchemas(string()["~"].state);
    expect(admitted(plain.filter, { in: ["anything"] })).toEqual({
      in: ["anything"],
    });
  });

  test("a TEXT-stored format keeps every string operator", () => {
    const text = getScalarSchemas(string().cuid()["~"].state);
    expect(admitted(text.filter, { contains: "tz4a" })).toEqual({
      contains: "tz4a",
    });
    expect(admitted(text.filter, { equals: CUID })).toEqual({ equals: CUID });
    // Its equality operand is still a value of the domain.
    expect(admitted(text.filter, { equals: "tz4a" })).toBeUndefined();
  });

  test("a bare `.id()` names no format and admits what a string admits", () => {
    const key = getScalarSchemas(string().id()["~"].state);
    expect(admitted(key.create, "anything at all")).toBe("anything at all");
    expect(admitted(key.filter, { contains: "any" })).toEqual({
      contains: "any",
    });
  });

  test("a custom default crosses the same validator an input does", () => {
    // `.default(fn)` after a generator replaces only the closure; the declared
    // format stays, and the closure's output is admitted exactly as an
    // explicit value is — it is not a back door into the column.
    const good = getScalarSchemas(
      string()
        .uuid("usr")
        .default(() => `usr-${UUID}`)["~"].state
    );
    expect(admitted(good.create, undefined)).toBe(`usr-${UUID}`);

    const bad = getScalarSchemas(
      string()
        .uuid("usr")
        .default(() => "not a uuid")["~"].state
    );
    expect(admitted(bad.create, undefined)).toBeUndefined();

    // And an alias from a custom default normalizes like any other value.
    const shouting = getScalarSchemas(
      string()
        .uuid("usr")
        .default(() => `usr-${UUID.toUpperCase()}`)["~"].state
    );
    expect(admitted(shouting.create, undefined)).toBe(`usr-${UUID}`);
  });

  describe("a custom schema's output crosses the domain again", () => {
    /** A Standard Schema that returns `map(input)`, recording what it read. */
    const returning = (map: (input: string) => string) => {
      const seen: unknown[] = [];
      const schema: StandardSchemaV1<string, string> = {
        "~standard": {
          version: 1,
          vendor: "custom-output-probe",
          validate: (value) => {
            seen.push(value);
            return { value: map(String(value)) };
          },
        },
      };
      return { schema, seen };
    };

    test("an output outside the domain is refused at admission", () => {
      // Before the domain was the last word, `"garbage"` was admitted and the
      // engine died at the binding (`EngineInvariantError: Identifier field
      // 'id' reached its binding with a value outside a uuid value prefixed
      // 'usr-'`).
      const { schema } = returning(() => "garbage");
      const schemas = getScalarSchemas(
        string().uuid("usr").schema(schema)["~"].state
      );
      const result = parse(schemas.create, `usr-${UUID}`);
      expect(result.issues?.[0]?.message).toBe(
        "Expected a uuid value prefixed 'usr-'"
      );
      expect(
        admitted(schemas.filter, { equals: `usr-${UUID}` })
      ).toBeUndefined();

      const user = s.model({
        id: s.string().uuid("usr").schema(schema).id(),
        name: s.string(),
      });
      const create = parse(
        createSchemaRegistry({ user }).proxy.user.args.create,
        {
          data: { id: `usr-${UUID}`, name: "a" },
        }
      );
      expect(create.issues).toEqual([
        {
          message: "Expected a uuid value prefixed 'usr-'",
          path: ["data", "id"],
        },
      ]);
    });

    test("an alias it returns folds to the canonical spelling", () => {
      const { schema, seen } = returning(
        (input) => `usr-${input.slice("usr-".length).toUpperCase()}`
      );
      const schemas = getScalarSchemas(
        string().uuid("usr").schema(schema)["~"].state
      );
      // The custom schema still reads the canonical spelling first ...
      expect(admitted(schemas.create, `usr-${UUID.toUpperCase()}`)).toBe(
        `usr-${UUID}`
      );
      expect(seen).toEqual([`usr-${UUID}`]);
      // ... and what it returns leaves canonical, operand and value alike.
      expect(admitted(schemas.filter, { equals: `usr-${UUID}` })).toEqual({
        equals: `usr-${UUID}`,
      });
    });
  });

  test("a LIST of strings has no domain, whatever it declares", () => {
    const list = getScalarSchemas(string().uuid().array()["~"].state);
    expect(admitted(list.create, ["anything"])).toEqual(["anything"]);
  });

  test("a DERIVED domain admits on a field that declares nothing", () => {
    const derived = getScalarSchemas(string()["~"].state, {
      format: "uuid",
      prefix: "usr",
    });
    expect(admitted(derived.create, `usr-${UUID}`)).toBe(`usr-${UUID}`);
    expect(admitted(derived.create, UUID)).toBeUndefined();
    expect(admitted(derived.filter, { contains: "usr" })).toBeUndefined();
    // A field that declares its OWN domain ignores the derived one; a schema
    // where the two disagree never resolves (FK012).
    const declared = getScalarSchemas(string().ulid()["~"].state, {
      format: "uuid",
      prefix: "usr",
    });
    expect(admitted(declared.create, "01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(
      "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    );
  });

  test("a model's scalars take the domains their foreign keys derive", () => {
    const model = s.model({
      id: s.string().id(),
      authorId: s.string(),
      label: s.string(),
    });
    const withDerived = getScalarsSchemas(
      model,
      new Map([["authorId", { format: "uuid", prefix: "usr" } as const]])
    );
    expect(admitted(withDerived.authorId.create, `usr-${UUID}`)).toBe(
      `usr-${UUID}`
    );
    expect(admitted(withDerived.authorId.create, UUID)).toBeUndefined();
    // A field the map does not name is untouched.
    expect(admitted(withDerived.label.create, "anything")).toBe("anything");
    // And without a map, nothing derives.
    expect(admitted(getScalarsSchemas(model).authorId.create, UUID)).toBe(UUID);
  });

  test("two fields share a filter tree exactly when they share a domain", () => {
    const first = getScalarSchemas(string().uuid("usr")["~"].state).filter;
    const same = getScalarSchemas(string().uuid("usr")["~"].state).filter;
    const otherPrefix = getScalarSchemas(
      string().uuid("org")["~"].state
    ).filter;
    const noDomain = getScalarSchemas(string()["~"].state).filter;
    expect(first).toBe(same);
    expect(first).not.toBe(otherPrefix);
    expect(first).not.toBe(noDomain);
  });
});
