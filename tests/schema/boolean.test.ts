import { s } from "../../src/schema/index.js";
import z from "zod/v4";
import {
  boolean,
  nullableBoolean,
  booleanWithDefault,
  booleanWithValidation,
} from "../schema.js";

describe("Boolean Field", () => {
  describe("Basic Boolean Field", () => {
    test("should have correct field type", () => {
      expect(boolean["~fieldType"]).toBe("boolean");
    });

    test("should not be nullable by default", () => {
      expect(boolean["~isOptional"]).toBe(false);
    });

    test("should not have default value", () => {
      expect(boolean["~defaultValue"]).toBeUndefined();
    });

    test("should not have validator by default", () => {
      expect(boolean["~fieldValidator"]).toBeUndefined();
    });

    test("should not be ID field by default", () => {
      expect(boolean["~isId"]).toBe(false);
    });

    test("should not be unique by default", () => {
      expect(boolean["~isUnique"]).toBe(false);
    });

    test("should not be array by default", () => {
      expect(boolean["~isArray"]).toBe(false);
    });
  });

  describe("Nullable Boolean Field", () => {
    test("should be nullable", () => {
      expect(nullableBoolean["~isOptional"]).toBe(true);
    });

    test("should maintain boolean type", () => {
      expect(nullableBoolean["~fieldType"]).toBe("boolean");
    });
  });

  describe("Boolean Field with Default", () => {
    test("should have default value", () => {
      expect(booleanWithDefault["~defaultValue"]).toBe(true);
    });

    test("should not be nullable", () => {
      expect(booleanWithDefault["~isOptional"]).toBe(false);
    });
  });

  describe("Boolean Field with Validation", () => {
    test("should have validator", () => {
      expect(booleanWithValidation["~fieldValidator"]).toBeDefined();
    });

    test("should validate correctly", async () => {
      const result1 = await booleanWithValidation["~validate"](true);
      expect(result1.valid).toBe(true);

      const result2 = await booleanWithValidation["~validate"](false);
      expect(result2.valid).toBe(true);

      const result3 = await booleanWithValidation["~validate"]("not boolean");
      expect(result3.valid).toBe(false);
    });
  });

  describe("Chainable Methods", () => {
    test("should chain nullable()", () => {
      const field = s.boolean().nullable();
      expect(field["~isOptional"]).toBe(true);
    });

    test("should chain default()", () => {
      const field = s.boolean().default(false);
      expect(field["~defaultValue"]).toBe(false);
    });

    test("should chain validator()", () => {
      const field = s.boolean().validator(z.boolean());
      expect(field["~fieldValidator"]).toBeDefined();
    });

    test("should chain unique()", () => {
      const field = s.boolean().unique();
      expect(field["~isUnique"]).toBe(true);
    });

    test("should chain array()", () => {
      const field = s.boolean().array();
      expect(field["~isArray"]).toBe(true);
    });
  });

  describe("Type Validation", () => {
    test("should validate boolean values", async () => {
      const result1 = await boolean["~validate"](true);
      expect(result1.valid).toBe(true);
      expect(result1.output).toBe(true);

      const result2 = await boolean["~validate"](false);
      expect(result2.valid).toBe(true);
      expect(result2.output).toBe(false);
    });

    test("should reject non-boolean values", async () => {
      const result = await boolean["~validate"]("not boolean");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Invalid type for field. Expected boolean"
      );
    });

    test("should accept null for nullable fields", async () => {
      const result = await nullableBoolean["~validate"](null);
      expect(result.valid).toBe(true);
    });
  });

  describe("Type Inference", () => {
    test("boolean field should have expected type properties", () => {
      expectTypeOf(boolean).toHaveProperty("~fieldType");
      expectTypeOf(boolean).toHaveProperty("~isOptional");
      expectTypeOf(boolean).toHaveProperty("~isId");
    });

    test("methods should return correct types", () => {
      expectTypeOf(s.boolean().nullable()).toHaveProperty("~isOptional");
      expectTypeOf(s.boolean().default(true)).toHaveProperty("~defaultValue");
      expectTypeOf(s.boolean().unique()).toHaveProperty("~isUnique");
    });

    test("basic boolean field infer type should be boolean", () => {
      expectTypeOf(boolean.infer).toEqualTypeOf<boolean>();
    });

    test("nullable boolean field infer type should be boolean | null", () => {
      expectTypeOf(nullableBoolean.infer).toEqualTypeOf<boolean | null>();
    });

    test("boolean field with default infer type should be boolean", () => {
      expectTypeOf(booleanWithDefault.infer).toEqualTypeOf<boolean>();
    });

    test("boolean array field infer type should be boolean[]", () => {
      const booleanArray = s.boolean().array();
      expectTypeOf(booleanArray.infer).toEqualTypeOf<boolean[]>();
    });

    test("nullable array field infer type should be boolean[] | null", () => {
      const nullableArray = s.boolean().array().nullable();
      expectTypeOf(nullableArray.infer).toEqualTypeOf<boolean[] | null>();
    });

    test("array of nullable booleans should have infer property", () => {
      const arrayOfNullableBooleans = s.boolean().nullable().array();
      expectTypeOf(arrayOfNullableBooleans).toHaveProperty("infer");
    });
  });
});
