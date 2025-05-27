import { s } from "../src/schema/index.js";
describe("Comprehensive Model Type Inference", () => {
    describe("Basic field type inference", () => {
        test("simple model with basic field types", () => {
            const userModel = s.model("user", {
                id: s.string().id(),
                name: s.string(),
                age: s.int(),
                isActive: s.boolean(),
                balance: s.decimal(),
                bigScore: s.bigInt(),
                createdAt: s.dateTime(),
                avatar: s.blob(),
                metadata: s.json(),
                status: s.enum(["active", "inactive"]),
            });
            // Test that we can create objects with correct types
            const user = {
                id: "user-123",
                name: "John Doe",
                age: 30,
                isActive: true,
                balance: 99.99,
                bigScore: 123456789n,
                createdAt: new Date(),
                avatar: new Uint8Array([1, 2, 3]),
                metadata: { role: "admin" },
                status: "active",
            };
            expect(user.id).toBe("user-123");
            expect(user.name).toBe("John Doe");
            expect(user.age).toBe(30);
            expect(user.isActive).toBe(true);
            expect(user.balance).toBe(99.99);
            expect(user.bigScore).toBe(123456789n);
            expect(user.createdAt).toBeInstanceOf(Date);
            expect(user.avatar).toBeInstanceOf(Uint8Array);
            expect(user.metadata).toEqual({ role: "admin" });
            expect(user.status).toBe("active");
            // Test individual field types
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
        test("model with nullable fields", () => {
            const postModel = s.model("post", {
                id: s.string().id(),
                title: s.string(),
                content: s.string().nullable(),
                excerpt: s.string().nullable(),
                viewCount: s.int().nullable(),
                isPublished: s.boolean().nullable(),
                publishedAt: s.dateTime().nullable(),
                thumbnail: s.blob().nullable(),
                settings: s.json().nullable(),
                category: s.enum(["tech", "lifestyle"]).nullable(),
            });
            // Test that nullable fields accept null
            const post = {
                id: "post-123",
                title: "Test Post",
                content: null,
                excerpt: "Short description",
                viewCount: null,
                isPublished: true,
                publishedAt: null,
                thumbnail: null,
                settings: null,
                category: null,
            };
            expect(post.id).toBe("post-123");
            expect(post.title).toBe("Test Post");
            expect(post.content).toBeNull();
            expect(post.excerpt).toBe("Short description");
            // Test field types with nullable
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
        test("model with list fields", () => {
            const blogModel = s.model("blog", {
                id: s.string().id(),
                title: s.string(),
                tags: s.string().list(),
                ratings: s.int().list(),
                flags: s.boolean().list(),
                scores: s.decimal().list(),
                bigNumbers: s.bigInt().list(),
                timestamps: s.dateTime().list(),
                images: s.blob().list(),
                metadata: s.json().list(),
                categories: s.enum(["A", "B", "C"]).list(),
            });
            const blog = {
                id: "blog-123",
                title: "My Blog",
                tags: ["javascript", "typescript"],
                ratings: [5, 4, 3],
                flags: [true, false, true],
                scores: [9.5, 8.7, 9.2],
                bigNumbers: [123n, 456n],
                timestamps: [new Date(), new Date()],
                images: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
                metadata: [{ type: "header" }, { type: "footer" }],
                categories: ["A", "B"],
            };
            expect(blog.tags).toEqual(["javascript", "typescript"]);
            expect(blog.ratings).toEqual([5, 4, 3]);
            // Test list field types
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
        test("model with list nullable combinations", () => {
            const complexModel = s.model("complex", {
                id: s.string().id(),
                optionalTags: s.string().list().nullable(), // string[] | null
                nullableItems: s.int().nullable().list(), // number[] | null (nullable applies to final result)
                complexList: s.string().nullable().list().nullable(), // string[] | null (nullable applies to final result)
            });
            const data1 = {
                id: "test",
                optionalTags: null,
                nullableItems: null,
                complexList: null,
            };
            const data2 = {
                id: "test",
                optionalTags: ["tag1", "tag2"],
                nullableItems: [1, 2, 3],
                complexList: ["item1", "item3"],
            };
            expect(data1.optionalTags).toBeNull();
            expect(data2.optionalTags).toEqual(["tag1", "tag2"]);
            // Test complex list types - all nullable lists are string[] | null
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
    });
    describe("Auto fields and smart inference", () => {
        test("auto generated fields", () => {
            const model = s.model("autoTest", {
                id: s.string().id().auto.ulid(),
                uuid: s.string().auto.uuid(),
                counter: s.int().auto.increment(),
                createdAt: s.dateTime().auto.now(),
                updatedAt: s.dateTime().auto.updatedAt(),
                title: s.string(),
            });
            // Test that we can create objects (auto fields should be inferred as their base types)
            const data = {
                id: "01H123456789ABCDEF123456",
                uuid: "123e4567-e89b-12d3-a456-426614174000",
                counter: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
                title: "Test",
            };
            expect(data.id).toBeTruthy();
            expect(data.uuid).toBeTruthy();
            // Test auto field types
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
        test("default fields", () => {
            const model = s.model("defaultTest", {
                id: s.string().id(),
                title: s.string().default("Untitled"),
                isActive: s.boolean().default(true),
                count: s.int().default(0),
                price: s.decimal().default(9.99),
                role: s.enum(["user", "admin"]).default("user"),
                tags: s.string().list().default(["default"]),
            });
            const data = {
                id: "test",
                title: "Custom Title",
                isActive: false,
                count: 5,
                price: 19.99,
                role: "admin",
                tags: ["custom", "tags"],
            };
            expect(data.title).toBe("Custom Title");
            expect(data.isActive).toBe(false);
            // Test default field types (should be non-nullable)
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
        test("unique fields", () => {
            const model = s.model("uniqueTest", {
                id: s.string().id(),
                email: s.string().unique(),
                username: s.string().unique(),
                slug: s.string().unique().nullable(),
            });
            const data = {
                id: "test",
                email: "test@example.com",
                username: "testuser",
                slug: null,
            };
            expect(data.email).toBe("test@example.com");
            // Test unique field types
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
    });
    describe("Real-world model examples", () => {
        test("complete user model", () => {
            const userModel = s.model("user", {
                // ID and auto fields
                id: s.string().id().auto.ulid(),
                createdAt: s.dateTime().auto.now(),
                updatedAt: s.dateTime().auto.updatedAt(),
                // Required fields
                email: s.string().unique(),
                username: s.string().unique(),
                firstName: s.string(),
                lastName: s.string(),
                // Optional fields
                bio: s.string().nullable(),
                avatar: s.blob().nullable(),
                birthDate: s.dateTime().nullable(),
                // Fields with defaults
                isActive: s.boolean().default(true),
                role: s.enum(["user", "admin", "moderator"]).default("user"),
                preferences: s.json().default({}),
                // Lists
                tags: s.string().list(),
                permissions: s.string().list().nullable(),
                // Computed/tracked fields
                loginCount: s.int().default(0),
                lastLoginAt: s.dateTime().nullable(),
            });
            const user = {
                id: "01H123456789ABCDEF123456",
                createdAt: new Date(),
                updatedAt: new Date(),
                email: "john@example.com",
                username: "johndoe",
                firstName: "John",
                lastName: "Doe",
                bio: null,
                avatar: null,
                birthDate: null,
                isActive: true,
                role: "user",
                preferences: { theme: "dark" },
                tags: ["developer", "typescript"],
                permissions: null,
                loginCount: 5,
                lastLoginAt: new Date(),
            };
            expect(user.email).toBe("john@example.com");
            expect(user.isActive).toBe(true);
            // Test key field types
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
        test("blog post model", () => {
            const postModel = s.model("post", {
                id: s.string().id().auto.ulid(),
                slug: s.string().unique(),
                title: s.string(),
                content: s.string(),
                excerpt: s.string().nullable(),
                coverImage: s.blob().nullable(),
                status: s
                    .enum(["draft", "published", "archived"])
                    .default("draft"),
                tags: s.string().list(),
                categories: s.enum(["tech", "lifestyle", "business"]).list(),
                viewCount: s.int().default(0),
                likeCount: s.int().default(0),
                publishedAt: s.dateTime().nullable(),
                createdAt: s.dateTime().auto.now(),
                updatedAt: s.dateTime().auto.updatedAt(),
                metadata: s.json().nullable(),
            });
            const post = {
                id: "01H123456789ABCDEF123456",
                slug: "my-first-post",
                title: "My First Post",
                content: "This is the content...",
                excerpt: null,
                coverImage: null,
                status: "published",
                tags: ["javascript", "tutorial"],
                categories: ["tech"],
                viewCount: 100,
                likeCount: 5,
                publishedAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                metadata: null,
            };
            expect(post.title).toBe("My First Post");
            expect(post.status).toBe("published");
            // Test field types
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
        test("e-commerce product model", () => {
            const productModel = s.model("product", {
                id: s.string().id().auto.ulid(),
                sku: s.string().unique(),
                name: s.string(),
                description: s.string().nullable(),
                price: s.decimal(),
                comparePrice: s.decimal().nullable(),
                cost: s.decimal().nullable(),
                inventory: s.int().default(0),
                weight: s.decimal().nullable(),
                isActive: s.boolean().default(true),
                isDigital: s.boolean().default(false),
                category: s.enum(["electronics", "clothing", "books", "home"]),
                tags: s.string().list(),
                images: s.blob().list(),
                specifications: s.json().nullable(),
                variants: s.json().list(),
                createdAt: s.dateTime().auto.now(),
                updatedAt: s.dateTime().auto.updatedAt(),
            });
            const product = {
                id: "01H123456789ABCDEF123456",
                sku: "PROD-001",
                name: "Wireless Headphones",
                description: "High-quality wireless headphones",
                price: 99.99,
                comparePrice: null,
                cost: 50.0,
                inventory: 25,
                weight: 0.5,
                isActive: true,
                isDigital: false,
                category: "electronics",
                tags: ["wireless", "audio", "bluetooth"],
                images: [new Uint8Array([1, 2, 3])],
                specifications: { battery: "20 hours", range: "30 meters" },
                variants: [{ color: "black", size: "M" }],
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            expect(product.name).toBe("Wireless Headphones");
            expect(product.price).toBe(99.99);
            // Test field types
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
    });
    describe("Edge cases and complex scenarios", () => {
        test("empty model", () => {
            const emptyModel = s.model("empty", {});
            const empty = {};
            expect(empty).toEqual({});
            expectTypeOf().toMatchTypeOf();
        });
        test("single field model", () => {
            const singleModel = s.model("single", { value: s.string() });
            const single = { value: "test" };
            expect(single.value).toBe("test");
            expectTypeOf().toMatchTypeOf();
        });
        test("all field modifiers combined", () => {
            const complexModel = s.model("complex", {
                // Various ID field combinations
                primaryId: s.string().id(),
                secondaryId: s.bigInt().id().nullable(),
                // Auto field combinations
                autoValue: s.string().auto.uuid(),
                autoWithDefault: s.string().auto.uuid().default("fallback"),
                autoNullable: s.string().auto.uuid().nullable(),
                // Default combinations
                defaultString: s.string().default("test"),
                defaultWithNullable: s.string().default("test").nullable(),
                defaultList: s.string().list(),
                // Unique combinations
                uniqueField: s.string().unique(),
                uniqueNullable: s.string().unique().nullable(),
                // Complex list combinations
                basicList: s.string().list(),
                nullableList: s.string().list().nullable(),
                listOfNullables: s.string().nullable().list(),
                complexListType: s
                    .enum(["A", "B"])
                    .nullable()
                    .list()
                    .nullable(),
                // JSON variations
                basicJson: s.json(),
                nullableJson: s.json().nullable(),
                jsonList: s.json().list(),
                jsonWithDefault: s.json().default({ key: "value" }),
            });
            // Test that the model can be instantiated
            const complex = {
                primaryId: "id1",
                secondaryId: 123n,
                autoValue: "uuid-123",
                autoWithDefault: "uuid-456",
                autoNullable: "uuid-789",
                defaultString: "custom",
                defaultWithNullable: "custom2",
                defaultList: ["custom"],
                uniqueField: "unique1",
                uniqueNullable: null,
                basicList: ["item1"],
                nullableList: null,
                listOfNullables: ["item", "item2"],
                complexListType: null,
                basicJson: { data: "value" },
                nullableJson: null,
                jsonList: [{ item: 1 }],
                jsonWithDefault: { custom: "data" },
            };
            expect(complex.primaryId).toBe("id1");
            // Test some key type inferences
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
            expectTypeOf().toMatchTypeOf();
        });
    });
});
//# sourceMappingURL=comprehensive-model-type-inference.test.js.map