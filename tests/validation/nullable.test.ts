import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("nullable wrapper schema", () => {
  describe("basic validation", () => {
    const schema = v.nullable(v.string());

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | null }).value).toBeNull();
    });

    test("passes through value", () => {
      const result = parse(schema, "hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | null }).value).toBe("hello");
    });

    test("rejects undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string | null>();
    });
  });

  describe("with different types", () => {
    test("nullable number", () => {
      const schema = v.nullable(v.number());
      expect(parse(schema, null).issues).toBeUndefined();
      expect(parse(schema, 42).issues).toBeUndefined();
    });

    test("nullable boolean", () => {
      const schema = v.nullable(v.boolean());
      expect(parse(schema, null).issues).toBeUndefined();
      expect(parse(schema, true).issues).toBeUndefined();
    });
  });

  describe("nested nullable", () => {
    test("nullable array", () => {
      const schema = v.nullable(v.array(v.string()));
      expect(parse(schema, null).issues).toBeUndefined();
      expect(parse(schema, ["a"]).issues).toBeUndefined();
    });
  });
});

describe("nullable option vs wrapper comparison", () => {
  describe("string({ nullable: true }) vs nullable(string())", () => {
    const optionsSchema = v.string({ nullable: true });
    const wrapperSchema = v.nullable(v.string());

    test("both allow null", () => {
      const optionsResult = parse(optionsSchema, null);
      const wrapperResult = parse(wrapperSchema, null);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string | null }).value).toBeNull();
      expect((wrapperResult as { value: string | null }).value).toBeNull();
    });

    test("both pass through valid strings", () => {
      const input = "hello";
      const optionsResult = parse(optionsSchema, input);
      const wrapperResult = parse(wrapperSchema, input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string | null }).value).toBe(input);
      expect((wrapperResult as { value: string | null }).value).toBe(input);
    });

    test("both reject undefined", () => {
      expect(parse(optionsSchema, undefined).issues).toBeDefined();
      expect(parse(wrapperSchema, undefined).issues).toBeDefined();
    });

    test("both reject invalid types", () => {
      expect(parse(optionsSchema, 123).issues).toBeDefined();
      expect(parse(wrapperSchema, 123).issues).toBeDefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<string | null>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<string | null>();
    });
  });

  describe("number({ nullable: true }) vs nullable(number())", () => {
    const optionsSchema = v.number({ nullable: true });
    const wrapperSchema = v.nullable(v.number());

    test("both allow null", () => {
      expect(parse(optionsSchema, null).issues).toBeUndefined();
      expect(parse(wrapperSchema, null).issues).toBeUndefined();
    });

    test("both validate numbers", () => {
      const input = 42;
      const optionsResult = parse(optionsSchema, input);
      const wrapperResult = parse(wrapperSchema, input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: number | null }).value).toBe(input);
      expect((wrapperResult as { value: number | null }).value).toBe(input);
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<number | null>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<number | null>();
    });
  });

  describe("boolean({ nullable: true }) vs nullable(boolean())", () => {
    const optionsSchema = v.boolean({ nullable: true });
    const wrapperSchema = v.nullable(v.boolean());

    test("both allow null", () => {
      expect(parse(optionsSchema, null).issues).toBeUndefined();
      expect(parse(wrapperSchema, null).issues).toBeUndefined();
    });

    test("both validate booleans", () => {
      expect(parse(optionsSchema, true).issues).toBeUndefined();
      expect(parse(wrapperSchema, false).issues).toBeUndefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<boolean | null>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<boolean | null>();
    });
  });
});
