import { string } from "../src/schema/fields/string.js";
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
            const listField = string().list();
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
            const listField = string().list();
            const uniqueField = string().unique();
            expect(idField.isId).toBe(true);
            expect(nullableField.isOptional).toBe(true);
            expect(listField.isList).toBe(true);
            expect(uniqueField.isUnique).toBe(true);
        });
    });
    describe("validation", () => {
        const emailValidator = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || "Invalid email format";
        const minLengthValidator = (min) => (value) => value.length >= min || `Must be at least ${min} characters`;
        const maxLengthValidator = (max) => (value) => value.length <= max || `Must be at most ${max} characters`;
        test("applies validators correctly", () => {
            const emailField = string().unique().validator(emailValidator);
            const lengthField = string().validator(minLengthValidator(5), maxLengthValidator(100));
            expect(emailField.constructor.name).toBe("StringField");
            expect(lengthField.constructor.name).toBe("StringField");
        });
        test("validates email correctly", async () => {
            const emailField = string().validator(emailValidator);
            const validResult = await emailField.validate("test@example.com");
            const invalidResult = await emailField.validate("invalid-email");
            expect(validResult.valid).toBe(true);
            expect(invalidResult.valid).toBe(false);
        });
        test("validates length correctly", async () => {
            const lengthField = string().validator(minLengthValidator(5));
            const validResult = await lengthField.validate("hello");
            const invalidResult = await lengthField.validate("hi");
            expect(validResult.valid).toBe(true);
            expect(invalidResult.valid).toBe(false);
        });
        test("validates complex field with multiple validators", async () => {
            const complexField = string()
                .id()
                .unique()
                .validator(minLengthValidator(3));
            const validResult = await complexField.validate("test");
            const invalidResult = await complexField.validate("ab");
            expect(complexField.constructor.name).toBe("StringField");
            expect(validResult.valid).toBe(true);
            expect(invalidResult.valid).toBe(false);
        });
    });
    describe("type inference", () => {
        test("infers correct types", () => {
            const idField = string().id();
            const nullableField = string().nullable();
            const listField = string().list();
            // Type tests
            expectTypeOf(idField.infer).toEqualTypeOf();
            expectTypeOf(nullableField.infer).toEqualTypeOf();
            expectTypeOf(listField.infer).toEqualTypeOf();
        });
    });
    describe("schema creation", () => {
        test("creates schema with various string fields", () => {
            const emailValidator = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || "Invalid email format";
            const minLengthValidator = (min) => (value) => value.length >= min || `Must be at least ${min} characters`;
            const maxLengthValidator = (max) => (value) => value.length <= max || `Must be at most ${max} characters`;
            const testSchema = {
                id: string().id(),
                email: string().unique().validator(emailValidator),
                name: string().validator(minLengthValidator(2), maxLengthValidator(50)),
                bio: string().nullable(),
                tags: string().list(),
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
//# sourceMappingURL=string-field.test.js.map