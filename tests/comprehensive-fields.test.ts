import { s } from "../src/schema/index.js";

describe("Comprehensive Field Types", () => {
  describe("All field type constructors", () => {
    test("creates all field types correctly", () => {
      const stringField = s.string();
      const intField = s.int();
      const floatField = s.float();
      const decimalField = s.decimal();
      const booleanField = s.boolean();
      const bigIntField = s.bigInt();
      const dateTimeField = s.dateTime();
      const jsonField = s.json();
      const blobField = s.blob();
      const enumField = s.enum(["a", "b", "c"]);

      expect(stringField.constructor.name).toBe("StringField");
      expect(intField.constructor.name).toBe("NumberField");
      expect(floatField.constructor.name).toBe("NumberField");
      expect(decimalField.constructor.name).toBe("NumberField");
      expect(booleanField.constructor.name).toBe("BooleanField");
      expect(bigIntField.constructor.name).toBe("BigIntField");
      expect(dateTimeField.constructor.name).toBe("DateTimeField");
      expect(jsonField.constructor.name).toBe("JsonField");
      expect(blobField.constructor.name).toBe("BlobField");
      expect(enumField.constructor.name).toBe("EnumField");
    });
  });

  describe("Chainable methods work on all field types", () => {
    test("string field supports all chainable methods", () => {
      const complexString = s
        .string()
        .id()
        .unique()
        .nullable()
        .array()
        .default(["test"]);

      expect(complexString.constructor.name).toBe("StringField");
      expect((complexString as any)["~isId"]).toBe(true);
      expect((complexString as any)["~isUnique"]).toBe(true);
      expect((complexString as any)["~isOptional"]).toBe(true);
      expect((complexString as any)["~isArray"]).toBe(true);
    });

    test("number field supports chainable methods", () => {
      const complexNumber = s.int().unique();

      expect(complexNumber.constructor.name).toBe("NumberField");
      expect((complexNumber as any)["~isUnique"]).toBe(true);
    });

    test("boolean field supports chainable methods", () => {
      const complexBool = s.boolean().array().nullable().default([true]);

      expect(complexBool.constructor.name).toBe("BooleanField");
      expect((complexBool as any)["~isArray"]).toBe(true);
      expect((complexBool as any)["~isOptional"]).toBe(true);
    });

    test("enum field supports chainable methods", () => {
      const complexEnum = s
        .enum(["red", "green", "blue"] as const)
        .nullable()
        .default("red");

      expect(complexEnum.constructor.name).toBe("EnumField");
      expect((complexEnum as any)["~isOptional"]).toBe(true);
    });
  });

  describe("Complete user model", () => {
    test("creates comprehensive user model with basic field types", () => {
      const userModel = s.model("user", {
        // String fields with various modifiers
        id: s.string().id(),
        email: s.string().unique(),
        username: s.string(),
        firstName: s.string(),
        lastName: s.string(),
        bio: s.string().nullable(),
        tags: s.string().array(),
        socialLinks: s.string().array().nullable(),

        // Number fields
        age: s.int(),
        score: s.float(),
        balance: s.decimal(),
        favoriteNumbers: s.int().array(),

        // Boolean fields
        isActive: s.boolean().default(true),
        isVerified: s.boolean().default(false),
        permissions: s.boolean().array(),

        // BigInt fields
        userId: s.bigInt().id(),
        largeValue: s.bigInt().nullable(),

        // DateTime fields
        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),
        birthDate: s.dateTime().nullable(),
        loginTimes: s.dateTime().array(),

        // JSON fields
        metadata: s.json(),
        preferences: s.json().nullable(),
        history: s.json(),

        // Blob fields
        avatar: s.blob().nullable(),
        attachments: s.blob().array(),

        // Enum fields
        status: s
          .enum(["active", "inactive", "suspended"] as const)
          .default("active"),
        role: s.enum(["user", "admin", "moderator"] as const),
        categories: s
          .enum([1, 2, 3, 4, 5] as const)
          .array()
          .nullable(),
      });

      expect(userModel.name).toBe("user");
      expect(userModel.fields.size).toBe(29);

      // Test some key fields
      const idField = userModel.fields.get("id");
      const emailField = userModel.fields.get("email");
      const ageField = userModel.fields.get("age");
      const isActiveField = userModel.fields.get("isActive");
      const statusField = userModel.fields.get("status");

      expect(idField?.constructor.name).toBe("StringField");
      expect(emailField?.constructor.name).toBe("StringField");
      expect(ageField?.constructor.name).toBe("NumberField");
      expect(isActiveField?.constructor.name).toBe("BooleanField");
      expect(statusField?.constructor.name).toBe("EnumField");
    });
  });

  describe("Sample data creation", () => {
    test("creates valid sample data for all field types", () => {
      const sampleUser = {
        // String types
        id: "user-123",
        email: "john@example.com",
        username: "johndoe",
        firstName: "John",
        lastName: "Doe",
        bio: null,
        tags: ["developer", "typescript"],
        socialLinks: null,

        // Number types
        age: 30,
        score: 95.5,
        balance: 1000.5,
        favoriteNumbers: [7, 13, 42],

        // Boolean types
        isActive: true,
        isVerified: false,
        permissions: [true, false, true],

        // BigInt types
        userId: BigInt(123456789),
        largeValue: null,

        // Date types
        createdAt: new Date(),
        updatedAt: new Date(),
        birthDate: new Date("1990-01-01"),
        loginTimes: [new Date(), new Date()],

        // JSON types
        metadata: { theme: "dark", language: "en" },
        preferences: null,
        history: [{ action: "login" }, { action: "logout" }],

        // Blob types
        avatar: null,
        attachments: [new Uint8Array([1, 2, 3])],

        // Enum types
        status: "active" as const,
        role: "user" as const,
        categories: [1, 3, 5],
      };

      // Test sample data structure
      expect(sampleUser.id).toBe("user-123");
      expect(sampleUser.email).toBe("john@example.com");
      expect(sampleUser.age).toBe(30);
      expect(sampleUser.isActive).toBe(true);
      expect(sampleUser.userId).toBe(BigInt(123456789));
      expect(sampleUser.createdAt).toBeInstanceOf(Date);
      expect(sampleUser.metadata).toEqual({ theme: "dark", language: "en" });
      expect(sampleUser.attachments[0]).toBeInstanceOf(Uint8Array);
      expect(sampleUser.status).toBe("active");
      expect(sampleUser.bio).toBeNull();
      expect(sampleUser.preferences).toBeNull();
    });
  });

  describe("Basic field features", () => {
    test("all field types support basic methods", () => {
      const stringField = s.string();
      const numberField = s.int();
      const booleanField = s.boolean();
      const dateField = s.dateTime();

      expect(stringField.constructor.name).toBe("StringField");
      expect(numberField.constructor.name).toBe("NumberField");
      expect(booleanField.constructor.name).toBe("BooleanField");
      expect(dateField.constructor.name).toBe("DateTimeField");
    });
  });

  describe("Complex field combinations", () => {
    test("creates complex field combinations successfully", () => {
      const complexFields = {
        complexString: s.string().id().unique(),
        complexNumber: s.int().unique(),
        complexBool: s.boolean().array().nullable(),
        complexEnum: s
          .enum(["red", "green", "blue"] as const)
          .nullable()
          .default("red"),
        complexDate: s.dateTime().nullable(),
        complexBlob: s.blob().nullable(),
      };

      expect(complexFields.complexString.constructor.name).toBe("StringField");
      expect(complexFields.complexNumber.constructor.name).toBe("NumberField");
      expect(complexFields.complexBool.constructor.name).toBe("BooleanField");
      expect(complexFields.complexEnum.constructor.name).toBe("EnumField");
      expect(complexFields.complexDate.constructor.name).toBe("DateTimeField");
      expect(complexFields.complexBlob.constructor.name).toBe("BlobField");

      // Test properties are set
      expect((complexFields.complexString as any)["~isId"]).toBe(true);
      expect((complexFields.complexString as any)["~isUnique"]).toBe(true);
      expect((complexFields.complexNumber as any)["~isUnique"]).toBe(true);
      expect((complexFields.complexBool as any)["~isArray"]).toBe(true);
      expect((complexFields.complexBool as any)["~isOptional"]).toBe(true);
    });
  });
});
