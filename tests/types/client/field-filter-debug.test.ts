import { describe, test, expectTypeOf } from "vitest";
import {
  StringField,
  NumberField,
  BooleanField,
  DateTimeField,
  BigIntField,
  JsonField,
  EnumField,
} from "../../../src/schema/fields";
import type { FieldFilter } from "../../../src/types/client/query/filters";

describe("FieldFilter Debug Tests", () => {
  test("Debug StringField type resolution", () => {
    const nonNullableString = new StringField();
    const nullableString = new StringField().nullable();

    type NonNullableStringFilter = FieldFilter<typeof nonNullableString>;
    type NullableStringFilter = FieldFilter<typeof nullableString>;

    // Check what these types actually resolve to
    type DebugNonNullable = NonNullableStringFilter extends never
      ? "NEVER"
      : "NOT_NEVER";
    type DebugNullable = NullableStringFilter extends never
      ? "NEVER"
      : "NOT_NEVER";

    // Check field properties
    type IsStringField = typeof nonNullableString extends StringField<any>
      ? true
      : false;
    type IsOptional = (typeof nonNullableString)["~isOptional"];
    type IsOptionalNullable = (typeof nullableString)["~isOptional"];

    // These should not be never
    expectTypeOf<DebugNonNullable>().toEqualTypeOf<"NOT_NEVER">();
    expectTypeOf<DebugNullable>().toEqualTypeOf<"NOT_NEVER">();

    // These should reflect the field properties correctly
    expectTypeOf<IsStringField>().toEqualTypeOf<true>();
    expectTypeOf<IsOptional>().toEqualTypeOf<false>();
    expectTypeOf<IsOptionalNullable>().toEqualTypeOf<true>();
  });
});
