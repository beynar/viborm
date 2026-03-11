import type { StandardSchemaV1 } from "@standard-schema/spec";
import v from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("record schema", () => {
  describe("basic validation", () => {
    const schema = v.record(v.string(), v.number());

    test("validates records", () => {
      const result = schema["~standard"].validate({ a: 1, b: 2 });
      expect(result.issues).toBeUndefined();
      expect((result as { value: Record<string, number> }).value).toEqual({
        a: 1,
        b: 2,
      });
    });

    test("validates empty record", () => {
      const result = schema["~standard"].validate({});
      expect(result.issues).toBeUndefined();
      expect((result as { value: Record<string, number> }).value).toEqual({});
    });

    test("rejects non-objects", () => {
      expect(schema["~standard"].validate(null).issues).toBeDefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
      expect(schema["~standard"].validate([]).issues).toBeDefined();
    });

    test("rejects invalid values", () => {
      const result = schema["~standard"].validate({ a: "1" });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual(["a"]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<Record<string, number>>();
    });
  });

  describe("with different key types", () => {
    test("string keys (object keys are always strings)", () => {
      // JavaScript object keys are always strings, even { 1: "a" } has key "1"
      const schema = v.record(v.string(), v.string());
      const result = schema["~standard"].validate({ a: "1", b: "2" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: Record<string, string> }).value).toEqual({
        a: "1",
        b: "2",
      });
    });

    test("literal keys", () => {
      const schema = v.record(v.literal("key"), v.string());
      const result = schema["~standard"].validate({ key: "value" });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("with different value types", () => {
    test("string values", () => {
      const schema = v.record(v.string(), v.string());
      const result = schema["~standard"].validate({ a: "1", b: "2" });
      expect(result.issues).toBeUndefined();
    });

    test("boolean values", () => {
      const schema = v.record(v.string(), v.boolean());
      const result = schema["~standard"].validate({ a: true, b: false });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("error paths", () => {
    test("reports correct path for invalid value", () => {
      const schema = v.record(v.string(), v.number());
      const result = schema["~standard"].validate({ a: 1, b: "2", c: 3 });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual(["b"]);
    });
  });
});
