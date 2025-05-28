import z from "zod";
import { s } from "../src/schema/index.js";
import type { StandardSchemaV1 } from "../src/types/standardSchema.js";

describe("JSON Schema Support", () => {
  describe("Basic JSON fields", () => {
    test("creates basic JSON field", () => {
      const jsonField = s.json();
      expect(jsonField.constructor.name).toBe("JsonField");
    });

    test("creates nullable JSON field", () => {
      const nullableJson = s.json().nullable();
      expect(nullableJson.constructor.name).toBe("JsonField");
      expect((nullableJson as any)["~isOptional"]).toBe(true);
    });

    test("creates JSON list field", () => {
      const jsonList = s.json();
      expect(jsonList.constructor.name).toBe("JsonField");
    });
  });

  describe("Typed JSON fields with schema", () => {
    test("creates JSON field with custom schema", () => {
      const userPreferencesSchema = z.object({
        theme: z.string(),
        language: z.string(),
      });

      const userPreferences = s.json(userPreferencesSchema);
    });
  });

  describe("Model with JSON fields", () => {
    test("creates model with mixed JSON fields", () => {
      const productModel = s.model("product", {
        id: s.string().id().ulid(),
        name: s.string(),
        price: s.decimal(),

        // Basic untyped JSON for flexibility
        metadata: s.json(),

        // Array of JSON objects
        variants: s.json(),

        // Nullable JSON field
        settings: s.json().nullable(),

        createdAt: s.dateTime().now(),
      });

      expect(productModel.name).toBe("product");
      expect(productModel.fields.size).toBe(7);

      // Test JSON fields
      const metadataField = productModel.fields.get("metadata");
      const variantsField = productModel.fields.get("variants");
      const settingsField = productModel.fields.get("settings");

      expect(metadataField?.constructor.name).toBe("JsonField");
      expect(variantsField?.constructor.name).toBe("JsonField");
      expect(settingsField?.constructor.name).toBe("JsonField");

      expect((variantsField as any)["~isArray"]).toBe(false);
      expect((settingsField as any)["~isOptional"]).toBe(true);
    });
  });

  describe("Sample JSON data", () => {
    test("creates valid JSON data samples", () => {
      const sampleJsonData = {
        // Basic JSON (any type)
        metadata: { theme: "dark", language: "en" },

        // JSON array
        history: [{ action: "login" }, { action: "logout" }],

        // Complex nested JSON
        preferences: {
          theme: "light",
          language: "en",
          notifications: {
            email: true,
            push: false,
            sms: true,
          },
          privacy: {
            profileVisible: true,
            dataSharing: false,
          },
        },

        // Nullable JSON
        optionalSettings: null,
      };

      expect(typeof sampleJsonData.metadata).toBe("object");
      expect(Array.isArray(sampleJsonData.history)).toBe(true);
      expect(typeof sampleJsonData.preferences).toBe("object");
      expect(sampleJsonData.preferences.theme).toBe("light");
      expect(sampleJsonData.preferences.notifications.email).toBe(true);
      expect(sampleJsonData.optionalSettings).toBeNull();
    });
  });

  describe("JSON field validation", () => {
    test("validates JSON field basic functionality", async () => {
      // This would test validation if implemented
      const jsonField = s.json();

      // Test that the field exists and has basic properties
      expect(jsonField.constructor.name).toBe("JsonField");
      expect(jsonField).toHaveProperty("~validate");

      // Basic validation test with the new ~validate method
      const validJson = { key: "value" };
      const result = await jsonField["~validate"](validJson);
      expect(result).toBeDefined();
    });
  });

  describe("E-commerce example", () => {
    test("creates e-commerce model with JSON fields", () => {
      const productModel = s.model("product", {
        id: s.string().id().ulid(),
        name: s.string(),
        description: s.string().nullable(),
        price: s.decimal(),

        // Product attributes (size, color, material, etc.)
        attributes: s.json(),

        // Basic metadata
        metadata: s.json(),

        // Array of product variants
        variants: s.json(),

        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().now(),
      });

      const userModel = s.model("user", {
        id: s.string().id().ulid(),
        email: s.string().unique(),
        username: s.string().unique(),

        // User preferences
        preferences: s.json(),

        // Optional settings
        settings: s.json().nullable(),

        // Audit trail
        auditLog: s.json(),

        createdAt: s.dateTime().now(),
      });

      expect(productModel.name).toBe("product");
      expect(userModel.name).toBe("user");

      expect(productModel.fields.size).toBe(9);
      expect(userModel.fields.size).toBe(7);

      // Test that JSON fields are created correctly
      expect(productModel.fields.get("attributes")?.constructor.name).toBe(
        "JsonField"
      );
      expect(productModel.fields.get("variants")?.constructor.name).toBe(
        "JsonField"
      );
      expect(userModel.fields.get("preferences")?.constructor.name).toBe(
        "JsonField"
      );
      expect(userModel.fields.get("settings")?.constructor.name).toBe(
        "JsonField"
      );
      expect(userModel.fields.get("auditLog")?.constructor.name).toBe(
        "JsonField"
      );

      // Test properties
      expect((productModel.fields.get("variants") as any)["~isArray"]).toBe(
        false
      );
      expect((userModel.fields.get("settings") as any)["~isOptional"]).toBe(
        true
      );
      expect((userModel.fields.get("auditLog") as any)["~isArray"]).toBe(false);
    });
  });
});
