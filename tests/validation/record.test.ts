import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("record schema", () => {
  describe("basic validation", () => {
    const schema = v.record(v.string(), v.number());

    test("validates records", () => {
      const result = parse(schema, { a: 1, b: 2 });
      expect(result.issues).toBeUndefined();
      expect((result as { value: Record<string, number> }).value).toEqual({
        a: 1,
        b: 2,
      });
    });

    test("validates empty record", () => {
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
      expect((result as { value: Record<string, number> }).value).toEqual({});
    });

    test("rejects non-objects", () => {
      expect(parse(schema, null).issues).toBeDefined();
      expect(parse(schema, undefined).issues).toBeDefined();
      expect(parse(schema, []).issues).toBeDefined();
    });

    test("rejects invalid values", () => {
      const result = parse(schema, { a: "1" });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual(["a"]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<Record<string, number>>();
    });
  });

  describe("with different key types", () => {
    test("string keys (object keys are always strings)", () => {
      // JavaScript object keys are always strings, even { 1: "a" } has key "1"
      const schema = v.record(v.string(), v.string());
      const result = parse(schema, { a: "1", b: "2" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: Record<string, string> }).value).toEqual({
        a: "1",
        b: "2",
      });
    });

    test("literal keys", () => {
      const schema = v.record(v.literal("key"), v.string());
      const result = parse(schema, { key: "value" });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("with different value types", () => {
    test("string values", () => {
      const schema = v.record(v.string(), v.string());
      const result = parse(schema, { a: "1", b: "2" });
      expect(result.issues).toBeUndefined();
    });

    test("boolean values", () => {
      const schema = v.record(v.string(), v.boolean());
      const result = parse(schema, { a: true, b: false });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("error paths", () => {
    test("reports correct path for invalid value", () => {
      const schema = v.record(v.string(), v.number());
      const result = parse(schema, { a: 1, b: "2", c: 3 });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual(["b"]);
    });
  });
});
