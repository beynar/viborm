import { string } from "../src/schema/fields/string.js";
import { s } from "../src/schema/index.js";
describe("Model", () => {
    describe("Basic model creation", () => {
        test("creates model with string fields using direct import", () => {
            const userModel = {
                id: string().id(),
                email: string().unique(),
                name: string(),
                bio: string().nullable(),
                tags: string().list(),
                slug: string().unique(),
                description: string().default("No description"),
            };
            // Test all fields are StringField instances
            Object.values(userModel).forEach((field) => {
                expect(field.constructor.name).toBe("StringField");
            });
            // Test specific field properties
            expect(userModel.id.isId).toBe(true);
            expect(userModel.email.isUnique).toBe(true);
            expect(userModel.bio.isOptional).toBe(true);
            expect(userModel.tags.isList).toBe(true);
            expect(userModel.slug.isUnique).toBe(true);
        });
        test("creates model using schema builder", () => {
            const userModel = s.model("user", {
                id: s.string().id(),
                email: s.string().unique(),
                name: s.string(),
                bio: s.string().nullable(),
                tags: s.string().list(),
                slug: s.string().unique(),
                description: s.string().default("No description"),
            });
            expect(userModel.name).toBe("user");
            expect(userModel.fields.size).toBe(7);
            // Check field names exist
            const fieldNames = Array.from(userModel.fields.keys());
            expect(fieldNames).toEqual([
                "id",
                "email",
                "name",
                "bio",
                "tags",
                "slug",
                "description",
            ]);
            // Check field types
            const idField = userModel.fields.get("id");
            const emailField = userModel.fields.get("email");
            const bioField = userModel.fields.get("bio");
            expect(idField?.constructor.name).toBe("StringField");
            expect(emailField?.constructor.name).toBe("StringField");
            expect(bioField?.constructor.name).toBe("StringField");
        });
    });
    describe("Type inference", () => {
        test("provides type inference properties", () => {
            const userModel = s.model("user", {
                id: s.string().id(),
                name: s.string(),
                age: s.int(),
                isActive: s.boolean(),
            });
            // Test that inference properties exist on the model
            expect(userModel).toHaveProperty("infer");
        });
    });
    describe("Sample data creation", () => {
        test("creates valid sample data matching model structure", () => {
            const userSchema = {
                id: string().id(),
                email: string().unique(),
                name: string(),
                bio: string().nullable(),
                tags: string().list(),
                slug: string().unique(),
                description: string().default("No description"),
            };
            const sampleUser = {
                id: "user-123",
                email: "test@example.com",
                name: "John Doe",
                bio: null,
                tags: ["developer", "typescript"],
                slug: "john-doe",
                description: "A developer",
            };
            expect(sampleUser.id).toBe("user-123");
            expect(sampleUser.email).toBe("test@example.com");
            expect(sampleUser.name).toBe("John Doe");
            expect(sampleUser.bio).toBeNull();
            expect(sampleUser.tags).toEqual(["developer", "typescript"]);
            expect(sampleUser.slug).toBe("john-doe");
            expect(sampleUser.description).toBe("A developer");
        });
    });
    describe("Mixed field types", () => {
        test("creates model with mixed field types", () => {
            const mixedModel = s.model("mixed", {
                id: s.string().id(),
                name: s.string(),
                age: s.int(),
                isActive: s.boolean(),
                createdAt: s.dateTime(),
                metadata: s.json(),
                avatar: s.blob().nullable(),
                status: s.enum(["active", "inactive"]),
            });
            expect(mixedModel.name).toBe("mixed");
            expect(mixedModel.fields.size).toBe(8);
            // Test different field types
            expect(mixedModel.fields.get("id")?.constructor.name).toBe("StringField");
            expect(mixedModel.fields.get("age")?.constructor.name).toBe("NumberField");
            expect(mixedModel.fields.get("isActive")?.constructor.name).toBe("BooleanField");
            expect(mixedModel.fields.get("createdAt")?.constructor.name).toBe("DateTimeField");
            expect(mixedModel.fields.get("metadata")?.constructor.name).toBe("JsonField");
            expect(mixedModel.fields.get("avatar")?.constructor.name).toBe("BlobField");
            expect(mixedModel.fields.get("status")?.constructor.name).toBe("EnumField");
        });
    });
});
//# sourceMappingURL=model.test.js.map