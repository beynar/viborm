import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, nonArray, element, string, number } from "../../src/validation";

describe("nonArray wrapper schema", () => {
  describe("basic validation", () => {
    test("unwraps array schema to single element", () => {
      const arraySchema = string({ array: true });
      const schema = nonArray(arraySchema);

      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("hello");
    });

    test("validates single element from array input", () => {
      const arraySchema = number({ array: true });
      const schema = nonArray(arraySchema);

      // If input is array, validates first element
      const result = schema["~standard"].validate([42]);
      expect(result.issues).toBeUndefined();
    });

    test("type inference", () => {
      const arraySchema = string({ array: true });
      const schema = nonArray(arraySchema);
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
    });
  });

  describe("element alias", () => {
    test("element is alias for nonArray", () => {
      const arraySchema = number({ array: true });
      const schema = element(arraySchema);

      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("with different types", () => {
    test("nonArray number", () => {
      const arraySchema = number({ array: true });
      const schema = nonArray(arraySchema);
      expect(schema["~standard"].validate(42).issues).toBeUndefined();
    });

    test("nonArray boolean", () => {
      const arraySchema = v.boolean({ array: true });
      const schema = nonArray(arraySchema);
      expect(schema["~standard"].validate(true).issues).toBeUndefined();
    });
  });
});

