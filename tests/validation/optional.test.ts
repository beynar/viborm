import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("optional wrapper schema", () => {
  describe("basic validation", () => {
    const schema = v.optional(v.number());

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | undefined }).value).toBeUndefined();
    });

    test("passes through value", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number | undefined }).value).toBe(42);
    });

    test("rejects null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number | undefined>();
    });
  });

  describe("with default", () => {
    test("static default", () => {
      const schema = v.optional(v.number(), 0);
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(0);
    });

    test("default factory function", () => {
      let counter = 0;
      const schema = v.optional(v.number(), () => ++counter);
      expect((parse(schema, undefined) as { value: number }).value).toBe(1);
      expect((parse(schema, undefined) as { value: number }).value).toBe(2);
    });
  });

  describe("with different types", () => {
    test("optional string", () => {
      const schema = v.optional(v.string());
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, "hello").issues).toBeUndefined();
    });

    test("optional boolean", () => {
      const schema = v.optional(v.boolean());
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, true).issues).toBeUndefined();
    });
  });

  describe("nested optional", () => {
    test("optional array", () => {
      const schema = v.optional(v.array(v.string()));
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, ["a"]).issues).toBeUndefined();
    });
  });
});

describe("optional option vs wrapper comparison", () => {
  describe("string({ optional: true }) vs optional(string())", () => {
    const optionsSchema = v.string({ optional: true });
    const wrapperSchema = v.optional(v.string());

    test("both allow undefined", () => {
      const optionsResult = parse(optionsSchema, undefined);
      const wrapperResult = parse(wrapperSchema, undefined);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect(
        (optionsResult as { value: string | undefined }).value
      ).toBeUndefined();
      expect(
        (wrapperResult as { value: string | undefined }).value
      ).toBeUndefined();
    });

    test("both pass through valid strings", () => {
      const input = "hello";
      const optionsResult = parse(optionsSchema, input);
      const wrapperResult = parse(wrapperSchema, input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: string | undefined }).value).toBe(
        input
      );
      expect((wrapperResult as { value: string | undefined }).value).toBe(
        input
      );
    });

    test("both reject null", () => {
      expect(parse(optionsSchema, null).issues).toBeDefined();
      expect(parse(wrapperSchema, null).issues).toBeDefined();
    });

    test("both reject invalid types", () => {
      expect(parse(optionsSchema, 123).issues).toBeDefined();
      expect(parse(wrapperSchema, 123).issues).toBeDefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<string | undefined>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<string | undefined>();
    });
  });

  describe("number({ optional: true }) vs optional(number())", () => {
    const optionsSchema = v.number({ optional: true });
    const wrapperSchema = v.optional(v.number());

    test("both allow undefined", () => {
      expect(parse(optionsSchema, undefined).issues).toBeUndefined();
      expect(parse(wrapperSchema, undefined).issues).toBeUndefined();
    });

    test("both validate numbers", () => {
      const input = 42;
      const optionsResult = parse(optionsSchema, input);
      const wrapperResult = parse(wrapperSchema, input);

      expect(optionsResult.issues).toBeUndefined();
      expect(wrapperResult.issues).toBeUndefined();
      expect((optionsResult as { value: number | undefined }).value).toBe(
        input
      );
      expect((wrapperResult as { value: number | undefined }).value).toBe(
        input
      );
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<number | undefined>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<number | undefined>();
    });
  });

  describe("boolean({ optional: true }) vs optional(boolean())", () => {
    const optionsSchema = v.boolean({ optional: true });
    const wrapperSchema = v.optional(v.boolean());

    test("both allow undefined", () => {
      expect(parse(optionsSchema, undefined).issues).toBeUndefined();
      expect(parse(wrapperSchema, undefined).issues).toBeUndefined();
    });

    test("both validate booleans", () => {
      expect(parse(optionsSchema, true).issues).toBeUndefined();
      expect(parse(wrapperSchema, false).issues).toBeUndefined();
    });

    test("both have same type inference", () => {
      type OptionsOutput = StandardSchemaV1.InferOutput<typeof optionsSchema>;
      type WrapperOutput = StandardSchemaV1.InferOutput<typeof wrapperSchema>;

      expectTypeOf<OptionsOutput>().toMatchTypeOf<boolean | undefined>();
      expectTypeOf<WrapperOutput>().toMatchTypeOf<boolean | undefined>();
    });
  });
});
