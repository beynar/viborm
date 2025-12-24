import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, nonOptional, required, string, number } from "../../src/validation";

describe("nonOptional wrapper schema", () => {
  describe("basic validation", () => {
    test("excludes undefined from input and output", () => {
      const optionalSchema = string({ optional: true });
      const schema = nonOptional(optionalSchema);

      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("hello");
    });

    test("rejects undefined input", () => {
      const optionalSchema = string({ optional: true });
      const schema = nonOptional(optionalSchema);

      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("required");
    });

    test("rejects undefined output from wrapped schema", () => {
      const optionalSchema: StandardSchemaV1<string | undefined, string | undefined> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => ({ value: undefined }),
        },
      };
      const schema = nonOptional(optionalSchema);

      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      const optionalSchema = string({ optional: true });
      const schema = nonOptional(optionalSchema);
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
      expectTypeOf<Input>().toEqualTypeOf<string>();
    });
  });

  describe("required alias", () => {
    test("required is alias for nonOptional", () => {
      const optionalSchema = number({ optional: true });
      const schema = required(optionalSchema);

      expect(schema["~standard"].validate(42).issues).toBeUndefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
    });
  });

  describe("with different types", () => {
    test("nonOptional number", () => {
      const optionalSchema = number({ optional: true });
      const schema = nonOptional(optionalSchema);
      expect(schema["~standard"].validate(42).issues).toBeUndefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
    });

    test("nonOptional array", () => {
      const optionalSchema = v.array(string(), { optional: true });
      const schema = nonOptional(optionalSchema);
      expect(schema["~standard"].validate(["a"]).issues).toBeUndefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
    });
  });
});

