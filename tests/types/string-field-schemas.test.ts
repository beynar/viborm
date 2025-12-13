/**
 * String Field Schema Type Tests
 *
 * Systematically tests type inference for all string field variants:
 * - Raw (required)
 * - Nullable (with default null)
 * - List (array)
 * - Nullable List (nullable array)
 *
 * For each variant, tests:
 * - base: The element/field type
 * - create: Input type for creation
 * - update: Input type for updates
 * - filter: Input type for filtering
 *
 * Also tests branded type preservation for each variant.
 */

import { describe, test, expectTypeOf } from "vitest";
import { email } from "zod/v4-mini";
import { string } from "../../src/schema/fields/string/field";
import type { InferStringInput } from "../../src/schema/fields/string/schemas";
import { BRAND } from "zod/v4";

// =============================================================================
// RAW STRING FIELD (required, no modifiers)
// =============================================================================

describe("Raw String Field", () => {
  const field = string();
  type State = (typeof field)["~"]["state"];

  describe("type inference", () => {
    test("base is string", () => {
      type Base = InferStringInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<string>();
    });

    test("create is required string", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<string>();
    });

    test("update accepts string or { set: string }", () => {
      type Update = InferStringInput<State, "update">;
      // Update should accept shorthand string or { set: string }
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<{ set: string }>().toExtend<Update>();
    });

    test("filter accepts string shorthand", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<string>().toExtend<Filter>();
    });

    test("filter accepts equals object", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ equals: string }>().toExtend<Filter>();
    });

    test("filter accepts contains/startsWith/endsWith", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ contains: string }>().toExtend<Filter>();
      expectTypeOf<{ startsWith: string }>().toExtend<Filter>();
      expectTypeOf<{ endsWith: string }>().toExtend<Filter>();
    });
  });

  describe("branded type preservation", () => {
    const brandedField = string().schema(email().brand("email"));
    type BrandedOutput =
      (typeof brandedField)["~"]["schemas"]["base"]["_zod"]["output"];
    type EmailBrand = string & BRAND<"email">;

    test("base output preserves brand", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand>();
    });
  });
});

// =============================================================================
// NULLABLE STRING FIELD
// =============================================================================

describe("Nullable String Field", () => {
  const field = string().nullable();
  type State = (typeof field)["~"]["state"];

  describe("type inference", () => {
    test("base is string | null", () => {
      type Base = InferStringInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<string | null>();
    });

    test("create is optional (has default null)", () => {
      type Create = InferStringInput<State, "create">;
      // Nullable fields have hasDefault: true with defaultValue: null
      // So create input should be optional
      expectTypeOf<string | null | undefined>().toExtend<Create>();
    });

    test("update accepts string, null, or { set: string | null }", () => {
      type Update = InferStringInput<State, "update">;
      expectTypeOf<string>().toExtend<Update>();
      expectTypeOf<null>().toExtend<Update>();
      expectTypeOf<{ set: string | null }>().toExtend<Update>();
    });

    test("filter accepts null", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });
  });

  describe("branded type preservation", () => {
    const brandedField = string().schema(email().brand("email")).nullable();
    type BrandedOutput =
      (typeof brandedField)["~"]["schemas"]["base"]["_zod"]["output"];
    type EmailBrand = string & BRAND<"email">;

    test("base output preserves brand with null", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand | null>();
    });
  });
});

// =============================================================================
// LIST STRING FIELD (array)
// =============================================================================

describe("List String Field", () => {
  const field = string().array();
  type State = (typeof field)["~"]["state"];

  describe("type inference", () => {
    test("base is string[]", () => {
      type Base = InferStringInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<string[]>();
    });

    test("create is required string[]", () => {
      type Create = InferStringInput<State, "create">;
      expectTypeOf<Create>().toEqualTypeOf<string[]>();
    });

    test("update accepts array operations", () => {
      type Update = InferStringInput<State, "update">;
      // Should accept set, push, unshift operations
      expectTypeOf<{ set: string[] }>().toExtend<Update>();
      expectTypeOf<{ push: string }>().toExtend<Update>();
      expectTypeOf<{ push: string[] }>().toExtend<Update>();
      expectTypeOf<{ unshift: string }>().toExtend<Update>();
    });

    test("filter accepts array filters", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<{ has: string }>().toExtend<Filter>();
      expectTypeOf<{ hasEvery: string[] }>().toExtend<Filter>();
      expectTypeOf<{ hasSome: string[] }>().toExtend<Filter>();
      expectTypeOf<{ isEmpty: boolean }>().toExtend<Filter>();
      expectTypeOf<{ equals: string[] }>().toExtend<Filter>();
    });
  });

  describe("branded type preservation", () => {
    const brandedField = string().schema(email().brand("email")).array();
    type BrandedOutput =
      (typeof brandedField)["~"]["schemas"]["base"]["_zod"]["output"];
    type EmailBrand = string & BRAND<"email">;

    test("base output preserves brand in array", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand[]>();
    });
  });
});

// =============================================================================
// NULLABLE LIST STRING FIELD (nullable array)
// =============================================================================

describe("Nullable List String Field", () => {
  const field = string().array().nullable();
  type State = (typeof field)["~"]["state"];

  describe("type inference", () => {
    test("base is string[] | null", () => {
      type Base = InferStringInput<State, "base">;
      expectTypeOf<Base>().toEqualTypeOf<string[] | null>();
    });

    test("create is optional (has default null)", () => {
      type Create = InferStringInput<State, "create">;
      // Nullable list has hasDefault: true with defaultValue: null
      expectTypeOf<string[] | null | undefined>().toExtend<Create>();
    });

    test("update accepts null and array operations", () => {
      type Update = InferStringInput<State, "update">;
      expectTypeOf<{ set: string[] | null }>().toExtend<Update>();
      expectTypeOf<{ push: string }>().toExtend<Update>();
    });

    test("filter accepts null", () => {
      type Filter = InferStringInput<State, "filter">;
      expectTypeOf<null>().toExtend<Filter>();
      expectTypeOf<{ equals: null }>().toExtend<Filter>();
    });
  });

  describe("branded type preservation", () => {
    const brandedField = string()
      .schema(email().brand("email"))
      .array()
      .nullable();
    type BrandedOutput =
      (typeof brandedField)["~"]["schemas"]["base"]["_zod"]["output"];
    type EmailBrand = string & BRAND<"email">;

    test("base output preserves brand in nullable array", () => {
      expectTypeOf<BrandedOutput>().toEqualTypeOf<EmailBrand[] | null>();
    });
  });
});

// =============================================================================
// DEFAULT VALUE BEHAVIOR
// =============================================================================

describe("Default Value Behavior", () => {
  test("field with default is optional in create", () => {
    const field = string().default("hello");
    type State = (typeof field)["~"]["state"];
    type Create = InferStringInput<State, "create">;
    // With default, field should be optional
    expectTypeOf<string | undefined>().toExtend<Create>();
  });

  test("field with default function is optional in create", () => {
    const field = string().default(() => "generated");
    type State = (typeof field)["~"]["state"];
    type Create = InferStringInput<State, "create">;
    expectTypeOf<string | undefined>().toExtend<Create>();
  });

  test("auto-generated fields are optional in create", () => {
    const uuidField = string().uuid();
    type UuidState = (typeof uuidField)["~"]["state"];
    type UuidCreate = InferStringInput<UuidState, "create">;
    expectTypeOf<string | undefined>().toExtend<UuidCreate>();

    const ulidField = string().ulid();
    type UlidState = (typeof ulidField)["~"]["state"];
    type UlidCreate = InferStringInput<UlidState, "create">;
    expectTypeOf<string | undefined>().toExtend<UlidCreate>();

    const nanoidField = string().nanoid();
    type NanoidState = (typeof nanoidField)["~"]["state"];
    type NanoidCreate = InferStringInput<NanoidState, "create">;
    expectTypeOf<string | undefined>().toExtend<NanoidCreate>();

    const cuidField = string().cuid();
    type CuidState = (typeof cuidField)["~"]["state"];
    type CuidCreate = InferStringInput<CuidState, "create">;
    expectTypeOf<string | undefined>().toExtend<CuidCreate>();
  });
});
