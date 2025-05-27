import { z } from "zod";
import { s } from "../src/schema/index.js";
import { expectTypeOf } from "vitest";

// Define Zod schemas for different use cases (Zod already implements Standard Schema V1)
const userProfileSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  avatar: z.string().url().optional(),
  bio: z.string().max(500).optional(),
  socialLinks: z
    .object({
      twitter: z.string().url().optional(),
      github: z.string().url().optional(),
      linkedin: z.string().url().optional(),
    })
    .optional(),
});

const userPreferencesSchema = z.object({
  theme: z.enum(["light", "dark", "auto"]),
  language: z.string().min(2).max(5),
  notifications: z.object({
    email: z.boolean(),
    push: z.boolean(),
    sms: z.boolean(),
  }),
  privacy: z.object({
    showEmail: z.boolean(),
    showProfile: z.boolean(),
    allowIndexing: z.boolean(),
  }),
});

const productMetadataSchema = z.object({
  category: z.string(),
  tags: z.array(z.string()),
  specifications: z.record(z.union([z.string(), z.number(), z.boolean()])),
  images: z.array(
    z.object({
      url: z.string().url(),
      alt: z.string(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
  ),
  seo: z.object({
    title: z.string().max(60),
    description: z.string().max(160),
    keywords: z.array(z.string()),
  }),
});

describe("JsonField Practical Examples with Zod", () => {
  describe("User model with typed JSON fields", () => {
    test("should create user model with strongly typed profile and preferences", () => {
      const userModel = s.model("user", {
        id: s.string().id().ulid(),
        email: s.string(),
        profile: s.json(userProfileSchema),
        preferences: s.json(userPreferencesSchema).default({
          theme: "auto",
          language: "en",
          notifications: { email: true, push: true, sms: false },
          privacy: { showEmail: false, showProfile: true, allowIndexing: true },
        }),
        metadata: s.json().nullable(), // Flexible JSON for additional data
      });

      type UserType = typeof userModel.infer;

      expectTypeOf<UserType["profile"]>().toMatchTypeOf<
        (typeof userProfileSchema)["_output"]
      >();
      // Verify that the JSON fields are properly typed based on their schemas
      // Test individual properties to ensure proper type inference from Zod schemas
      expectTypeOf<UserType["profile"]["firstName"]>().toEqualTypeOf<string>();
      expectTypeOf<UserType["profile"]["lastName"]>().toEqualTypeOf<string>();
      expectTypeOf<UserType["preferences"]["theme"]>().toEqualTypeOf<
        "light" | "dark" | "auto"
      >();
      expectTypeOf<
        UserType["preferences"]["notifications"]["email"]
      >().toEqualTypeOf<boolean>();
      expectTypeOf<UserType["metadata"]>().toMatchTypeOf<any | null>();

      // Test field properties
      expect(userModel.fields.get("id")!.isId).toBe(true);
      expect(userModel.fields.get("profile")!.fieldType).toBe("json");
      expect(userModel.fields.get("preferences")!.defaultValue).toBeDefined();
      expect(userModel.fields.get("metadata")!.isOptional).toBe(true);
    });

    test("should validate user data against schemas", async () => {
      const userModel = s.model("user", {
        id: s.string().id().ulid(),
        email: s.string(),
        profile: s.json(userProfileSchema),
        preferences: s.json(userPreferencesSchema),
      });

      // Valid profile data
      const validProfile = {
        firstName: "John",
        lastName: "Doe",
        avatar: "https://example.com/avatar.jpg",
        bio: "Software developer",
        socialLinks: {
          github: "https://github.com/johndoe",
          twitter: "https://twitter.com/johndoe",
        },
      };

      const profileResult = await userModel.fields
        .get("profile")!
        .validate(validProfile);
      expect(profileResult.valid).toBe(true);

      // Valid preferences data
      const validPreferences = {
        theme: "dark" as const,
        language: "en-US",
        notifications: { email: true, push: false, sms: false },
        privacy: { showEmail: false, showProfile: true, allowIndexing: true },
      };

      const preferencesResult = await userModel.fields
        .get("preferences")!
        .validate(validPreferences);
      expect(preferencesResult.valid).toBe(true);

      // Invalid profile data
      const invalidProfile = {
        firstName: "", // Invalid: empty string
        lastName: "Doe",
        avatar: "not-a-url", // Invalid: not a URL
      };

      const invalidProfileResult = await userModel.fields
        .get("profile")!
        .validate(invalidProfile);
      expect(invalidProfileResult.valid).toBe(false);
      expect(invalidProfileResult.errors).toBeDefined();
    });
  });

  describe("E-commerce product model", () => {
    test("should create product model with complex metadata schema", () => {
      const productModel = s.model("product", {
        id: s.string().id().ulid(),
        name: s.string(),
        price: s.decimal(),
        metadata: s.json(productMetadataSchema),
        customFields: s.json().nullable(), // Flexible JSON for custom data
        variants: s.json(productMetadataSchema).list(), // Array of metadata
      });

      type ProductType = typeof productModel.infer;

      // Verify complex metadata type structure
      expectTypeOf<ProductType>().toMatchTypeOf<{
        id: string;
        name: string;
        price: number;
        metadata: {
          category: string;
          tags: string[];
          specifications: Record<string, string | number | boolean>;
          images: Array<{
            url: string;
            alt: string;
            width: number;
            height: number;
          }>;
          seo: {
            title: string;
            description: string;
            keywords: string[];
          };
        };
        customFields: any | null;
        variants: Array<{
          category: string;
          tags: string[];
          specifications: Record<string, string | number | boolean>;
          images: Array<{
            url: string;
            alt: string;
            width: number;
            height: number;
          }>;
          seo: {
            title: string;
            description: string;
            keywords: string[];
          };
        }>;
      }>();

      expect(productModel.fields.get("metadata")!.fieldType).toBe("json");
      expect(productModel.fields.get("variants")!.isList).toBe(true);
      expect(productModel.fields.get("customFields")!.isOptional).toBe(true);
    });

    test("should validate complex product metadata", async () => {
      const productModel = s.model("product", {
        id: s.string().id(),
        metadata: s.json(productMetadataSchema),
      });

      const validMetadata = {
        category: "Electronics",
        tags: ["smartphone", "flagship", "5G"],
        specifications: {
          brand: "TechCorp",
          model: "TC-2024",
          storage: 256,
          ram: 8,
          hasWirelessCharging: true,
          screenSize: 6.7,
        },
        images: [
          {
            url: "https://example.com/phone-front.jpg",
            alt: "Phone front view",
            width: 1200,
            height: 1600,
          },
          {
            url: "https://example.com/phone-back.jpg",
            alt: "Phone back view",
            width: 1200,
            height: 1600,
          },
        ],
        seo: {
          title: "TechCorp TC-2024 Smartphone",
          description: "Latest flagship smartphone with 5G connectivity",
          keywords: ["smartphone", "5G", "flagship", "TechCorp"],
        },
      };

      const result = await productModel.fields
        .get("metadata")!
        .validate(validMetadata);
      expect(result.valid).toBe(true);

      // Test invalid data
      const invalidMetadata = {
        category: "Electronics",
        tags: ["smartphone"],
        specifications: { brand: "TechCorp" },
        images: [
          {
            url: "not-a-url", // Invalid URL
            alt: "Phone",
            width: -100, // Invalid negative width
            height: 1600,
          },
        ],
        seo: {
          title: "A".repeat(100), // Too long title (>60 chars)
          description: "Valid description",
          keywords: ["phone"],
        },
      };

      const invalidResult = await productModel.fields
        .get("metadata")!
        .validate(invalidMetadata);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors!.length).toBeGreaterThan(0);
    });
  });

  describe("Configuration and settings models", () => {
    test("should handle application configuration with Zod validation", async () => {
      const configSchema = z.object({
        database: z.object({
          host: z.string(),
          port: z.number().min(1).max(65535),
          username: z.string(),
          ssl: z.boolean(),
          poolSize: z.number().positive(),
        }),
        cache: z.object({
          redis: z.object({
            host: z.string(),
            port: z.number(),
            ttl: z.number().positive(),
          }),
          memory: z.object({
            maxSize: z.number().positive(),
            evictionPolicy: z.enum(["lru", "lfu", "fifo"]),
          }),
        }),
        features: z.object({
          enableLogging: z.boolean(),
          enableMetrics: z.boolean(),
          enableAuth: z.boolean(),
          experimentalFeatures: z.array(z.string()),
        }),
      });

      const settingsModel = s.model("settings", {
        id: s.string().id(),
        environment: s.string(),
        config: s.json(configSchema),
        overrides: s.json().nullable(),
      });

      const validConfig = {
        database: {
          host: "localhost",
          port: 5432,
          username: "admin",
          ssl: false,
          poolSize: 10,
        },
        cache: {
          redis: { host: "redis-server", port: 6379, ttl: 3600 },
          memory: { maxSize: 1000000, evictionPolicy: "lru" as const },
        },
        features: {
          enableLogging: true,
          enableMetrics: true,
          enableAuth: true,
          experimentalFeatures: ["newUI", "betaAPI"],
        },
      };

      const result = await settingsModel.fields
        .get("config")!
        .validate(validConfig);
      expect(result.valid).toBe(true);

      // Verify that the config field is properly typed based on the schema
      type SettingsType = typeof settingsModel.infer;
      expectTypeOf<SettingsType>().toMatchTypeOf<{
        id: string;
        environment: string;
        config: {
          database: {
            host: string;
            port: number;
            username: string;
            ssl: boolean;
            poolSize: number;
          };
          cache: {
            redis: {
              host: string;
              port: number;
              ttl: number;
            };
            memory: {
              maxSize: number;
              evictionPolicy: "lru" | "lfu" | "fifo";
            };
          };
          features: {
            enableLogging: boolean;
            enableMetrics: boolean;
            enableAuth: boolean;
            experimentalFeatures: string[];
          };
        };
        overrides: any | null;
      }>();
    });
  });
});
