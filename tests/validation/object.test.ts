import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, object, string, number, optional } from "../../src/validation";

describe("object schema", () => {
  describe("basic validation", () => {
    const schema = object({
      name: string(),
      age: number(),
    });

    test("validates objects", () => {
      const result = schema["~standard"].validate({ name: "Alice", age: 30 });
      expect(result.issues).toBeUndefined();
      expect((result as { value: { name: string; age: number } }).value).toEqual({
        name: "Alice",
        age: 30,
      });
    });

    test("rejects non-objects", () => {
      expect(schema["~standard"].validate(null).issues).toBeDefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
      expect(schema["~standard"].validate([]).issues).toBeDefined();
      expect(schema["~standard"].validate("string").issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<{ name?: string; age?: number }>();
    });
  });

  describe("strict option (default: true)", () => {
    const schema = object({
      name: string(),
      age: number(),
    });

    test("rejects unknown keys by default", () => {
      const result = schema["~standard"].validate({
        name: "Alice",
        age: 30,
        extra: true,
      });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("Unknown key");
      expect(result.issues![0].path).toEqual(["extra"]);
    });

    test("allows unknown keys with strict: false", () => {
      const looseSchema = object(
        { name: string(), age: number() },
        { strict: false }
      );
      const result = looseSchema["~standard"].validate({
        name: "Alice",
        age: 30,
        extra: true,
      });
      expect(result.issues).toBeUndefined();
      expect((result as { value: { name: string; age: number } }).value).toEqual({
        name: "Alice",
        age: 30,
      });
    });
  });

  describe("partial option (default: true)", () => {
    test("allows missing fields by default", () => {
      const schema = object({
        name: string(),
        age: number(),
      });
      const result = schema["~standard"].validate({ name: "Alice" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: { name?: string; age?: number } }).value).toEqual({
        name: "Alice",
        age: undefined,
      });
    });

    test("allows empty object by default", () => {
      const schema = object({
        name: string(),
        age: number(),
      });
      const result = schema["~standard"].validate({});
      expect(result.issues).toBeUndefined();
    });

    test("requires all fields with partial: false", () => {
      const schema = object(
        {
          name: string(),
          age: number(),
        },
        { partial: false }
      );
      const result = schema["~standard"].validate({ name: "Alice" });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("age");
    });
  });

  describe("optional fields", () => {
    test("handles optional wrapper", () => {
      const schema = object({
        name: string(),
        age: optional(number()),
      });
      const result = schema["~standard"].validate({ name: "Alice" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: { name: string; age?: number } }).value).toEqual({
        name: "Alice",
        age: undefined,
      });
    });

    test("handles optional option on field", () => {
      const schema = object({
        name: string(),
        age: number({ optional: true }),
      });
      const result = schema["~standard"].validate({ name: "Alice" });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("object options", () => {
    test("optional object", () => {
      const schema = object({ name: string() }, { optional: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
      expect(schema["~standard"].validate({ name: "A" }).issues).toBeUndefined();
    });

    test("nullable object", () => {
      const schema = object({ name: string() }, { nullable: true });
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
    });

    test("array of objects", () => {
      const schema = object({ name: string() }, { array: true });
      const result = schema["~standard"].validate([{ name: "A" }, { name: "B" }]);
      expect(result.issues).toBeUndefined();
      expect((result as { value: { name: string }[] }).value).toEqual([
        { name: "A" },
        { name: "B" },
      ]);
    });

    test("object with default", () => {
      const schema = object(
        { name: string() },
        { optional: true, default: { name: "Unknown" } }
      );
      const result = schema["~standard"].validate(undefined);
      expect((result as { value: { name: string } }).value).toEqual({ name: "Unknown" });
    });

    test("object with transform", () => {
      const schema = object(
        { name: string() },
        { transform: (u) => ({ ...u, name: u.name.toUpperCase() }) }
      );
      const result = schema["~standard"].validate({ name: "alice" });
      expect((result as { value: { name: string } }).value).toEqual({ name: "ALICE" });
    });
  });

  describe("nested objects", () => {
    test("validates nested objects", () => {
      const schema = object({
        user: object({
          name: string(),
          age: number(),
        }),
      });
      const result = schema["~standard"].validate({
        user: { name: "Alice", age: 30 },
      });
      expect(result.issues).toBeUndefined();
    });

    test("reports correct path for nested errors", () => {
      const schema = object({
        user: object({
          name: string(),
          age: number(),
        }),
      });
      const result = schema["~standard"].validate({
        user: { name: "Alice", age: "30" },
      });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].path).toEqual(["user", "age"]);
    });
  });

  describe("error paths", () => {
    test("reports correct path for missing field", () => {
      const schema = object(
        {
          name: string(),
          age: number(),
        },
        { partial: false }
      );
      const result = schema["~standard"].validate({ name: "Alice" });
      expect(result.issues![0].path).toEqual(["age"]);
    });

    test("reports correct path for invalid field", () => {
      const schema = object({
        name: string(),
        age: number(),
      });
      const result = schema["~standard"].validate({ name: "Alice", age: "30" });
      expect(result.issues![0].path).toEqual(["age"]);
    });
  });
});

