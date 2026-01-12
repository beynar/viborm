/**
 * PostgreSQL DDL Generation Tests
 */

import { describe, expect, it } from "vitest";
import { postgresMigrations } from "../../src/adapters/databases/postgres/migrations";
import type { DiffOperation } from "../../src/migrations/types";

// =============================================================================
// HELPERS
// =============================================================================

function generateDDL(op: DiffOperation): string {
  return postgresMigrations.generateDDL(op);
}

// =============================================================================
// TESTS
// =============================================================================

describe("PostgreSQL DDL Generation", () => {
  describe("createTable", () => {
    it("should generate CREATE TABLE with columns", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            { name: "id", type: "integer", nullable: false },
            { name: "email", type: "text", nullable: false },
            { name: "name", type: "text", nullable: true },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CREATE TABLE "users"');
      expect(ddl).toContain('"id" integer NOT NULL');
      expect(ddl).toContain('"email" text NOT NULL');
      expect(ddl).toContain('"name" text');
      expect(ddl).not.toContain('"name" text NOT NULL');
    });

    it("should generate CREATE TABLE with primary key", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [{ name: "id", type: "integer", nullable: false }],
          primaryKey: { columns: ["id"], name: "users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CONSTRAINT "users_pkey" PRIMARY KEY ("id")');
    });

    it("should generate CREATE TABLE with auto-increment", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            {
              name: "id",
              type: "integer",
              nullable: false,
              autoIncrement: true,
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('"id" SERIAL NOT NULL');
    });

    it("should generate CREATE TABLE with default value", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            {
              name: "status",
              type: "text",
              nullable: false,
              default: "'active'",
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("DEFAULT 'active'");
    });

    it("should generate CREATE TABLE with unique constraint", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [{ name: "email", type: "text", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [{ name: "users_email_key", columns: ["email"] }],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CONSTRAINT "users_email_key" UNIQUE ("email")');
    });
  });

  describe("dropTable", () => {
    it("should generate DROP TABLE CASCADE", () => {
      const op: DiffOperation = {
        type: "dropTable",
        tableName: "users",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('DROP TABLE "users" CASCADE');
    });
  });

  describe("renameTable", () => {
    it("should generate ALTER TABLE RENAME TO", () => {
      const op: DiffOperation = {
        type: "renameTable",
        from: "users",
        to: "accounts",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" RENAME TO "accounts"');
    });
  });

  describe("addColumn", () => {
    it("should generate ALTER TABLE ADD COLUMN", () => {
      const op: DiffOperation = {
        type: "addColumn",
        tableName: "users",
        column: { name: "email", type: "text", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" ADD COLUMN "email" text NOT NULL');
    });

    it("should handle nullable columns", () => {
      const op: DiffOperation = {
        type: "addColumn",
        tableName: "users",
        column: { name: "bio", type: "text", nullable: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" ADD COLUMN "bio" text');
    });
  });

  describe("dropColumn", () => {
    it("should generate ALTER TABLE DROP COLUMN", () => {
      const op: DiffOperation = {
        type: "dropColumn",
        tableName: "users",
        columnName: "email",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" DROP COLUMN "email"');
    });
  });

  describe("renameColumn", () => {
    it("should generate ALTER TABLE RENAME COLUMN", () => {
      const op: DiffOperation = {
        type: "renameColumn",
        tableName: "users",
        from: "username",
        to: "name",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" RENAME COLUMN "username" TO "name"'
      );
    });
  });

  describe("alterColumn", () => {
    it("should generate ALTER COLUMN for type change", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "text", nullable: false },
        to: { name: "age", type: "integer", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        'ALTER TABLE "users" ALTER COLUMN "age" TYPE integer'
      );
    });

    it("should generate ALTER COLUMN for nullable change", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "email",
        from: { name: "email", type: "text", nullable: false },
        to: { name: "email", type: "text", nullable: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL'
      );
    });

    it("should generate ALTER COLUMN for default change", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "status",
        from: { name: "status", type: "text", nullable: false },
        to: {
          name: "status",
          type: "text",
          nullable: false,
          default: "'active'",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("SET DEFAULT 'active'");
    });
  });

  describe("createIndex", () => {
    it("should generate CREATE INDEX", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: { name: "idx_users_email", columns: ["email"], unique: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('CREATE INDEX "idx_users_email" ON "users" ("email")');
    });

    it("should generate CREATE UNIQUE INDEX", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: { name: "idx_users_email", columns: ["email"], unique: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email")'
      );
    });

    it("should generate CREATE INDEX with type", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_users_data",
          columns: ["data"],
          unique: false,
          type: "gin",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE INDEX "idx_users_data" ON "users" USING gin ("data")'
      );
    });

    it("should generate CREATE INDEX with WHERE clause", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_users_active",
          columns: ["email"],
          unique: false,
          where: "active = true",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("WHERE active = true");
    });
  });

  describe("dropIndex", () => {
    it("should generate DROP INDEX", () => {
      const op: DiffOperation = {
        type: "dropIndex",
        indexName: "idx_users_email",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('DROP INDEX "idx_users_email"');
    });
  });

  describe("addForeignKey", () => {
    it("should generate ALTER TABLE ADD CONSTRAINT FOREIGN KEY", () => {
      const op: DiffOperation = {
        type: "addForeignKey",
        tableName: "posts",
        fk: {
          name: "fk_posts_user",
          columns: ["user_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
          onDelete: "cascade",
          onUpdate: "noAction",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_user"'
      );
      expect(ddl).toContain('FOREIGN KEY ("user_id")');
      expect(ddl).toContain('REFERENCES "users" ("id")');
      expect(ddl).toContain("ON DELETE CASCADE");
      expect(ddl).toContain("ON UPDATE NO ACTION");
    });
  });

  describe("dropForeignKey", () => {
    it("should generate ALTER TABLE DROP CONSTRAINT", () => {
      const op: DiffOperation = {
        type: "dropForeignKey",
        tableName: "posts",
        fkName: "fk_posts_user",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "posts" DROP CONSTRAINT "fk_posts_user"');
    });
  });

  describe("addUniqueConstraint", () => {
    it("should generate ALTER TABLE ADD CONSTRAINT UNIQUE", () => {
      const op: DiffOperation = {
        type: "addUniqueConstraint",
        tableName: "users",
        constraint: { name: "users_email_key", columns: ["email"] },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE ("email")'
      );
    });
  });

  describe("dropUniqueConstraint", () => {
    it("should generate ALTER TABLE DROP CONSTRAINT", () => {
      const op: DiffOperation = {
        type: "dropUniqueConstraint",
        tableName: "users",
        constraintName: "users_email_key",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" DROP CONSTRAINT "users_email_key"');
    });
  });

  describe("createEnum", () => {
    it("should generate CREATE TYPE AS ENUM", () => {
      const op: DiffOperation = {
        type: "createEnum",
        enumDef: { name: "status", values: ["active", "inactive", "pending"] },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        "CREATE TYPE \"status\" AS ENUM ('active', 'inactive', 'pending')"
      );
    });
  });

  describe("dropEnum", () => {
    it("should generate DROP TYPE", () => {
      const op: DiffOperation = {
        type: "dropEnum",
        enumName: "status",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('DROP TYPE "status"');
    });
  });

  describe("alterEnum", () => {
    it("should generate ALTER TYPE ADD VALUE", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        addValues: ["pending", "archived"],
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("ALTER TYPE \"status\" ADD VALUE 'pending'");
      expect(ddl).toContain("ALTER TYPE \"status\" ADD VALUE 'archived'");
    });
  });

  describe("mapFieldType", () => {
    // Helper to create mock field with minimal state
    const createMockField = (state: any) =>
      ({
        ["~"]: {
          state,
          nativeType: undefined,
        },
      }) as any;

    const createFieldState = (
      type: string,
      overrides: Record<string, any> = {}
    ) => ({
      type,
      nullable: false,
      array: false,
      hasDefault: false,
      isId: false,
      isUnique: false,
      default: undefined,
      autoGenerate: undefined,
      schema: undefined,
      optional: false,
      columnName: undefined,
      base: {} as any,
      withTimezone: false,
      ...overrides,
    });

    it("should map VibORM types to PostgreSQL types", () => {
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("string")),
          createFieldState("string")
        )
      ).toBe("text");
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("int")),
          createFieldState("int")
        )
      ).toBe("integer");
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("float")),
          createFieldState("float")
        )
      ).toBe("double precision");
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("boolean")),
          createFieldState("boolean")
        )
      ).toBe("boolean");
      // datetime without timezone (default false) -> timestamp
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("datetime")),
          createFieldState("datetime")
        )
      ).toBe("timestamp");
      // datetime with timezone -> timestamptz
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("datetime", { withTimezone: true })),
          createFieldState("datetime", { withTimezone: true })
        )
      ).toBe("timestamptz");
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("json")),
          createFieldState("json")
        )
      ).toBe("jsonb");
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("bigint")),
          createFieldState("bigint")
        )
      ).toBe("bigint");
    });

    it("should handle array types", () => {
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("string", { array: true })),
          createFieldState("string", { array: true })
        )
      ).toBe("text[]");
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("int", { array: true })),
          createFieldState("int", { array: true })
        )
      ).toBe("integer[]");
    });

    it("should handle auto-increment", () => {
      // mapFieldType returns base type; DDL generator converts to serial/bigserial
      // based on ColumnDef.autoIncrement flag
      expect(
        postgresMigrations.mapFieldType(
          createMockField(
            createFieldState("int", { autoGenerate: "increment" })
          ),
          createFieldState("int", { autoGenerate: "increment" })
        )
      ).toBe("integer");
      expect(
        postgresMigrations.mapFieldType(
          createMockField(
            createFieldState("bigint", { autoGenerate: "increment" })
          ),
          createFieldState("bigint", { autoGenerate: "increment" })
        )
      ).toBe("bigint");
    });

    it("should handle time with and without timezone", () => {
      // time without timezone (default) -> time
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("time")),
          createFieldState("time")
        )
      ).toBe("time");
      // time with timezone -> timetz
      expect(
        postgresMigrations.mapFieldType(
          createMockField(createFieldState("time", { withTimezone: true })),
          createFieldState("time", { withTimezone: true })
        )
      ).toBe("timetz");
    });
  });
});
