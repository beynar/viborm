import type { StandardSchemaV1 } from "@standard-schema/spec";
import v from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("nullable wrapper schema", () => {
  describe("basic validation", () => {
    const schema = v.nullable(v.string());

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | null }).value).toBeNull();
    });

    test("passes through value", () => {
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | null }).value).toBe("hello");
    });

    test("rejects undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string | null>();
    });
  });

  describe("with different types", () => {
    test("nullable number", () => {
      const schema = v.nullable(v.number());
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
      expect(schema["~standard"].validate(42).issues).toBeUndefined();
    });

    test("nullable boolean", () => {
      const schema = v.nullable(v.boolean());
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
      expect(schema["~standard"].validate(true).issues).toBeUndefined();
    });
  });

  describe("nested nullable", () => {
    test("nullable array", () => {
      const schema = v.nullable(v.array(v.string()));
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
      expect(schema["~standard"].validate(["a"]).issues).toBeUndefined();
    });
  });
});

describe("nullable option vs wrapper comparison", () => {
  describe("string({ nullable: true }) vs nullable(string())", () => {
    const optionsSchema = v.string({ nullable: true });
    const wrapperSchema = v.nullable(v.string());

    test("both allow null", () => {
      const optionsResult = optionsSchema["~standard"].validate(null);
      const wrapperResult = wrapperSchema["~standard"].validate(null);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string | null }).value).toBeNull();
      expect((wrapperResult as { value: string | null }).value).toBeNull();
    });

    test("both pass through valid strings", () => {
      const input = "hello";
      const optionsResult = optionsSchema["~standard"].validate(input);
      const wrapperResult = wrapperSchema["~standard"].validate(input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string | null }).value).toBe(input);
      expect((wrapperResult as { value: string | null }).value).toBe(input);
    });

    test("both reject undefined", () => {
      expect(
        optionsSchema["~standard"].validate(undefined).issues
      ).toBeDefined();
      expect(
        wrapperSchema["~standard"].validate(undefined).issues
      ).toBeDefined();
    });

    test("both reject invalid types", () => {
      expect(optionsSchema["~standard"].validate(123).issues).toBeDefined();
      expect(wrapperSchema["~standard"].validate(123).issues).toBeDefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<string | null>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<string | null>();
    });
  });

  describe("number({ nullable: true }) vs nullable(number())", () => {
    const optionsSchema = v.number({ nullable: true });
    const wrapperSchema = v.nullable(v.number());

    test("both allow null", () => {
      expect(optionsSchema["~standard"].validate(null).issues).toBeUndefined();
      expect(wrapperSchema["~standard"].validate(null).issues).toBeUndefined();
    });

    test("both validate numbers", () => {
      const input = 42;
      const optionsResult = optionsSchema["~standard"].validate(input);
      const wrapperResult = wrapperSchema["~standard"].validate(input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: number | null }).value).toBe(input);
      expect((wrapperResult as { value: number | null }).value).toBe(input);
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<number | null>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<number | null>();
    });
  });

  describe("boolean({ nullable: true }) vs nullable(boolean())", () => {
    const optionsSchema = v.boolean({ nullable: true });
    const wrapperSchema = v.nullable(v.boolean());

    test("both allow null", () => {
      expect(optionsSchema["~standard"].validate(null).issues).toBeUndefined();
      expect(wrapperSchema["~standard"].validate(null).issues).toBeUndefined();
    });

    test("both validate booleans", () => {
      expect(optionsSchema["~standard"].validate(true).issues).toBeUndefined();
      expect(wrapperSchema["~standard"].validate(false).issues).toBeUndefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toEqualTypeOf<boolean | null>();
      expectTypeOf<WrapperOutput>().toEqualTypeOf<boolean | null>();
    });
  });
});
