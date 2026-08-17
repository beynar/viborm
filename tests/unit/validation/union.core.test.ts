import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("union schema", () => {
  describe("basic validation", () => {
    const schema = v.union([v.string(), v.number()]);

    test("validates first matching option", () => {
      const result1 = parse(schema, "hello");
      expect(result1.issues).toBeUndefined();
      expect((result1 as { value: string | number }).value).toBe("hello");

      const result2 = parse(schema, 42);
      expect(result2.issues).toBeUndefined();
      expect((result2 as { value: string | number }).value).toBe(42);
    });

    test("rejects non-matching values", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeDefined();
    });

    test("rejects null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeDefined();
    });

    test("rejects undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string | number>();
    });
  });

  describe("with multiple types", () => {
    test("string | number | boolean", () => {
      const schema = v.union([v.string(), v.number(), v.boolean()]);
      expect(parse(schema, "hello").issues).toBeUndefined();
      expect(parse(schema, 42).issues).toBeUndefined();
      expect(parse(schema, true).issues).toBeUndefined();
      expect(parse(schema, null).issues).toBeDefined();
    });

    test("with literals", () => {
      const schema = v.union([
        v.literal("admin"),
        v.literal("user"),
        v.number(),
      ]);
      expect(parse(schema, "admin").issues).toBeUndefined();
      expect(parse(schema, "user").issues).toBeUndefined();
      expect(parse(schema, 42).issues).toBeUndefined();
      expect(parse(schema, "guest").issues).toBeDefined();
    });
  });

  describe("order matters", () => {
    test("first matching schema wins", () => {
      // string matches first, so "42" is validated as string
      const schema = v.union([v.string(), v.number()]);
      const result = parse(schema, "42");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | number }).value).toBe("42");
    });
  });

  describe("edge cases", () => {
    test("empty union (should not happen but handles gracefully)", () => {
      const schema = v.union([]);
      const result = parse(schema, "anything");
      expect(result.issues).toBeDefined();
    });

    test("single option union", () => {
      const schema = v.union([v.string()]);
      expect(parse(schema, "hello").issues).toBeUndefined();
      expect(parse(schema, 42).issues).toBeDefined();
    });

    test("returns the matching member result without wrapping it", () => {
      const member = v.string({ optional: true });
      const expected = member["~standard"].validate(undefined);
      const schema = v.union([member]);

      expect(schema["~standard"].validate(undefined)).toBe(expected);
    });

    test("treats an asynchronous member as a failed member", () => {
      const asynchronous = v.string();
      Object.defineProperty(asynchronous["~standard"], "validate", {
        value: async () => ({ value: "unreachable" }),
      });
      const schema = v.union([asynchronous, v.number()]);

      expect(parse(schema, 42)).toEqual({ value: 42 });
      expect(parse(schema, true).issues?.[0]?.message).toContain(
        "Async schemas are not supported"
      );
    });
  });
});
