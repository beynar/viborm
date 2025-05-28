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
        status: s.enum(["active", "inactive"] as const),
      });

      type UserType = typeof userModel.infer;

      // Test that we can create objects with correct types
      const user: UserType = {
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
      expectTypeOf<UserType["id"]>().toMatchTypeOf<string>();
      expectTypeOf<UserType["name"]>().toMatchTypeOf<string>();
      expectTypeOf<UserType["age"]>().toMatchTypeOf<number>();
      expectTypeOf<UserType["isActive"]>().toMatchTypeOf<boolean>();
      expectTypeOf<UserType["balance"]>().toMatchTypeOf<number>();
      expectTypeOf<UserType["bigScore"]>().toMatchTypeOf<bigint>();
      expectTypeOf<UserType["createdAt"]>().toMatchTypeOf<Date>();
      expectTypeOf<UserType["avatar"]>().toMatchTypeOf<Uint8Array>();
      expectTypeOf<UserType["metadata"]>().toMatchTypeOf<any>();
      expectTypeOf<UserType["status"]>().toMatchTypeOf<"active" | "inactive">();
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
        category: s.enum(["tech", "lifestyle"] as const).nullable(),
      });

      type PostType = typeof postModel.infer;

      // Test that nullable fields accept null
      const post: PostType = {
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
      expectTypeOf<PostType["content"]>().toMatchTypeOf<string | null>();
      expectTypeOf<PostType["viewCount"]>().toMatchTypeOf<number | null>();
      expectTypeOf<PostType["isPublished"]>().toMatchTypeOf<boolean | null>();
      expectTypeOf<PostType["publishedAt"]>().toMatchTypeOf<Date | null>();
      expectTypeOf<PostType["thumbnail"]>().toMatchTypeOf<Uint8Array | null>();
      expectTypeOf<PostType["settings"]>().toMatchTypeOf<any | null>();
      expectTypeOf<PostType["category"]>().toMatchTypeOf<
        "tech" | "lifestyle" | null
      >();
    });

    test("model with list fields", () => {
      const blogModel = s.model("blog", {
        id: s.string().id(),
        title: s.string(),
        tags: s.string().array(),
        ratings: s.int().array(),
        flags: s.boolean().array(),
        scores: s.decimal().array(),
        bigNumbers: s.bigInt().array(),
        timestamps: s.dateTime().array(),
        images: s.blob().array(),
        metadata: s.json(),
        categories: s.enum(["A", "B", "C"] as const).array(),
      });

      type BlogType = typeof blogModel.infer;

      const blog: BlogType = {
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
      expectTypeOf<BlogType["tags"]>().toMatchTypeOf<string[]>();
      expectTypeOf<BlogType["ratings"]>().toMatchTypeOf<number[]>();
      expectTypeOf<BlogType["flags"]>().toMatchTypeOf<boolean[]>();
      expectTypeOf<BlogType["scores"]>().toMatchTypeOf<number[]>();
      expectTypeOf<BlogType["bigNumbers"]>().toMatchTypeOf<bigint[]>();
      expectTypeOf<BlogType["timestamps"]>().toMatchTypeOf<Date[]>();
      expectTypeOf<BlogType["images"]>().toMatchTypeOf<Uint8Array[]>();
      expectTypeOf<BlogType["metadata"]>().toMatchTypeOf<any[]>();
      expectTypeOf<BlogType["categories"]>().toMatchTypeOf<
        ("A" | "B" | "C")[]
      >();
    });

    test("model with list nullable combinations", () => {
      const complexModel = s.model("complex", {
        id: s.string().id(),
        optionalTags: s.string().array().nullable(), // string[] | null
        nullableItems: s.int().nullable().array(), // number[] | null (nullable applies to final result)
        complexList: s.string().nullable().array().nullable(), // string[] | null (nullable applies to final result)
      });

      type ComplexType = typeof complexModel.infer;

      const data1: ComplexType = {
        id: "test",
        optionalTags: null,
        nullableItems: null,
        complexList: null,
      };

      const data2: ComplexType = {
        id: "test",
        optionalTags: ["tag1", "tag2"],
        nullableItems: [1, 2, 3],
        complexList: ["item1", "item3"],
      };

      expect(data1.optionalTags).toBeNull();
      expect(data2.optionalTags).toEqual(["tag1", "tag2"]);

      // Test complex list types - all nullable lists are string[] | null
      expectTypeOf<ComplexType["optionalTags"]>().toMatchTypeOf<
        string[] | null
      >();
      expectTypeOf<ComplexType["nullableItems"]>().toMatchTypeOf<
        number[] | null
      >();
      expectTypeOf<ComplexType["complexList"]>().toMatchTypeOf<
        string[] | null
      >();
    });
  });

  describe("Auto fields and smart inference", () => {
    test("auto generated fields", () => {
      const model = s.model("autoTest", {
        id: s.string().id().ulid(),
        uuid: s.string().uuid(),
        counter: s.int().increment(),
        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),
        title: s.string(),
      });

      type ModelType = typeof model.infer;

      // Test that we can create objects (auto fields should be inferred as their base types)
      const data: ModelType = {
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
      expectTypeOf<ModelType["id"]>().toMatchTypeOf<string>();
      expectTypeOf<ModelType["uuid"]>().toMatchTypeOf<string>();
      expectTypeOf<ModelType["counter"]>().toMatchTypeOf<number>();
      expectTypeOf<ModelType["createdAt"]>().toMatchTypeOf<Date>();
      expectTypeOf<ModelType["updatedAt"]>().toMatchTypeOf<Date>();
    });

    test("default fields", () => {
      const model = s.model("defaultTest", {
        id: s.string().id(),
        title: s.string().default("Untitled"),
        isActive: s.boolean().default(true),
        count: s.int().default(0),
        price: s.decimal().default(9.99),
        role: s.enum(["user", "admin"] as const).default("user"),
        tags: s.string().array().default(["default"]),
      });

      type ModelType = typeof model.infer;

      const data: ModelType = {
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
      expectTypeOf<ModelType["title"]>().toMatchTypeOf<string>();
      expectTypeOf<ModelType["isActive"]>().toMatchTypeOf<boolean>();
      expectTypeOf<ModelType["count"]>().toMatchTypeOf<number>();
      expectTypeOf<ModelType["price"]>().toMatchTypeOf<number>();
      expectTypeOf<ModelType["role"]>().toMatchTypeOf<"user" | "admin">();
      expectTypeOf<ModelType["tags"]>().toMatchTypeOf<string[]>();
    });

    test("unique fields", () => {
      const model = s.model("uniqueTest", {
        id: s.string().id(),
        email: s.string().unique(),
        username: s.string().unique(),
        slug: s.string().unique().nullable(),
      });

      type ModelType = typeof model.infer;

      const data: ModelType = {
        id: "test",
        email: "test@example.com",
        username: "testuser",
        slug: null,
      };

      expect(data.email).toBe("test@example.com");

      // Test unique field types
      expectTypeOf<ModelType["email"]>().toMatchTypeOf<string>();
      expectTypeOf<ModelType["username"]>().toMatchTypeOf<string>();
      expectTypeOf<ModelType["slug"]>().toMatchTypeOf<string | null>();
    });
  });

  describe("Real-world model examples", () => {
    test("complete user model", () => {
      const userModel = s.model("user", {
        // ID and auto fields
        id: s.string().id().ulid(),
        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),

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
        role: s.enum(["user", "admin", "moderator"] as const).default("user"),
        preferences: s.json().default({}),

        // Lists
        tags: s.string().array(),
        permissions: s.string().array().nullable(),

        // Computed/tracked fields
        loginCount: s.int().default(0),
        lastLoginAt: s.dateTime().nullable(),
      });

      type UserModelType = typeof userModel.infer;

      const user: UserModelType = {
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
      expectTypeOf<UserModelType["id"]>().toMatchTypeOf<string>();
      expectTypeOf<UserModelType["email"]>().toMatchTypeOf<string>();
      expectTypeOf<UserModelType["bio"]>().toMatchTypeOf<string | null>();
      expectTypeOf<UserModelType["isActive"]>().toMatchTypeOf<boolean>();
      expectTypeOf<UserModelType["role"]>().toMatchTypeOf<
        "user" | "admin" | "moderator"
      >();
      expectTypeOf<UserModelType["tags"]>().toMatchTypeOf<string[]>();
      expectTypeOf<UserModelType["permissions"]>().toMatchTypeOf<
        string[] | null
      >();
    });

    test("blog post model", () => {
      const postModel = s.model("post", {
        id: s.string().id().ulid(),
        slug: s.string().unique(),
        title: s.string(),
        content: s.string(),
        excerpt: s.string().nullable(),
        coverImage: s.blob().nullable(),

        status: s
          .enum(["draft", "published", "archived"] as const)
          .default("draft"),
        tags: s.string().array(),
        categories: s.enum(["tech", "lifestyle", "business"] as const).array(),

        viewCount: s.int().default(0),
        likeCount: s.int().default(0),

        publishedAt: s.dateTime().nullable(),
        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),

        metadata: s.json().nullable(),
      });

      type PostModelType = typeof postModel.infer;

      const post: PostModelType = {
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
      expectTypeOf<PostModelType["status"]>().toMatchTypeOf<
        "draft" | "published" | "archived"
      >();
      expectTypeOf<PostModelType["tags"]>().toMatchTypeOf<string[]>();
      expectTypeOf<PostModelType["categories"]>().toMatchTypeOf<
        ("tech" | "lifestyle" | "business")[]
      >();
      expectTypeOf<PostModelType["excerpt"]>().toMatchTypeOf<string | null>();
    });

    test("e-commerce product model", () => {
      const productModel = s.model("product", {
        id: s.string().id().ulid(),
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

        category: s.enum(["electronics", "clothing", "books", "home"] as const),
        tags: s.string().array(),
        images: s.blob().array(),

        specifications: s.json().nullable(),
        variants: s.json(),

        createdAt: s.dateTime().now(),
        updatedAt: s.dateTime().updatedAt(),
      });

      type ProductModelType = typeof productModel.infer;

      const product: ProductModelType = {
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
      expectTypeOf<ProductModelType["price"]>().toMatchTypeOf<number>();
      expectTypeOf<ProductModelType["category"]>().toMatchTypeOf<
        "electronics" | "clothing" | "books" | "home"
      >();
      expectTypeOf<ProductModelType["tags"]>().toMatchTypeOf<string[]>();
      expectTypeOf<ProductModelType["images"]>().toMatchTypeOf<Uint8Array[]>();
      expectTypeOf<ProductModelType["variants"]>().toMatchTypeOf<any[]>();
    });
  });

  describe("Edge cases and complex scenarios", () => {
    test("empty model", () => {
      const emptyModel = s.model("empty", {});
      type EmptyType = typeof emptyModel.infer;

      const empty: EmptyType = {};
      expect(empty).toEqual({});

      expectTypeOf<EmptyType>().toMatchTypeOf<{}>();
    });

    test("single field model", () => {
      const singleModel = s.model("single", { value: s.string() });
      type SingleType = typeof singleModel.infer;

      const single: SingleType = { value: "test" };
      expect(single.value).toBe("test");

      expectTypeOf<SingleType>().toMatchTypeOf<{ value: string }>();
    });

    test("all field modifiers combined", () => {
      const complexModel = s.model("complex", {
        // Various ID field combinations
        primaryId: s.string().id(),
        secondaryId: s.bigInt().id().nullable(),

        // Auto field combinations
        autoValue: s.string().uuid(),
        autoWithDefault: s.string().uuid().default("fallback"),
        autoNullable: s.string().uuid().nullable(),

        // Default combinations
        defaultString: s.string().default("test"),
        defaultWithNullable: s.string().default("test").nullable(),
        defaultList: s.string().array(),

        // Unique combinations
        uniqueField: s.string().unique(),
        uniqueNullable: s.string().unique().nullable(),

        // Complex list combinations
        basicList: s.string().array(),
        nullableList: s.string().array().nullable(),
        listOfNullables: s.string().nullable().array(),
        complexListType: s
          .enum(["A", "B"] as const)
          .nullable()
          .array()
          .nullable(),

        // JSON variations
        basicJson: s.json(),
        nullableJson: s.json().nullable(),
        jsonList: s.json(),
        jsonWithDefault: s.json().default({ key: "value" }),
      });

      type ComplexType = typeof complexModel.infer;

      // Test that the model can be instantiated
      const complex: ComplexType = {
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
      expectTypeOf<ComplexType["primaryId"]>().toMatchTypeOf<string>();
      expectTypeOf<ComplexType["basicList"]>().toMatchTypeOf<string[]>();
      expectTypeOf<ComplexType["nullableList"]>().toMatchTypeOf<
        string[] | null
      >();
      expectTypeOf<ComplexType["listOfNullables"]>().toMatchTypeOf<
        string[] | null
      >();
      expectTypeOf<ComplexType["complexListType"]>().toMatchTypeOf<
        ("A" | "B" | null)[] | null
      >();
    });
  });
});
