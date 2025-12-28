import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  v,
  union,
  string,
  number,
  literal,
  boolean,
} from "../../src/validation";

describe("union schema", () => {
  describe("basic validation", () => {
    const schema = union([string(), number()]);

    test("validates first matching option", () => {
      const result1 = schema["~standard"].validate("hello");
      expect(result1.issues).toBeUndefined();
      expect((result1 as { value: string | number }).value).toBe("hello");

      const result2 = schema["~standard"].validate(42);
      expect(result2.issues).toBeUndefined();
      expect((result2 as { value: string | number }).value).toBe(42);
    });

    test("rejects non-matching values", () => {
      const result = schema["~standard"].validate(true);
      expect(result.issues).toBeDefined();
    });

    test("rejects null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeDefined();
    });

    test("rejects undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string | number>();
    });
  });

  describe("with multiple types", () => {
    test("string | number | boolean", () => {
      const schema = union([string(), number(), boolean()]);
      expect(schema["~standard"].validate("hello").issues).toBeUndefined();
      expect(schema["~standard"].validate(42).issues).toBeUndefined();
      expect(schema["~standard"].validate(true).issues).toBeUndefined();
      expect(schema["~standard"].validate(null).issues).toBeDefined();
    });

    test("with literals", () => {
      const schema = union([literal("admin"), literal("user"), number()]);
      expect(schema["~standard"].validate("admin").issues).toBeUndefined();
      expect(schema["~standard"].validate("user").issues).toBeUndefined();
      expect(schema["~standard"].validate(42).issues).toBeUndefined();
      expect(schema["~standard"].validate("guest").issues).toBeDefined();
    });
  });

  describe("order matters", () => {
    test("first matching schema wins", () => {
      // string matches first, so "42" is validated as string
      const schema = union([string(), number()]);
      const result = schema["~standard"].validate("42");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | number }).value).toBe("42");
    });
  });

  describe("edge cases", () => {
    test("empty union (should not happen but handles gracefully)", () => {
      const schema = union([]);
      const result = schema["~standard"].validate("anything");
      expect(result.issues).toBeDefined();
    });

    test("single option union", () => {
      const schema = union([string()]);
      expect(schema["~standard"].validate("hello").issues).toBeUndefined();
      expect(schema["~standard"].validate(42).issues).toBeDefined();
    });
  });
});
