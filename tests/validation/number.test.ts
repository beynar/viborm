import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, number, integer } from "@validation";

describe("number schema", () => {
  describe("basic validation", () => {
    const schema = number();

    test("validates numbers", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("validates zero", () => {
      const result = schema["~standard"].validate(0);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(0);
    });

    test("validates negative numbers", () => {
      const result = schema["~standard"].validate(-42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(-42);
    });

    test("validates floats", () => {
      const result = schema["~standard"].validate(3.14);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(3.14);
    });

    test("rejects NaN", () => {
      const result = schema["~standard"].validate(NaN);
      expect(result.issues).toBeDefined();
    });

    test("rejects Infinity", () => {
      // Infinity is not storable in MySQL, so we reject it
      const result = schema["~standard"].validate(Infinity);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("finite number");
    });

    test("rejects -Infinity", () => {
      const result = schema["~standard"].validate(-Infinity);
      expect(result.issues).toBeDefined();
    });

    test("rejects strings", () => {
      const result = schema["~standard"].validate("42");
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
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number>();
      expectTypeOf<Input>().toEqualTypeOf<number>();
    });
  });

  describe("optional option", () => {
    const schema = number({ optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | undefined }).value).toBeUndefined();
    });

    test("validates numbers", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | undefined }).value).toBe(42);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = number({ nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | null }).value).toBeNull();
    });

    test("validates numbers", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | null }).value).toBe(42);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number | null>();
    });
  });

  describe("array option", () => {
    const schema = number({ array: true });

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
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeDefined();
    });

    test("rejects array with invalid items", () => {
      const result = schema["~standard"].validate([1, "2", 3]);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual([1]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number[]>();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const schema = number({ default: 0 });
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(0);
    });

    test("default factory function", () => {
      let counter = 0;
      const schema = number({ default: () => ++counter });
      expect(
        (schema["~standard"].validate(undefined) as { value: number }).value
      ).toBe(1);
      expect(
        (schema["~standard"].validate(undefined) as { value: number }).value
      ).toBe(2);
    });
  });

  describe("transform option", () => {
    const schema = number({ transform: (n) => n * 2 });

    test("applies transform to output", () => {
      const result = schema["~standard"].validate(21);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number>();
    });
  });

  describe("schema option", () => {
    const customSchema: StandardSchemaV1<number, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: value.toString() }),
      },
    };

    const schema = number({ schema: customSchema });

    test("applies additional schema validation", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("42");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
    });
  });

  describe("combined options", () => {
    test("optional + nullable + array", () => {
      const schema = number({ optional: true, nullable: true, array: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
      expect(schema["~standard"].validate([1, 2]).issues).toBeUndefined();
    });

    test("array + transform", () => {
      const schema = number({ array: true, transform: (n) => n * 2 });
      const result = schema["~standard"].validate([1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([2, 4, 6]);
    });
  });

  describe("edge cases", () => {
    test("very large numbers", () => {
      const schema = number();
      const result = schema["~standard"].validate(Number.MAX_SAFE_INTEGER);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(Number.MAX_SAFE_INTEGER);
    });

    test("very small numbers", () => {
      const schema = number();
      const result = schema["~standard"].validate(Number.MIN_SAFE_INTEGER);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(Number.MIN_SAFE_INTEGER);
    });

    test("negative zero", () => {
      const schema = number();
      const result = schema["~standard"].validate(-0);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(-0);
    });
  });
});

describe("integer schema", () => {
  describe("basic validation", () => {
    const schema = integer();

    test("validates integers", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("validates zero", () => {
      const result = schema["~standard"].validate(0);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(0);
    });

    test("validates negative integers", () => {
      const result = schema["~standard"].validate(-42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(-42);
    });

    test("rejects floats", () => {
      const result = schema["~standard"].validate(3.14);
      expect(result.issues).toBeDefined();
    });

    test("rejects numbers with decimal part", () => {
      const result = schema["~standard"].validate(42.1);
      expect(result.issues).toBeDefined();
    });

    test("accepts whole floats", () => {
      const result = schema["~standard"].validate(42.0);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number>();
    });
  });

  describe("options", () => {
    test("optional integer", () => {
      const schema = integer({ optional: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate(42).issues).toBeUndefined();
    });

    test("array of integers", () => {
      const schema = integer({ array: true });
      const result = schema["~standard"].validate([1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3]);
    });

    test("rejects array with floats", () => {
      const schema = integer({ array: true });
      const result = schema["~standard"].validate([1, 2.5, 3]);
      expect(result.issues).toBeDefined();
    });
  });
});
