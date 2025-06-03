import { describe, test, expectTypeOf } from "vitest";
import {
  stringFieldUpdateOperationsInput,
  nullableStringFieldUpdateOperationsInput,
  stringArrayFieldUpdateOperationsInput,
  nullableStringArrayFieldUpdateOperationsInput,
  intFieldUpdateOperationsInput,
  nullableIntFieldUpdateOperationsInput,
  intArrayFieldUpdateOperationsInput,
  nullableIntArrayFieldUpdateOperationsInput,
  floatFieldUpdateOperationsInput,
  nullableFloatFieldUpdateOperationsInput,
  floatArrayFieldUpdateOperationsInput,
  nullableFloatArrayFieldUpdateOperationsInput,
  boolFieldUpdateOperationsInput,
  nullableBoolFieldUpdateOperationsInput,
  boolArrayFieldUpdateOperationsInput,
  nullableBoolArrayFieldUpdateOperationsInput,
  dateTimeFieldUpdateOperationsInput,
  nullableDateTimeFieldUpdateOperationsInput,
  dateTimeArrayFieldUpdateOperationsInput,
  nullableDateTimeArrayFieldUpdateOperationsInput,
  bigIntFieldUpdateOperationsInput,
  nullableBigIntFieldUpdateOperationsInput,
  bigIntArrayFieldUpdateOperationsInput,
  nullableBigIntArrayFieldUpdateOperationsInput,
  jsonFieldUpdateOperationsInput,
  nullableJsonFieldUpdateOperationsInput,
  type StringFieldUpdateOperationsInput,
  type NullableStringFieldUpdateOperationsInput,
  type StringArrayFieldUpdateOperationsInput,
  type NullableStringArrayFieldUpdateOperationsInput,
  type IntFieldUpdateOperationsInput,
  type NullableIntFieldUpdateOperationsInput,
  type IntArrayFieldUpdateOperationsInput,
  type NullableIntArrayFieldUpdateOperationsInput,
  type FloatFieldUpdateOperationsInput,
  type NullableFloatFieldUpdateOperationsInput,
  type FloatArrayFieldUpdateOperationsInput,
  type NullableFloatArrayFieldUpdateOperationsInput,
  type BoolFieldUpdateOperationsInput,
  type NullableBoolFieldUpdateOperationsInput,
  type BoolArrayFieldUpdateOperationsInput,
  type NullableBoolArrayFieldUpdateOperationsInput,
  type DateTimeFieldUpdateOperationsInput,
  type NullableDateTimeFieldUpdateOperationsInput,
  type DateTimeArrayFieldUpdateOperationsInput,
  type NullableDateTimeArrayFieldUpdateOperationsInput,
  type BigIntFieldUpdateOperationsInput,
  type NullableBigIntFieldUpdateOperationsInput,
  type BigIntArrayFieldUpdateOperationsInput,
  type NullableBigIntArrayFieldUpdateOperationsInput,
  type JsonFieldUpdateOperationsInput,
  type NullableJsonFieldUpdateOperationsInput,
} from "../../../../src/types/client/query/update-input";

describe("Field Update Operations", () => {
  describe("String update operations", () => {
    test("StringFieldUpdateOperationsInput should allow set operation", () => {
      expectTypeOf<StringFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: string;
      }>();
    });

    test("NullableStringFieldUpdateOperationsInput should allow set with null", () => {
      expectTypeOf<NullableStringFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: string | null;
      }>();
    });
  });

  describe("Number update operations", () => {
    test("IntFieldUpdateOperationsInput should allow arithmetic operations", () => {
      expectTypeOf<IntFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: number;
        increment?: number;
        decrement?: number;
        multiply?: number;
        divide?: number;
      }>();
    });

    test("NullableIntFieldUpdateOperationsInput should allow set with null", () => {
      expectTypeOf<NullableIntFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: number | null;
        increment?: number;
        decrement?: number;
        multiply?: number;
        divide?: number;
      }>();
    });
  });

  describe("Boolean update operations", () => {
    test("BoolFieldUpdateOperationsInput should allow set operation", () => {
      expectTypeOf<BoolFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: boolean;
      }>();
    });

    test("NullableBoolFieldUpdateOperationsInput should allow set with null", () => {
      expectTypeOf<NullableBoolFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: boolean | null;
      }>();
    });
  });

  describe("DateTime update operations", () => {
    test("DateTimeFieldUpdateOperationsInput should allow set operation", () => {
      expectTypeOf<DateTimeFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: Date;
      }>();
    });

    test("NullableDateTimeFieldUpdateOperationsInput should allow set with null", () => {
      expectTypeOf<NullableDateTimeFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: Date | null;
      }>();
    });
  });

  describe("BigInt update operations", () => {
    test("BigIntFieldUpdateOperationsInput should allow arithmetic operations", () => {
      expectTypeOf<BigIntFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: bigint;
        increment?: bigint;
        decrement?: bigint;
        multiply?: bigint;
        divide?: bigint;
      }>();
    });

    test("NullableBigIntFieldUpdateOperationsInput should allow set with null", () => {
      expectTypeOf<NullableBigIntFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: bigint | null;
        increment?: bigint;
        decrement?: bigint;
        multiply?: bigint;
        divide?: bigint;
      }>();
    });
  });

  describe("JSON update operations", () => {
    test("JsonFieldUpdateOperationsInput should allow set operation", () => {
      expectTypeOf<JsonFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: any;
      }>();
    });

    test("NullableJsonFieldUpdateOperationsInput should allow set with null", () => {
      expectTypeOf<NullableJsonFieldUpdateOperationsInput>().toMatchTypeOf<{
        set?: any | null;
      }>();
    });
  });
});

describe("Update Input Schemas", () => {
  describe("String update operations", () => {
    test("should validate string field update operations", () => {
      const validUpdate = { set: "hello" };
      const result = stringFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable string field update operations", () => {
      const validUpdate = { set: null };
      const result =
        nullableStringFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate string array field update operations", () => {
      const validUpdate = {
        set: ["hello", "world"],
        push: "new item",
        pop: true,
      };
      const result = stringArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable string array field update operations", () => {
      const validUpdate = {
        set: null,
        push: ["item1", "item2"],
      };
      const result =
        nullableStringArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });
  });

  describe("Number update operations", () => {
    test("should validate int field update operations", () => {
      const validUpdate = {
        set: 42,
        increment: 5,
        multiply: 2,
      };
      const result = intFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable int field update operations", () => {
      const validUpdate = {
        set: null,
        increment: 10,
      };
      const result = nullableIntFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate int array field update operations", () => {
      const validUpdate = {
        set: [1, 2, 3],
        push: 4,
        splice: { start: 0, deleteCount: 1, items: [10] },
      };
      const result = intArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable int array field update operations", () => {
      const validUpdate = {
        set: null,
        unshift: [5, 6],
      };
      const result =
        nullableIntArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate float field update operations", () => {
      const validUpdate = {
        set: 3.14,
        divide: 2.0,
      };
      const result = floatFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable float field update operations", () => {
      const validUpdate = {
        set: null,
        decrement: 1.5,
      };
      const result = nullableFloatFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate float array field update operations", () => {
      const validUpdate = {
        set: [1.1, 2.2, 3.3],
        push: 4.4,
      };
      const result = floatArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable float array field update operations", () => {
      const validUpdate = {
        set: null,
        shift: true,
      };
      const result =
        nullableFloatArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });
  });

  describe("Boolean update operations", () => {
    test("should validate bool field update operations", () => {
      const validUpdate = { set: true };
      const result = boolFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable bool field update operations", () => {
      const validUpdate = { set: null };
      const result = nullableBoolFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate bool array field update operations", () => {
      const validUpdate = {
        set: [true, false, true],
        push: false,
      };
      const result = boolArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable bool array field update operations", () => {
      const validUpdate = {
        set: null,
        unshift: true,
      };
      const result =
        nullableBoolArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });
  });

  describe("DateTime update operations", () => {
    test("should validate dateTime field update operations", () => {
      const date = new Date();
      const validUpdate = { set: date };
      const result = dateTimeFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable dateTime field update operations", () => {
      const validUpdate = { set: null };
      const result =
        nullableDateTimeFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate dateTime array field update operations", () => {
      const dates = [new Date(), new Date()];
      const validUpdate = {
        set: dates,
        push: new Date(),
      };
      const result = dateTimeArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable dateTime array field update operations", () => {
      const validUpdate = {
        set: null,
        pop: true,
      };
      const result =
        nullableDateTimeArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });
  });

  describe("BigInt update operations", () => {
    test("should validate bigInt field update operations", () => {
      const validUpdate = {
        set: 123n,
        increment: 5n,
      };
      const result = bigIntFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable bigInt field update operations", () => {
      const validUpdate = {
        set: null,
        multiply: 2n,
      };
      const result =
        nullableBigIntFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate bigInt array field update operations", () => {
      const validUpdate = {
        set: [1n, 2n, 3n],
        push: 4n,
      };
      const result = bigIntArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable bigInt array field update operations", () => {
      const validUpdate = {
        set: null,
        unshift: [5n, 6n],
      };
      const result =
        nullableBigIntArrayFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });
  });

  describe("JSON update operations", () => {
    test("should validate json field update operations", () => {
      const validUpdate = {
        set: { key: "value" },
        merge: { another: "property" },
        path: { path: ["nested", "field"], value: "new value" },
      };
      const result = jsonFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });

    test("should validate nullable json field update operations", () => {
      const validUpdate = {
        set: null,
        merge: { key: "value" },
      };
      const result = nullableJsonFieldUpdateOperationsInput.parse(validUpdate);
      expect(result).toEqual(validUpdate);
    });
  });
});

describe("Update Input Type Tests", () => {
  test("string field update operations types", () => {
    expectTypeOf<StringFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: string;
    }>();

    expectTypeOf<NullableStringFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: string | null;
    }>();

    expectTypeOf<StringArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: string[];
      push?: string | string[];
      unshift?: string | string[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: string[];
      };
    }>();

    expectTypeOf<NullableStringArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: string[] | null;
      push?: string | string[];
      unshift?: string | string[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: string[];
      };
    }>();
  });

  test("number field update operations types", () => {
    expectTypeOf<IntFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: number;
      increment?: number;
      decrement?: number;
      multiply?: number;
      divide?: number;
    }>();

    expectTypeOf<NullableIntFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: number | null;
      increment?: number;
      decrement?: number;
      multiply?: number;
      divide?: number;
    }>();

    expectTypeOf<IntArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: number[];
      push?: number | number[];
      unshift?: number | number[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: number[];
      };
    }>();

    expectTypeOf<NullableIntArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: number[] | null;
      push?: number | number[];
      unshift?: number | number[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: number[];
      };
    }>();
  });

  test("boolean field update operations types", () => {
    expectTypeOf<BoolFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: boolean;
    }>();

    expectTypeOf<NullableBoolFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: boolean | null;
    }>();

    expectTypeOf<BoolArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: boolean[];
      push?: boolean | boolean[];
      unshift?: boolean | boolean[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: boolean[];
      };
    }>();

    expectTypeOf<NullableBoolArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: boolean[] | null;
      push?: boolean | boolean[];
      unshift?: boolean | boolean[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: boolean[];
      };
    }>();
  });

  test("dateTime field update operations types", () => {
    expectTypeOf<DateTimeFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: Date;
    }>();

    expectTypeOf<NullableDateTimeFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: Date | null;
    }>();

    expectTypeOf<DateTimeArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: Date[];
      push?: Date | Date[];
      unshift?: Date | Date[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: Date[];
      };
    }>();

    expectTypeOf<NullableDateTimeArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: Date[] | null;
      push?: Date | Date[];
      unshift?: Date | Date[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: Date[];
      };
    }>();
  });

  test("bigInt field update operations types", () => {
    expectTypeOf<BigIntFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: bigint;
      increment?: bigint;
      decrement?: bigint;
      multiply?: bigint;
      divide?: bigint;
    }>();

    expectTypeOf<NullableBigIntFieldUpdateOperationsInput>().toEqualTypeOf<{
      set?: bigint | null;
      increment?: bigint;
      decrement?: bigint;
      multiply?: bigint;
      divide?: bigint;
    }>();

    expectTypeOf<BigIntArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: bigint[];
      push?: bigint | bigint[];
      unshift?: bigint | bigint[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: bigint[];
      };
    }>();

    expectTypeOf<NullableBigIntArrayFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: bigint[] | null;
      push?: bigint | bigint[];
      unshift?: bigint | bigint[];
      pop?: boolean;
      shift?: boolean;
      splice?: {
        start: number;
        deleteCount?: number;
        items?: bigint[];
      };
    }>();
  });

  test("json field update operations types", () => {
    expectTypeOf<JsonFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: any;
      merge?: any;
      path?: {
        path: string[];
        value: any;
      };
    }>();

    expectTypeOf<NullableJsonFieldUpdateOperationsInput>().toMatchTypeOf<{
      set?: any | null;
      merge?: any;
      path?: {
        path: string[];
        value: any;
      };
    }>();
  });
});
