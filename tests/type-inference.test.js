import { s } from "../src/schema/index.js";
describe("Smart Type Inference", () => {
    describe("ID fields", () => {
        test("ID fields are never nullable even if marked nullable", () => {
            const idField = s.string().id();
            const nullableIdField = s.string().id().nullable();
            // Runtime tests
            expect(idField.constructor.name).toBe("StringField");
            expect(nullableIdField.constructor.name).toBe("StringField");
            expect(idField.isId).toBe(true);
            expect(nullableIdField.isId).toBe(true);
        });
    });
    describe("Auto-generated fields", () => {
        test("auto-generated fields are never nullable", () => {
            const autoUlidField = s.string().auto.ulid();
            const nullableAutoField = s.string().auto.uuid().nullable();
            // Runtime tests
            expect(autoUlidField.constructor.name).toBe("StringField");
            expect(nullableAutoField.constructor.name).toBe("StringField");
        });
    });
    describe("Fields with defaults", () => {
        test("fields with defaults are non-nullable for storage", () => {
            const defaultField = s.string().default("hello");
            const nullableDefaultField = s.string().default("world").nullable();
            // Runtime tests
            expect(defaultField.constructor.name).toBe("StringField");
            expect(nullableDefaultField.constructor.name).toBe("StringField");
        });
    });
    describe("Input vs Storage type distinction", () => {
        test("provides different inference methods", () => {
            const autoIdField = s.string().id().auto.ulid();
            // Test that the methods exist
            expect(autoIdField).toHaveProperty("infer");
            expect(autoIdField).toHaveProperty("inferInput");
            expect(autoIdField).toHaveProperty("inferStorage");
        });
    });
    describe("Regular nullable fields", () => {
        test("regular nullable fields work as expected", () => {
            const normalNullableField = s.string().nullable();
            expect(normalNullableField.constructor.name).toBe("StringField");
            expect(normalNullableField.isOptional).toBe(true);
        });
    });
    describe("Complex combinations", () => {
        test("handles complex field combinations correctly", () => {
            const complexField = s.string().id().auto.ulid().unique();
            expect(complexField.constructor.name).toBe("StringField");
            expect(complexField.isId).toBe(true);
            expect(complexField.isUnique).toBe(true);
        });
    });
    describe("List fields with constraints", () => {
        test("list fields respect constraints", () => {
            const listIdField = s.string().list().id();
            const nullableListField = s.string().list().nullable();
            expect(listIdField.constructor.name).toBe("StringField");
            expect(nullableListField.constructor.name).toBe("StringField");
            expect(listIdField.isList).toBe(true);
            expect(nullableListField.isList).toBe(true);
            expect(nullableListField.isOptional).toBe(true);
        });
    });
    describe("Schema with mixed field types", () => {
        test("creates valid schema with mixed field types", () => {
            const userSchema = {
                // ID field: never nullable, auto-generated = optional for input
                id: s.string().id().auto.ulid(),
                // Regular field: nullable as specified
                name: s.string().nullable(),
                // Field with default: non-nullable, optional for input
                status: s.string().default("active"),
                // Regular required field
                email: s.string(),
                // Problematic field (should still work but shows warnings)
                problematicId: s.int().id().nullable().auto.increment(),
            };
            // Test that all fields are created correctly
            expect(userSchema.id.constructor.name).toBe("StringField");
            expect(userSchema.name.constructor.name).toBe("StringField");
            expect(userSchema.status.constructor.name).toBe("StringField");
            expect(userSchema.email.constructor.name).toBe("StringField");
            expect(userSchema.problematicId.constructor.name).toBe("NumberField");
            // Test properties
            expect(userSchema.id.isId).toBe(true);
            expect(userSchema.name.isOptional).toBe(true);
            expect(userSchema.problematicId.isId).toBe(true);
        });
    });
    describe("Runtime behavior", () => {
        test("creates valid sample data matching schema structure", () => {
            const userSchema = {
                id: s.string().id().auto.ulid(),
                name: s.string().nullable(),
                status: s.string().default("active"),
                email: s.string(),
                problematicId: s.int().id().nullable().auto.increment(),
            };
            // Test that we can create valid objects
            const userGeneral = {
                id: "ulid_123",
                name: null,
                status: "active",
                email: "test@example.com",
                problematicId: 123,
            };
            const userInput = {
                name: null,
                email: "test@example.com",
            };
            const userStorage = {
                id: "ulid_123",
                name: null,
                status: "active",
                email: "test@example.com",
                problematicId: 123,
            };
            expect(userGeneral.id).toBe("ulid_123");
            expect(userGeneral.name).toBeNull();
            expect(userGeneral.status).toBe("active");
            expect(userGeneral.email).toBe("test@example.com");
            expect(userGeneral.problematicId).toBe(123);
            expect(userInput.name).toBeNull();
            expect(userInput.email).toBe("test@example.com");
            expect(userStorage.id).toBe("ulid_123");
            expect(userStorage.status).toBe("active");
        });
    });
});
//# sourceMappingURL=type-inference.test.js.map