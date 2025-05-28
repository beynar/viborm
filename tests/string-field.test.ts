import z from "zod";
import { string } from "../src/schema/fields/string.js";
import type { StringField } from "../src/schema/fields/string.js";

describe("StringField", () => {
  test("creates basic string field", () => {
    const name = string();
    expect(name).toBeInstanceOf(Object);
    expect(name.constructor.name).toBe("StringField");
  });

  describe("chainable methods", () => {
    test("returns StringField instances for all chainable methods", () => {
      const idField = string().id();
      const nullableField = string().nullable();
      const listField = string().array();
      const uniqueField = string().unique();
      const defaultField = string().default("test");

      expect(idField.constructor.name).toBe("StringField");
      expect(nullableField.constructor.name).toBe("StringField");
      expect(listField.constructor.name).toBe("StringField");
      expect(uniqueField.constructor.name).toBe("StringField");
      expect(defaultField.constructor.name).toBe("StringField");
    });

    test("sets properties correctly", () => {
      const idField = string().id();
      const nullableField = string().nullable();
      const listField = string().array();
      const uniqueField = string().unique();

      expect((idField as any)["~isId"]).toBe(true);
      expect((nullableField as any)["~isOptional"]).toBe(true);
      expect((listField as any)["~isArray"]).toBe(true);
      expect((uniqueField as any)["~isUnique"]).toBe(true);
    });
  });

  describe("validation", () => {
    const emailValidator = z.string().min(3).email();

    test("applies validators correctly", () => {
      const emailField = string().unique().validator(emailValidator);

      expect(emailField.constructor.name).toBe("StringField");
    });

    test("validates email correctly", async () => {
      const emailField = string().validator(emailValidator);

      const validResult = await emailField["~validate"]("test@example.com");
      const invalidResult = await emailField["~validate"]("invalid-email");

      expect(validResult.valid).toBe(true);
      expect(invalidResult.valid).toBe(false);
    });

    test("validates length correctly", async () => {
      const lengthField = string().validator(z.string().min(5));

      const validResult = await lengthField["~validate"]("hello");
      const invalidResult = await lengthField["~validate"]("hi");

      expect(validResult.valid).toBe(true);
      expect(invalidResult.valid).toBe(false);
    });

    test("validates complex field with multiple validators", async () => {
      const complexField = string().id().unique().validator(z.string().min(3));

      const validResult = await complexField["~validate"]("test");
      const invalidResult = await complexField["~validate"]("ab");

      expect(complexField.constructor.name).toBe("StringField");
      expect(validResult.valid).toBe(true);
      expect(invalidResult.valid).toBe(false);
    });
  });

  describe("type inference", () => {
    test("infers correct types", () => {
      const idField = string().id();
      const nullableField = string().nullable();
      const listField = string().array();

      // Type tests
      expectTypeOf(idField.infer).toEqualTypeOf<string>();
      expectTypeOf(nullableField.infer).toEqualTypeOf<string | null>();
      expectTypeOf(listField.infer).toEqualTypeOf<string[]>();
    });
  });

  describe("schema creation", () => {
    test("creates schema with various string fields", () => {
      const emailValidator = z.string().min(3).email();

      const testSchema = {
        id: string().id(),
        email: string().unique().validator(emailValidator),
        name: string().validator(z.string().min(2)),
        bio: string().nullable(),
        tags: string().array(),
        slug: string().unique(),
        description: string().default("No description"),
      };

      expect(Object.keys(testSchema)).toEqual([
        "id",
        "email",
        "name",
        "bio",
        "tags",
        "slug",
        "description",
      ]);

      // Check all fields are StringField instances
      Object.values(testSchema).forEach((field) => {
        expect(field.constructor.name).toBe("StringField");
      });
    });
  });
});
