// v1 Features Tests
// Tests for compound IDs/uniques, default functions, and native types

import { describe, test, expect, expectTypeOf } from "vitest";
import {
  s,
  PG,
  MYSQL,
  SQLITE,
  type NativeType,
  type CompoundKeyName,
} from "../../src/schema";
import { validateSchema } from "../../src/schema/validation";

// =============================================================================
// COMPOUND ID TESTS
// =============================================================================

describe("Compound ID", () => {
  describe("Model API", () => {
    test(".id() creates compound primary key", () => {
      const membership = s
        .model({
          orgId: s.string(),
          userId: s.string(),
          role: s.string(),
        })
        .id(["orgId", "userId"])
        .map("membership");

      // CompoundConstraint format: { fields, name }
      expect(membership["~"].compoundId).toEqual({
        fields: ["orgId", "userId"],
        name: undefined,
      });
    });

    test(".id() only accepts scalar field names", () => {
      const m = s.model({
        a: s.string(),
        b: s.int(),
        rel: s.relation.oneToMany(() => m),
      });

      // Should only allow "a" | "b", not "rel"
      // @ts-expect-error - "rel" is not a scalar field
      m.id(["rel"]);
    });

    test("compound ID captures field names in generic", () => {
      const m = s
        .model({
          email: s.string(),
          username: s.string(),
        })
        .id(["email", "username"]);

      // Type test: compoundId should be CompoundConstraint<readonly ["email", "username"], undefined>
      type CompoundIdFields = (typeof m)["~"]["compoundId"];
      expectTypeOf<CompoundIdFields>().toEqualTypeOf<{
        fields: readonly ["email", "username"];
        name: undefined;
      }>();
    });

    test("compound ID captures custom name in generic", () => {
      const m = s
        .model({
          email: s.string(),
          username: s.string(),
        })
        .id(["email", "username"], { name: "my_custom_pk" });

      // Type test: compoundId should have the custom name
      type CompoundIdFields = (typeof m)["~"]["compoundId"];
      expectTypeOf<CompoundIdFields>().toEqualTypeOf<{
        fields: readonly ["email", "username"];
        name: "my_custom_pk";
      }>();
    });
  });

  describe("Validation", () => {
    test("M001 passes with compound ID (no field-level ID)", () => {
      const result = validateSchema({
        membership: s
          .model({
            orgId: s.string(),
            userId: s.string(),
            role: s.string(),
          })
          .id(["orgId", "userId"])
          .map("membership"),
      });

      const m001Errors = result.errors.filter((e) => e.code === "M001");
      expect(m001Errors).toHaveLength(0);
    });

    test("F002 fails with both compound ID and field-level ID", () => {
      const result = validateSchema({
        conflict: s
          .model({
            id: s.string().id(),
            orgId: s.string(),
            userId: s.string(),
          })
          .id(["orgId", "userId"])
          .map("conflict"),
      });

      const f002Errors = result.errors.filter((e) => e.code === "F002");
      expect(f002Errors.length).toBeGreaterThan(0);
    });

    test("I003 fails with non-existent compound ID field", () => {
      const m = s
        .model({
          a: s.string(),
          b: s.string(),
        })
        // @ts-expect-error - "c" doesn't exist
        .id(["a", "c"])
        .map("invalid");

      // Debug: check the compound ID is set (CompoundConstraint format)
      expect(m["~"].compoundId).toEqual({
        fields: ["a", "c"],
        name: undefined,
      });

      const result = validateSchema({ invalid: m });
      const i003Errors = result.errors.filter((e) => e.code === "I003");
      expect(i003Errors.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// COMPOUND UNIQUE TESTS
// =============================================================================

describe("Compound Unique", () => {
  describe("Model API", () => {
    test(".unique() creates compound unique constraint", () => {
      const user = s
        .model({
          id: s.string().id().ulid(),
          email: s.string(),
          orgId: s.string(),
        })
        .unique(["email", "orgId"])
        .map("users");

      // CompoundConstraint format: { fields: readonly string[], name: string | undefined }
      expect(user["~"].compoundUniques).toEqual([
        { fields: ["email", "orgId"], name: undefined },
      ]);
    });

    test(".unique() with custom name", () => {
      const user = s
        .model({
          id: s.string().id().ulid(),
          email: s.string(),
          orgId: s.string(),
        })
        .unique(["email", "orgId"], { name: "my_unique_constraint" })
        .map("users");

      expect(user["~"].compoundUniques).toEqual([
        { fields: ["email", "orgId"], name: "my_unique_constraint" },
      ]);
    });

    test("multiple .unique() calls stack", () => {
      const m = s
        .model({
          id: s.string().id(),
          a: s.string(),
          b: s.string(),
          c: s.string(),
        })
        .unique(["a", "b"])
        .unique(["b", "c"])
        .map("m");

      // CompoundConstraint format
      expect(m["~"].compoundUniques).toEqual([
        { fields: ["a", "b"], name: undefined },
        { fields: ["b", "c"], name: undefined },
      ]);
    });

    test(".unique() only accepts scalar field names", () => {
      const m = s.model({
        id: s.string().id(),
        a: s.string(),
        rel: s.relation.oneToMany(() => m),
      });

      // @ts-expect-error - "rel" is not a scalar field
      m.unique(["a", "rel"]);
    });
  });

  describe("Validation", () => {
    test("I003 fails with non-existent compound unique field", () => {
      const result = validateSchema({
        invalid: s
          .model({
            id: s.string().id(),
            a: s.string(),
          })
          // @ts-expect-error - "nonexistent" doesn't exist
          .unique(["a", "nonexistent"])
          .map("invalid"),
      });

      const i003Errors = result.errors.filter((e) => e.code === "I003");
      expect(i003Errors.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// COMPOUND KEY NAME TYPE TESTS
// =============================================================================

describe("CompoundKeyName type", () => {
  test("generates correct key names", () => {
    type TwoFields = CompoundKeyName<["email", "orgId"]>;
    expectTypeOf<TwoFields>().toEqualTypeOf<"email_orgId">();

    type ThreeFields = CompoundKeyName<["a", "b", "c"]>;
    expectTypeOf<ThreeFields>().toEqualTypeOf<"a_b_c">();

    type SingleField = CompoundKeyName<["id"]>;
    expectTypeOf<SingleField>().toEqualTypeOf<"id">();
  });
});

// =============================================================================
// COMPOUND KEY RUNTIME SCHEMA TESTS
// =============================================================================

// Helper to check ArkType errors
function isArkErrors(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "summary" in result &&
    typeof (result as { summary: string }).summary === "string"
  );
}

function assertValid(result: unknown): void {
  expect(isArkErrors(result)).toBe(false);
}

function assertInvalid(result: unknown): void {
  expect(isArkErrors(result)).toBe(true);
}

describe("Compound Key Runtime Schemas", () => {
  describe("Compound ID in whereUnique", () => {
    const membership = s
      .model({
        orgId: s.string(),
        userId: s.string(),
        role: s.string(),
      })
      .id(["orgId", "userId"])
      .map("membership");

    test("schema accepts compound key object", () => {
      const schema = membership["~"].schemas.whereUnique;

      // Valid: compound key provided
      const validResult = schema({
        orgId_userId: { orgId: "org-1", userId: "user-1" },
      });
      assertValid(validResult);
    });

    test("schema rejects empty object", () => {
      const schema = membership["~"].schemas.whereUnique;

      // Invalid: no unique identifier provided
      const invalidResult = schema({});
      assertInvalid(invalidResult);
    });

    test("schema rejects partial compound key", () => {
      const schema = membership["~"].schemas.whereUnique;

      // Invalid: only orgId provided, not the compound key
      // Note: individual fields are NOT unique identifiers in compound ID models
      const partialResult = schema({ orgId: "org-1" });
      assertInvalid(partialResult);
    });

    test("compound key requires all fields", () => {
      const schema = membership["~"].schemas.whereUnique;

      // Invalid: compound key object missing userId
      const incompleteResult = schema({
        orgId_userId: { orgId: "org-1" },
      });
      assertInvalid(incompleteResult);
    });
  });

  describe("Compound unique in whereUnique", () => {
    const user = s
      .model({
        id: s.string().id().ulid(),
        email: s.string(),
        orgId: s.string(),
        name: s.string(),
      })
      .unique(["email", "orgId"])
      .map("users");

    test("schema accepts single-field id", () => {
      const schema = user["~"].schemas.whereUnique;

      // Valid: id provided
      const validResult = schema({ id: "01ABC" });
      assertValid(validResult);
    });

    test("schema accepts compound unique key object", () => {
      const schema = user["~"].schemas.whereUnique;

      // Valid: compound unique provided
      const validResult = schema({
        email_orgId: { email: "test@example.com", orgId: "org-1" },
      });
      assertValid(validResult);
    });

    test("schema rejects empty object", () => {
      const schema = user["~"].schemas.whereUnique;

      // Invalid: no unique identifier provided
      const invalidResult = schema({});
      assertInvalid(invalidResult);
    });
  });

  describe("Multiple compound uniques", () => {
    const entity = s
      .model({
        id: s.string().id(),
        a: s.string(),
        b: s.string(),
        c: s.string(),
      })
      .unique(["a", "b"])
      .unique(["b", "c"])
      .map("entities");

    test("schema accepts first compound unique", () => {
      const schema = entity["~"].schemas.whereUnique;

      const result = schema({ a_b: { a: "val-a", b: "val-b" } });
      assertValid(result);
    });

    test("schema accepts second compound unique", () => {
      const schema = entity["~"].schemas.whereUnique;

      const result = schema({ b_c: { b: "val-b", c: "val-c" } });
      assertValid(result);
    });

    test("schema accepts single-field id", () => {
      const schema = entity["~"].schemas.whereUnique;

      const result = schema({ id: "some-id" });
      assertValid(result);
    });
  });

  describe("findUnique args schema", () => {
    const membership = s
      .model({
        orgId: s.string(),
        userId: s.string(),
        role: s.string(),
      })
      .id(["orgId", "userId"])
      .map("membership");

    test("findUnique accepts compound key in where", () => {
      const schema = membership["~"].schemas.findUnique;

      const result = schema({
        where: {
          orgId_userId: { orgId: "org-1", userId: "user-1" },
        },
      });
      assertValid(result);
    });

    test("findUnique with select and compound key", () => {
      const schema = membership["~"].schemas.findUnique;

      const result = schema({
        where: {
          orgId_userId: { orgId: "org-1", userId: "user-1" },
        },
        select: { role: true },
      });
      assertValid(result);
    });
  });
});

// =============================================================================
// DEFAULT FUNCTION TESTS
// =============================================================================

describe("Default Functions", () => {
  test("default() accepts function values", () => {
    const uuid = () => crypto.randomUUID();
    const m = s.model({
      id: s.string().default(uuid).id(),
      name: s.string(),
    });

    const state = m["~"].fieldMap.get("id")?.["~"].state;
    expect(state?.hasDefault).toBe(true);
    expect(typeof state?.defaultValue).toBe("function");
  });

  test("default() accepts static values", () => {
    const m = s.model({
      id: s.string().id().ulid(),
      status: s.string().default("pending"),
      count: s.int().default(0),
      active: s.boolean().default(true),
    });

    expect(m["~"].fieldMap.get("status")?.["~"].state.defaultValue).toBe(
      "pending"
    );
    expect(m["~"].fieldMap.get("count")?.["~"].state.defaultValue).toBe(0);
    expect(m["~"].fieldMap.get("active")?.["~"].state.defaultValue).toBe(true);
  });

  test("default() function type matches field type", () => {
    // Type test: function must return correct type
    s.string().default(() => "hello");
    s.int().default(() => 42);
    s.boolean().default(() => true);
    s.dateTime().default(() => new Date());

    // @ts-expect-error - function returns wrong type
    s.string().default(() => 42);

    // @ts-expect-error - function returns wrong type
    s.int().default(() => "hello");
  });
});

// =============================================================================
// NATIVE TYPE TESTS
// =============================================================================

describe("Native Types", () => {
  describe("PostgreSQL types", () => {
    test("PG.STRING types are available", () => {
      expect(PG.STRING.TEXT).toEqual({ db: "pg", type: "text" });
      expect(PG.STRING.CITEXT).toEqual({ db: "pg", type: "citext" });
      expect(PG.STRING.UUID).toEqual({ db: "pg", type: "uuid" });
      expect(PG.STRING.VARCHAR(255)).toEqual({
        db: "pg",
        type: "varchar(255)",
      });
      expect(PG.STRING.CHAR(10)).toEqual({ db: "pg", type: "char(10)" });
    });

    test("PG.INT types are available", () => {
      expect(PG.INT.SMALLINT).toEqual({ db: "pg", type: "smallint" });
      expect(PG.INT.INTEGER).toEqual({ db: "pg", type: "integer" });
    });

    test("PG.DECIMAL types support precision", () => {
      expect(PG.DECIMAL.DECIMAL(10, 2)).toEqual({
        db: "pg",
        type: "decimal(10,2)",
      });
      expect(PG.DECIMAL.MONEY).toEqual({ db: "pg", type: "money" });
    });

    test("PG.DATETIME types are available", () => {
      expect(PG.DATETIME.TIMESTAMP()).toEqual({ db: "pg", type: "timestamp" });
      expect(PG.DATETIME.TIMESTAMP(3)).toEqual({
        db: "pg",
        type: "timestamp(3)",
      });
      expect(PG.DATETIME.TIMESTAMPTZ()).toEqual({
        db: "pg",
        type: "timestamptz",
      });
      expect(PG.DATETIME.DATE).toEqual({ db: "pg", type: "date" });
    });

    test("PG.JSON types are available", () => {
      expect(PG.JSON.JSON).toEqual({ db: "pg", type: "json" });
      expect(PG.JSON.JSONB).toEqual({ db: "pg", type: "jsonb" });
    });
  });

  describe("MySQL types", () => {
    test("MYSQL.STRING types are available", () => {
      expect(MYSQL.STRING.VARCHAR(255)).toEqual({
        db: "mysql",
        type: "VARCHAR(255)",
      });
      expect(MYSQL.STRING.TEXT).toEqual({ db: "mysql", type: "TEXT" });
      expect(MYSQL.STRING.LONGTEXT).toEqual({ db: "mysql", type: "LONGTEXT" });
    });

    test("MYSQL.INT types are available", () => {
      expect(MYSQL.INT.TINYINT).toEqual({ db: "mysql", type: "TINYINT" });
      expect(MYSQL.INT.INT).toEqual({ db: "mysql", type: "INT" });
      expect(MYSQL.INT.INT_UNSIGNED).toEqual({
        db: "mysql",
        type: "INT UNSIGNED",
      });
    });

    test("MYSQL.BLOB types are available", () => {
      expect(MYSQL.BLOB.BLOB).toEqual({ db: "mysql", type: "BLOB" });
      expect(MYSQL.BLOB.LONGBLOB).toEqual({ db: "mysql", type: "LONGBLOB" });
    });
  });

  describe("SQLite types", () => {
    test("SQLITE types are available", () => {
      expect(SQLITE.STRING.TEXT).toEqual({ db: "sqlite", type: "TEXT" });
      expect(SQLITE.INT.INTEGER).toEqual({ db: "sqlite", type: "INTEGER" });
      expect(SQLITE.FLOAT.REAL).toEqual({ db: "sqlite", type: "REAL" });
      expect(SQLITE.BLOB.BLOB).toEqual({ db: "sqlite", type: "BLOB" });
    });
  });

  describe("Field integration", () => {
    test("string() accepts native type", () => {
      const field = s.string(PG.STRING.VARCHAR(255));
      expect(field["~"].nativeType).toEqual({ db: "pg", type: "varchar(255)" });
    });

    test("int() accepts native type", () => {
      const field = s.int(PG.INT.SMALLINT);
      expect(field["~"].nativeType).toEqual({ db: "pg", type: "smallint" });
    });

    test("decimal() accepts native type", () => {
      const field = s.decimal(PG.DECIMAL.DECIMAL(10, 2));
      expect(field["~"].nativeType).toEqual({
        db: "pg",
        type: "decimal(10,2)",
      });
    });

    test("dateTime() accepts native type", () => {
      const field = s.dateTime(PG.DATETIME.TIMESTAMPTZ());
      expect(field["~"].nativeType).toEqual({ db: "pg", type: "timestamptz" });
    });

    test("json() accepts native type", () => {
      const field = s.json(PG.JSON.JSONB);
      expect(field["~"].nativeType).toEqual({ db: "pg", type: "jsonb" });
    });

    test("blob() accepts native type", () => {
      const field = s.blob(MYSQL.BLOB.LONGBLOB);
      expect(field["~"].nativeType).toEqual({ db: "mysql", type: "LONGBLOB" });
    });

    test("native type is exposed in model", () => {
      const user = s.model({
        id: s.string(PG.STRING.UUID).id(),
        name: s.string(PG.STRING.VARCHAR(100)),
        balance: s.decimal(PG.DECIMAL.MONEY),
      });

      expect(user["~"].fieldMap.get("id")?.["~"].nativeType).toEqual({
        db: "pg",
        type: "uuid",
      });
      expect(user["~"].fieldMap.get("name")?.["~"].nativeType).toEqual({
        db: "pg",
        type: "varchar(100)",
      });
      expect(user["~"].fieldMap.get("balance")?.["~"].nativeType).toEqual({
        db: "pg",
        type: "money",
      });
    });
  });
});
