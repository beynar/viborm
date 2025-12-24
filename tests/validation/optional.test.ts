import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, optional, string, number, array } from "../../src/validation";

describe("optional wrapper schema", () => {
  describe("basic validation", () => {
    const schema = optional(number());

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | undefined }).value).toBeUndefined();
    });

    test("passes through value", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | undefined }).value).toBe(42);
    });

    test("rejects null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<number | undefined>();
    });
  });

  describe("with default", () => {
    test("static default", () => {
      const schema = optional(number(), 0);
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(0);
    });

    test("default factory function", () => {
      let counter = 0;
      const schema = optional(number(), () => ++counter);
      expect((schema["~standard"].validate(undefined) as { value: number }).value).toBe(1);
      expect((schema["~standard"].validate(undefined) as { value: number }).value).toBe(2);
    });
  });

  describe("with different types", () => {
    test("optional string", () => {
      const schema = optional(string());
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate("hello").issues).toBeUndefined();
    });

    test("optional boolean", () => {
      const schema = optional(v.boolean());
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate(true).issues).toBeUndefined();
    });
  });

  describe("nested optional", () => {
    test("optional array", () => {
      const schema = optional(array(string()));
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate(["a"]).issues).toBeUndefined();
    });
  });
});

describe("optional option vs wrapper comparison", () => {
  describe("string({ optional: true }) vs optional(string())", () => {
    const optionsSchema = string({ optional: true });
    const wrapperSchema = optional(string());

    test("both allow undefined", () => {
      const optionsResult = optionsSchema["~standard"].validate(undefined);
      const wrapperResult = wrapperSchema["~standard"].validate(undefined);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string | undefined }).value).toBeUndefined();
      expect((wrapperResult as { value: string | undefined }).value).toBeUndefined();
    });

    test("both pass through valid strings", () => {
      const input = "hello";
      const optionsResult = optionsSchema["~standard"].validate(input);
      const wrapperResult = wrapperSchema["~standard"].validate(input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string | undefined }).value).toBe(input);
      expect((wrapperResult as { value: string | undefined }).value).toBe(input);
    });

    test("both reject null", () => {
      expect(optionsSchema["~standard"].validate(null).issues).toBeDefined();
      expect(wrapperSchema["~standard"].validate(null).issues).toBeDefined();
    });

    test("both reject invalid types", () => {
      expect(optionsSchema["~standard"].validate(123).issues).toBeDefined();
      expect(wrapperSchema["~standard"].validate(123).issues).toBeDefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<string | undefined>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<string | undefined>();
    });
  });

  describe("number({ optional: true }) vs optional(number())", () => {
    const optionsSchema = number({ optional: true });
    const wrapperSchema = optional(number());

    test("both allow undefined", () => {
      expect(optionsSchema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(wrapperSchema["~standard"].validate(undefined).issues).toBeUndefined();
    });

    test("both validate numbers", () => {
      const input = 42;
      const optionsResult = optionsSchema["~standard"].validate(input);
      const wrapperResult = wrapperSchema["~standard"].validate(input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: number | undefined }).value).toBe(input);
      expect((wrapperResult as { value: number | undefined }).value).toBe(input);
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<number | undefined>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<number | undefined>();
    });
  });

  describe("boolean({ optional: true }) vs optional(boolean())", () => {
    const optionsSchema = v.boolean({ optional: true });
    const wrapperSchema = optional(v.boolean());

    test("both allow undefined", () => {
      expect(optionsSchema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(wrapperSchema["~standard"].validate(undefined).issues).toBeUndefined();
    });

    test("both validate booleans", () => {
      expect(optionsSchema["~standard"].validate(true).issues).toBeUndefined();
      expect(wrapperSchema["~standard"].validate(false).issues).toBeUndefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<boolean | undefined>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<boolean | undefined>();
    });
  });
});

