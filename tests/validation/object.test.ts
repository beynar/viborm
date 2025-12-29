import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  v,
  object,
  string,
  number,
  optional,
  Prettify,
} from "../../src/validation";

describe("object schema", () => {
  describe("basic validation", () => {
    const schema = object({
      name: string(),
      age: number(),
    });

    test("validates objects", () => {
      const result = schema["~standard"].validate({ name: "Alice", age: 30 });
      expect(result.issues).toBeUndefined();
      expect(
        (result as { value: { name: string; age: number } }).value
      ).toEqual({
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
      expect(
        (result as { value: { name: string; age: number } }).value
      ).toEqual({
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
      expect(
        (result as { value: { name?: string; age?: number } }).value
      ).toEqual({
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
      expect(
        (result as { value: { name: string; age?: number } }).value
      ).toEqual({
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
      expect(
        schema["~standard"].validate({ name: "A" }).issues
      ).toBeUndefined();
    });

    test("nullable object", () => {
      const schema = object({ name: string() }, { nullable: true });
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
    });

    test("array of objects", () => {
      const schema = object({ name: string() }, { array: true });
      const result = schema["~standard"].validate([
        { name: "A" },
        { name: "B" },
      ]);
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
      expect((result as { value: { name: string } }).value).toEqual({
        name: "Unknown",
      });
    });

    test("object with transform", () => {
      const schema = object(
        { name: string() },
        { transform: (u) => ({ ...u, name: u.name.toUpperCase() }) }
      );
      const result = schema["~standard"].validate({ name: "alice" });
      expect((result as { value: { name: string } }).value).toEqual({
        name: "ALICE",
      });
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

  describe("extend method", () => {
    const baseSchema = object({
      name: string(),
    });

    test("creates extended schema with new fields", () => {
      const extendedSchema = baseSchema.extend({
        age: number(),
      });

      const result = extendedSchema["~standard"].validate({
        name: "Alice",
        age: 30,
      });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        name: "Alice",
        age: 30,
      });
    });

    test("extended schema validates new fields", () => {
      const extendedSchema = baseSchema.extend({
        age: number(),
      });

      // Should fail if age is wrong type
      const result = extendedSchema["~standard"].validate({
        name: "Alice",
        age: "30",
      });
      expect(result.issues).toBeDefined();
    });

    test("extended schema type inference", () => {
      const extendedSchema = baseSchema.extend({
        age: number(),
      });

      type Output = StandardSchemaV1.InferOutput<typeof extendedSchema>;
      expectTypeOf<Output>().toEqualTypeOf<{ name?: string; age?: number }>();
    });

    test("original schema is unchanged", () => {
      baseSchema.extend({ age: number() });

      // Original should not have age field validation
      const result = baseSchema["~standard"].validate({ name: "Alice" });
      expect(result.issues).toBeUndefined();
    });

    test("chaining multiple extends", () => {
      const step1 = baseSchema.extend({ age: number() });
      const step2 = step1.extend({ email: string() });

      const result = step2["~standard"].validate({
        name: "Alice",
        age: 30,
        email: "alice@test.com",
      });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        name: "Alice",
        age: 30,
        email: "alice@test.com",
      });

      // Type inference for chained extends
      type Output = StandardSchemaV1.InferOutput<typeof step2>;
      expectTypeOf<Output>().toEqualTypeOf<{
        name?: string;
        age?: number;
        email?: string;
      }>();
    });

    test("overriding existing fields", () => {
      // Override name from string to number
      const overridden = baseSchema.extend({
        name: number(),
      });

      // Should now accept number for name
      const result = overridden["~standard"].validate({ name: 123 });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({ name: 123 });

      // Should reject string for name now
      const invalidResult = overridden["~standard"].validate({ name: "Alice" });
      expect(invalidResult.issues).toBeDefined();
    });

    test("preserves options from parent schema", () => {
      const strictSchema = object(
        { name: string() },
        { strict: true, partial: false }
      );

      const extended = strictSchema.extend({ age: number() });

      // Should still reject unknown keys (strict: true preserved)
      const result = extended["~standard"].validate({
        name: "Alice",
        age: 30,
        extra: true,
      });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("Unknown key");
    });

    test("extending with optional fields", () => {
      const extended = baseSchema.extend({
        nickname: optional(string()),
      });

      // Should work without nickname
      const result1 = extended["~standard"].validate({ name: "Alice" });
      expect(result1.issues).toBeUndefined();

      // Should work with nickname
      const result2 = extended["~standard"].validate({
        name: "Alice",
        nickname: "Ali",
      });
      expect(result2.issues).toBeUndefined();
    });

    test("extending with nested objects", () => {
      const address = object({
        city: string(),
        zip: string(),
      });

      const extended = baseSchema.extend({
        address: address,
      });

      const result = extended["~standard"].validate({
        name: "Alice",
        address: { city: "NYC", zip: "10001" },
      });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        name: "Alice",
        address: { city: "NYC", zip: "10001" },
      });
    });

    test("extended schema has correct entries property", () => {
      const extended = baseSchema.extend({ age: number() });

      expect(extended.entries).toHaveProperty("name");
      expect(extended.entries).toHaveProperty("age");
    });
  });

  describe("non-partial with optional fields and defaults", () => {
    test("applies defaults for optional fields not provided in input", () => {
      const schema = object(
        {
          name: string(),
          age: number({ optional: true, default: 18 }),
          active: v.boolean({ optional: true, default: true }),
        },
        { partial: false }
      );

      // Provide only required field, optional fields should get defaults
      const result = schema["~standard"].validate({ name: "Alice" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        name: "Alice",
        age: 18,
        active: true,
      });
    });

    test("uses provided values over defaults", () => {
      const schema = object(
        {
          name: string(),
          age: number({ optional: true, default: 18 }),
          active: v.boolean({ optional: true, default: true }),
        },
        { partial: false }
      );

      const result = schema["~standard"].validate({
        name: "Bob",
        age: 25,
        active: false,
      });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        name: "Bob",
        age: 25,
        active: false,
      });
    });

    test("applies function defaults", () => {
      let callCount = 0;
      const schema = object(
        {
          name: string(),
          createdAt: string({
            optional: true,
            default: () => {
              callCount++;
              return "2024-01-01";
            },
          }),
        },
        { partial: false }
      );

      const result = schema["~standard"].validate({ name: "Test" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        name: "Test",
        createdAt: "2024-01-01",
      });
      expect(callCount).toBe(1);
    });

    test("rejects missing required field even with optional fields having defaults", () => {
      const schema = object(
        {
          name: string(),
          age: number({ optional: true, default: 18 }),
        },
        { partial: false }
      );

      // Missing required 'name' field
      const result = schema["~standard"].validate({ age: 25 });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("name");
    });

    test("type inference includes defaults in output type", () => {
      const schema = object(
        {
          name: string(),
          age: number({ optional: true, default: 18 }),
        },
        { partial: false }
      );

      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      // With partial: false, all fields should be required in output
      expectTypeOf<Output>().toEqualTypeOf<{ name: string; age: number }>();
    });
  });

  describe("atLeast option", () => {
    test("requires only specified keys in partial object", () => {
      const schema = object(
        {
          id: string(),
          name: string(),
          email: string(),
          age: number(),
        },
        { atLeast: ["id", "name"] }
      );

      // Valid: has required keys, missing optional keys
      const result = schema["~standard"].validate({ id: "1", name: "Alice" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        id: "1",
        name: "Alice",
        email: undefined,
        age: undefined,
      });
    });

    test("accepts all fields when provided", () => {
      const schema = object(
        {
          id: string(),
          name: string(),
          email: string(),
        },
        { atLeast: ["id"] }
      );

      const result = schema["~standard"].validate({
        id: "1",
        name: "Alice",
        email: "alice@test.com",
      });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        id: "1",
        name: "Alice",
        email: "alice@test.com",
      });
    });

    test("rejects when atLeast key is missing", () => {
      const schema = object(
        {
          id: string(),
          name: string(),
          email: string(),
        },
        { atLeast: ["id", "name"] }
      );

      // Missing required 'id' key
      const result = schema["~standard"].validate({ name: "Alice" });
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("id");
    });

    test("type inference makes atLeast keys required", () => {
      const schema = object(
        {
          id: string(),
          name: string(),
          email: string(),
        },
        { atLeast: ["id", "name"] as const }
      );

      type Output = Prettify<StandardSchemaV1.InferOutput<typeof schema>>;
      // id and name should be required, email should be optional
      expectTypeOf<Output>().toEqualTypeOf<{
        id: string;
        name: string;
        email?: string;
      }>();
    });

    test("atLeast with empty array behaves like partial", () => {
      const schema = object(
        {
          name: string(),
          age: number(),
        },
        { atLeast: [] }
      );

      const result = schema["~standard"].validate({});
      expect(result.issues).toBeUndefined();
    });

    test("atLeast overridden by partial: false", () => {
      // When partial: false, all fields are required regardless of atLeast
      const schema = object(
        {
          id: string(),
          name: string(),
          email: string(),
        },
        { partial: false, atLeast: ["id"] }
      );

      // Should fail because all fields are required with partial: false
      const result = schema["~standard"].validate({ id: "1" });
      expect(result.issues).toBeDefined();
    });
  });
});
