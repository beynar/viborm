import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, point } from "@validation";

describe("point schema", () => {
  describe("basic validation", () => {
    const schema = point();

    test("validates point objects", () => {
      const result = schema["~standard"].validate({ x: 1, y: 2 });
      expect(result.issues).toBeUndefined();
      expect((result as { value: { x: number; y: number } }).value).toEqual({ x: 1, y: 2 });
    });

    test("rejects missing x", () => {
      const result = schema["~standard"].validate({ y: 2 });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("x");
    });

    test("rejects missing y", () => {
      const result = schema["~standard"].validate({ x: 1 });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("y");
    });

    test("rejects non-numbers", () => {
      expect(schema["~standard"].validate({ x: "1", y: 2 }).issues).toBeDefined();
      expect(schema["~standard"].validate({ x: 1, y: "2" }).issues).toBeDefined();
    });

    test("rejects non-objects", () => {
      expect(schema["~standard"].validate(null).issues).toBeDefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
      expect(schema["~standard"].validate([1, 2]).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<{ x: number; y: number }>();
    });
  });

  describe("optional option", () => {
    const schema = point({ optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nullable option", () => {
    const schema = point({ nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = point({ array: true });

    test("validates array of points", () => {
      const result = schema["~standard"].validate([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
      expect(result.issues).toBeUndefined();
    });
  });
});

