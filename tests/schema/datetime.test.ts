import { s } from "../../src/schema/index.js";
import z from "zod/v4";
import {
  dateTime,
  nullableDateTime,
  dateTimeWithDefault,
  dateTimeWithValidation,
} from "../schema.js";

describe("DateTime Field", () => {
  describe("Basic DateTime Field", () => {
    test("should have correct field type", () => {
      expect(dateTime["~fieldType"]).toBe("dateTime");
    });

    test("should not be nullable by default", () => {
      expect(dateTime["~isOptional"]).toBe(false);
    });

    test("should not have default value", () => {
      expect(dateTime["~defaultValue"]).toBeUndefined();
    });

    test("should not have validator by default", () => {
      expect(dateTime["~fieldValidator"]).toBeUndefined();
    });

    test("should not be ID field by default", () => {
      expect(dateTime["~isId"]).toBe(false);
    });

    test("should not be unique by default", () => {
      expect(dateTime["~isUnique"]).toBe(false);
    });

    test("should not be array by default", () => {
      expect(dateTime["~isArray"]).toBe(false);
    });
  });

  describe("Nullable DateTime Field", () => {
    test("should be nullable", () => {
      expect(nullableDateTime["~isOptional"]).toBe(true);
    });

    test("should maintain dateTime type", () => {
      expect(nullableDateTime["~fieldType"]).toBe("dateTime");
    });
  });

  describe("DateTime Field with Default", () => {
    test("should have default value", () => {
      expect(dateTimeWithDefault["~defaultValue"]).toBeInstanceOf(Date);
    });

    test("should not be nullable", () => {
      expect(dateTimeWithDefault["~isOptional"]).toBe(false);
    });
  });

  describe("DateTime Field with Validation", () => {
    test("should have validator", () => {
      expect(dateTimeWithValidation["~fieldValidator"]).toBeDefined();
    });

    test("should validate correctly", async () => {
      const validDate = new Date();
      const result1 = await dateTimeWithValidation["~validate"](validDate);
      expect(result1.valid).toBe(true);

      const result2 = await dateTimeWithValidation["~validate"]("invalid-date");
      expect(result2.valid).toBe(false);
    });
  });

  describe("Chainable Methods", () => {
    test("should chain nullable()", () => {
      const field = s.dateTime().nullable();
      expect(field["~isOptional"]).toBe(true);
    });

    test("should chain default()", () => {
      const defaultDate = new Date("2023-01-01");
      const field = s.dateTime().default(defaultDate);
      expect(field["~defaultValue"]).toBe(defaultDate);
    });

    test("should chain validator()", () => {
      const field = s.dateTime().validator(z.date());
      expect(field["~fieldValidator"]).toBeDefined();
    });

    test("should chain unique()", () => {
      const field = s.dateTime().unique();
      expect(field["~isUnique"]).toBe(true);
    });

    test("should chain array()", () => {
      const field = s.dateTime().array();
      expect(field["~isArray"]).toBe(true);
    });

    test("should chain auto-generation methods", () => {
      const nowField = s.dateTime().id().now();
      expect(nowField["~isId"]).toBe(true);
      expect(nowField["~autoGenerate"]).toBe("now");

      const updatedAtField = s.dateTime().updatedAt();
      expect(updatedAtField["~autoGenerate"]).toBe("updatedAt");
    });
  });

  describe("Type Validation", () => {
    test("should validate Date objects", async () => {
      const testDate = new Date();
      const result = await dateTime["~validate"](testDate);
      expect(result.valid).toBe(true);
      expect(result.output).toBe(testDate);
    });

    test("should validate date strings", async () => {
      const result = await dateTime["~validate"]("2023-01-01T00:00:00.000Z");
      expect(result.valid).toBe(true);
    });

    test("should reject invalid date values", async () => {
      const result = await dateTime["~validate"]("not a date");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Invalid type for field. Expected dateTime"
      );
    });

    test("should accept null for nullable fields", async () => {
      const result = await nullableDateTime["~validate"](null);
      expect(result.valid).toBe(true);
    });
  });

  describe("Type Inference", () => {
    test("datetime field should have expected type properties", () => {
      expectTypeOf(dateTime).toHaveProperty("~fieldType");
      expectTypeOf(dateTime).toHaveProperty("~isOptional");
      expectTypeOf(dateTime).toHaveProperty("~isId");
    });

    test("methods should return correct types", () => {
      expectTypeOf(s.dateTime().nullable()).toHaveProperty("~isOptional");
      expectTypeOf(s.dateTime().default(new Date())).toHaveProperty(
        "~defaultValue"
      );
      expectTypeOf(s.dateTime().id()).toHaveProperty("~isId");
    });
  });
});
