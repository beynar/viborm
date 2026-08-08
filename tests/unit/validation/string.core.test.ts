import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("string schema", () => {
  describe("basic validation", () => {
    const schema = v.string();

    test("validates strings", () => {
      const result = parse(schema, "hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("hello");
    });

    test("validates empty string", () => {
      const result = parse(schema, "");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("");
    });

    test("rejects non-strings", () => {
      const result = parse(schema, 123);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("Expected string");
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
      expectTypeOf<Output>().toMatchTypeOf<string>();
      expectTypeOf<Input>().toMatchTypeOf<string>();
    });
  });

  describe("optional option", () => {
    const schema = v.string({ optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | undefined }).value).toBeUndefined();
    });

    test("validates strings", () => {
      const result = parse(schema, "hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | undefined }).value).toBe("hello");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = v.string({ nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | null }).value).toBeNull();
    });

    test("validates strings", () => {
      const result = parse(schema, "hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string | null }).value).toBe("hello");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string | null>();
    });
  });

  describe("array option", () => {
    const schema = v.string({ array: true });

    test("validates array of strings", () => {
      const result = parse(schema, ["a", "b", "c"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual(["a", "b", "c"]);
    });

    test("validates empty array", () => {
      const result = parse(schema, []);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual([]);
    });

    test("rejects non-arrays", () => {
      const result = parse(schema, "a");
      expect(result.issues).toBeDefined();
    });

    test("rejects array with invalid items", () => {
      const result = parse(schema, ["a", 123, "c"]);
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual([1]);
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string[]>();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const schema = v.string({ default: "default" });
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("default");
    });

    test("default factory function", () => {
      let counter = 0;
      const schema = v.string({ default: () => `value-${++counter}` });
      expect((parse(schema, undefined) as { value: string }).value).toBe(
        "value-1"
      );
      expect((parse(schema, undefined) as { value: string }).value).toBe(
        "value-2"
      );
    });

    test("default not used when value provided", () => {
      const schema = v.string({ default: "default" });
      const result = parse(schema, "provided");
      expect((result as { value: string }).value).toBe("provided");
    });
  });

  describe("transform option", () => {
    const schema = v.string({ transform: (s) => s.toUpperCase() });

    test("applies transform to output", () => {
      const result = parse(schema, "hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("HELLO");
    });

    test("transform receives validated value", () => {
      const schema = v.string({ transform: (s) => s.length.toString() });
      const result = parse(schema, "hello");
      expect((result as { value: string }).value).toBe("5");
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<string>();
    });
  });

  describe("schema option", () => {
    const customSchema: StandardSchemaV1<string, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
          const num = Number.parseInt(value as string, 10);
          if (isNaN(num)) {
            return { issues: [{ message: "Not a number" }] };
          }
          return { value: num };
        },
      },
    };

    const schema = v.string({ schema: customSchema });

    test("applies additional schema validation", () => {
      const result = parse(schema, "42");
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("fails if custom schema rejects", () => {
      const result = parse(schema, "not-a-number");
      expect(result.issues).toBeDefined();
    });

    test("fails explicitly for async custom schemas", () => {
      const asyncSchema: StandardSchemaV1<string, string> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: async () => ({ value: "ok" }),
        },
      };
      const result = parse(asyncSchema, "hello");
      expect(result.issues?.[0]?.message).toContain(
        "Async validation is not supported"
      );
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number>();
    });
  });

  describe("combined options", () => {
    test("optional + nullable", () => {
      const schema = v.string({ optional: true, nullable: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, null).issues).toBeUndefined();
      expect(parse(schema, "hello").issues).toBeUndefined();
    });

    test("array + optional", () => {
      const schema = v.string({ array: true, optional: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(parse(schema, ["a"]).issues).toBeUndefined();
    });

    test("array + transform", () => {
      const schema = v.string({
        array: true,
        transform: (s) => s.toUpperCase(),
      });
      const result = parse(schema, ["a", "b"]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string[] }).value).toEqual(["A", "B"]);
    });

    test("schema + transform", () => {
      const customSchema: StandardSchemaV1<string, number> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value) => ({
            value: Number.parseInt(value as string, 10),
          }),
        },
      };
      const schema = v.string({
        schema: customSchema,
        transform: (n: number) => n * 2,
      });
      const result = parse(schema, "21");
      expect((result as { value: number }).value).toBe(42);
    });
  });

  describe("edge cases", () => {
    test("unicode strings", () => {
      const schema = v.string();
      const result = parse(schema, "🚀 hello 🌍");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("🚀 hello 🌍");
    });

    test("very long strings", () => {
      const schema = v.string();
      const longString = "a".repeat(10_000);
      const result = parse(schema, longString);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(longString);
    });

    test("special characters", () => {
      const schema = v.string();
      const special = "\n\t\r\"'\\";
      const result = parse(schema, special);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(special);
    });
  });
});
