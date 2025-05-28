import { s } from "../../src/schema/index.js";
import z from "zod/v4";
import {
  number,
  nullableNumber,
  numberWithDefault,
  numberWithValidation,
} from "../schema.js";

describe("Number Field", () => {
  describe("Basic Number Field", () => {
    test("should have correct field type", () => {
      expect(number["~fieldType"]).toBe("int");
    });

    test("should not be nullable by default", () => {
      expect(number["~isOptional"]).toBe(false);
    });

    test("should not have default value", () => {
      expect(number["~defaultValue"]).toBeUndefined();
    });

    test("should not have validator by default", () => {
      expect(number["~fieldValidator"]).toBeUndefined();
    });

    test("should not be ID field by default", () => {
      expect(number["~isId"]).toBe(false);
    });

    test("should not be unique by default", () => {
      expect(number["~isUnique"]).toBe(false);
    });

    test("should not be array by default", () => {
      expect(number["~isArray"]).toBe(false);
    });
  });

  describe("Nullable Number Field", () => {
    test("should be nullable", () => {
      expect(nullableNumber["~isOptional"]).toBe(true);
    });

    test("should maintain int type", () => {
      expect(nullableNumber["~fieldType"]).toBe("int");
    });
  });

  describe("Number Field with Default", () => {
    test("should have default value", () => {
      expect(numberWithDefault["~defaultValue"]).toBe(1);
    });

    test("should not be nullable", () => {
      expect(numberWithDefault["~isOptional"]).toBe(false);
    });
  });

  describe("Number Field with Validation", () => {
    test("should have validator", () => {
      expect(numberWithValidation["~fieldValidator"]).toBeDefined();
    });

    test("should validate correctly", async () => {
      const result1 = await numberWithValidation["~validate"](5);
      expect(result1.valid).toBe(true);

      const result2 = await numberWithValidation["~validate"](0);
      expect(result2.valid).toBe(false);
    });
  });

  describe("Chainable Methods", () => {
    test("should chain nullable()", () => {
      const field = s.int().nullable();
      expect(field["~isOptional"]).toBe(true);
    });

    test("should chain default()", () => {
      const field = s.int().default(42);
      expect(field["~defaultValue"]).toBe(42);
    });

    test("should chain validator()", () => {
      const field = s.int().validator(z.number().min(0));
      expect(field["~fieldValidator"]).toBeDefined();
    });

    test("should chain id() with auto-generation methods", () => {
      const autoIncrementField = s.int().id().autoIncrement();
      expect(autoIncrementField["~isId"]).toBe(true);
      expect(autoIncrementField["~autoGenerate"]).toBe("increment");
    });

    test("should chain unique()", () => {
      const field = s.int().unique();
      expect(field["~isUnique"]).toBe(true);
    });

    test("should chain array()", () => {
      const field = s.int().array();
      expect(field["~isArray"]).toBe(true);
    });
  });

  describe("Number Type Variants", () => {
    test("should create float field", () => {
      const floatField = s.float();
      expect(floatField["~fieldType"]).toBe("float");
    });

    test("should create decimal field", () => {
      const decimalField = s.decimal();
      expect(decimalField["~fieldType"]).toBe("decimal");
    });
  });

  describe("Type Validation", () => {
    test("should validate number values", async () => {
      const result = await number["~validate"](123);
      expect(result.valid).toBe(true);
      expect(result.output).toBe(123);
    });

    test("should reject non-number values", async () => {
      const result = await number["~validate"]("not a number");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Invalid type for field. Expected int");
    });

    test("should accept null for nullable fields", async () => {
      const result = await nullableNumber["~validate"](null);
      expect(result.valid).toBe(true);
    });
  });

  describe("Type Inference", () => {
    test("number field should have expected type properties", () => {
      expectTypeOf(number).toHaveProperty("~fieldType");
      expectTypeOf(number).toHaveProperty("~isOptional");
      expectTypeOf(number).toHaveProperty("~isId");
    });

    test("methods should return correct types", () => {
      expectTypeOf(s.int().nullable()).toHaveProperty("~isOptional");
      expectTypeOf(s.int().default(42)).toHaveProperty("~defaultValue");
      expectTypeOf(s.int().id()).toHaveProperty("~isId");
    });

    test("basic number field infer type should be number", () => {
      expectTypeOf(number.infer).toEqualTypeOf<number>();
    });

    test("nullable number field infer type should be number | null", () => {
      expectTypeOf(nullableNumber.infer).toEqualTypeOf<number | null>();
    });

    test("number field with default infer type should be number", () => {
      expectTypeOf(numberWithDefault.infer).toEqualTypeOf<number>();
    });

    test("float field infer type should be number", () => {
      const floatField = s.float();
      expectTypeOf(floatField.infer).toEqualTypeOf<number>();
    });

    test("decimal field infer type should be number", () => {
      const decimalField = s.decimal();
      expectTypeOf(decimalField.infer).toEqualTypeOf<number>();
    });

    test("number array field infer type should be number[]", () => {
      const numberArray = s.int().array();
      expectTypeOf(numberArray.infer).toEqualTypeOf<number[]>();
    });

    test("number ID field infer type should be number", () => {
      const numberId = s.int().id();
      expectTypeOf(numberId.infer).toEqualTypeOf<number>();
    });

    test("auto-increment field infer type should be number", () => {
      const autoIncrement = s.int().autoIncrement();
      expectTypeOf(autoIncrement.infer).toEqualTypeOf<number>();
    });

    test("nullable array field infer type should be number[] | null", () => {
      const nullableArray = s.int().array().nullable();
      expectTypeOf(nullableArray.infer).toEqualTypeOf<number[] | null>();
    });

    test("array of nullable numbers should have infer property", () => {
      const arrayOfNullableNumbers = s.int().nullable().array();
      expectTypeOf(arrayOfNullableNumbers).toHaveProperty("infer");
    });
  });
});
