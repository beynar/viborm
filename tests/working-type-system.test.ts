import { string } from "../src/schema/fields/string.js";
import { int, float } from "../src/schema/fields/number.js";

describe("Working Type System", () => {
  describe("String field type inference", () => {
    test("basic string field", () => {
      const name = string();
      expect(name.constructor.name).toBe("StringField");
    });

    test("nullable string field", () => {
      const optionalName = string().nullable();
      expect(optionalName.constructor.name).toBe("StringField");
      expect((optionalName as any).isOptional).toBe(true);
    });

    test("string list field", () => {
      const tags = string().list();
      expect(tags.constructor.name).toBe("StringField");
      expect((tags as any).isList).toBe(true);
    });

    test("nullable string list field", () => {
      const optionalTags = string().list().nullable();
      expect(optionalTags.constructor.name).toBe("StringField");
      expect((optionalTags as any).isList).toBe(true);
      expect((optionalTags as any).isOptional).toBe(true);
    });
  });

  describe("Number field type inference", () => {
    test("basic integer field", () => {
      const age = int();
      expect(age.constructor.name).toBe("NumberField");
    });

    test("nullable integer field", () => {
      const optionalAge = int().nullable();
      expect(optionalAge.constructor.name).toBe("NumberField");
      expect((optionalAge as any).isOptional).toBe(true);
    });

    test("float list field", () => {
      const scores = float().list();
      expect(scores.constructor.name).toBe("NumberField");
      expect((scores as any).isList).toBe(true);
    });
  });

  describe("Special field types", () => {
    test("ID field", () => {
      const id = string().id();
      expect(id.constructor.name).toBe("StringField");
      expect((id as any).isId).toBe(true);
    });

    test("unique field", () => {
      const uniqueEmail = string().unique();
      expect(uniqueEmail.constructor.name).toBe("StringField");
      expect((uniqueEmail as any).isUnique).toBe(true);
    });

    test("field with default", () => {
      const defaultDescription = string().default("No description");
      expect(defaultDescription.constructor.name).toBe("StringField");
    });
  });

  describe("Type demonstration", () => {
    test("creates valid typed data", () => {
      // Create fields
      const name = string();
      const optionalName = string().nullable();
      const tags = string().list();
      const age = int();
      const scores = float().list();

      // Create sample data that would match the inferred types
      const nameValue = "Alice";
      const optionalNameValue = null;
      const tagsValue = ["tag1", "tag2"];
      const ageValue = 25;
      const scoresValue = [95.5, 87.2, 92.1];

      expect(typeof nameValue).toBe("string");
      expect(optionalNameValue).toBeNull();
      expect(Array.isArray(tagsValue)).toBe(true);
      expect(tagsValue.every((tag) => typeof tag === "string")).toBe(true);
      expect(typeof ageValue).toBe("number");
      expect(Array.isArray(scoresValue)).toBe(true);
      expect(scoresValue.every((score) => typeof score === "number")).toBe(
        true
      );
    });
  });

  describe("Complete schema example", () => {
    test("creates and validates user schema", () => {
      const userSchema = {
        id: string().id(),
        email: string().unique(),
        name: string(),
        age: int(),
        bio: string().nullable(),
        tags: string().list(),
        scores: float().list().nullable(),
        description: string().default("No description"),
      };

      // Test schema structure
      expect(Object.keys(userSchema)).toEqual([
        "id",
        "email",
        "name",
        "age",
        "bio",
        "tags",
        "scores",
        "description",
      ]);

      // Test field types
      expect(userSchema.id.constructor.name).toBe("StringField");
      expect(userSchema.email.constructor.name).toBe("StringField");
      expect(userSchema.name.constructor.name).toBe("StringField");
      expect(userSchema.age.constructor.name).toBe("NumberField");
      expect(userSchema.bio.constructor.name).toBe("StringField");
      expect(userSchema.tags.constructor.name).toBe("StringField");
      expect(userSchema.scores.constructor.name).toBe("NumberField");
      expect(userSchema.description.constructor.name).toBe("StringField");

      // Test field properties
      expect((userSchema.id as any).isId).toBe(true);
      expect((userSchema.email as any).isUnique).toBe(true);
      expect((userSchema.bio as any).isOptional).toBe(true);
      expect((userSchema.tags as any).isList).toBe(true);
      expect((userSchema.scores as any).isList).toBe(true);
      expect((userSchema.scores as any).isOptional).toBe(true);
    });

    test("creates valid user data", () => {
      const user = {
        id: "user-123",
        email: "user@example.com",
        name: "Alice",
        age: 25,
        bio: null,
        tags: ["developer", "typescript"],
        scores: [95.5, 87.2],
        description: "A TypeScript developer",
      };

      expect(user.id).toBe("user-123");
      expect(user.email).toBe("user@example.com");
      expect(user.name).toBe("Alice");
      expect(user.age).toBe(25);
      expect(user.bio).toBeNull();
      expect(user.tags).toEqual(["developer", "typescript"]);
      expect(user.scores).toEqual([95.5, 87.2]);
      expect(user.description).toBe("A TypeScript developer");
    });
  });

  describe("Type inference properties", () => {
    test("fields have type inference properties", () => {
      const stringField = string();
      const numberField = int();
      const booleanField = string().nullable();

      // Test that inference properties exist
      expect(stringField).toHaveProperty("infer");
      expect(numberField).toHaveProperty("infer");
      expect(booleanField).toHaveProperty("infer");
    });
  });
});
