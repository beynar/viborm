import { describe, test, expect, expectTypeOf } from "vitest";
import { v } from "../../src/validation";
import type { StandardSchemaV1 } from "@standard-schema/spec";

describe("enum_ schema", () => {
  describe("basic validation", () => {
    const status = v.enum(["active", "inactive", "pending"]);

    test("accepts valid enum value", () => {
      const result = status["~standard"].validate("active");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("active");
    });

    test("accepts all enum values", () => {
      for (const value of ["active", "inactive", "pending"]) {
        const result = status["~standard"].validate(value);
        expect(result.issues).toBeUndefined();
      }
    });

    test("rejects invalid string", () => {
      const result = status["~standard"].validate("unknown");
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("Expected one of:");
    });

    test("rejects wrong type", () => {
      const result = status["~standard"].validate(123);
      expect(result.issues).toBeDefined();
    });

    test("rejects null", () => {
      const result = status["~standard"].validate(null);
      expect(result.issues).toBeDefined();
    });

    test("rejects undefined", () => {
      const result = status["~standard"].validate(undefined);
      expect(result.issues).toBeDefined();
    });
  });

  describe("number enum", () => {
    const level = v.enum([1, 2, 3]);

    test("accepts valid number", () => {
      const result = level["~standard"].validate(2);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(2);
    });

    test("rejects invalid number", () => {
      const result = level["~standard"].validate(4);
      expect(result.issues).toBeDefined();
    });

    test("rejects string", () => {
      const result = level["~standard"].validate("1");
      expect(result.issues).toBeDefined();
    });
  });

  describe("mixed enum", () => {
    const mixed = v.enum(["a", 1, "b", 2] as const);

    test("accepts string value", () => {
      const result = mixed["~standard"].validate("a");
      expect(result.issues).toBeUndefined();
    });

    test("accepts number value", () => {
      const result = mixed["~standard"].validate(1);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("with options", () => {
    test("optional enum", () => {
      const schema = v.enum(["a", "b"], { optional: true });
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: undefined }).value).toBeUndefined();
    });

    test("nullable enum", () => {
      const schema = v.enum(["a", "b"], { nullable: true });
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: null }).value).toBeNull();
    });

    test("enum with default", () => {
      const schema = v.enum(["a", "b"], { default: "a" });
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("a");
    });

    test("array of enums", () => {
      const schema = v.enum(["a", "b"], { array: true });
      const result = schema["~standard"].validate(["a", "b", "a"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual(["a", "b", "a"]);
    });
  });

  describe("type inference", () => {
    test("infers correct type", () => {
      const status = v.enum(["active", "inactive", "pending"] as const);
      type Status = StandardSchemaV1.InferOutput<typeof status>;
      expectTypeOf<Status>().toEqualTypeOf<
        "active" | "inactive" | "pending"
      >();
    });

    test("infers number type", () => {
      const level = v.enum([1, 2, 3] as const);
      type Level = StandardSchemaV1.InferOutput<typeof level>;
      expectTypeOf<Level>().toEqualTypeOf<1 | 2 | 3>();
    });
  });

  describe("schema properties", () => {
    test("has correct type", () => {
      const schema = v.enum(["a", "b"]);
      expect(schema.type).toBe("enum");
    });

    test("has values property", () => {
      const values = ["x", "y", "z"] as const;
      const schema = v.enum(values);
      expect(schema.values).toEqual(values);
    });
  });
});

