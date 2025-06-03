import { describe, test, expectTypeOf } from "vitest";
import {
  StringFilter,
  StringNullableFilter,
  StringArrayFilter,
  StringNullableArrayFilter,
  NumberFilter,
  NumberNullableFilter,
  NumberArrayFilter,
  NumberNullableArrayFilter,
  BoolFilter,
  BoolNullableFilter,
  BoolArrayFilter,
  BoolNullableArrayFilter,
  DateTimeFilter,
  DateTimeNullableFilter,
  DateTimeArrayFilter,
  DateTimeNullableArrayFilter,
  BigIntFilter,
  BigIntNullableFilter,
  BigIntArrayFilter,
  BigIntNullableArrayFilter,
  JsonFilter,
  JsonNullableFilter,
} from "../../../../src/types/client/query/filters-input";

describe("Filter Types", () => {
  describe("String filters", () => {
    test("StringFilter should allow string operations", () => {
      expectTypeOf<StringFilter>().toMatchTypeOf<string>();
      expectTypeOf<StringFilter>().toMatchTypeOf<{
        equals?: string;
        contains?: string;
        startsWith?: string;
        endsWith?: string;
      }>();
    });

    test("StringNullableFilter should allow null", () => {
      expectTypeOf<StringNullableFilter>().toMatchTypeOf<string | null>();
      expectTypeOf<StringNullableFilter>().toMatchTypeOf<{
        equals?: string | null;
      }>();
    });

    test("StringArrayFilter should allow array operations", () => {
      expectTypeOf<StringArrayFilter>().toMatchTypeOf<string[]>();
      expectTypeOf<StringArrayFilter>().toMatchTypeOf<{
        equals?: string[];
        has?: string;
        hasEvery?: string[];
        hasSome?: string[];
        isEmpty?: boolean;
      }>();
    });

    test("StringNullableArrayFilter should allow nullable array operations", () => {
      expectTypeOf<StringNullableArrayFilter>().toMatchTypeOf<{
        equals?: string[] | null;
        has?: string;
        hasEvery?: string[];
        hasSome?: string[];
        isEmpty?: boolean;
      }>();
    });
  });

  describe("Number filters", () => {
    test("NumberFilter should allow number operations", () => {
      expectTypeOf<NumberFilter>().toMatchTypeOf<number>();
      expectTypeOf<NumberFilter>().toMatchTypeOf<{
        equals?: number;
        lt?: number;
        lte?: number;
        gt?: number;
        gte?: number;
      }>();
    });

    test("NumberNullableFilter should allow null", () => {
      expectTypeOf<NumberNullableFilter>().toMatchTypeOf<number | null>();
      expectTypeOf<NumberNullableFilter>().toMatchTypeOf<{
        equals?: number | null;
      }>();
    });

    test("NumberArrayFilter should allow array operations", () => {
      expectTypeOf<NumberArrayFilter>().toMatchTypeOf<number[]>();
      expectTypeOf<NumberArrayFilter>().toMatchTypeOf<{
        equals?: number[];
        has?: number;
        hasEvery?: number[];
        hasSome?: number[];
        isEmpty?: boolean;
      }>();
    });

    test("NumberNullableArrayFilter should allow nullable array operations", () => {
      expectTypeOf<NumberNullableArrayFilter>().toMatchTypeOf<{
        equals?: number[] | null;
        has?: number;
        hasEvery?: number[];
        hasSome?: number[];
        isEmpty?: boolean;
      }>();
    });
  });

  describe("Boolean filters", () => {
    test("BoolFilter should allow boolean operations", () => {
      expectTypeOf<BoolFilter>().toMatchTypeOf<boolean>();
      expectTypeOf<BoolFilter>().toMatchTypeOf<{
        equals?: boolean;
      }>();
    });

    test("BoolNullableFilter should allow null", () => {
      expectTypeOf<BoolNullableFilter>().toMatchTypeOf<boolean | null>();
      expectTypeOf<BoolNullableFilter>().toMatchTypeOf<{
        equals?: boolean | null;
      }>();
    });

    test("BoolArrayFilter should allow array operations", () => {
      expectTypeOf<BoolArrayFilter>().toMatchTypeOf<boolean[]>();
      expectTypeOf<BoolArrayFilter>().toMatchTypeOf<{
        equals?: boolean[];
        has?: boolean;
        hasEvery?: boolean[];
        hasSome?: boolean[];
        isEmpty?: boolean;
      }>();
    });

    test("BoolNullableArrayFilter should allow nullable array operations", () => {
      expectTypeOf<BoolNullableArrayFilter>().toMatchTypeOf<{
        equals?: boolean[] | null;
        has?: boolean;
        hasEvery?: boolean[];
        hasSome?: boolean[];
        isEmpty?: boolean;
      }>();
    });
  });

  describe("DateTime filters", () => {
    test("DateTimeFilter should allow Date operations", () => {
      expectTypeOf<DateTimeFilter>().toMatchTypeOf<Date>();
      expectTypeOf<DateTimeFilter>().toMatchTypeOf<{
        equals?: Date;
        lt?: Date;
        lte?: Date;
        gt?: Date;
        gte?: Date;
      }>();
    });

    test("DateTimeNullableFilter should allow null", () => {
      expectTypeOf<DateTimeNullableFilter>().toMatchTypeOf<Date | null>();
      expectTypeOf<DateTimeNullableFilter>().toMatchTypeOf<{
        equals?: Date | null;
      }>();
    });

    test("DateTimeArrayFilter should allow array operations", () => {
      expectTypeOf<DateTimeArrayFilter>().toMatchTypeOf<Date[]>();
      expectTypeOf<DateTimeArrayFilter>().toMatchTypeOf<{
        equals?: Date[];
        has?: Date;
        hasEvery?: Date[];
        hasSome?: Date[];
        isEmpty?: boolean;
      }>();
    });

    test("DateTimeNullableArrayFilter should allow nullable array operations", () => {
      expectTypeOf<DateTimeNullableArrayFilter>().toMatchTypeOf<{
        equals?: Date[] | null;
        has?: Date;
        hasEvery?: Date[];
        hasSome?: Date[];
        isEmpty?: boolean;
      }>();
    });
  });

  describe("BigInt filters", () => {
    test("BigIntFilter should allow bigint operations", () => {
      expectTypeOf<BigIntFilter>().toMatchTypeOf<bigint>();
      expectTypeOf<BigIntFilter>().toMatchTypeOf<{
        equals?: bigint;
        lt?: bigint;
        lte?: bigint;
        gt?: bigint;
        gte?: bigint;
      }>();
    });

    test("BigIntNullableFilter should allow null", () => {
      expectTypeOf<BigIntNullableFilter>().toMatchTypeOf<bigint | null>();
      expectTypeOf<BigIntNullableFilter>().toMatchTypeOf<{
        equals?: bigint | null;
      }>();
    });

    test("BigIntArrayFilter should allow array operations", () => {
      expectTypeOf<BigIntArrayFilter>().toMatchTypeOf<bigint[]>();
      expectTypeOf<BigIntArrayFilter>().toMatchTypeOf<{
        equals?: bigint[];
        has?: bigint;
        hasEvery?: bigint[];
        hasSome?: bigint[];
        isEmpty?: boolean;
      }>();
    });

    test("BigIntNullableArrayFilter should allow nullable array operations", () => {
      expectTypeOf<BigIntNullableArrayFilter>().toMatchTypeOf<{
        equals?: bigint[] | null;
        has?: bigint;
        hasEvery?: bigint[];
        hasSome?: bigint[];
        isEmpty?: boolean;
      }>();
    });
  });

  describe("JSON filters", () => {
    test("JsonFilter should allow any value and JSON operations", () => {
      expectTypeOf<JsonFilter>().toMatchTypeOf<{
        equals?: any;
        path?: string[];
        string_contains?: string;
        array_contains?: any;
      }>();
    });

    test("JsonNullableFilter should allow null", () => {
      expectTypeOf<JsonNullableFilter>().toMatchTypeOf<{
        equals?: any | null;
        path?: string[];
      }>();
    });
  });
});
