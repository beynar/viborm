import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, coerce, map, string, number, date } from "../../src/validation";

describe("coerce schema", () => {
  describe("basic validation", () => {
    test("transforms string to uppercase", () => {
      const schema = coerce(string(), (s) => s.toUpperCase());
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("HELLO");
    });

    test("transforms string to number", () => {
      const schema = coerce(string(), (s) => parseInt(s, 10));
      const result = schema["~standard"].validate("42");
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("validates base schema first", () => {
      const schema = coerce(string(), (s) => s.toUpperCase());
      const result = schema["~standard"].validate(123);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      const schema = coerce(string(), (s) => parseInt(s, 10));
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number>();
    });
  });

  describe("map alias", () => {
    test("map is alias for coerce", () => {
      const schema = map(string(), (s) => s.toUpperCase());
      const result = schema["~standard"].validate("hello");
      expect((result as { value: string }).value).toBe("HELLO");
    });
  });

  describe("date transformations", () => {
    test("date to ISO string", () => {
      const schema = coerce(date(), (d) => d.toISOString());
      const d = new Date("2023-01-01");
      const result = schema["~standard"].validate(d);
      expect((result as { value: string }).value).toBe(d.toISOString());
    });
  });

  describe("object transformations", () => {
    test("extract property", () => {
      const schema = coerce(
        v.object({ name: string(), age: number() }),
        (obj) => obj.name
      );
      const result = schema["~standard"].validate({ name: "Alice", age: 30 });
      expect((result as { value: string }).value).toBe("Alice");
    });
  });

  describe("transform errors", () => {
    test("handles transform exceptions", () => {
      const schema = coerce(string(), () => {
        throw new Error("Transform failed");
      });
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("Transform failed");
    });
  });
});
