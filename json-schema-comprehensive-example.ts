// Comprehensive example of JSON fields with schema support
import { s } from "./src/schema/index.js";
import type { StandardSchemaV1 } from "./src/types/standardSchema.js";

// ==== Example: E-commerce Product Catalog ====

// Product attributes schema (dynamic product properties)
const productAttributesSchema: StandardSchemaV1<
  any,
  {
    color?: string;
    size?: "XS" | "S" | "M" | "L" | "XL" | "XXL";
    material?: string;
    weight?: number;
    dimensions?: {
      width: number;
      height: number;
      depth: number;
    };
  }
> = {
  "~standard": {
    version: 1,
    vendor: "baseorm-example",
    validate: async (value: unknown) => {
      if (typeof value !== "object" || value === null) {
        return {
          issues: [{ message: "Product attributes must be an object" }],
        };
      }

      const obj = value as any;

      // Validate optional fields
      if (obj.color !== undefined && typeof obj.color !== "string") {
        return { issues: [{ message: "Color must be a string" }] };
      }

      if (
        obj.size !== undefined &&
        !["XS", "S", "M", "L", "XL", "XXL"].includes(obj.size)
      ) {
        return {
          issues: [{ message: "Size must be one of: XS, S, M, L, XL, XXL" }],
        };
      }

      if (obj.weight !== undefined && typeof obj.weight !== "number") {
        return { issues: [{ message: "Weight must be a number" }] };
      }

      if (obj.dimensions !== undefined) {
        if (
          typeof obj.dimensions !== "object" ||
          typeof obj.dimensions.width !== "number" ||
          typeof obj.dimensions.height !== "number" ||
          typeof obj.dimensions.depth !== "number"
        ) {
          return {
            issues: [
              {
                message:
                  "Dimensions must be an object with width, height, depth numbers",
              },
            ],
          };
        }
      }

      return { value: obj };
    },
    types: {
      input: {} as any,
      output: {} as {
        color?: string;
        size?: "XS" | "S" | "M" | "L" | "XL" | "XXL";
        material?: string;
        weight?: number;
        dimensions?: {
          width: number;
          height: number;
          depth: number;
        };
      },
    },
  },
};

// User preferences schema
const userPreferencesSchema: StandardSchemaV1<
  any,
  {
    theme: "light" | "dark" | "auto";
    language: string;
    notifications: {
      email: boolean;
      push: boolean;
      sms: boolean;
    };
    privacy: {
      profileVisible: boolean;
      dataSharing: boolean;
    };
  }
> = {
  "~standard": {
    version: 1,
    vendor: "baseorm-example",
    validate: async (value: unknown) => {
      if (typeof value !== "object" || value === null) {
        return { issues: [{ message: "User preferences must be an object" }] };
      }

      const obj = value as any;

      if (!["light", "dark", "auto"].includes(obj.theme)) {
        return { issues: [{ message: "Theme must be light, dark, or auto" }] };
      }

      if (typeof obj.language !== "string") {
        return { issues: [{ message: "Language must be a string" }] };
      }

      // Validate nested objects
      if (!obj.notifications || typeof obj.notifications !== "object") {
        return { issues: [{ message: "Notifications settings required" }] };
      }

      if (!obj.privacy || typeof obj.privacy !== "object") {
        return { issues: [{ message: "Privacy settings required" }] };
      }

      return { value: obj };
    },
    types: {
      input: {} as any,
      output: {} as {
        theme: "light" | "dark" | "auto";
        language: string;
        notifications: {
          email: boolean;
          push: boolean;
          sms: boolean;
        };
        privacy: {
          profileVisible: boolean;
          dataSharing: boolean;
        };
      },
    },
  },
};

// Define models with typed JSON fields
const productModel = s.model("product", {
  id: s.string().id().auto.ulid(),
  name: s.string(),
  description: s.string().nullable(),
  price: s.decimal(),

  // Strongly typed product attributes
  attributes: s.json(productAttributesSchema),

  // Basic metadata (untyped JSON for flexibility)
  metadata: s.json(),

  // Array of configurations
  variants: s.json(productAttributesSchema).list(),

  createdAt: s.dateTime().auto.now(),
  updatedAt: s.dateTime().auto.now(),
});

const userModel = s.model("user", {
  id: s.string().id().auto.ulid(),
  email: s.string().unique(),
  username: s.string().unique(),

  // Strongly typed user preferences
  preferences: s.json(userPreferencesSchema),

  // Optional settings (can be null)
  settings: s.json(userPreferencesSchema).nullable(),

  // Audit trail (untyped for flexibility)
  auditLog: s.json().list(),

  createdAt: s.dateTime().auto.now(),
});

// ==== Type inference demonstration ====
console.log("=== Type Inference Demonstration ===");

// These variables get proper TypeScript types
type ProductType = typeof productModel.infer;
type UserType = typeof userModel.infer;

// ProductType.attributes will be strongly typed as the schema output
// UserType.preferences will be strongly typed as the user preferences schema

console.log("Product model fields:", Array.from(productModel.fields.keys()));
console.log("User model fields:", Array.from(userModel.fields.keys()));

// ==== Validation demonstration ====
console.log("\n=== Validation Demonstration ===");

async function demonstrateValidation() {
  const attributesField = productModel.fields.get("attributes") as any;
  const preferencesField = userModel.fields.get("preferences") as any;

  // Valid product attributes
  const validAttributes = {
    color: "red",
    size: "M" as const,
    material: "cotton",
    weight: 0.5,
    dimensions: {
      width: 10,
      height: 15,
      depth: 2,
    },
  };

  const validAttrResult = await attributesField.validate(validAttributes);
  console.log("Valid attributes:", validAttrResult);

  // Invalid product attributes
  const invalidAttributes = {
    color: "blue",
    size: "XXXL", // Invalid size
    weight: "heavy", // Should be number
  };

  const invalidAttrResult = await attributesField.validate(invalidAttributes);
  console.log("Invalid attributes:", invalidAttrResult);

  // Valid user preferences
  const validPreferences = {
    theme: "dark" as const,
    language: "en-US",
    notifications: {
      email: true,
      push: false,
      sms: true,
    },
    privacy: {
      profileVisible: true,
      dataSharing: false,
    },
  };

  const validPrefResult = await preferencesField.validate(validPreferences);
  console.log("Valid preferences:", validPrefResult);

  // Invalid user preferences
  const invalidPreferences = {
    theme: "rainbow", // Invalid theme
    language: "en-US",
    notifications: "all", // Should be object
  };

  const invalidPrefResult = await preferencesField.validate(invalidPreferences);
  console.log("Invalid preferences:", invalidPrefResult);
}

demonstrateValidation().catch(console.error);

// ==== Benefits Summary ====
console.log("\n=== Benefits of Schema-based JSON Fields ===");
console.log("✅ Type Safety: JSON data is strongly typed based on schema");
console.log("✅ Validation: Automatic validation of JSON structure and values");
console.log(
  "✅ IntelliSense: Full IDE support with autocomplete and type checking"
);
console.log("✅ Flexibility: Can mix typed and untyped JSON fields as needed");
console.log(
  "✅ Chainable: All field modifiers (nullable, list, etc.) work with schemas"
);
console.log("✅ Standard Schema: Compatible with popular validation libraries");
console.log("✅ Backward Compatible: Existing json() calls continue to work");

export {
  productModel,
  userModel,
  productAttributesSchema,
  userPreferencesSchema,
};
