import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, string } from "@validation";

describe("string schema", () => {
  describe("basic validation", () => {
    const schema = string();

    test("validates strings", () => {
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("hello");
    });

    test("validates empty string", () => {
      const result = schema["~standard"].validate("");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("");
    });

    test("rejects non-strings", () => {
      const result = schema["~standard"].validate(123);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("Expected string");
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
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
      expectTypeOf<Input>().toEqualTypeOf<string>();
    });
  });

  describe("optional option", () => {
    const schema = string({ optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | undefined }).value).toBeUndefined();
    });

    test("validates strings", () => {
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | undefined }).value).toBe("hello");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = string({ nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | null }).value).toBeNull();
    });

    test("validates strings", () => {
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | null }).value).toBe("hello");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string | null>();
    });
  });

  describe("array option", () => {
    const schema = string({ array: true });

    test("validates array of strings", () => {
      const result = schema["~standard"].validate(["a", "b", "c"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual(["a", "b", "c"]);
    });

    test("validates empty array", () => {
      const result = schema["~standard"].validate([]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      const result = schema["~standard"].validate("a");
      expect(result.issues).toBeDefined();
    });

    test("rejects array with invalid items", () => {
      const result = schema["~standard"].validate(["a", 123, "c"]);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual([1]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string[]>();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const schema = string({ default: "default" });
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("default");
    });

    test("default factory function", () => {
      let counter = 0;
      const schema = string({ default: () => `value-${++counter}` });
      expect(
        (schema["~standard"].validate(undefined) as { value: string }).value
      ).toBe("value-1");
      expect(
        (schema["~standard"].validate(undefined) as { value: string }).value
      ).toBe("value-2");
    });

    test("default not used when value provided", () => {
      const schema = string({ default: "default" });
      const result = schema["~standard"].validate("provided");
      expect((result as { value: string }).value).toBe("provided");
    });
  });

  describe("transform option", () => {
    const schema = string({ transform: (s) => s.toUpperCase() });

    test("applies transform to output", () => {
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("HELLO");
    });

    test("transform receives validated value", () => {
      const schema = string({ transform: (s) => s.length.toString() });
      const result = schema["~standard"].validate("hello");
      expect((result as { value: string }).value).toBe("5");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
    });
  });

  describe("schema option", () => {
    const customSchema: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
          const num = parseInt(value, 10);
          if (isNaN(num)) {
            return { issues: [{ message: "Not a number" }] };
          }
          return { value: num };
        },
      },
    };

    const schema = string({ schema: customSchema });

    test("applies additional schema validation", () => {
      const result = schema["~standard"].validate("42");
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("fails if custom schema rejects", () => {
      const result = schema["~standard"].validate("not-a-number");
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number>();
    });
  });

  describe("combined options", () => {
    test("optional + nullable", () => {
      const schema = string({ optional: true, nullable: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
      expect(schema["~standard"].validate("hello").issues).toBeUndefined();
    });

    test("array + optional", () => {
      const schema = string({ array: true, optional: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate(["a"]).issues).toBeUndefined();
    });

    test("array + transform", () => {
      const schema = string({ array: true, transform: (s) => s.toUpperCase() });
      const result = schema["~standard"].validate(["a", "b"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual(["A", "B"]);
    });

    test("schema + transform", () => {
      const customSchema: StandardSchemaV1<string, number> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value) => ({ value: parseInt(value, 10) }),
        },
      };
      const schema = string({ schema: customSchema, transform: (n) => n * 2 });
      const result = schema["~standard"].validate("21");
      expect((result as { value: number }).value).toBe(42);
    });
  });

  describe("edge cases", () => {
    test("unicode strings", () => {
      const schema = string();
      const result = schema["~standard"].validate("🚀 hello 🌍");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("🚀 hello 🌍");
    });

    test("very long strings", () => {
      const schema = string();
      const longString = "a".repeat(10000);
      const result = schema["~standard"].validate(longString);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(longString);
    });

    test("special characters", () => {
      const schema = string();
      const special = "\n\t\r\"'\\";
      const result = schema["~standard"].validate(special);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(special);
    });
  });
});
