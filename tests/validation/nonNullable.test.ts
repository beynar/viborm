import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, nonNullable, string, number } from "../../src/validation";

describe("nonNullable wrapper schema", () => {
  describe("basic validation", () => {
    test("excludes null from input and output", () => {
      const nullableSchema = string({ nullable: true });
      const schema = nonNullable(nullableSchema);

      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("hello");
    });

    test("rejects null input", () => {
      const nullableSchema = string({ nullable: true });
      const schema = nonNullable(nullableSchema);

      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("null");
    });

    test("rejects null output from wrapped schema", () => {
      const nullableSchema: StandardSchemaV1<string | null, string | null> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => ({ value: null }),
        },
      };
      const schema = nonNullable(nullableSchema);

      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      const nullableSchema = string({ nullable: true });
      const schema = nonNullable(nullableSchema);
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
      expectTypeOf<Input>().toEqualTypeOf<string>();
    });
  });

  describe("with different types", () => {
    test("nonNullable number", () => {
      const nullableSchema = number({ nullable: true });
      const schema = nonNullable(nullableSchema);
      expect(schema["~standard"].validate(42).issues).toBeUndefined();
      expect(schema["~standard"].validate(null).issues).toBeDefined();
    });

    test("nonNullable array", () => {
      const nullableSchema = v.array(string(), { nullable: true });
      const schema = nonNullable(nullableSchema);
      expect(schema["~standard"].validate(["a"]).issues).toBeUndefined();
      expect(schema["~standard"].validate(null).issues).toBeDefined();
    });
  });
});
