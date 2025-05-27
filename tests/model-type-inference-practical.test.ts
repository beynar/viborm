import { s } from "../src/schema/index.js";

describe("Model Type Inference - Practical Tests", () => {
  describe("Basic model types", () => {
    test("simple model type structure", () => {
      const userModel = s.model("user", {
        id: s.string().id(),
        name: s.string(),
        age: s.int(),
        isActive: s.boolean(),
      });

      type UserType = typeof userModel.infer;

      // Test that we can create objects matching the inferred type
      const user: UserType = {
        id: "user-123",
        name: "John Doe",
        age: 30,
        isActive: true,
      };

      expect(user.id).toBe("user-123");
      expect(user.name).toBe("John Doe");
      expect(user.age).toBe(30);
      expect(user.isActive).toBe(true);

      // Test individual field types
      expectTypeOf<UserType["id"]>().toEqualTypeOf<string>();
      expectTypeOf<UserType["name"]>().toEqualTypeOf<string>();
      expectTypeOf<UserType["age"]>().toEqualTypeOf<number>();
      expectTypeOf<UserType["isActive"]>().toEqualTypeOf<boolean>();
    });

    test("model with nullable fields", () => {
      const profileModel = s.model("profile", {
        id: s.string().id(),
        bio: s.string().nullable(),
        avatar: s.string().nullable(),
      });

      type ProfileType = typeof profileModel.infer;

      const profile: ProfileType = {
        id: "profile-123",
        bio: null,
        avatar: "avatar.jpg",
      };

      expect(profile.id).toBe("profile-123");
      expect(profile.bio).toBeNull();
      expect(profile.avatar).toBe("avatar.jpg");

      // Test field types
      expectTypeOf<ProfileType["id"]>().toEqualTypeOf<string>();
      expectTypeOf<ProfileType["bio"]>().toEqualTypeOf<string | null>();
      expectTypeOf<ProfileType["avatar"]>().toEqualTypeOf<string | null>();
    });

    test("model with array fields", () => {
      const postModel = s.model("post", {
        id: s.string().id(),
        title: s.string(),
        tags: s.string().list(),
        scores: s.int().list(),
      });

      type PostType = typeof postModel.infer;

      const post: PostType = {
        id: "post-123",
        title: "My Post",
        tags: ["typescript", "testing"],
        scores: [95, 87, 92],
      };

      expect(post.tags).toEqual(["typescript", "testing"]);
      expect(post.scores).toEqual([95, 87, 92]);

      // Test array field types
      expectTypeOf<PostType["tags"]>().toEqualTypeOf<string[]>();
      expectTypeOf<PostType["scores"]>().toEqualTypeOf<number[]>();
    });
  });

  describe("All field types", () => {
    test("comprehensive model with all basic field types", () => {
      const model = s.model("comprehensive", {
        // String fields
        id: s.string().id(),
        name: s.string(),
        bio: s.string().nullable(),
        tags: s.string().list(),

        // Number fields
        age: s.int(),
        score: s.float(),
        balance: s.decimal(),

        // Boolean fields
        isActive: s.boolean(),
        permissions: s.boolean().list(),

        // BigInt fields
        bigValue: s.bigInt(),

        // DateTime fields
        createdAt: s.dateTime(),
        dates: s.dateTime().list(),

        // JSON fields
        metadata: s.json(),
        configs: s.json().list(),

        // Blob fields
        avatar: s.blob().nullable(),

        // Enum fields
        status: s.enum(["active", "inactive"] as const),
        roles: s.enum(["user", "admin"] as const).list(),
      });

      type ModelType = typeof model.infer;

      // Test individual field types
      expectTypeOf<ModelType["id"]>().toEqualTypeOf<string>();
      expectTypeOf<ModelType["name"]>().toEqualTypeOf<string>();
      expectTypeOf<ModelType["bio"]>().toEqualTypeOf<string | null>();
      expectTypeOf<ModelType["tags"]>().toEqualTypeOf<string[]>();
      expectTypeOf<ModelType["age"]>().toEqualTypeOf<number>();
      expectTypeOf<ModelType["score"]>().toEqualTypeOf<number>();
      expectTypeOf<ModelType["balance"]>().toEqualTypeOf<number>();
      expectTypeOf<ModelType["isActive"]>().toEqualTypeOf<boolean>();
      expectTypeOf<ModelType["permissions"]>().toEqualTypeOf<boolean[]>();
      expectTypeOf<ModelType["bigValue"]>().toEqualTypeOf<bigint>();
      expectTypeOf<ModelType["createdAt"]>().toEqualTypeOf<Date>();
      expectTypeOf<ModelType["dates"]>().toEqualTypeOf<Date[]>();
      expectTypeOf<ModelType["metadata"]>().toEqualTypeOf<any>();
      expectTypeOf<ModelType["configs"]>().toEqualTypeOf<any[]>();
      expectTypeOf<ModelType["avatar"]>().toEqualTypeOf<Uint8Array | null>();
      expectTypeOf<ModelType["status"]>().toEqualTypeOf<
        "active" | "inactive"
      >();
      expectTypeOf<ModelType["roles"]>().toEqualTypeOf<("user" | "admin")[]>();
    });
  });

  describe("Enum type inference", () => {
    test("string enum types", () => {
      const enumModel = s.model("enumTest", {
        status: s.enum(["draft", "published", "archived"] as const),
        priority: s.enum(["low", "medium", "high"] as const).nullable(),
        categories: s.enum(["tech", "business", "lifestyle"] as const).list(),
      });

      type EnumModelType = typeof enumModel.infer;

      const data: EnumModelType = {
        status: "published",
        priority: null,
        categories: ["tech", "business"],
      };

      expect(data.status).toBe("published");
      expect(data.priority).toBeNull();
      expect(data.categories).toEqual(["tech", "business"]);

      // Test enum types
      expectTypeOf<EnumModelType["status"]>().toEqualTypeOf<
        "draft" | "published" | "archived"
      >();
      expectTypeOf<EnumModelType["priority"]>().toEqualTypeOf<
        "low" | "medium" | "high" | null
      >();
      expectTypeOf<EnumModelType["categories"]>().toEqualTypeOf<
        ("tech" | "business" | "lifestyle")[]
      >();
    });

    test("number enum types", () => {
      const numberEnumModel = s.model("numberEnum", {
        level: s.enum([1, 2, 3, 4, 5] as const),
        scores: s.enum([10, 20, 30] as const).list(),
      });

      type NumberEnumType = typeof numberEnumModel.infer;

      const data: NumberEnumType = {
        level: 3,
        scores: [10, 30],
      };

      expect(data.level).toBe(3);
      expect(data.scores).toEqual([10, 30]);

      // Test number enum types
      expectTypeOf<NumberEnumType["level"]>().toEqualTypeOf<
        1 | 2 | 3 | 4 | 5
      >();
      expectTypeOf<NumberEnumType["scores"]>().toEqualTypeOf<
        (10 | 20 | 30)[]
      >();
    });

    test("mixed enum types", () => {
      const mixedEnumModel = s.model("mixedEnum", {
        value: s.enum(["start", 1, "end", 2] as const),
      });

      type MixedEnumType = typeof mixedEnumModel.infer;

      const data: MixedEnumType = {
        value: 1,
      };

      expect(data.value).toBe(1);

      // Test mixed enum type
      expectTypeOf<MixedEnumType["value"]>().toEqualTypeOf<
        "start" | 1 | "end" | 2
      >();
    });
  });

  describe("Smart type inference behavior", () => {
    test("ID fields properties", () => {
      const idModel = s.model("idTest", {
        stringId: s.string().id(),
        bigintId: s.bigInt().id(),
      });

      // Test that ID fields are created correctly
      expect(idModel.fields.get("stringId")).toBeDefined();
      expect(idModel.fields.get("bigintId")).toBeDefined();
      expect((idModel.fields.get("stringId") as any).isId).toBe(true);
      expect((idModel.fields.get("bigintId") as any).isId).toBe(true);

      type IdModelType = typeof idModel.infer;

      // Test that we can create valid data
      const data: IdModelType = {
        stringId: "id-123",
        bigintId: BigInt(456),
      };

      expect(data.stringId).toBe("id-123");
      expect(data.bigintId).toBe(BigInt(456));
    });

    test("auto-generated fields properties", () => {
      const autoModel = s.model("autoTest", {
        uuid: s.string().auto.uuid(),
        increment: s.int().auto.increment(),
        timestamp: s.dateTime().auto.now(),
      });

      // Test that auto fields are created correctly
      expect((autoModel.fields.get("uuid") as any).autoGenerate).toBe("uuid");
      expect((autoModel.fields.get("increment") as any).autoGenerate).toBe(
        "increment"
      );
      expect((autoModel.fields.get("timestamp") as any).autoGenerate).toBe(
        "now"
      );

      type AutoModelType = typeof autoModel.infer;

      // Test that we can create valid data (auto fields would be generated)
      const data: AutoModelType = {
        uuid: "uuid-123",
        increment: 1,
        timestamp: new Date(),
      };

      expect(typeof data.uuid).toBe("string");
      expect(typeof data.increment).toBe("number");
      expect(data.timestamp).toBeInstanceOf(Date);
    });

    test("fields with defaults", () => {
      const defaultModel = s.model("defaultTest", {
        title: s.string().default("Untitled"),
        active: s.boolean().default(true),
        count: s.int().default(0),
      });

      // Test that default values are set
      expect((defaultModel.fields.get("title") as any).defaultValue).toBe(
        "Untitled"
      );
      expect((defaultModel.fields.get("active") as any).defaultValue).toBe(
        true
      );
      expect((defaultModel.fields.get("count") as any).defaultValue).toBe(0);

      type DefaultModelType = typeof defaultModel.infer;

      const data: DefaultModelType = {
        title: "My Title",
        active: false,
        count: 5,
      };

      expect(data.title).toBe("My Title");
      expect(data.active).toBe(false);
      expect(data.count).toBe(5);
    });
  });

  describe("Real-world examples", () => {
    test("user model", () => {
      const userModel = s.model("user", {
        id: s.string().id().auto.ulid(),
        email: s.string().unique(),
        name: s.string(),
        bio: s.string().nullable(),
        avatar: s.blob().nullable(),
        isActive: s.boolean().default(true),
        role: s.enum(["user", "admin", "moderator"] as const).default("user"),
        tags: s.string().list(),
        metadata: s.json().nullable(),
        createdAt: s.dateTime().auto.now(),
      });

      type UserType = typeof userModel.infer;

      const user: UserType = {
        id: "ulid-123",
        email: "user@example.com",
        name: "John Doe",
        bio: null,
        avatar: null,
        isActive: true,
        role: "user",
        tags: ["developer", "typescript"],
        metadata: { theme: "dark" },
        createdAt: new Date(),
      };

      expect(user.id).toBe("ulid-123");
      expect(user.email).toBe("user@example.com");
      expect(user.isActive).toBe(true);
      expect(user.role).toBe("user");
      expect(user.tags).toEqual(["developer", "typescript"]);

      // Test individual field types
      expectTypeOf<UserType["id"]>().toEqualTypeOf<string>();
      expectTypeOf<UserType["email"]>().toEqualTypeOf<string>();
      expectTypeOf<UserType["bio"]>().toEqualTypeOf<string | null>();
      expectTypeOf<UserType["role"]>().toEqualTypeOf<
        "user" | "admin" | "moderator"
      >();
      expectTypeOf<UserType["tags"]>().toEqualTypeOf<string[]>();
      expectTypeOf<UserType["metadata"]>().toEqualTypeOf<any | null>();
    });

    test("product model", () => {
      const productModel = s.model("product", {
        id: s.string().id().auto.ulid(),
        name: s.string(),
        price: s.decimal(),
        inStock: s.boolean(),
        categories: s
          .enum(["electronics", "clothing", "books"] as const)
          .list(),
        variants: s.json().list(),
        images: s.blob().list(),
        tags: s.string().list().nullable(),
        createdAt: s.dateTime().auto.now(),
      });

      type ProductType = typeof productModel.infer;

      const product: ProductType = {
        id: "product-123",
        name: "TypeScript Book",
        price: 29.99,
        inStock: true,
        categories: ["books"],
        variants: [{ size: "paperback" }, { size: "hardcover" }],
        images: [new Uint8Array([1, 2, 3])],
        tags: ["programming", "typescript"],
        createdAt: new Date(),
      };

      expect(product.name).toBe("TypeScript Book");
      expect(product.price).toBe(29.99);
      expect(product.categories).toEqual(["books"]);
      expect(product.variants).toHaveLength(2);

      // Test types
      expectTypeOf<ProductType["categories"]>().toEqualTypeOf<
        ("electronics" | "clothing" | "books")[]
      >();
      expectTypeOf<ProductType["variants"]>().toEqualTypeOf<any[]>();
      expectTypeOf<ProductType["images"]>().toEqualTypeOf<Uint8Array[]>();
      expectTypeOf<ProductType["tags"]>().toEqualTypeOf<string[] | null>();
    });
  });

  describe("Edge cases", () => {
    test("empty model", () => {
      const emptyModel = s.model("empty", {});
      type EmptyType = typeof emptyModel.infer;

      const empty: EmptyType = {};

      expect(Object.keys(empty)).toHaveLength(0);
      expectTypeOf<EmptyType>().toEqualTypeOf<{}>();
    });

    test("model with only nullable fields", () => {
      const nullableModel = s.model("nullable", {
        name: s.string().nullable(),
        age: s.int().nullable(),
        active: s.boolean().nullable(),
      });

      type NullableType = typeof nullableModel.infer;

      const allNull: NullableType = {
        name: null,
        age: null,
        active: null,
      };

      expect(allNull.name).toBeNull();
      expect(allNull.age).toBeNull();
      expect(allNull.active).toBeNull();

      expectTypeOf<NullableType["name"]>().toEqualTypeOf<string | null>();
      expectTypeOf<NullableType["age"]>().toEqualTypeOf<number | null>();
      expectTypeOf<NullableType["active"]>().toEqualTypeOf<boolean | null>();
    });
  });
});
