import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("number schema", () => {
  describe("basic validation", () => {
    const schema = v.number();

    test("validates numbers", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("validates zero", () => {
      const result = parse(schema, 0);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(0);
    });

    test("validates negative numbers", () => {
      const result = parse(schema, -42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(-42);
    });

    test("validates floats", () => {
      const result = parse(schema, 3.14);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(3.14);
    });

    test("rejects NaN", () => {
      const result = parse(schema, Number.NaN);
      expect(result.issues).toBeDefined();
    });

    test("rejects Infinity", () => {
      // Infinity is not storable in MySQL, so we reject it
      const result = parse(schema, Number.POSITIVE_INFINITY);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("finite number");
    });

    test("rejects -Infinity", () => {
      const result = parse(schema, Number.NEGATIVE_INFINITY);
      expect(result.issues).toBeDefined();
    });

    test("rejects strings", () => {
      const result = parse(schema, "42");
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
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number>();
      expectTypeOf<Input>().toMatchTypeOf<number>();
    });
  });

  describe("optional option", () => {
    const schema = v.number({ optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | undefined }).value).toBeUndefined();
    });

    test("validates numbers", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | undefined }).value).toBe(42);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = v.number({ nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | null }).value).toBeNull();
    });

    test("validates numbers", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | null }).value).toBe(42);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number | null>();
    });
  });

  describe("array option", () => {
    const schema = v.number({ array: true });

    test("validates array of numbers", () => {
      const result = parse(schema, [1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3]);
    });

    test("validates empty array", () => {
      const result = parse(schema, []);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeDefined();
    });

    test("rejects array with invalid items", () => {
      const result = parse(schema, [1, "2", 3]);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual([1]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number[]>();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const schema = v.number({ default: 0 });
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(0);
    });

    test("default factory function", () => {
      let counter = 0;
      const schema = v.number({ default: () => ++counter });
      expect(
        (parse(schema, undefined) as { value: number }).value
      ).toBe(1);
      expect(
        (parse(schema, undefined) as { value: number }).value
      ).toBe(2);
    });
  });

  describe("transform option", () => {
    const schema = v.number({ transform: (n) => n * 2 });

    test("applies transform to output", () => {
      const result = parse(schema, 21);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number>();
    });
  });

  describe("schema option", () => {
    const customSchema: StandardSchemaV1<number, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: (value as number).toString() }),
      },
    };

    const schema = v.number({ schema: customSchema });

    test("applies additional schema validation", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("42");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string>();
    });
  });

  describe("combined options", () => {
    test("optional + nullable + array", () => {
      const schema = v.number({ optional: true, nullable: true, array: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, null).issues).toBeUndefined();
      expect(parse(schema, [1, 2]).issues).toBeUndefined();
    });

    test("array + transform", () => {
      const schema = v.number({ array: true, transform: (n) => n * 2 });
      const result = parse(schema, [1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([2, 4, 6]);
    });
  });

  describe("edge cases", () => {
    test("very large numbers", () => {
      const schema = v.number();
      const result = parse(schema, Number.MAX_SAFE_INTEGER);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(Number.MAX_SAFE_INTEGER);
    });

    test("very small numbers", () => {
      const schema = v.number();
      const result = parse(schema, Number.MIN_SAFE_INTEGER);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(Number.MIN_SAFE_INTEGER);
    });

    test("negative zero", () => {
      const schema = v.number();
      const result = parse(schema, -0);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(-0);
    });
  });
});

describe("integer schema", () => {
  describe("basic validation", () => {
    const schema = v.integer();

    test("validates integers", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("validates zero", () => {
      const result = parse(schema, 0);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(0);
    });

    test("validates negative integers", () => {
      const result = parse(schema, -42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(-42);
    });

    test("rejects floats", () => {
      const result = parse(schema, 3.14);
      expect(result.issues).toBeDefined();
    });

    test("rejects numbers with decimal part", () => {
      const result = parse(schema, 42.1);
      expect(result.issues).toBeDefined();
    });

    test("accepts whole floats", () => {
      const result = parse(schema, 42.0);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number>();
    });
  });

  describe("options", () => {
    test("optional integer", () => {
      const schema = v.integer({ optional: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, 42).issues).toBeUndefined();
    });

    test("array of integers", () => {
      const schema = v.integer({ array: true });
      const result = parse(schema, [1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3]);
    });

    test("rejects array with floats", () => {
      const schema = v.integer({ array: true });
      const result = parse(schema, [1, 2.5, 3]);
      expect(result.issues).toBeDefined();
    });
  });
});
