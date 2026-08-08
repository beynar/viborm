import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("array wrapper schema", () => {
  describe("basic validation", () => {
    const schema = v.array(v.number());

    test("validates arrays", () => {
      const result = parse(schema, [1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3]);
    });

    test("validates empty arrays", () => {
      const result = parse(schema, []);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      expect(parse(schema, 1).issues).toBeDefined();
      expect(parse(schema, "array").issues).toBeDefined();
      expect(parse(schema, null).issues).toBeDefined();
      expect(parse(schema, undefined).issues).toBeDefined();
    });

    test("rejects invalid items", () => {
      const result = parse(schema, [1, "2", 3]);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual([1]);
    });

    test("validates each item", () => {
      const result = parse(schema, [1, 2, 3, 4, 5]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3, 4, 5]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number[]>();
    });
  });

  describe("with different element types", () => {
    test("array of strings", () => {
      const schema = v.array(v.string());
      const result = parse(schema, ["a", "b", "c"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual(["a", "b", "c"]);
    });

    test("array of booleans", () => {
      const schema = v.array(v.boolean());
      const result = parse(schema, [true, false]);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nested arrays", () => {
    test("array of arrays", () => {
      const schema = v.array(v.array(v.number()));
      const result = parse(schema, [
        [1, 2],
        [3, 4],
      ]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[][] }).value).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });
  });

  describe("error paths", () => {
    test("reports correct path for nested errors", () => {
      const schema = v.array(v.array(v.number()));
      const result = parse(schema, [
        [1, 2],
        [3, "4"],
      ]);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual([1, 1]);
    });
  });
});

describe("array option vs wrapper comparison", () => {
  describe("string({ array: true }) vs array(string())", () => {
    const optionsSchema = v.string({ array: true });
    const wrapperSchema = v.array(v.string());

    test("both validate arrays of strings", () => {
      const input = ["a", "b", "c"];
      const optionsResult = parse(optionsSchema, input);
      const wrapperResult = parse(wrapperSchema, input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string[] }).value).toEqual(input);
      expect((wrapperResult as { value: string[] }).value).toEqual(input);
    });

    test("both validate empty arrays", () => {
      const input: string[] = [];
      expect(parse(optionsSchema, input).issues).toBeUndefined();
      expect(parse(wrapperSchema, input).issues).toBeUndefined();
    });

    test("both reject non-arrays", () => {
      expect(parse(optionsSchema, "not-array").issues).toBeDefined();
      expect(parse(wrapperSchema, "not-array").issues).toBeDefined();
    });

    test("both reject invalid items", () => {
      const input = ["a", 123, "c"];
      const optionsResult = parse(optionsSchema, input);
      const wrapperResult = parse(wrapperSchema, input);

      expect(optionsResult.issues).toBeDefined();
      expect(wrapperResult.issues).toBeDefined();
      expect(optionsResult.issues?.[0]?.path).toEqual([1]);
      expect(wrapperResult.issues?.[0]?.path).toEqual([1]);
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<string[]>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<string[]>();
    });
  });

  describe("number({ array: true }) vs array(number())", () => {
    const optionsSchema = v.number({ array: true });
    const wrapperSchema = v.array(v.number());

    test("both validate arrays of numbers", () => {
      const input = [1, 2, 3];
      const optionsResult = parse(optionsSchema, input);
      const wrapperResult = parse(wrapperSchema, input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: number[] }).value).toEqual(input);
      expect((wrapperResult as { value: number[] }).value).toEqual(input);
    });

    test("both reject non-numbers in array", () => {
      const input = [1, "2", 3];
      expect(parse(optionsSchema, input).issues).toBeDefined();
      expect(parse(wrapperSchema, input).issues).toBeDefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<number[]>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<number[]>();
    });
  });

  describe("boolean({ array: true }) vs array(boolean())", () => {
    const optionsSchema = v.boolean({ array: true });
    const wrapperSchema = v.array(v.boolean());

    test("both validate arrays of booleans", () => {
      const input = [true, false, true];
      expect(parse(optionsSchema, input).issues).toBeUndefined();
      expect(parse(wrapperSchema, input).issues).toBeUndefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<boolean[]>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<boolean[]>();
    });
  });
});
