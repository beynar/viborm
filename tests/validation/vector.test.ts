import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, vector } from "../../src/validation";

describe("vector schema", () => {
  describe("basic validation", () => {
    const schema = vector();

    test("validates array of numbers", () => {
      const result = schema["~standard"].validate([1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3]);
    });

    test("validates empty array", () => {
      const result = schema["~standard"].validate([]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      expect(schema["~standard"].validate(1).issues).toBeDefined();
      expect(schema["~standard"].validate("vector").issues).toBeDefined();
    });

    test("rejects array with non-numbers", () => {
      const result = schema["~standard"].validate([1, "2", 3]);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("number");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number[]>();
    });
  });

  describe("fixed length", () => {
    const schema = vector(3);

    test("validates vector of exact length", () => {
      const result = schema["~standard"].validate([1, 2, 3]);
      expect(result.issues).toBeUndefined();
    });

    test("rejects wrong length", () => {
      expect(schema["~standard"].validate([1, 2]).issues).toBeDefined();
      expect(schema["~standard"].validate([1, 2, 3, 4]).issues).toBeDefined();
    });

    test("validates empty array when length is 0", () => {
      const zeroSchema = vector(0);
      const result = zeroSchema["~standard"].validate([]);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("optional option", () => {
    const schema = vector(undefined, { optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = vector(undefined, { nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = vector(undefined, { array: true });

    test("validates array of vectors", () => {
      const result = schema["~standard"].validate([[1, 2], [3, 4]]);
      expect(result.issues).toBeUndefined();
    });
  });
});

