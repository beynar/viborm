import { s } from "../../src/schema/index.js";
import z from "zod/v4";
import { json, nullableJson, jsonWithDefault, simpleJson } from "../schema.js";

describe("JSON Field", () => {
  describe("Basic JSON Field", () => {
    test("should have correct field type", () => {
      expect(json["~fieldType"]).toBe("json");
    });

    test("should not be nullable by default", () => {
      expect(json["~isOptional"]).toBe(false);
    });

    test("should not have default value", () => {
      expect(json["~defaultValue"]).toBeUndefined();
    });

    test("should not be ID field by default", () => {
      expect(json["~isId"]).toBe(false);
    });

    test("should not be unique by default", () => {
      expect(json["~isUnique"]).toBe(false);
    });

    test("should not be array by default", () => {
      expect(json["~isArray"]).toBe(false);
    });
  });

  describe("Nullable JSON Field", () => {
    test("should be nullable", () => {
      expect(nullableJson["~isOptional"]).toBe(true);
    });

    test("should maintain json type", () => {
      expect(nullableJson["~fieldType"]).toBe("json");
    });
  });

  describe("JSON Field with Default", () => {
    test("should have default value", () => {
      expect(jsonWithDefault["~defaultValue"]).toEqual({
        name: "John",
        age: 30,
      });
    });

    test("should not be nullable", () => {
      expect(jsonWithDefault["~isOptional"]).toBe(false);
    });
  });

  describe("Chainable Methods", () => {
    test("should chain nullable()", () => {
      const field = s.json(simpleJson).nullable();
      expect(field["~isOptional"]).toBe(true);
    });

    test("should chain default()", () => {
      const defaultValue = { name: "Test", age: 25 };
      const field = s.json(simpleJson).default(defaultValue);
      expect(field["~defaultValue"]).toEqual(defaultValue);
    });

    test("should chain unique()", () => {
      const field = s.json(simpleJson).unique();
      expect(field["~isUnique"]).toBe(true);
    });

    test("should chain array()", () => {
      const field = s.json(simpleJson).array();
      expect(field["~isArray"]).toBe(true);
    });
  });

  describe("Type Validation", () => {
    test("should validate valid JSON objects", async () => {
      const validData = { name: "Alice", age: 30 };
      const result = await json["~validate"](validData);
      expect(result.valid).toBe(true);
      expect(result.output).toEqual(validData);
    });

    test("should reject invalid JSON structure", async () => {
      const invalidData = { name: "Alice", age: "thirty" }; // age should be number
      const result = await json["~validate"](invalidData);
      expect(result.valid).toBe(false);
    });

    test("should accept null for nullable fields", async () => {
      const result = await nullableJson["~validate"](null);
      console.log(result);
      expect(result.valid).toBe(true);
    });
  });

  describe("Type Inference", () => {
    test("json field should have expected type properties", () => {
      expectTypeOf(json).toHaveProperty("~fieldType");
      expectTypeOf(json).toHaveProperty("~isOptional");
      expectTypeOf(json).toHaveProperty("~isUnique");
    });

    test("methods should return correct types", () => {
      expectTypeOf(s.json(simpleJson).nullable()).toHaveProperty("~isOptional");
      expectTypeOf(
        s.json(simpleJson).default({ name: "test", age: 1 })
      ).toHaveProperty("~defaultValue");
      expectTypeOf(s.json(simpleJson).unique()).toHaveProperty("~isUnique");
    });

    test("field type should be correct", () => {
      expectTypeOf(json["~fieldType"]).toEqualTypeOf<"json">();
    });
  });
});
