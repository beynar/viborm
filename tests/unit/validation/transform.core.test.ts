import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("coerce schema", () => {
  describe("basic validation", () => {
    test("transforms string to uppercase", () => {
      const schema = v.coerce(v.string(), (s) => s.toUpperCase());
      const result = parse(schema, "hello");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("HELLO");
    });

    test("transforms string to number", () => {
      const schema = v.coerce(v.string(), (s) => Number.parseInt(s, 10));
      const result = parse(schema, "42");
      expect(result.issues).toBeUndefined();
      expect((result as { value: number }).value).toBe(42);
    });

    test("validates base schema first", () => {
      const schema = v.coerce(v.string(), (s) => s.toUpperCase());
      const result = parse(schema, 123);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      const schema = v.coerce(v.string(), (s) => Number.parseInt(s, 10));
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<number>();
    });
  });

  describe("map alias", () => {
    test("map is alias for coerce", () => {
      const schema = v.map(v.string(), (s) => s.toUpperCase());
      const result = parse(schema, "hello");
      expect((result as { value: string }).value).toBe("HELLO");
    });
  });

  test("inherits optionality from the wrapped schema", () => {
    const schema = v.coerce(v.string({ optional: true }), (value) =>
      value?.toUpperCase()
    );

    expect(Reflect.get(schema, "acceptsUndefined")).toBe(true);
    expect(parse(schema, undefined)).toEqual({ value: undefined });
  });

  describe("date transformations", () => {
    test("date to ISO string", () => {
      const schema = v.coerce(v.date(), (d) => d.toISOString());
      const d = new Date("2023-01-01");
      const result = parse(schema, d);
      expect((result as { value: string }).value).toBe(d.toISOString());
    });
  });

  describe("object transformations", () => {
    test("extract property", () => {
      const schema = v.coerce(
        v.object({ name: v.string(), age: v.number() }),
        (obj) => obj.name
      );
      const result = parse(schema, { name: "Alice", age: 30 });
      expect((result as { value: string }).value).toBe("Alice");
    });
  });

  describe("transform errors", () => {
    test("handles transform exceptions", () => {
      const schema = v.coerce(v.string(), () => {
        throw new Error("Transform failed");
      });
      const result = parse(schema, "hello");
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("Transform failed");
    });

    test("handles non-Error transform throws", () => {
      const schema = v.coerce(v.string(), () => {
        throw "transform refused";
      });

      expect(parse(schema, "hello").issues?.[0]?.message).toBe(
        "Transform failed: transform refused"
      );
    });
  });
});
