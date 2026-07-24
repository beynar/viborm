import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type JsonValue, parse, v } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("json schema", () => {
  const schema = v.json();

  describe("accepts valid JSON primitives", () => {
    test("string", () => {
      const result = parse(schema, "hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("hello");
    });

    test("number (finite)", () => {
      const result = parse(schema, 42);
      expect(result.issues).toBeUndefined();
    });

    test("negative number", () => {
      const result = parse(schema, -123.45);
      expect(result.issues).toBeUndefined();
    });

    test("zero", () => {
      const result = parse(schema, 0);
      expect(result.issues).toBeUndefined();
    });

    test("boolean true", () => {
      const result = parse(schema, true);
      expect(result.issues).toBeUndefined();
    });

    test("boolean false", () => {
      const result = parse(schema, false);
      expect(result.issues).toBeUndefined();
    });

    test("null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("accepts valid JSON structures", () => {
    test("empty array", () => {
      const result = parse(schema, []);
      expect(result.issues).toBeUndefined();
    });

    test("array of primitives", () => {
      const result = parse(schema, [1, "two", true, null]);
      expect(result.issues).toBeUndefined();
    });

    test("nested array", () => {
      const result = parse(schema, [
        [1, 2],
        [3, [4, 5]],
      ]);
      expect(result.issues).toBeUndefined();
    });

    test("empty object", () => {
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
    });

    test("simple object", () => {
      const result = parse(schema, {
        name: "John",
        age: 30,
        active: true,
      });
      expect(result.issues).toBeUndefined();
    });

    test("nested object", () => {
      const result = parse(schema, {
        user: {
          profile: {
            name: "John",
            settings: { theme: "dark" },
          },
        },
      });
      expect(result.issues).toBeUndefined();
    });

    test("complex mixed structure", () => {
      const result = parse(schema, {
        users: [
          { name: "Alice", scores: [1, 2, 3] },
          { name: "Bob", scores: [4, 5, 6] },
        ],
        metadata: {
          count: 2,
          valid: true,
        },
      });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("rejects non-JSON values", () => {
    test("undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeDefined();
    });

    test("function", () => {
      const result = parse(schema, () => {});
      expect(result.issues).toBeDefined();
    });

    test("symbol", () => {
      const result = parse(schema, Symbol("test"));
      expect(result.issues).toBeDefined();
    });

    test("bigint", () => {
      const result = parse(schema, BigInt(123));
      expect(result.issues).toBeDefined();
    });

    test("NaN", () => {
      const result = parse(schema, Number.NaN);
      expect(result.issues).toBeDefined();
    });

    test("Infinity", () => {
      const result = parse(schema, Number.POSITIVE_INFINITY);
      expect(result.issues).toBeDefined();
    });

    test("-Infinity", () => {
      const result = parse(schema, Number.NEGATIVE_INFINITY);
      expect(result.issues).toBeDefined();
    });

    test("Date object", () => {
      const result = parse(schema, new Date());
      expect(result.issues).toBeDefined();
    });

    test("RegExp", () => {
      const result = parse(schema, /test/);
      expect(result.issues).toBeDefined();
    });

    test("class instance", () => {
      class MyClass {}
      const result = parse(schema, new MyClass());
      expect(result.issues).toBeDefined();
    });

    test("object with undefined value", () => {
      const result = parse(schema, { a: undefined });
      expect(result.issues).toBeDefined();
    });

    test("object with function value", () => {
      const result = parse(schema, { fn: () => {} });
      expect(result.issues).toBeDefined();
    });

    test("array with undefined", () => {
      const result = parse(schema, [1, undefined, 3]);
      expect(result.issues).toBeDefined();
    });

    test("array with function", () => {
      const result = parse(schema, [1, () => {}, 3]);
      expect(result.issues).toBeDefined();
    });
  });

  describe("handles circular references", () => {
    test("rejects circular object", () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      const result = parse(schema, obj);
      expect(result.issues).toBeDefined();
    });

    test("rejects circular array", () => {
      const arr: any[] = [1, 2];
      arr.push(arr);
      const result = parse(schema, arr);
      expect(result.issues).toBeDefined();
    });
  });

  describe("with options", () => {
    test("optional json", () => {
      const optionalSchema = v.json({ optional: true });
      const result = parse(optionalSchema, undefined);
      expect(result.issues).toBeUndefined();
    });

    test("nullable json", () => {
      const nullableSchema = v.json({ nullable: true });
      const result = parse(nullableSchema, null);
      expect(result.issues).toBeUndefined();
    });

    test("json with default", () => {
      const defaultSchema = v.json({ default: { empty: true } });
      const result = parse(defaultSchema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: object }).value).toEqual({ empty: true });
    });

    test("array of json", () => {
      const arraySchema = v.json({ array: true });
      const result = parse(arraySchema, [{ a: 1 }, { b: 2 }, "string"]);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("type inference", () => {
    test("infers JsonValue type", () => {
      const jsonSchema = v.json();
      type JsonType = StandardSchemaV1.InferOutput<typeof jsonSchema>;
      expectTypeOf<JsonType>().toMatchTypeOf<JsonValue>();
    });
  });

  describe("schema properties", () => {
    test("has correct type", () => {
      expect(schema.type).toBe("json");
    });
  });
});
