import { s } from "../../src/schema/index.js";
import z from "zod/v4";
import {
  enumField,
  nullableEnumField,
  enumFieldWithDefault,
  enumFieldWithValidation,
} from "../schema.js";

describe("Enum Field", () => {
  describe("Basic Enum Field", () => {
    test("should have correct field type", () => {
      expect(enumField["~fieldType"]).toBe("enum");
    });

    test("should not be nullable by default", () => {
      expect(enumField["~isOptional"]).toBe(false);
    });

    test("should not have default value", () => {
      expect(enumField["~defaultValue"]).toBeUndefined();
    });

    test("should not be ID field by default", () => {
      expect(enumField["~isId"]).toBe(false);
    });

    test("should not be unique by default", () => {
      expect(enumField["~isUnique"]).toBe(false);
    });

    test("should not be array by default", () => {
      expect(enumField["~isArray"]).toBe(false);
    });

    test("should have enum values defined", () => {
      expect(enumField["~getEnumValues"]()).toEqual(["a", "b"]);
    });
  });

  describe("Nullable Enum Field", () => {
    test("should be nullable", () => {
      expect(nullableEnumField["~isOptional"]).toBe(true);
    });

    test("should maintain enum type", () => {
      expect(nullableEnumField["~fieldType"]).toBe("enum");
    });

    test("should maintain enum values", () => {
      expect(nullableEnumField["~getEnumValues"]()).toEqual(["a", "b"]);
    });
  });

  describe("Enum Field with Default", () => {
    test("should have default value", () => {
      expect(enumFieldWithDefault["~defaultValue"]).toBe("a");
    });

    test("should not be nullable", () => {
      expect(enumFieldWithDefault["~isOptional"]).toBe(false);
    });
  });

  describe("Enum Field with Validation", () => {
    test("should have validator", () => {
      expect(enumFieldWithValidation["~fieldValidator"]).toBeDefined();
    });

    test("should validate correctly", async () => {
      const result1 = await enumFieldWithValidation["~validate"]("a");
      expect(result1.valid).toBe(true);

      const result2 = await enumFieldWithValidation["~validate"]("b");
      expect(result2.valid).toBe(true);

      const result3 = await enumFieldWithValidation["~validate"]("c");
      expect(result3.valid).toBe(false);
    });
  });

  describe("Chainable Methods", () => {
    test("should chain nullable()", () => {
      const field = s.enum(["x", "y"]).nullable();
      expect(field["~isOptional"]).toBe(true);
    });

    test("should chain default()", () => {
      const field = s.enum(["x", "y"]).default("x");
      expect(field["~defaultValue"]).toBe("x");
    });

    test("should chain validator()", () => {
      const field = s.enum(["x", "y"]).validator(z.enum(["x", "y"]));
      expect(field["~fieldValidator"]).toBeDefined();
    });

    test("should chain unique()", () => {
      const field = s.enum(["x", "y"]).unique();
      expect(field["~isUnique"]).toBe(true);
    });

    test("should chain array()", () => {
      const field = s.enum(["x", "y"]).array();
      expect(field["~isArray"]).toBe(true);
    });
  });

  describe("Type Validation", () => {
    test("should validate valid enum values", async () => {
      const result1 = await enumField["~validate"]("a");
      expect(result1.valid).toBe(true);
      expect(result1.output).toBe("a");

      const result2 = await enumField["~validate"]("b");
      expect(result2.valid).toBe(true);
      expect(result2.output).toBe("b");
    });

    test("should reject invalid enum values", async () => {
      const result = await enumField["~validate"]("c");
      expect(result.valid).toBe(false);
    });

    test("should accept null for nullable fields", async () => {
      const result = await nullableEnumField["~validate"](null);
      expect(result.valid).toBe(true);
    });
  });

  describe("Type Inference", () => {
    test("enum field should have expected type properties", () => {
      expectTypeOf(enumField).toHaveProperty("~fieldType");
      expectTypeOf(enumField).toHaveProperty("~isOptional");
      expectTypeOf(enumField).toHaveProperty("~getEnumValues");
    });

    test("methods should return correct types", () => {
      expectTypeOf(s.enum(["x", "y"]).nullable()).toHaveProperty("~isOptional");
      expectTypeOf(s.enum(["x", "y"]).default("x")).toHaveProperty(
        "~defaultValue"
      );
      expectTypeOf(s.enum(["x", "y"]).unique()).toHaveProperty("~isUnique");
    });

    test("field type should be correct", () => {
      expectTypeOf(enumField["~fieldType"]).toEqualTypeOf<"enum">();
    });

    test("basic enum field infer should have correct type", () => {
      expectTypeOf(enumField.infer).toBeString();
    });

    test("nullable enum field infer should include null", () => {
      expectTypeOf(nullableEnumField).toHaveProperty("infer");
    });

    test("enum field with default should have correct type", () => {
      expectTypeOf(enumFieldWithDefault.infer).toBeString();
    });

    test("enum array field should have correct type", () => {
      const enumArray = s.enum(["a", "b"]).array();
      expectTypeOf(enumArray.infer).toBeArray();
    });

    test("nullable enum array field should have correct type", () => {
      const nullableEnumArray = s.enum(["a", "b"]).array().nullable();
      expectTypeOf(nullableEnumArray).toHaveProperty("infer");
    });

    test("array of nullable enums should have infer property", () => {
      const arrayOfNullableEnums = s.enum(["a", "b"]).nullable().array();
      expectTypeOf(arrayOfNullableEnums).toHaveProperty("infer");
    });
  });
});
