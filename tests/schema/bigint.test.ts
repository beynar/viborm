import { s } from "../../src/schema/index.js";
import z from "zod/v4";
import {
  bigint,
  nullableBigint,
  bigintWithDefault,
  bigintWithValidation,
} from "../schema.js";

describe("BigInt Field", () => {
  describe("Basic BigInt Field", () => {
    test("should have correct field type", () => {
      expect(bigint["~fieldType"]).toBe("bigInt");
    });

    test("should not be nullable by default", () => {
      expect(bigint["~isOptional"]).toBe(false);
    });

    test("should not have default value", () => {
      expect(bigint["~defaultValue"]).toBeUndefined();
    });

    test("should not have validator by default", () => {
      expect(bigint["~fieldValidator"]).toBeUndefined();
    });

    test("should not be ID field by default", () => {
      expect(bigint["~isId"]).toBe(false);
    });

    test("should not be unique by default", () => {
      expect(bigint["~isUnique"]).toBe(false);
    });

    test("should not be array by default", () => {
      expect(bigint["~isArray"]).toBe(false);
    });
  });

  describe("Nullable BigInt Field", () => {
    test("should be nullable", () => {
      expect(nullableBigint["~isOptional"]).toBe(true);
    });

    test("should maintain bigInt type", () => {
      expect(nullableBigint["~fieldType"]).toBe("bigInt");
    });
  });

  describe("BigInt Field with Default", () => {
    test("should have default value", () => {
      expect(bigintWithDefault["~defaultValue"]).toBe(BigInt(1));
    });

    test("should not be nullable", () => {
      expect(bigintWithDefault["~isOptional"]).toBe(false);
    });
  });

  describe("BigInt Field with Validation", () => {
    test("should have validator", () => {
      expect(bigintWithValidation["~fieldValidator"]).toBeDefined();
    });

    test("should validate correctly", async () => {
      const result1 = await bigintWithValidation["~validate"](BigInt(5));
      expect(result1.valid).toBe(true);

      const result2 = await bigintWithValidation["~validate"](BigInt(0));
      expect(result2.valid).toBe(false);
    });
  });

  describe("Chainable Methods", () => {
    test("should chain nullable()", () => {
      const field = s.bigInt().nullable();
      expect(field["~isOptional"]).toBe(true);
    });

    test("should chain default()", () => {
      const field = s.bigInt().default(BigInt(42));
      expect(field["~defaultValue"]).toBe(BigInt(42));
    });

    test("should chain validator()", () => {
      const field = s.bigInt().validator(z.bigint().min(BigInt(0)));
      expect(field["~fieldValidator"]).toBeDefined();
    });

    test("should chain id() with auto-generation methods", () => {
      const incrementField = s.bigInt().id().autoIncrement();
      expect(incrementField["~isId"]).toBe(true);
      expect(incrementField["~autoGenerate"]).toBe("increment");
    });

    test("should chain unique()", () => {
      const field = s.bigInt().unique();
      expect(field["~isUnique"]).toBe(true);
    });

    test("should chain array()", () => {
      const field = s.bigInt().array();
      expect(field["~isArray"]).toBe(true);
    });
  });

  describe("Type Validation", () => {
    test("should validate bigint values", async () => {
      const result = await bigint["~validate"](BigInt(123));
      expect(result.valid).toBe(true);
      expect(result.output).toBe(BigInt(123));
    });

    test("should reject non-bigint values", async () => {
      const result = await bigint["~validate"](123);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Invalid type for field. Expected bigInt"
      );
    });

    test("should accept null for nullable fields", async () => {
      const result = await nullableBigint["~validate"](null);
      expect(result.valid).toBe(true);
    });
  });

  describe("Type Inference", () => {
    test("bigint field should have expected type properties", () => {
      expectTypeOf(bigint).toHaveProperty("~fieldType");
      expectTypeOf(bigint).toHaveProperty("~isOptional");
      expectTypeOf(bigint).toHaveProperty("~isId");
    });

    test("methods should return correct types", () => {
      expectTypeOf(s.bigInt().nullable()).toHaveProperty("~isOptional");
      expectTypeOf(s.bigInt().default(BigInt(0))).toHaveProperty(
        "~defaultValue"
      );
      expectTypeOf(s.bigInt().id()).toHaveProperty("~isId");
    });
  });
});
