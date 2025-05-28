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

describe("FieldFilter Type Tests", () => {
  test("StringField filters", () => {
    // Non-nullable string field
    const nonNullableString = new StringField();
    type NonNullableStringFilter = FieldFilter<typeof nonNullableString>;

    // Should allow direct string values
    expectTypeOf<NonNullableStringFilter>().toMatchTypeOf<string>();

    // Should allow string filter objects
    expectTypeOf<NonNullableStringFilter>().toMatchTypeOf<{
      equals?: string;
      contains?: string;
      startsWith?: string;
      endsWith?: string;
      in?: string[];
      not?: string;
    }>();

    // Should NOT allow null
    expectTypeOf<NonNullableStringFilter>().not.toMatchTypeOf<null>();

    // Nullable string field
    const nullableString = new StringField().nullable();
    type NullableStringFilter = FieldFilter<typeof nullableString>;

    // Should allow direct string values and null
    expectTypeOf<NullableStringFilter>().toMatchTypeOf<string | null>();

    // Should allow nullable string filter objects
    expectTypeOf<NullableStringFilter>().toMatchTypeOf<{
      equals?: string | null;
      contains?: string;
      not?: string | null;
    }>();
  });

  test("NumberField filters", () => {
    // Non-nullable number field
    const nonNullableNumber = new NumberField();
    type NonNullableNumberFilter = FieldFilter<typeof nonNullableNumber>;

    // Should allow direct number values
    expectTypeOf<NonNullableNumberFilter>().toMatchTypeOf<number>();

    // Should allow number filter objects
    expectTypeOf<NonNullableNumberFilter>().toMatchTypeOf<{
      equals?: number;
      lt?: number;
      gte?: number;
      in?: number[];
    }>();

    // Should NOT allow null
    expectTypeOf<NonNullableNumberFilter>().not.toMatchTypeOf<null>();

    // Nullable number field
    const nullableNumber = new NumberField().nullable();
    type NullableNumberFilter = FieldFilter<typeof nullableNumber>;

    // Should allow direct number values and null
    expectTypeOf<NullableNumberFilter>().toMatchTypeOf<number | null>();
  });

  test("BooleanField filters", () => {
    // Non-nullable boolean field
    const nonNullableBoolean = new BooleanField();
    type NonNullableBooleanFilter = FieldFilter<typeof nonNullableBoolean>;

    // Should allow direct boolean values
    expectTypeOf<NonNullableBooleanFilter>().toMatchTypeOf<boolean>();

    // Should allow boolean filter objects
    expectTypeOf<NonNullableBooleanFilter>().toMatchTypeOf<{
      equals?: boolean;
      not?: boolean;
    }>();

    // Should NOT allow null
    expectTypeOf<NonNullableBooleanFilter>().not.toMatchTypeOf<null>();

    // Nullable boolean field
    const nullableBoolean = new BooleanField().nullable();
    type NullableBooleanFilter = FieldFilter<typeof nullableBoolean>;

    // Should allow direct boolean values and null
    expectTypeOf<NullableBooleanFilter>().toMatchTypeOf<boolean | null>();
  });

  test("DateTimeField filters", () => {
    // Non-nullable datetime field
    const nonNullableDateTime = new DateTimeField();
    type NonNullableDateTimeFilter = FieldFilter<typeof nonNullableDateTime>;

    // Should allow direct Date values
    expectTypeOf<NonNullableDateTimeFilter>().toMatchTypeOf<Date>();

    // Should allow datetime filter objects
    expectTypeOf<NonNullableDateTimeFilter>().toMatchTypeOf<{
      equals?: Date;
      lt?: Date;
      gte?: Date;
      in?: Date[];
    }>();

    // Should NOT allow null
    expectTypeOf<NonNullableDateTimeFilter>().not.toMatchTypeOf<null>();

    // Nullable datetime field
    const nullableDateTime = new DateTimeField().nullable();
    type NullableDateTimeFilter = FieldFilter<typeof nullableDateTime>;

    // Should allow direct Date values and null
    expectTypeOf<NullableDateTimeFilter>().toMatchTypeOf<Date | null>();
  });

  test("BigIntField filters", () => {
    // Non-nullable bigint field
    const nonNullableBigInt = new BigIntField();
    type NonNullableBigIntFilter = FieldFilter<typeof nonNullableBigInt>;

    // Should allow direct bigint values
    expectTypeOf<NonNullableBigIntFilter>().toMatchTypeOf<bigint>();

    // Should allow bigint filter objects
    expectTypeOf<NonNullableBigIntFilter>().toMatchTypeOf<{
      equals?: bigint;
      lt?: bigint;
      gte?: bigint;
      in?: bigint[];
    }>();

    // Should NOT allow null
    expectTypeOf<NonNullableBigIntFilter>().not.toMatchTypeOf<null>();

    // Nullable bigint field
    const nullableBigInt = new BigIntField().nullable();
    type NullableBigIntFilter = FieldFilter<typeof nullableBigInt>;

    // Should allow direct bigint values and null
    expectTypeOf<NullableBigIntFilter>().toMatchTypeOf<bigint | null>();
  });

  test("JsonField filters", () => {
    // Non-nullable json field
    const nonNullableJson = new JsonField();
    type NonNullableJsonFilter = FieldFilter<typeof nonNullableJson>;

    // Should allow any direct values
    expectTypeOf<NonNullableJsonFilter>().toMatchTypeOf<any>();

    // Should allow json filter objects
    expectTypeOf<NonNullableJsonFilter>().toMatchTypeOf<{
      equals?: any;
      path?: string[];
      string_contains?: string;
    }>();

    // Nullable json field
    const nullableJson = new JsonField().nullable();
    type NullableJsonFilter = FieldFilter<typeof nullableJson>;

    // Should allow any direct values and null
    expectTypeOf<NullableJsonFilter>().toMatchTypeOf<any | null>();
  });

  test("EnumField filters", () => {
    // Non-nullable enum field
    const nonNullableEnum = new EnumField([
      "active",
      "inactive",
      "pending",
    ] as const);
    type NonNullableEnumFilter = FieldFilter<typeof nonNullableEnum>;

    // Should allow direct enum values
    expectTypeOf<NonNullableEnumFilter>().toMatchTypeOf<
      "active" | "inactive" | "pending"
    >();

    // Should allow enum filter objects
    expectTypeOf<NonNullableEnumFilter>().toMatchTypeOf<{
      equals?: "active" | "inactive" | "pending";
      in?: ("active" | "inactive" | "pending")[];
      not?: "active" | "inactive" | "pending";
    }>();

    // Should NOT allow null
    expectTypeOf<NonNullableEnumFilter>().not.toMatchTypeOf<null>();

    // Nullable enum field
    const nullableEnum = new EnumField([
      "active",
      "inactive",
      "pending",
    ] as const).nullable();
    type NullableEnumFilter = FieldFilter<typeof nullableEnum>;

    // Should allow direct enum values and null
    expectTypeOf<NullableEnumFilter>().toMatchTypeOf<
      "active" | "inactive" | "pending" | null
    >();
  });
});
