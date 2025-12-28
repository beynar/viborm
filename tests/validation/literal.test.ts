import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, literal } from "../../src/validation";

describe("literal schema", () => {
  describe("string literals", () => {
    const schema = literal("admin");

    test("validates exact match", () => {
      const result = schema["~standard"].validate("admin");
      expect(result.issues).toBeUndefined();
      expect((result as { value: "admin" }).value).toBe("admin");
    });

    test("rejects non-match", () => {
      const result = schema["~standard"].validate("user");
      expect(result.issues).toBeDefined();
    });

    test("rejects similar strings", () => {
      expect(schema["~standard"].validate("Admin").issues).toBeDefined();
      expect(schema["~standard"].validate("admin ").issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<"admin">();
    });
  });

  describe("number literals", () => {
    const schema = literal(42);

    test("validates exact match", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: 42 }).value).toBe(42);
    });

    test("rejects different numbers", () => {
      expect(schema["~standard"].validate(41).issues).toBeDefined();
      expect(schema["~standard"].validate(43).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<42>();
    });
  });

  describe("boolean literals", () => {
    test("true literal", () => {
      const schema = literal(true);
      expect(schema["~standard"].validate(true).issues).toBeUndefined();
      expect(schema["~standard"].validate(false).issues).toBeDefined();
    });

    test("false literal", () => {
      const schema = literal(false);
      expect(schema["~standard"].validate(false).issues).toBeUndefined();
      expect(schema["~standard"].validate(true).issues).toBeDefined();
    });
  });

  describe("optional option", () => {
    const schema = v.literal("admin", { optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
    });

    test("validates literal", () => {
      const result = schema["~standard"].validate("admin");
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = v.literal("admin", { nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
    });

    test("validates literal", () => {
      const result = schema["~standard"].validate("admin");
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = v.literal("admin", { array: true });

    test("validates array of literals", () => {
      const result = schema["~standard"].validate(["admin", "admin"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: "admin"[] }).value).toEqual([
        "admin",
        "admin",
      ]);
    });

    test("rejects array with non-matching items", () => {
      const result = schema["~standard"].validate(["admin", "user"]);
      expect(result.issues).toBeDefined();
    });
  });

  describe("default option", () => {
    const schema = v.literal("admin", { default: "admin" });

    test("provides default", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: "admin" }).value).toBe("admin");
    });
  });
});
