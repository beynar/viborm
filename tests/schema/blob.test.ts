import { s } from "../../src/schema/index.js";
import z from "zod/v4";
import {
  blob,
  nullableBlob,
  blobWithDefault,
  blobWithValidation,
} from "../schema.js";

describe("Blob Field", () => {
  describe("Basic Blob Field", () => {
    test("should have correct field type", () => {
      expect(blob["~fieldType"]).toBe("blob");
    });

    test("should not be nullable by default", () => {
      expect(blob["~isOptional"]).toBe(false);
    });

    test("should not have default value", () => {
      expect(blob["~defaultValue"]).toBeUndefined();
    });

    test("should not have validator by default", () => {
      expect(blob["~fieldValidator"]).toBeUndefined();
    });

    test("should not be ID field by default", () => {
      expect(blob["~isId"]).toBe(false);
    });

    test("should not be unique by default", () => {
      expect(blob["~isUnique"]).toBe(false);
    });

    test("should not be array by default", () => {
      expect(blob["~isArray"]).toBe(false);
    });
  });

  describe("Nullable Blob Field", () => {
    test("should be nullable", () => {
      expect(nullableBlob["~isOptional"]).toBe(true);
    });

    test("should maintain blob type", () => {
      expect(nullableBlob["~fieldType"]).toBe("blob");
    });
  });

  describe("Blob Field with Default", () => {
    test("should have default value", () => {
      expect(blobWithDefault["~defaultValue"]).toEqual(
        new Uint8Array([1, 2, 3])
      );
    });

    test("should not be nullable", () => {
      expect(blobWithDefault["~isOptional"]).toBe(false);
    });
  });

  describe("Blob Field with Validation", () => {
    test("should have validator", () => {
      expect(blobWithValidation["~fieldValidator"]).toBeDefined();
    });

    test("should validate correctly", async () => {
      const validBlob = new Uint8Array([1, 2, 3, 4]);
      const result1 = await blobWithValidation["~validate"](validBlob);
      expect(result1.valid).toBe(true);

      const result2 = await blobWithValidation["~validate"]("not a blob");
      expect(result2.valid).toBe(false);
    });
  });

  describe("Chainable Methods", () => {
    test("should chain nullable()", () => {
      const field = s.blob().nullable();
      expect(field["~isOptional"]).toBe(true);
    });

    test("should chain default()", () => {
      const defaultValue = new Uint8Array([5, 6, 7]);
      const field = s.blob().default(defaultValue);
      expect(field["~defaultValue"]).toEqual(defaultValue);
    });

    test("should chain validator()", () => {
      const field = s.blob().validator(z.instanceof(Uint8Array));
      expect(field["~fieldValidator"]).toBeDefined();
    });

    test("should chain unique()", () => {
      const field = s.blob().unique();
      expect(field["~isUnique"]).toBe(true);
    });

    test("should chain array()", () => {
      const field = s.blob().array();
      expect(field["~isArray"]).toBe(true);
    });
  });

  describe("Type Validation", () => {
    test("should validate Uint8Array values", async () => {
      const testBlob = new Uint8Array([10, 20, 30]);
      const result = await blob["~validate"](testBlob);
      expect(result.valid).toBe(true);
      expect(result.output).toEqual(testBlob);
    });

    test("should reject non-Uint8Array values", async () => {
      const result = await blob["~validate"]("not a blob");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Invalid type for field. Expected blob");
    });

    test("should accept null for nullable fields", async () => {
      const result = await nullableBlob["~validate"](null);
      expect(result.valid).toBe(true);
    });
  });

  describe("Type Inference", () => {
    test("blob field should have expected type properties", () => {
      expectTypeOf(blob).toHaveProperty("~fieldType");
      expectTypeOf(blob).toHaveProperty("~isOptional");
      expectTypeOf(blob).toHaveProperty("~isUnique");
    });

    test("methods should return correct types", () => {
      expectTypeOf(s.blob().nullable()).toHaveProperty("~isOptional");
      expectTypeOf(s.blob().default(new Uint8Array())).toHaveProperty(
        "~defaultValue"
      );
      expectTypeOf(s.blob().unique()).toHaveProperty("~isUnique");
    });

    test("field type should be correct", () => {
      expectTypeOf(blob["~fieldType"]).toEqualTypeOf<"blob">();
    });
  });
});
