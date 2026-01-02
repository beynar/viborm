import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, array, string, number } from "@validation";

describe("array wrapper schema", () => {
  describe("basic validation", () => {
    const schema = array(number());

    test("validates arrays", () => {
      const result = schema["~standard"].validate([1, 2, 3]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3]);
    });

    test("validates empty arrays", () => {
      const result = schema["~standard"].validate([]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      expect(schema["~standard"].validate(1).issues).toBeDefined();
      expect(schema["~standard"].validate("array").issues).toBeDefined();
      expect(schema["~standard"].validate(null).issues).toBeDefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
    });

    test("rejects invalid items", () => {
      const result = schema["~standard"].validate([1, "2", 3]);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual([1]);
    });

    test("validates each item", () => {
      const result = schema["~standard"].validate([1, 2, 3, 4, 5]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number[] }).value).toEqual([1, 2, 3, 4, 5]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number[]>();
    });
  });

  describe("with different element types", () => {
    test("array of strings", () => {
      const schema = array(string());
      const result = schema["~standard"].validate(["a", "b", "c"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual(["a", "b", "c"]);
    });

    test("array of booleans", () => {
      const schema = array(v.boolean());
      const result = schema["~standard"].validate([true, false]);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("nested arrays", () => {
    test("array of arrays", () => {
      const schema = array(array(number()));
      const result = schema["~standard"].validate([
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
      const schema = array(array(number()));
      const result = schema["~standard"].validate([
        [1, 2],
        [3, "4"],
      ]);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual([1, 1]);
    });
  });
});

describe("array option vs wrapper comparison", () => {
  describe("string({ array: true }) vs array(string())", () => {
    const optionsSchema = string({ array: true });
    const wrapperSchema = array(string());

    test("both validate arrays of strings", () => {
      const input = ["a", "b", "c"];
      const optionsResult = optionsSchema["~standard"].validate(input);
      const wrapperResult = wrapperSchema["~standard"].validate(input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string[] }).value).toEqual(input);
      expect((wrapperResult as { value: string[] }).value).toEqual(input);
    });

    test("both validate empty arrays", () => {
      const input: string[] = [];
      expect(optionsSchema["~standard"].validate(input).issues).toBeUndefined();
      expect(wrapperSchema["~standard"].validate(input).issues).toBeUndefined();
    });

    test("both reject non-arrays", () => {
      expect(
        optionsSchema["~standard"].validate("not-array").issues
      ).toBeDefined();
      expect(
        wrapperSchema["~standard"].validate("not-array").issues
      ).toBeDefined();
    });

    test("both reject invalid items", () => {
      const input = ["a", 123, "c"];
      const optionsResult = optionsSchema["~standard"].validate(input);
      const wrapperResult = wrapperSchema["~standard"].validate(input);

      expect(optionsResult.issues).toBeDefined();
      expect(wrapperResult.issues).toBeDefined();
      expect(optionsResult.issues![0].path).toEqual([1]);
      expect(wrapperResult.issues![0].path).toEqual([1]);
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<string[]>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<string[]>();
    });
  });

  describe("number({ array: true }) vs array(number())", () => {
    const optionsSchema = number({ array: true });
    const wrapperSchema = array(number());

    test("both validate arrays of numbers", () => {
      const input = [1, 2, 3];
      const optionsResult = optionsSchema["~standard"].validate(input);
      const wrapperResult = wrapperSchema["~standard"].validate(input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: number[] }).value).toEqual(input);
      expect((wrapperResult as { value: number[] }).value).toEqual(input);
    });

    test("both reject non-numbers in array", () => {
      const input = [1, "2", 3];
      expect(optionsSchema["~standard"].validate(input).issues).toBeDefined();
      expect(wrapperSchema["~standard"].validate(input).issues).toBeDefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<number[]>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<number[]>();
    });
  });

  describe("boolean({ array: true }) vs array(boolean())", () => {
    const optionsSchema = v.boolean({ array: true });
    const wrapperSchema = array(v.boolean());

    test("both validate arrays of booleans", () => {
      const input = [true, false, true];
      expect(optionsSchema["~standard"].validate(input).issues).toBeUndefined();
      expect(wrapperSchema["~standard"].validate(input).issues).toBeUndefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<boolean[]>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<boolean[]>();
    });
  });
});
