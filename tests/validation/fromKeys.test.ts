import { describe, test, expect, expectTypeOf } from "vitest";
import v from "../../src/validation/index";
import type {
  VibSchema,
  ValidationResult,
  InferOutput,
} from "../../src/validation/types";

// Helper to get sync result from parse
function parse<T>(
  schema: { parse: (v: unknown) => any },
  value: unknown
): ValidationResult<T> {
  return schema.parse(value) as ValidationResult<T>;
}

describe("fromKeys", () => {
  test("creates object schema from keys with same value schema", () => {
    const schema = v.fromKeys(["name", "email", "bio"] as const, v.string());

    expect(schema.type).toBe("object");

    const validResult = parse(schema, {
      name: "John",
      email: "john@example.com",
      bio: "Developer",
    });
    expect(validResult.issues).toBeUndefined();
    expect((validResult as any).value).toEqual({
      name: "John",
      email: "john@example.com",
      bio: "Developer",
    });
  });

  test("validates value types correctly", () => {
    const schema = v.fromKeys(["a", "b", "c"] as const, v.number());

    const validResult = parse(schema, { a: 1, b: 2, c: 3 });
    expect(validResult.issues).toBeUndefined();

    const invalidResult = parse(schema, { a: 1, b: "two", c: 3 });
    expect(invalidResult.issues).toBeDefined();
  });

  test("supports partial option (default: true)", () => {
    const schema = v.fromKeys(["x", "y", "z"] as const, v.string());

    // Partial by default - missing keys are allowed
    const result = parse(schema, { x: "hello" });
    expect(result.issues).toBeUndefined();
  });

  test("supports partial: false option", () => {
    const schema = v.fromKeys(["x", "y"] as const, v.string(), {
      partial: false,
    });

    // Non-partial - missing keys are errors
    const result = parse(schema, { x: "hello" });
    expect(result.issues).toBeDefined();
    expect(result.issues?.[0]?.message).toContain("Missing required field");
  });

  test("supports optional option", () => {
    const schema = v.fromKeys(["key"] as const, v.string(), { optional: true });

    const result = parse(schema, undefined);
    expect(result.issues).toBeUndefined();
    expect((result as any).value).toBeUndefined();
  });

  test("supports nullable option", () => {
    const schema = v.fromKeys(["key"] as const, v.string(), { nullable: true });

    const result = parse(schema, null);
    expect(result.issues).toBeUndefined();
    expect((result as any).value).toBeNull();
  });

  test("supports array option", () => {
    const schema = v.fromKeys(["a", "b"] as const, v.number(), { array: true });

    const result = parse(schema, [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
    expect(result.issues).toBeUndefined();
    expect((result as any).value).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  test("works with thunks (circular references)", () => {
    const nodeSchema: VibSchema<any, any> = v.object({
      value: v.string(),
    });

    const schema = v.fromKeys(["left", "right"] as const, () => nodeSchema);

    expect(schema.type).toBe("object");

    const result = parse(schema, {
      left: { value: "L" },
      right: { value: "R" },
    });
    expect(result.issues).toBeUndefined();
  });

  describe("type inference", () => {
    test("infers correct output type", () => {
      const schema = v.fromKeys(
        ["name", "email"] as const,
        v.string(),
        { partial: false }
      );

      expectTypeOf<InferOutput<typeof schema>>().toExtend<{
        name: string;
        email: string;
      }>();
    });

    test("infers partial type when partial: true (default)", () => {
      const schema = v.fromKeys(["a", "b"] as const, v.number());

      expectTypeOf<InferOutput<typeof schema>>().toExtend<
        Partial<{ a: number; b: number }>
      >();
    });

    test("infers array type when array: true", () => {
      const schema = v.fromKeys(["x"] as const, v.boolean(), {
        array: true,
        partial: false,
      });

      expectTypeOf<InferOutput<typeof schema>>().toExtend<{ x: boolean }[]>();
    });

    test("infers nullable type when nullable: true", () => {
      const schema = v.fromKeys(["x"] as const, v.string(), {
        nullable: true,
        partial: false,
      });

      expectTypeOf<InferOutput<typeof schema>>().toExtend<
        { x: string } | null
      >();
    });

    test("infers optional type when optional: true", () => {
      const schema = v.fromKeys(["x"] as const, v.string(), {
        optional: true,
        partial: false,
      });

      expectTypeOf<InferOutput<typeof schema>>().toExtend<
        { x: string } | undefined
      >();
    });
  });
});

