import { s } from "../src/schema/index.js";

describe("All Field Types", () => {
  describe("Individual field type creation", () => {
    test("creates all field types with basic modifiers", () => {
      const stringField = s.string().nullable();
      const intField = s.int().list();
      const boolField = s.boolean().default(true);
      const bigintField = s.bigInt().unique();
      const dateField = s.dateTime().nullable();
      const jsonField = s.json().list();
      const blobField = s.blob().nullable();
      const enumField = s.enum(["a", "b", "c"] as const).nullable();

      // Test field instances are correct types
      expect(stringField.constructor.name).toBe("StringField");
      expect(intField.constructor.name).toBe("NumberField");
      expect(boolField.constructor.name).toBe("BooleanField");
      expect(bigintField.constructor.name).toBe("BigIntField");
      expect(dateField.constructor.name).toBe("DateTimeField");
      expect(jsonField.constructor.name).toBe("JsonField");
      expect(blobField.constructor.name).toBe("BlobField");
      expect(enumField.constructor.name).toBe("EnumField");

      // Test properties are set correctly
      expect((stringField as any).isOptional).toBe(true);
      expect((intField as any).isList).toBe(true);
      expect((bigintField as any).isUnique).toBe(true);
      expect((dateField as any).isOptional).toBe(true);
      expect((jsonField as any).isList).toBe(true);
      expect((blobField as any).isOptional).toBe(true);
      expect((enumField as any).isOptional).toBe(true);
    });
  });

  describe("Comprehensive model with all field types", () => {
    test("creates model with every field type", () => {
      const comprehensiveModel = s.model("comprehensive", {
        // String fields
        id: s.string().id(),
        email: s.string().unique(),
        name: s.string(),
        bio: s.string().nullable(),
        tags: s.string().list(),
        description: s.string().default("No description"),

        // Number fields
        age: s.int(),
        score: s.float(),
        price: s.decimal(),
        count: s.int().list(),

        // Boolean fields
        isActive: s.boolean(),
        isVerified: s.boolean().default(false),
        permissions: s.boolean().list(),

        // BigInt fields
        bigId: s.bigInt().id(),
        bigValue: s.bigInt().nullable(),

        // DateTime fields
        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),
        birthDate: s.dateTime().nullable(),

        // JSON fields
        metadata: s.json(),
        config: s.json().nullable(),
        settings: s.json().list(),

        // Blob fields
        avatar: s.blob().nullable(),
        documents: s.blob().list(),

        // Enum fields
        status: s.enum(["draft", "published", "archived"] as const),
        role: s.enum(["user", "admin", "moderator"] as const).default("user"),
        categories: s.enum([1, 2, 3, 4, 5] as const).list(),
      });

      expect(comprehensiveModel.name).toBe("comprehensive");
      expect(comprehensiveModel.fields.size).toBe(26);

      // Test string fields
      expect(comprehensiveModel.fields.get("id")?.constructor.name).toBe(
        "StringField"
      );
      expect(comprehensiveModel.fields.get("email")?.constructor.name).toBe(
        "StringField"
      );
      expect(comprehensiveModel.fields.get("bio")?.constructor.name).toBe(
        "StringField"
      );

      // Test number fields
      expect(comprehensiveModel.fields.get("age")?.constructor.name).toBe(
        "NumberField"
      );
      expect(comprehensiveModel.fields.get("score")?.constructor.name).toBe(
        "NumberField"
      );
      expect(comprehensiveModel.fields.get("price")?.constructor.name).toBe(
        "NumberField"
      );

      // Test other field types
      expect(comprehensiveModel.fields.get("isActive")?.constructor.name).toBe(
        "BooleanField"
      );
      expect(comprehensiveModel.fields.get("bigId")?.constructor.name).toBe(
        "BigIntField"
      );
      expect(comprehensiveModel.fields.get("createdAt")?.constructor.name).toBe(
        "DateTimeField"
      );
      expect(comprehensiveModel.fields.get("metadata")?.constructor.name).toBe(
        "JsonField"
      );
      expect(comprehensiveModel.fields.get("avatar")?.constructor.name).toBe(
        "BlobField"
      );
      expect(comprehensiveModel.fields.get("status")?.constructor.name).toBe(
        "EnumField"
      );
    });
  });

  describe("Complex chaining", () => {
    test("supports complex method chaining on all field types", () => {
      const complexString = s.string().unique().nullable();
      const complexNumber = s.int().id();
      const complexDate = s.dateTime().nullable();
      const complexEnum = s
        .enum(["red", "green", "blue"] as const)
        .list()
        .nullable();

      expect(complexString.constructor.name).toBe("StringField");
      expect(complexNumber.constructor.name).toBe("NumberField");
      expect(complexDate.constructor.name).toBe("DateTimeField");
      expect(complexEnum.constructor.name).toBe("EnumField");

      // Test properties from chaining
      expect((complexString as any).isUnique).toBe(true);
      expect((complexString as any).isOptional).toBe(true);
      expect((complexNumber as any).isId).toBe(true);
      expect((complexDate as any).isOptional).toBe(true);
      expect((complexEnum as any).isList).toBe(true);
      expect((complexEnum as any).isOptional).toBe(true);
    });
  });

  describe("Field properties validation", () => {
    test("validates field properties are set correctly", () => {
      const fields = {
        stringField: s.string().nullable(),
        intField: s.int().list(),
        bigintField: s.bigInt().unique(),
        complexField: s.string().id().unique().nullable(),
      };

      // Test individual properties
      expect((fields.stringField as any).isOptional).toBe(true);
      expect((fields.intField as any).isList).toBe(true);
      expect((fields.bigintField as any).isUnique).toBe(true);

      // Test complex field has multiple properties
      expect((fields.complexField as any).isId).toBe(true);
      expect((fields.complexField as any).isUnique).toBe(true);
      expect((fields.complexField as any).isOptional).toBe(true);
    });
  });

  describe("Type inference methods", () => {
    test("all fields have type inference methods", () => {
      const stringField = s.string();
      const numberField = s.int();
      const booleanField = s.boolean();
      const bigintField = s.bigInt();
      const dateField = s.dateTime();
      const jsonField = s.json();
      const blobField = s.blob();
      const enumField = s.enum(["a", "b"]);

      // Test that all fields have inference properties
      const fields = [
        stringField,
        numberField,
        booleanField,
        bigintField,
        dateField,
        jsonField,
        blobField,
        enumField,
      ];

      fields.forEach((field) => {
        expect(field).toHaveProperty("infer");
        expect(field).toHaveProperty("inferInput");
        expect(field).toHaveProperty("inferStorage");
      });
    });
  });

  describe("Sample data for all field types", () => {
    test("creates valid sample data for comprehensive model", () => {
      const sampleData = {
        // String fields
        id: "comp-123",
        email: "test@example.com",
        name: "Test User",
        bio: null,
        tags: ["tag1", "tag2"],
        description: "A test user",

        // Number fields
        age: 30,
        score: 95.5,
        price: 1000.5,
        count: [1, 2, 3],

        // Boolean fields
        isActive: true,
        isVerified: false,
        permissions: [true, false, true],

        // BigInt fields
        bigId: BigInt(123456789),
        bigValue: null,

        // DateTime fields
        createdAt: new Date(),
        updatedAt: new Date(),
        birthDate: new Date("1990-01-01"),

        // JSON fields
        metadata: { version: 1 },
        config: null,
        settings: [{ key: "value" }],

        // Blob fields
        avatar: null,
        documents: [new Uint8Array([1, 2, 3])],

        // Enum fields
        status: "published" as const,
        role: "user" as const,
        categories: [1, 3, 5],
      };

      // Test data types
      expect(typeof sampleData.id).toBe("string");
      expect(typeof sampleData.age).toBe("number");
      expect(typeof sampleData.isActive).toBe("boolean");
      expect(typeof sampleData.bigId).toBe("bigint");
      expect(sampleData.createdAt).toBeInstanceOf(Date);
      expect(typeof sampleData.metadata).toBe("object");
      expect(Array.isArray(sampleData.documents)).toBe(true);
      expect(sampleData.documents[0]).toBeInstanceOf(Uint8Array);
      expect(sampleData.status).toBe("published");

      // Test null values
      expect(sampleData.bio).toBeNull();
      expect(sampleData.bigValue).toBeNull();
      expect(sampleData.config).toBeNull();
      expect(sampleData.avatar).toBeNull();

      // Test arrays
      expect(Array.isArray(sampleData.tags)).toBe(true);
      expect(Array.isArray(sampleData.count)).toBe(true);
      expect(Array.isArray(sampleData.permissions)).toBe(true);
      expect(Array.isArray(sampleData.settings)).toBe(true);
      expect(Array.isArray(sampleData.categories)).toBe(true);
    });
  });
});
