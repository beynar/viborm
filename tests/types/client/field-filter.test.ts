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
import type {
  FieldFilter,
  StringFilter,
  NumberFilter,
  BoolFilter,
  BoolNullableFilter,
  DateTimeFilter,
  DateTimeNullableFilter,
  BigIntFilter,
  BigIntNullableFilter,
  JsonFilter,
  JsonNullableFilter,
  EnumFilter,
  EnumNullableFilter,
} from "../../../src/types/client/query/filters";

describe("FieldFilter Type Tests", () => {
  test("StringField filters", () => {
    // Non-nullable string field
    const nonNullableString = new StringField();
    type NonNullableStringFilter = FieldFilter<typeof nonNullableString>;

    // Should extend string or StringFilter
    expectTypeOf<NonNullableStringFilter>().toExtend<string | StringFilter>();

    // Should NOT allow null
    expectTypeOf<NonNullableStringFilter>().not.toMatchTypeOf<null>();

    // Nullable string field
    const nullableString = new StringField().nullable();
    type NullableStringFilter = FieldFilter<typeof nullableString>;

    // Test that specific values are assignable to the filter type
    expectTypeOf<string>().toExtend<NullableStringFilter>();
    expectTypeOf<null>().toExtend<NullableStringFilter>();
  });

  test("NumberField filters", () => {
    // Non-nullable number field
    const nonNullableNumber = new NumberField();
    type NonNullableNumberFilter = FieldFilter<typeof nonNullableNumber>;

    // Should extend number or NumberFilter
    expectTypeOf<NonNullableNumberFilter>().toExtend<number | NumberFilter>();

    // Should NOT allow null
    expectTypeOf<NonNullableNumberFilter>().not.toExtend<null>();

    // Nullable number field
    const nullableNumber = new NumberField().nullable();
    type NullableNumberFilter = FieldFilter<typeof nullableNumber>;

    // Test that specific values are assignable to the filter type
    expectTypeOf<number>().toExtend<NullableNumberFilter>();
    expectTypeOf<null>().toExtend<NullableNumberFilter>();
  });

  test("BooleanField filters", () => {
    // Non-nullable boolean field
    const nonNullableBoolean = new BooleanField();
    type NonNullableBooleanFilter = FieldFilter<typeof nonNullableBoolean>;

    // Should extend boolean or BoolFilter
    expectTypeOf<NonNullableBooleanFilter>().toExtend<boolean | BoolFilter>();

    // Should NOT allow null
    expectTypeOf<NonNullableBooleanFilter>().not.toExtend<null>();

    // Nullable boolean field
    const nullableBoolean = new BooleanField().nullable();
    type NullableBooleanFilter = FieldFilter<typeof nullableBoolean>;

    // Test that specific values are assignable to the filter type
    expectTypeOf<boolean>().toExtend<NullableBooleanFilter>();
    expectTypeOf<null>().toExtend<NullableBooleanFilter>();
  });

  test("DateTimeField filters", () => {
    // Non-nullable datetime field
    const nonNullableDateTime = new DateTimeField();
    type NonNullableDateTimeFilter = FieldFilter<typeof nonNullableDateTime>;

    // Should extend Date or DateTimeFilter
    expectTypeOf<NonNullableDateTimeFilter>().toExtend<Date | DateTimeFilter>();

    // Should NOT allow null
    expectTypeOf<NonNullableDateTimeFilter>().not.toExtend<null>();

    // Nullable datetime field
    const nullableDateTime = new DateTimeField().nullable();
    type NullableDateTimeFilter = FieldFilter<typeof nullableDateTime>;

    // Test that specific values are assignable to the filter type
    expectTypeOf<Date>().toExtend<NullableDateTimeFilter>();
    expectTypeOf<null>().toExtend<NullableDateTimeFilter>();
  });

  test("BigIntField filters", () => {
    // Non-nullable bigint field
    const nonNullableBigInt = new BigIntField();
    type NonNullableBigIntFilter = FieldFilter<typeof nonNullableBigInt>;

    // Should extend bigint or BigIntFilter
    expectTypeOf<NonNullableBigIntFilter>().toExtend<bigint | BigIntFilter>();

    // Should NOT allow null
    expectTypeOf<NonNullableBigIntFilter>().not.toExtend<null>();

    // Nullable bigint field
    const nullableBigInt = new BigIntField().nullable();
    type NullableBigIntFilter = FieldFilter<typeof nullableBigInt>;

    // Test that specific values are assignable to the filter type
    expectTypeOf<bigint>().toExtend<NullableBigIntFilter>();
    expectTypeOf<null>().toExtend<NullableBigIntFilter>();
  });

  test("JsonField filters", () => {
    // Non-nullable json field
    const nonNullableJson = new JsonField();
    type NonNullableJsonFilter = FieldFilter<typeof nonNullableJson>;

    // Test basic assignability to any
    expectTypeOf<NonNullableJsonFilter>().toExtend<JsonFilter>();

    // Nullable json field
    const nullableJson = new JsonField().nullable();
    type NullableJsonFilter = FieldFilter<typeof nullableJson>;

    // Test that null is assignable
    expectTypeOf<null>().toExtend<NullableJsonFilter>(null as any);
  });

  test("EnumField filters", () => {
    // Non-nullable enum field
    const nonNullableEnum = new EnumField([
      "active",
      "inactive",
      "pending",
    ] as const);
    type NonNullableEnumFilter = FieldFilter<typeof nonNullableEnum>;

    expectTypeOf<
      EnumFilter<"active" | "inactive" | "pending">
    >().toExtend<NonNullableEnumFilter>();

    expectTypeOf<
      "active" | "inactive" | "pending"
    >().toExtend<NonNullableEnumFilter>();

    // Should NOT allow null
    expectTypeOf<NonNullableEnumFilter>().not.toExtend<null>();

    // Nullable enum field
    const nullableEnum = new EnumField([
      "active",
      "inactive",
      "pending",
    ] as const).nullable();
    type NullableEnumFilter = FieldFilter<typeof nullableEnum>;

    // Test that enum values and null are compatible
    expectTypeOf<"active">().toExtend<NullableEnumFilter>("active" as any);
    expectTypeOf<"inactive">().toExtend<NullableEnumFilter>("inactive" as any);
    expectTypeOf<"pending">().toExtend<NullableEnumFilter>("pending" as any);
    expectTypeOf<null>().toExtend<NullableEnumFilter>(null as any);
  });
});
