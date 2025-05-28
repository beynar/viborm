import { s } from "../../src/schema/index.js";
import z from "zod/v4";
import {
  string,
  nullableString,
  stringWithDefault,
  stringWithValidation,
} from "../schema.js";

describe("String Field", () => {
  describe("Basic String Field", () => {
    test("should have correct field type", () => {
      expect(string["~fieldType"]).toBe("string");
    });

    test("should not be nullable by default", () => {
      expect(string["~isOptional"]).toBe(false);
    });

    test("should not have default value", () => {
      expect(string["~defaultValue"]).toBeUndefined();
    });

    test("should not have validator by default", () => {
      expect(string["~fieldValidator"]).toBeUndefined();
    });

    test("should not be ID field by default", () => {
      expect(string["~isId"]).toBe(false);
    });

    test("should not be unique by default", () => {
      expect(string["~isUnique"]).toBe(false);
    });

    test("should not be array by default", () => {
      expect(string["~isArray"]).toBe(false);
    });
  });

  describe("Nullable String Field", () => {
    test("should be nullable", () => {
      expect(nullableString["~isOptional"]).toBe(true);
    });

    test("should maintain string type", () => {
      expect(nullableString["~fieldType"]).toBe("string");
    });
  });

  describe("String Field with Default", () => {
    test("should have default value", () => {
      expect(stringWithDefault["~defaultValue"]).toBe("default");
    });

    test("should not be nullable", () => {
      expect(stringWithDefault["~isOptional"]).toBe(false);
    });
  });

  describe("String Field with Validation", () => {
    test("should have validator", () => {
      expect(stringWithValidation["~fieldValidator"]).toBeDefined();
    });

    test("should validate correctly", async () => {
      const result1 = await stringWithValidation["~validate"](
        "test@example.com"
      );
      expect(result1.valid).toBe(true);

      const result2 = await stringWithValidation["~validate"]("invalid-email");
      expect(result2.valid).toBe(false);
    });
  });

  describe("Chainable Methods", () => {
    test("should chain nullable()", () => {
      const field = s.string().nullable();
      expect(field["~isOptional"]).toBe(true);
    });

    test("should chain default()", () => {
      const field = s.string().default("test");
      expect(field["~defaultValue"]).toBe("test");
    });

    test("should chain validator()", () => {
      const field = s.string().validator(z.string().email());
      expect(field["~fieldValidator"]).toBeDefined();
    });

    test("should chain id() with auto-generation methods", () => {
      const ulidField = s.string().id().ulid();
      expect(ulidField["~isId"]).toBe(true);
      expect(ulidField["~autoGenerate"]).toBe("ulid");

      const uuidField = s.string().id().uuid();
      expect(uuidField["~isId"]).toBe(true);
      expect(uuidField["~autoGenerate"]).toBe("uuid");

      const cuidField = s.string().id().cuid();
      expect(cuidField["~isId"]).toBe(true);
      expect(cuidField["~autoGenerate"]).toBe("cuid");

      const nanoidField = s.string().id().nanoid();
      expect(nanoidField["~isId"]).toBe(true);
      expect(nanoidField["~autoGenerate"]).toBe("nanoid");
    });

    test("should chain unique()", () => {
      const field = s.string().unique();
      expect(field["~isUnique"]).toBe(true);
    });

    test("should chain array()", () => {
      const field = s.string().array();
      expect(field["~isArray"]).toBe(true);
    });
  });

  describe("Type Validation", () => {
    test("should validate string values", async () => {
      const result = await string["~validate"]("test");
      expect(result.valid).toBe(true);
      expect(result.output).toBe("test");
    });

    test("should reject non-string values", async () => {
      const result = await string["~validate"](123);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "Invalid type for field. Expected string"
      );
    });

    test("should accept null for nullable fields", async () => {
      const result = await nullableString["~validate"](null);
      expect(result.valid).toBe(true);
    });
  });

  describe("Type Inference", () => {
    test("string field should have expected type properties", () => {
      expectTypeOf(string).toHaveProperty("~fieldType");
      expectTypeOf(string).toHaveProperty("~isOptional");
      expectTypeOf(string).toHaveProperty("~isId");
    });

    test("methods should return correct types", () => {
      expectTypeOf(s.string().nullable()).toHaveProperty("~isOptional");
      expectTypeOf(s.string().default("test")).toHaveProperty("~defaultValue");
      expectTypeOf(s.string().id()).toHaveProperty("~isId");
    });

    test("basic string field infer type should be string", () => {
      expectTypeOf(string.infer).toEqualTypeOf<string>();
    });

    test("nullable string field infer type should be string | null", () => {
      expectTypeOf(nullableString.infer).toEqualTypeOf<string | null>();
    });

    test("string field with default infer type should be string", () => {
      expectTypeOf(stringWithDefault.infer).toEqualTypeOf<string>();
    });

    test("string array field infer type should be string[]", () => {
      const stringArray = s.string().array();
      expectTypeOf(stringArray.infer).toEqualTypeOf<string[]>();
    });

    test("string ID field infer type should be string", () => {
      const stringId = s.string().id();
      expectTypeOf(stringId.infer).toEqualTypeOf<string>();
    });

    test("string with auto-generation infer type should be string", () => {
      const autoString = s.string().ulid();
      expectTypeOf(autoString.infer).toEqualTypeOf<string>();
    });

    test("nullable string array field should have infer property", () => {
      const nullableStringArray = s.string().nullable().array();
      expectTypeOf(nullableStringArray).toHaveProperty("infer");
    });

    test("nullable array field infer type should be string[] | null", () => {
      const nullableArray = s.string().array().nullable();
      expectTypeOf(nullableArray.infer).toEqualTypeOf<string[] | null>();
    });

    test("array of nullable strings should have infer property", () => {
      const arrayOfNullableStrings = s.string().nullable().array();
      expectTypeOf(arrayOfNullableStrings).toHaveProperty("infer");
    });
  });
});
