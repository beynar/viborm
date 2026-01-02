import { describe, test, expect, expectTypeOf } from "vitest";
import { v, JsonValue } from "@validation";
import type { StandardSchemaV1 } from "@standard-schema/spec";

describe("json schema", () => {
  const schema = v.json();

  describe("accepts valid JSON primitives", () => {
    test("string", () => {
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("hello");
    });

    test("number (finite)", () => {
      const result = schema["~standard"].validate(42);
      expect(result.issues).toBeUndefined();
    });

    test("negative number", () => {
      const result = schema["~standard"].validate(-123.45);
      expect(result.issues).toBeUndefined();
    });

    test("zero", () => {
      const result = schema["~standard"].validate(0);
      expect(result.issues).toBeUndefined();
    });

    test("boolean true", () => {
      const result = schema["~standard"].validate(true);
      expect(result.issues).toBeUndefined();
    });

    test("boolean false", () => {
      const result = schema["~standard"].validate(false);
      expect(result.issues).toBeUndefined();
    });

    test("null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("accepts valid JSON structures", () => {
    test("empty array", () => {
      const result = schema["~standard"].validate([]);
      expect(result.issues).toBeUndefined();
    });

    test("array of primitives", () => {
      const result = schema["~standard"].validate([1, "two", true, null]);
      expect(result.issues).toBeUndefined();
    });

    test("nested array", () => {
      const result = schema["~standard"].validate([
        [1, 2],
        [3, [4, 5]],
      ]);
      expect(result.issues).toBeUndefined();
    });

    test("empty object", () => {
      const result = schema["~standard"].validate({});
      expect(result.issues).toBeUndefined();
    });

    test("simple object", () => {
      const result = schema["~standard"].validate({
        name: "John",
        age: 30,
        active: true,
      });
      expect(result.issues).toBeUndefined();
    });

    test("nested object", () => {
      const result = schema["~standard"].validate({
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
      const result = schema["~standard"].validate({
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
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeDefined();
    });

    test("function", () => {
      const result = schema["~standard"].validate(() => {});
      expect(result.issues).toBeDefined();
    });

    test("symbol", () => {
      const result = schema["~standard"].validate(Symbol("test"));
      expect(result.issues).toBeDefined();
    });

    test("bigint", () => {
      const result = schema["~standard"].validate(BigInt(123));
      expect(result.issues).toBeDefined();
    });

    test("NaN", () => {
      const result = schema["~standard"].validate(NaN);
      expect(result.issues).toBeDefined();
    });

    test("Infinity", () => {
      const result = schema["~standard"].validate(Infinity);
      expect(result.issues).toBeDefined();
    });

    test("-Infinity", () => {
      const result = schema["~standard"].validate(-Infinity);
      expect(result.issues).toBeDefined();
    });

    test("Date object", () => {
      const result = schema["~standard"].validate(new Date());
      expect(result.issues).toBeDefined();
    });

    test("RegExp", () => {
      const result = schema["~standard"].validate(/test/);
      expect(result.issues).toBeDefined();
    });

    test("class instance", () => {
      class MyClass {}
      const result = schema["~standard"].validate(new MyClass());
      expect(result.issues).toBeDefined();
    });

    test("object with undefined value", () => {
      const result = schema["~standard"].validate({ a: undefined });
      expect(result.issues).toBeDefined();
    });

    test("object with function value", () => {
      const result = schema["~standard"].validate({ fn: () => {} });
      expect(result.issues).toBeDefined();
    });

    test("array with undefined", () => {
      const result = schema["~standard"].validate([1, undefined, 3]);
      expect(result.issues).toBeDefined();
    });

    test("array with function", () => {
      const result = schema["~standard"].validate([1, () => {}, 3]);
      expect(result.issues).toBeDefined();
    });
  });

  describe("handles circular references", () => {
    test("rejects circular object", () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      const result = schema["~standard"].validate(obj);
      expect(result.issues).toBeDefined();
    });

    test("rejects circular array", () => {
      const arr: any[] = [1, 2];
      arr.push(arr);
      const result = schema["~standard"].validate(arr);
      expect(result.issues).toBeDefined();
    });
  });

  describe("with options", () => {
    test("optional json", () => {
      const optionalSchema = v.json({ optional: true });
      const result = optionalSchema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
    });

    test("nullable json", () => {
      const nullableSchema = v.json({ nullable: true });
      const result = nullableSchema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
    });

    test("json with default", () => {
      const defaultSchema = v.json({ default: { empty: true } });
      const result = defaultSchema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: object }).value).toEqual({ empty: true });
    });

    test("array of json", () => {
      const arraySchema = v.json({ array: true });
      const result = arraySchema["~standard"].validate([
        { a: 1 },
        { b: 2 },
        "string",
      ]);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("type inference", () => {
    test("infers JsonValue type", () => {
      const jsonSchema = v.json();
      type JsonType = StandardSchemaV1.InferOutput<typeof jsonSchema>;
      expectTypeOf<JsonType>().toEqualTypeOf<JsonValue>();
    });
  });

  describe("schema properties", () => {
    test("has correct type", () => {
      expect(schema.type).toBe("json");
    });
  });
});
