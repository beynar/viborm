import { JsonField, json } from "../src/schema/fields/json.js";
import { expectTypeOf } from "vitest";
import { z } from "zod";

// Define test schemas using Zod directly (it already implements Standard Schema V1)
const userProfileSchema = z.object({
  name: z.string().min(1),
  age: z.number().min(0).max(150),
  email: z.string().email(),
  preferences: z.object({
    theme: z.enum(["light", "dark"]),
    notifications: z.boolean(),
  }),
});

const settingsSchema = z.object({
  apiKey: z.string().uuid(),
  timeout: z.number().positive(),
  features: z.array(z.string()),
});

const flexibleDataSchema = z.union([
  z.string(),
  z.number(),
  z.array(z.any()),
  z.record(z.any()),
]);

describe("JsonField", () => {
  describe("basic functionality", () => {
    test("should infer any type for json field without schema", () => {
      const field = json();
      expectTypeOf(field.infer).toEqualTypeOf<any>();
    });

    test("should properly type method chaining without schema", () => {
      const field = json().nullable().default({ test: "value" });
      expectTypeOf(field.infer).toEqualTypeOf<any>();
    });
  });

  describe("Zod schema integration", () => {
    test("should infer correct types from Zod schema", () => {
      // Create a field with a Zod schema
      const profileField = json(userProfileSchema);

      // Type should be inferred from the Zod schema
      type ProfileType = typeof profileField.infer;

      expectTypeOf<ProfileType>().toMatchTypeOf<{
        name: string;
        age: number;
        email: string;
        preferences: {
          theme: "light" | "dark";
          notifications: boolean;
        };
      }>();
    });

    test("should work with nullable schema fields", () => {
      const nullableProfileField = json(userProfileSchema).nullable();
      type NullableProfileType = typeof nullableProfileField.infer;

      expectTypeOf<NullableProfileType>().toMatchTypeOf<{
        name: string;
        age: number;
        email: string;
        preferences: {
          theme: "light" | "dark";
          notifications: boolean;
        };
      } | null>();
    });

    test("should work with list schema fields", () => {
      const profileListField = json(userProfileSchema).list();
      type ProfileListType = typeof profileListField.infer;

      expectTypeOf<ProfileListType>().toMatchTypeOf<
        Array<{
          name: string;
          age: number;
          email: string;
          preferences: {
            theme: "light" | "dark";
            notifications: boolean;
          };
        }>
      >();
    });
  });

  describe("Zod validation", () => {
    test("should validate data against Zod schema successfully", async () => {
      const field = json(userProfileSchema);

      const validData = {
        name: "John Doe",
        age: 30,
        email: "john@example.com",
        preferences: {
          theme: "dark" as const,
          notifications: true,
        },
      };

      const result = await field.validate(validData);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    test("should fail validation for invalid data against Zod schema", async () => {
      const field = json(userProfileSchema);

      const invalidData = {
        name: "", // Invalid: empty string
        age: -5, // Invalid: negative age
        email: "not-an-email", // Invalid: not an email
        preferences: {
          theme: "invalid-theme", // Invalid: not light or dark
          notifications: "yes", // Invalid: not a boolean
        },
      };

      const result = await field.validate(invalidData);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    test("should validate complex nested data", async () => {
      const field = json(settingsSchema);

      const validSettings = {
        apiKey: "550e8400-e29b-41d4-a716-446655440000",
        timeout: 5000,
        features: ["feature1", "feature2", "feature3"],
      };

      const result = await field.validate(validSettings);
      expect(result.valid).toBe(true);
    });

    test("should validate union types with flexible schema", async () => {
      const field = json(flexibleDataSchema);

      // Test string
      const stringResult = await field.validate("hello");
      expect(stringResult.valid).toBe(true);

      // Test number
      const numberResult = await field.validate(42);
      expect(numberResult.valid).toBe(true);

      // Test array
      const arrayResult = await field.validate([1, "two", { three: 3 }]);
      expect(arrayResult.valid).toBe(true);

      // Test object
      const objectResult = await field.validate({
        key: "value",
        nested: { data: true },
      });
      expect(objectResult.valid).toBe(true);
    });
  });

  describe("schema preservation through chaining", () => {
    test("should preserve Zod schema through method chaining", () => {
      const originalField = json(userProfileSchema);
      const chainedField = originalField.nullable().default({
        name: "Default User",
        age: 25,
        email: "default@example.com",
        preferences: {
          theme: "light" as const,
          notifications: false,
        },
      });

      expect(chainedField.getSchema()).toBe(userProfileSchema);
      expect(chainedField.isOptional).toBe(true);
      expect(chainedField.defaultValue).toBeDefined();
    });

    test("should maintain validation capabilities after chaining", async () => {
      const field = json(userProfileSchema)
        .nullable()
        .default({
          name: "Test",
          age: 20,
          email: "test@example.com",
          preferences: { theme: "light" as const, notifications: true },
        });

      // Test valid data
      const validResult = await field.validate({
        name: "Valid User",
        age: 30,
        email: "valid@example.com",
        preferences: { theme: "dark" as const, notifications: false },
      });
      expect(validResult.valid).toBe(true);

      // Test invalid data
      const invalidResult = await field.validate({
        name: "",
        age: "not-a-number",
        email: "invalid-email",
      });
      expect(invalidResult.valid).toBe(false);
    });
  });

  describe("validation without schema", () => {
    test("should validate any JSON value when no schema provided", async () => {
      const field = json();

      const result1 = await field.validate({ test: "value" });
      expect(result1.valid).toBe(true);

      const result2 = await field.validate([1, 2, 3]);
      expect(result2.valid).toBe(true);

      const result3 = await field.validate("string");
      expect(result3.valid).toBe(true);

      const result4 = await field.validate(42);
      expect(result4.valid).toBe(true);
    });

    test("should preserve field properties through method chaining", () => {
      const field = json().nullable().id().default({ test: "default" });

      expect(field.fieldType).toBe("json");
      expect(field.isOptional).toBe(true);
      expect(field.isId).toBe(true);
      expect(field.defaultValue).toEqual({ test: "default" });
    });
  });

  describe("real-world usage examples", () => {
    test("should work with configuration objects", async () => {
      const configSchema = z.object({
        database: z.object({
          host: z.string(),
          port: z.number().min(1).max(65535),
          ssl: z.boolean(),
        }),
        cache: z.object({
          ttl: z.number().positive(),
          maxSize: z.number().positive(),
        }),
        features: z.array(z.string()),
      });

      const configField = json(configSchema).default({
        database: { host: "localhost", port: 5432, ssl: false },
        cache: { ttl: 3600, maxSize: 1000 },
        features: ["auth", "logging"],
      });

      const validConfig = {
        database: { host: "prod.db.com", port: 5432, ssl: true },
        cache: { ttl: 7200, maxSize: 5000 },
        features: ["auth", "logging", "metrics"],
      };

      const result = await configField.validate(validConfig);
      expect(result.valid).toBe(true);
    });

    test("should work with user metadata", async () => {
      const metadataSchema = z.object({
        lastLogin: z.string().datetime(),
        loginCount: z.number().nonnegative(),
        preferences: z.record(z.any()),
        tags: z.array(z.string()),
      });

      const metadataField = json(metadataSchema).nullable();

      const validMetadata = {
        lastLogin: "2024-12-20T10:30:00Z",
        loginCount: 42,
        preferences: { theme: "dark", language: "en" },
        tags: ["premium", "verified"],
      };

      const result = await metadataField.validate(validMetadata);
      expect(result.valid).toBe(true);
    });
  });
});
