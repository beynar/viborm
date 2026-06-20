import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { type InferInput, parse } from "@validation";
import type { Prettify } from "@validation/types";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("object schema", () => {
  describe("basic validation", () => {
    const schema = v.object({
      name: v.string(),
      age: v.number(),
    });

    test("validates objects", () => {
      const result = parse(schema, { name: "Alice", age: 30 });
      expect(result.issues).toBeUndefined();
      expect(
        (result as { value: { name: string; age: number } }).value,
      ).toEqual({
        name: "Alice",
        age: 30,
      });
    });

    test("rejects non-objects", () => {
      expect(parse(schema, null).issues).toBeDefined();
      expect(parse(schema, undefined).issues).toBeDefined();
      expect(parse(schema, []).issues).toBeDefined();
      expect(parse(schema, "string").issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<{ name?: string; age?: number }>();
    });
  });

  describe("strict option (default: true)", () => {
    const schema = v.object({
      name: v.string(),
      age: v.number(),
    });

    test("rejects unknown keys by default", () => {
      const result = parse(schema, {
        name: "Alice",
        age: 30,
        extra: true,
      });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("Unknown key");
      expect(result.issues?.[0]?.path).toEqual(["extra"]);
    });

    test("allows unknown keys with strict: false", () => {
      const looseSchema = v.object(
        { name: v.string(), age: v.number() },
        { strict: false },
      );
      const result = parse(looseSchema, {
        name: "Alice",
        age: 30,
        extra: true,
      });
      expect(result.issues).toBeUndefined();
      expect(
        (result as { value: { name: string; age: number } }).value,
      ).toEqual({
        name: "Alice",
        age: 30,
      });
    });
  });

  describe("partial option (default: true)", () => {
    test("allows missing fields by default", () => {
      const schema = v.object({
        name: v.string(),
        age: v.number(),
      });
      const result = parse(schema, { name: "Alice" });
      expect(result.issues).toBeUndefined();
      expect(
        (result as { value: { name?: string; age?: number } }).value,
      ).toEqual({
        name: "Alice",
        age: undefined,
      });
    });

    test("allows empty object by default", () => {
      const schema = v.object({
        name: v.string(),
        age: v.number(),
      });
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
    });

    test("requires all fields with partial: false", () => {
      const schema = v.object(
        {
          name: v.string(),
          age: v.number(),
        },
        { partial: false },
      );
      const result = parse(schema, { name: "Alice" });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("age");
    });
  });

  describe("optional fields", () => {
    test("handles optional wrapper", () => {
      const schema = v.object({
        name: v.string(),
        age: v.optional(v.number()),
      });
      const result = parse(schema, { name: "Alice" });
      expect(result.issues).toBeUndefined();
      expect(
        (result as { value: { name: string; age?: number } }).value,
      ).toEqual({
        name: "Alice",
        age: undefined,
      });
    });

    test("handles optional option on field", () => {
      const schema = v.object({
        name: v.string(),
        age: v.number({ optional: true }),
      });
      const result = parse(schema, { name: "Alice" });
      expect(result.issues).toBeUndefined();
    });
  });

  describe("object options", () => {
    test("optional object", () => {
      const schema = v.object({ name: v.string() }, { optional: true });
      expect(parse(schema, undefined).issues).toBeUndefined();
      expect(
        parse(schema, { name: "A" }).issues,
      ).toBeUndefined();
    });

    test("nullable object", () => {
      const schema = v.object({ name: v.string() }, { nullable: true });
      expect(parse(schema, null).issues).toBeUndefined();
    });

    test("array of objects", () => {
      const schema = v.object({ name: v.string() }, { array: true });
      const result = parse(schema, [
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
      const schema = v.object(
        { name: v.string() },
        { optional: true, default: { name: "Unknown" } },
      );
      const result = parse(schema, undefined);
      expect((result as { value: { name: string } }).value).toEqual({
        name: "Unknown",
      });
    });

    test("object with transform", () => {
      const schema = v.object(
        { name: v.string() },
        {
          transform: (u) => {
            const user = u as { name: string };
            return { ...user, name: user.name.toUpperCase() };
          },
        },
      );
      const result = parse(schema, { name: "alice" });
      expect((result as { value: { name: string } }).value).toEqual({
        name: "ALICE",
      });
    });
  });

  describe("nested objects", () => {
    test("validates nested objects", () => {
      const schema = v.object({
        user: v.object({
          name: v.string(),
          age: v.number(),
        }),
      });
      const result = parse(schema, {
        user: { name: "Alice", age: 30 },
      });
      expect(result.issues).toBeUndefined();
    });

    test("reports correct path for nested errors", () => {
      const schema = v.object({
        user: v.object({
          name: v.string(),
          age: v.number(),
        }),
      });
      const result = parse(schema, {
        user: { name: "Alice", age: "30" },
      });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.path).toEqual(["user", "age"]);
    });
  });

  describe("error paths", () => {
    test("reports correct path for missing field", () => {
      const schema = v.object(
        {
          name: v.string(),
          age: v.number(),
        },
        { partial: false },
      );
      const result = parse(schema, { name: "Alice" });
      expect(result.issues?.[0]?.path).toEqual(["age"]);
    });

    test("reports correct path for invalid field", () => {
      const schema = v.object({
        name: v.string(),
        age: v.number(),
      });
      const result = parse(schema, { name: "Alice", age: "30" });
      expect(result.issues?.[0]?.path).toEqual(["age"]);
    });
  });

  describe("extend method", () => {
    const baseSchema = v.object({
      name: v.string(),
    });

    test("creates extended schema with new fields", () => {
      const extendedSchema = baseSchema.extend({
        age: v.number(),
      });

      const result = parse(extendedSchema, {
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
        age: v.number(),
      });

      // Should fail if age is wrong type
      const result = parse(extendedSchema, {
        name: "Alice",
        age: "30",
      });
      expect(result.issues).toBeDefined();
    });

    test("extended schema type inference", () => {
      const extendedSchema = baseSchema.extend({
        age: v.number(),
      });

      type Output = StandardSchemaV1.InferOutput<typeof extendedSchema>;
      expectTypeOf<Output>().toMatchTypeOf<{ name?: string; age?: number }>();
    });

    test("original schema is unchanged", () => {
      baseSchema.extend({ age: v.number() });

      // Original should not have age field validation
      const result = parse(baseSchema, { name: "Alice" });
      expect(result.issues).toBeUndefined();
    });

    test("chaining multiple extends", () => {
      const step1 = baseSchema.extend({ age: v.number() });
      const step2 = step1.extend({ email: v.string() });

      const result = parse(step2, {
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
      expectTypeOf<Output>().toMatchTypeOf<{
        name?: string;
        age?: number;
        email?: string;
      }>();
    });

    test("overriding existing fields", () => {
      // Override name from string to number
      const overridden = baseSchema.extend({
        name: v.number(),
      });

      // Should now accept number for name
      const result = parse(overridden, { name: 123 });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({ name: 123 });

      // Should reject string for name now
      const invalidResult = parse(overridden, { name: "Alice" });
      expect(invalidResult.issues).toBeDefined();
    });

    test("preserves options from parent schema", () => {
      const strictSchema = v.object(
        { name: v.string() },
        { strict: true, partial: false },
      );

      const extended = strictSchema.extend({ age: v.number() });

      // Should still reject unknown keys (strict: true preserved)
      const result = parse(extended, {
        name: "Alice",
        age: 30,
        extra: true,
      });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("Unknown key");
    });

    test("extending with optional fields", () => {
      const extended = baseSchema.extend({
        nickname: v.optional(v.string()),
      });

      // Should work without nickname
      const result1 = parse(extended, { name: "Alice" });
      expect(result1.issues).toBeUndefined();

      // Should work with nickname
      const result2 = parse(extended, {
        name: "Alice",
        nickname: "Ali",
      });
      expect(result2.issues).toBeUndefined();
    });

    test("extending with nested objects", () => {
      const address = v.object({
        city: v.string(),
        zip: v.string(),
      });

      const extended = baseSchema.extend({
        address,
      });

      const result = parse(extended, {
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
      const extended = baseSchema.extend({ age: v.number() });

      expect(extended.entries).toHaveProperty("name");
      expect(extended.entries).toHaveProperty("age");
    });
  });

  describe("non-partial with optional fields and defaults", () => {
    test("applies defaults for optional fields not provided in input", () => {
      const schema = v.object(
        {
          name: v.string(),
          age: v.number({ optional: true, default: 18 }),
          active: v.boolean({ optional: true, default: true }),
        },
        { partial: false },
      );

      // Provide only required field, optional fields should get defaults
      const result = parse(schema, { name: "Alice" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        name: "Alice",
        age: 18,
        active: true,
      });
    });

    test("uses provided values over defaults", () => {
      const schema = v.object(
        {
          name: v.string(),
          age: v.number({ optional: true, default: 18 }),
          active: v.boolean({ optional: true, default: true }),
        },
        { partial: false },
      );

      const result = parse(schema, {
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
      const schema = v.object(
        {
          name: v.string(),
          createdAt: v.string({
            optional: true,
            default: () => {
              callCount++;
              return "2024-01-01";
            },
          }),
        },
        { partial: false },
      );

      const result = parse(schema, { name: "Test" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        name: "Test",
        createdAt: "2024-01-01",
      });
      expect(callCount).toBe(1);
    });

    test("rejects missing required field even with optional fields having defaults", () => {
      const schema = v.object(
        {
          name: v.string(),
          age: v.number({ optional: true, default: 18 }),
        },
        { partial: false },
      );

      // Missing required 'name' field
      const result = parse(schema, { age: 25 });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("name");
    });

    test("type inference includes defaults in output type", () => {
      const schema = v.object(
        {
          name: v.string(),
          age: v.number({ optional: true, default: 18 }),
        },
        { partial: false },
      );

      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      // With partial: false, all fields should be required in output
      expectTypeOf<Output>().toMatchTypeOf<{ name: string; age: number }>();
    });
  });

  describe("atLeast option", () => {
    test("requires only specified keys in partial object", () => {
      const schema = v.object(
        {
          id: v.string(),
          name: v.string(),
          email: v.string(),
          age: v.number(),
        },
        { atLeast: ["id", "name"] },
      );

      // Valid: has required keys, missing optional keys
      const result = parse(schema, { id: "1", name: "Alice" });
      expect(result.issues).toBeUndefined();
      expect((result as { value: any }).value).toEqual({
        id: "1",
        name: "Alice",
        email: undefined,
        age: undefined,
      });
    });

    test("accepts all fields when provided", () => {
      const schema = v.object(
        {
          id: v.string(),
          name: v.string(),
          email: v.string(),
        },
        { atLeast: ["id"] },
      );

      const result = parse(schema, {
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
      const schema = v.object(
        {
          id: v.string(),
          name: v.string(),
          email: v.string(),
        },
        { atLeast: ["id", "name"] },
      );

      // Missing required 'id' key
      const result = parse(schema, { name: "Alice" });
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("id");
    });

    test("type inference makes atLeast keys required", () => {
      const schema = v.object(
        {
          id: v.string(),
          name: v.string(),
          email: v.string(),
        },
        { atLeast: ["id", "name"] as const },
      );

      type Output = Prettify<StandardSchemaV1.InferOutput<typeof schema>>;
      // id and name should be required, email should be optional
      expectTypeOf<Output>().toMatchTypeOf<{
        id: string;
        name: string;
        email?: string;
      }>();
    });

    test("atLeast with empty array behaves like partial", () => {
      const schema = v.object(
        {
          name: v.string(),
          age: v.number(),
        },
        { atLeast: [] },
      );

      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
    });

    test("atLeast overridden by partial: false", () => {
      // When partial: false, all fields are required regardless of atLeast
      const schema = v.object(
        {
          id: v.string(),
          name: v.string(),
          email: v.string(),
        },
        { partial: false, atLeast: ["id"] },
      );

      // Should fail because all fields are required with partial: false
      const result = parse(schema, { id: "1" });
      expect(result.issues).toBeDefined();
    });
  });

  describe("requiresOneOfKeySets option", () => {
    const schema = v.object(
      {
        authorId: v.string(),
        authorOrgId: v.string(),
        author: v.string(),
      },
      {
        requiresOneOfKeySets: [
          [
            ["authorId", "authorOrgId"],
            ["author"],
          ],
        ],
      },
    );

    test("rejects missing alternatives", () => {
      const result = parse(schema, {});

      expect(result.issues).toBeDefined();
    });

    test("rejects partial key-set alternatives", () => {
      const result = parse(schema, { authorId: "author-1" });

      expect(result.issues).toBeDefined();
    });

    test("accepts a complete key-set alternative", () => {
      const result = parse(schema, {
        authorId: "author-1",
        authorOrgId: "org-1",
      });

      expect(result.issues).toBeUndefined();
    });

    test("accepts a single-key alternative", () => {
      const result = parse(schema, { author: "author-1" });

      expect(result.issues).toBeUndefined();
    });

    test("type inference requires a complete key-set alternative", () => {
      type Input = Prettify<InferInput<typeof schema>>;

      expectTypeOf<{ authorId: string }>().not.toMatchTypeOf({} as Input);
      expectTypeOf<{
        authorId: string;
        authorOrgId: string;
      }>().toMatchTypeOf<Input>();
      expectTypeOf<{ author: string }>().toMatchTypeOf<Input>();
    });

    const multiGroupSchema = v.object(
      {
        authorId: v.string(),
        authorOrgId: v.string(),
        author: v.string(),
        categoryId: v.string(),
        category: v.string(),
      },
      {
        requiresOneOfKeySets: [
          [
            ["authorId", "authorOrgId"],
            ["author"],
          ],
          [["categoryId"], ["category"]],
        ],
      },
    );

    test("rejects when any key-set group is unsatisfied", () => {
      const result = parse(multiGroupSchema, {
        authorId: "author-1",
        authorOrgId: "org-1",
      });

      expect(result.issues).toBeDefined();
    });

    test("accepts one complete alternative from every group", () => {
      const result = parse(multiGroupSchema, {
        authorId: "author-1",
        authorOrgId: "org-1",
        category: "category-1",
      });

      expect(result.issues).toBeUndefined();
    });

    test("type inference requires every key-set group", () => {
      type Input = Prettify<InferInput<typeof multiGroupSchema>>;

      expectTypeOf<{
        authorId: string;
        authorOrgId: string;
      }>().not.toMatchTypeOf({} as Input);
      expectTypeOf<{
        authorId: string;
        authorOrgId: string;
        category: string;
      }>().toMatchTypeOf<Input>();
    });
  });

  describe("nonEmpty option", () => {
    test("rejects empty object when nonEmpty: true", () => {
      const schema = v.object(
        { name: v.string(), age: v.number() },
        { nonEmpty: true, partial: true },
      );
      const result = parse(schema, {});
      expect(result.issues).toBeDefined();
      expect(result.issues?.[0]?.message).toContain("empty");
    });

    test("accepts object with at least one key when nonEmpty: true", () => {
      const schema = v.object(
        { name: v.string(), age: v.number() },
        { nonEmpty: true, partial: true },
      );
      const result = parse(schema, { name: "Alice" });
      expect(result.issues).toBeUndefined();
    });

    test("nonEmpty works with strict: false", () => {
      const schema = v.object(
        { name: v.string() },
        { nonEmpty: true, strict: false, partial: true },
      );

      // Empty object should fail
      const emptyResult = parse(schema, {});
      expect(emptyResult.issues).toBeDefined();

      // Unknown key should pass (strict: false allows it)
      const unknownResult = parse(schema, { other: "value" });
      expect(unknownResult.issues).toBeUndefined();
    });

    test("nonEmpty: false allows empty objects", () => {
      const schema = v.object(
        { name: v.string() },
        { nonEmpty: false, partial: true },
      );
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
    });

    test("nonEmpty works with array wrapper", () => {
      const schema = v.object(
        { name: v.string() },
        { nonEmpty: true, array: true, partial: true },
      );

      // Array with empty object should fail
      const result = parse(schema, [{}]);
      expect(result.issues).toBeDefined();

      // Array with non-empty object should pass
      const validResult = parse(schema, [{ name: "Alice" }]);
      expect(validResult.issues).toBeUndefined();
    });

    test("default behavior allows empty objects", () => {
      const schema = v.object({ name: v.string() }, { partial: true });
      const result = parse(schema, {});
      expect(result.issues).toBeUndefined();
    });

    test("nonEmpty with partial: false is redundant but works", () => {
      // With partial: false, all fields are required, so object can't be empty anyway
      const schema = v.object(
        { name: v.string() },
        { nonEmpty: true, partial: false },
      );

      // Empty object fails because name is required (not because of nonEmpty)
      const result = parse(schema, {});
      expect(result.issues).toBeDefined();
    });
  });
});
