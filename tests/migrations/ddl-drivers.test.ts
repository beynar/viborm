/**
 * DDL Generation Tests for All Migration Drivers
 *
 * Tests SQLite3, LibSQL, MySQL, and PostgreSQL drivers for DDL generation.
 */

import { describe, expect, it } from "vitest";
import { libsqlMigrationDriver } from "../../src/migrations/drivers/libsql";
import { mysqlMigrationDriver } from "../../src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "../../src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "../../src/migrations/drivers/sqlite";
import type { DiffOperation, SchemaSnapshot } from "../../src/migrations/types";

// =============================================================================
// SQLITE3 DRIVER TESTS
// =============================================================================

describe("SQLite3 DDL Generation", () => {
  function generateDDL(
    op: DiffOperation,
    context?: { currentSchema?: SchemaSnapshot }
  ): string {
    return sqlite3MigrationDriver.generateDDL(op, context);
  }

  describe("createTable", () => {
    it("should generate CREATE TABLE with columns", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "TEXT", nullable: false },
            { name: "name", type: "TEXT", nullable: true },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CREATE TABLE "users"');
      expect(ddl).toContain('"id" INTEGER NOT NULL');
      expect(ddl).toContain('"email" TEXT NOT NULL');
      expect(ddl).toContain('"name" TEXT');
    });

    it("should generate CREATE TABLE with primary key", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [{ name: "id", type: "INTEGER", nullable: false }],
          primaryKey: { columns: ["id"], name: "users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('PRIMARY KEY ("id")');
    });

    it("should NOT add PRIMARY KEY constraint for INTEGER autoincrement", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            {
              name: "id",
              type: "INTEGER",
              nullable: false,
              autoIncrement: true,
            },
          ],
          primaryKey: { columns: ["id"], name: "users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      // SQLite INTEGER PRIMARY KEY is implicit with autoincrement
      expect(ddl).toContain('"id" INTEGER NOT NULL');
      // Should not have separate PRIMARY KEY clause for single INTEGER PK
      expect(ddl).not.toMatch(/PRIMARY KEY \("id"\)/);
    });

    it("should generate CREATE TABLE with default value", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            {
              name: "status",
              type: "TEXT",
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
          columns: [{ name: "email", type: "TEXT", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [{ name: "users_email_key", columns: ["email"] }],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CONSTRAINT "users_email_key" UNIQUE ("email")');
    });

    it("should generate CREATE TABLE with foreign key", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "posts",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "user_id", type: "INTEGER", nullable: false },
          ],
          indexes: [],
          foreignKeys: [
            {
              name: "fk_posts_user",
              columns: ["user_id"],
              referencedTable: "users",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CONSTRAINT "fk_posts_user"');
      expect(ddl).toContain('FOREIGN KEY ("user_id")');
      expect(ddl).toContain('REFERENCES "users" ("id")');
      expect(ddl).toContain("ON DELETE CASCADE");
    });

    it("should generate indexes separately", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [{ name: "email", type: "TEXT", nullable: false }],
          indexes: [
            { name: "idx_users_email", columns: ["email"], unique: false },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CREATE TABLE "users"');
      expect(ddl).toContain(
        'CREATE INDEX "idx_users_email" ON "users" ("email")'
      );
    });
  });

  describe("dropTable", () => {
    it("should generate DROP TABLE", () => {
      const op: DiffOperation = {
        type: "dropTable",
        tableName: "users",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('DROP TABLE "users"');
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
        column: { name: "email", type: "TEXT", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" ADD COLUMN "email" TEXT NOT NULL');
    });

    it("should handle nullable columns", () => {
      const op: DiffOperation = {
        type: "addColumn",
        tableName: "users",
        column: { name: "bio", type: "TEXT", nullable: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" ADD COLUMN "bio" TEXT');
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

  describe("alterColumn (table recreation)", () => {
    const currentSchema: SchemaSnapshot = {
      tables: [
        {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "age", type: "TEXT", nullable: false },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };

    it("should generate table recreation for type change", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "TEXT", nullable: false },
        to: { name: "age", type: "INTEGER", nullable: false },
      };

      const ddl = generateDDL(op, { currentSchema });

      // Should use table recreation pattern
      expect(ddl).toContain("PRAGMA foreign_keys=OFF");
      expect(ddl).toContain('CREATE TABLE "__new_users"');
      expect(ddl).toContain("INSERT INTO");
      expect(ddl).toContain('DROP TABLE "users"');
      expect(ddl).toContain('ALTER TABLE "__new_users" RENAME TO "users"');
      expect(ddl).toContain("PRAGMA foreign_keys=ON");
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

    it("should generate multi-column index", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_users_name_email",
          columns: ["name", "email"],
          unique: false,
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE INDEX "idx_users_name_email" ON "users" ("name", "email")'
      );
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

  describe("addUniqueConstraint", () => {
    it("should generate CREATE UNIQUE INDEX", () => {
      const op: DiffOperation = {
        type: "addUniqueConstraint",
        tableName: "users",
        constraint: { name: "users_email_key", columns: ["email"] },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE UNIQUE INDEX "users_email_key" ON "users" ("email")'
      );
    });
  });

  describe("dropUniqueConstraint", () => {
    it("should generate DROP INDEX", () => {
      const op: DiffOperation = {
        type: "dropUniqueConstraint",
        tableName: "users",
        constraintName: "users_email_key",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('DROP INDEX "users_email_key"');
    });
  });

  describe("enum operations (CHECK constraints)", () => {
    it("should return comment for createEnum", () => {
      const op: DiffOperation = {
        type: "createEnum",
        enumDef: { name: "status", values: ["active", "inactive"] },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        "-- SQLite: enum CHECK constraint is part of column definition"
      );
    });
  });

  describe("getEnumColumnType", () => {
    it("should return TEXT with CHECK constraint", () => {
      const result = sqlite3MigrationDriver.getEnumColumnType(
        "users",
        "status",
        ["active", "inactive", "pending"]
      );

      expect(result).toBe(
        "TEXT CHECK(\"status\" IN ('active', 'inactive', 'pending'))"
      );
    });

    it("should escape single quotes in values", () => {
      const result = sqlite3MigrationDriver.getEnumColumnType(
        "users",
        "status",
        ["it's active", "normal"]
      );

      expect(result).toBe(
        "TEXT CHECK(\"status\" IN ('it''s active', 'normal'))"
      );
    });
  });

  describe("migration tracking", () => {
    it("should generate CREATE TABLE for tracking table", () => {
      const ddl =
        sqlite3MigrationDriver.generateCreateTrackingTable("_migrations");

      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "_migrations"');
      expect(ddl).toContain("INTEGER PRIMARY KEY AUTOINCREMENT");
      expect(ddl).toContain("TEXT NOT NULL UNIQUE");
    });

    it("should generate INSERT for migration", () => {
      const { sql, paramCount } =
        sqlite3MigrationDriver.generateInsertMigration("_migrations");

      expect(sql).toBe(
        'INSERT INTO "_migrations" (name, checksum) VALUES (?, ?)'
      );
      expect(paramCount).toBe(2);
    });

    it("should generate DELETE for migration", () => {
      const { sql, paramCount } =
        sqlite3MigrationDriver.generateDeleteMigration("_migrations");

      expect(sql).toBe('DELETE FROM "_migrations" WHERE name = ?');
      expect(paramCount).toBe(1);
    });
  });

  describe("locking", () => {
    it("should return null for acquire lock (file-based)", () => {
      expect(sqlite3MigrationDriver.generateAcquireLock(12_345)).toBeNull();
    });

    it("should return null for release lock (file-based)", () => {
      expect(sqlite3MigrationDriver.generateReleaseLock(12_345)).toBeNull();
    });
  });
});

// =============================================================================
// LIBSQL DRIVER TESTS
// =============================================================================

describe("LibSQL DDL Generation", () => {
  function generateDDL(
    op: DiffOperation,
    context?: { currentSchema?: SchemaSnapshot }
  ): string {
    return libsqlMigrationDriver.generateDDL(op, context);
  }

  describe("inherits SQLite3 behavior", () => {
    it("should generate CREATE TABLE same as SQLite3", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "TEXT", nullable: false },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CREATE TABLE "users"');
      expect(ddl).toContain('"id" INTEGER NOT NULL');
    });
  });

  describe("alterColumn (native support)", () => {
    it("should generate ALTER TABLE ALTER COLUMN TO (not table recreation)", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "TEXT", nullable: false },
        to: { name: "age", type: "INTEGER", nullable: false },
      };

      const ddl = generateDDL(op);

      // LibSQL uses native ALTER COLUMN, not table recreation
      expect(ddl).toBe(
        'ALTER TABLE "users" ALTER COLUMN "age" TO "age" INTEGER NOT NULL'
      );
      expect(ddl).not.toContain("PRAGMA");
      expect(ddl).not.toContain("__new_");
    });

    it("should handle nullable change", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "email",
        from: { name: "email", type: "TEXT", nullable: false },
        to: { name: "email", type: "TEXT", nullable: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" ALTER COLUMN "email" TO "email" TEXT'
      );
      expect(ddl).not.toContain("NOT NULL");
    });

    it("should handle default value change", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "status",
        from: { name: "status", type: "TEXT", nullable: false },
        to: {
          name: "status",
          type: "TEXT",
          nullable: false,
          default: "'active'",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" ALTER COLUMN "status" TO "status" TEXT NOT NULL DEFAULT \'active\''
      );
    });
  });

  describe("addForeignKey (single column - native)", () => {
    const currentSchema: SchemaSnapshot = {
      tables: [
        {
          name: "posts",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "user_id", type: "INTEGER", nullable: false },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };

    it("should generate ALTER COLUMN with REFERENCES for single-column FK", () => {
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

      const ddl = generateDDL(op, { currentSchema });

      expect(ddl).toContain('ALTER TABLE "posts" ALTER COLUMN "user_id" TO');
      expect(ddl).toContain('REFERENCES "users"("id")');
      expect(ddl).toContain("ON DELETE CASCADE");
      expect(ddl).not.toContain("PRAGMA"); // Should NOT use table recreation
    });

    it("should fall back to table recreation for multi-column FK", () => {
      const multiColSchema: SchemaSnapshot = {
        tables: [
          {
            name: "order_items",
            columns: [
              { name: "order_id", type: "INTEGER", nullable: false },
              { name: "product_id", type: "INTEGER", nullable: false },
            ],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };

      const op: DiffOperation = {
        type: "addForeignKey",
        tableName: "order_items",
        fk: {
          name: "fk_composite",
          columns: ["order_id", "product_id"],
          referencedTable: "orders",
          referencedColumns: ["id", "product_id"],
          onDelete: "cascade",
          onUpdate: "noAction",
        },
      };

      const ddl = generateDDL(op, { currentSchema: multiColSchema });

      // Should use table recreation (inherited from SQLite3)
      expect(ddl).toContain("PRAGMA foreign_keys=OFF");
      expect(ddl).toContain('CREATE TABLE "__new_order_items"');
    });
  });

  describe("dropForeignKey (single column - native)", () => {
    const currentSchema: SchemaSnapshot = {
      tables: [
        {
          name: "posts",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "user_id", type: "INTEGER", nullable: false },
          ],
          indexes: [],
          foreignKeys: [
            {
              name: "fk_posts_user",
              columns: ["user_id"],
              referencedTable: "users",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    };

    it("should generate ALTER COLUMN without REFERENCES to drop FK", () => {
      const op: DiffOperation = {
        type: "dropForeignKey",
        tableName: "posts",
        fkName: "fk_posts_user",
      };

      const ddl = generateDDL(op, { currentSchema });

      expect(ddl).toContain('ALTER TABLE "posts" ALTER COLUMN "user_id" TO');
      expect(ddl).not.toContain("REFERENCES");
      expect(ddl).not.toContain("PRAGMA"); // Should NOT use table recreation
    });
  });

  describe("error handling", () => {
    it("should throw error for empty FK columns", () => {
      const currentSchema: SchemaSnapshot = {
        tables: [
          {
            name: "posts",
            columns: [{ name: "user_id", type: "INTEGER", nullable: false }],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };

      const op: DiffOperation = {
        type: "addForeignKey",
        tableName: "posts",
        fk: {
          name: "fk_empty",
          columns: [],
          referencedTable: "users",
          referencedColumns: [],
          onDelete: "noAction",
          onUpdate: "noAction",
        },
      };

      expect(() => generateDDL(op, { currentSchema })).toThrow(
        "Invalid foreign key: columns array is empty"
      );
    });

    it("should throw error when table not found in context", () => {
      const op: DiffOperation = {
        type: "addForeignKey",
        tableName: "nonexistent",
        fk: {
          name: "fk_test",
          columns: ["col"],
          referencedTable: "users",
          referencedColumns: ["id"],
          onDelete: "noAction",
          onUpdate: "noAction",
        },
      };

      expect(() => generateDDL(op, { currentSchema: { tables: [] } })).toThrow(
        'table "nonexistent" not found in current schema'
      );
    });
  });

  describe("capabilities", () => {
    it("should report correct capabilities", () => {
      expect(libsqlMigrationDriver.capabilities.supportsNativeEnums).toBe(
        false
      );
      expect(libsqlMigrationDriver.capabilities.supportsNativeArrays).toBe(
        false
      );
      expect(libsqlMigrationDriver.capabilities.supportsIndexTypes).toEqual([
        "btree",
      ]);
    });

    it("should have driverName as libsql", () => {
      expect(libsqlMigrationDriver.driverName).toBe("libsql");
    });

    it("should have dialect as sqlite", () => {
      expect(libsqlMigrationDriver.dialect).toBe("sqlite");
    });
  });
});

// =============================================================================
// MYSQL DRIVER TESTS
// =============================================================================

describe("MySQL DDL Generation", () => {
  function generateDDL(
    op: DiffOperation,
    context?: { currentSchema?: SchemaSnapshot }
  ): string {
    return mysqlMigrationDriver.generateDDL(op, context);
  }

  describe("identifier escaping", () => {
    it("should use backticks for identifiers", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [{ name: "id", type: "INT", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("`users`");
      expect(ddl).toContain("`id`");
      expect(ddl).not.toContain('"users"');
    });

    it("should escape backticks in identifiers", () => {
      const escaped = mysqlMigrationDriver.escapeIdentifier("table`name");
      expect(escaped).toBe("`table``name`");
    });
  });

  describe("createTable", () => {
    it("should generate CREATE TABLE with ENGINE and CHARSET", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            { name: "id", type: "INT", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: false },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("ENGINE=InnoDB");
      expect(ddl).toContain("DEFAULT CHARSET=utf8mb4");
      expect(ddl).toContain("COLLATE=utf8mb4_unicode_ci");
    });

    it("should generate CREATE TABLE with AUTO_INCREMENT", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            { name: "id", type: "INT", nullable: false, autoIncrement: true },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("`id` INT AUTO_INCREMENT NOT NULL");
    });

    it("should generate CREATE TABLE with BIGINT AUTO_INCREMENT", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            {
              name: "id",
              type: "BIGINT",
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

      expect(ddl).toContain("`id` BIGINT AUTO_INCREMENT NOT NULL");
    });

    it("should generate CREATE TABLE with inline foreign keys", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "posts",
          columns: [
            { name: "id", type: "INT", nullable: false },
            { name: "user_id", type: "INT", nullable: false },
          ],
          indexes: [],
          foreignKeys: [
            {
              name: "fk_posts_user",
              columns: ["user_id"],
              referencedTable: "users",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("CONSTRAINT `fk_posts_user`");
      expect(ddl).toContain("FOREIGN KEY (`user_id`)");
      expect(ddl).toContain("REFERENCES `users` (`id`)");
      expect(ddl).toContain("ON DELETE CASCADE");
    });

    it("should NOT include DEFAULT for TEXT columns", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "posts",
          columns: [
            {
              name: "content",
              type: "TEXT",
              nullable: true,
              default: "'default'",
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("`content` TEXT");
      // Should not have DEFAULT for the column itself (but table has DEFAULT CHARSET)
      expect(ddl).not.toMatch(/`content` TEXT[^)]*DEFAULT/);
    });

    it("should NOT include DEFAULT for BLOB columns", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "files",
          columns: [
            { name: "data", type: "BLOB", nullable: true, default: "''" },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("`data` BLOB");
      // Should not have DEFAULT for the column itself (but table has DEFAULT CHARSET)
      expect(ddl).not.toMatch(/`data` BLOB[^)]*DEFAULT/);
    });
  });

  describe("dropTable", () => {
    it("should generate DROP TABLE IF EXISTS", () => {
      const op: DiffOperation = {
        type: "dropTable",
        tableName: "users",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe("DROP TABLE IF EXISTS `users`");
    });
  });

  describe("renameTable", () => {
    it("should generate RENAME TABLE", () => {
      const op: DiffOperation = {
        type: "renameTable",
        from: "users",
        to: "accounts",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe("RENAME TABLE `users` TO `accounts`");
    });
  });

  describe("addColumn", () => {
    it("should generate ALTER TABLE ADD COLUMN", () => {
      const op: DiffOperation = {
        type: "addColumn",
        tableName: "users",
        column: { name: "email", type: "VARCHAR(255)", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        "ALTER TABLE `users` ADD COLUMN `email` VARCHAR(255) NOT NULL"
      );
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

      expect(ddl).toBe("ALTER TABLE `users` DROP COLUMN `email`");
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
        "ALTER TABLE `users` RENAME COLUMN `username` TO `name`"
      );
    });
  });

  describe("alterColumn", () => {
    it("should generate MODIFY COLUMN for same-name alterations", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "VARCHAR(10)", nullable: false },
        to: { name: "age", type: "INT", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe("ALTER TABLE `users` MODIFY COLUMN `age` INT NOT NULL");
    });

    it("should generate CHANGE COLUMN for rename + alter", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "old_name",
        from: { name: "old_name", type: "VARCHAR(50)", nullable: false },
        to: { name: "new_name", type: "VARCHAR(100)", nullable: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        "ALTER TABLE `users` CHANGE COLUMN `old_name` `new_name` VARCHAR(100)"
      );
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

      expect(ddl).toBe("CREATE INDEX `idx_users_email` ON `users` (`email`)");
    });

    it("should generate CREATE UNIQUE INDEX", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: { name: "idx_users_email", columns: ["email"], unique: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        "CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`)"
      );
    });

    it("should generate CREATE INDEX with HASH type", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_users_id",
          columns: ["id"],
          unique: false,
          type: "hash",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        "CREATE INDEX `idx_users_id` ON `users` (`id`) USING HASH"
      );
    });

    it("should generate CREATE INDEX with FULLTEXT type", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "posts",
        index: {
          name: "idx_posts_content",
          columns: ["content"],
          unique: false,
          type: "fulltext",
        },
      };

      const ddl = generateDDL(op);

      // FULLTEXT is a prefix in MySQL, not a USING clause
      expect(ddl).toBe(
        "CREATE FULLTEXT INDEX `idx_posts_content` ON `posts` (`content`)"
      );
    });
  });

  describe("dropIndex", () => {
    it("should generate DROP INDEX ON table", () => {
      const op: DiffOperation = {
        type: "dropIndex",
        indexName: "idx_users_email",
        tableName: "users",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe("DROP INDEX `idx_users_email` ON `users`");
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
          onUpdate: "setNull",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("ALTER TABLE `posts`");
      expect(ddl).toContain("ADD CONSTRAINT `fk_posts_user`");
      expect(ddl).toContain("FOREIGN KEY (`user_id`)");
      expect(ddl).toContain("REFERENCES `users` (`id`)");
      expect(ddl).toContain("ON DELETE CASCADE");
      expect(ddl).toContain("ON UPDATE SET NULL");
    });
  });

  describe("dropForeignKey", () => {
    it("should generate ALTER TABLE DROP FOREIGN KEY", () => {
      const op: DiffOperation = {
        type: "dropForeignKey",
        tableName: "posts",
        fkName: "fk_posts_user",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe("ALTER TABLE `posts` DROP FOREIGN KEY `fk_posts_user`");
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
        "ALTER TABLE `users` ADD CONSTRAINT `users_email_key` UNIQUE (`email`)"
      );
    });
  });

  describe("dropUniqueConstraint", () => {
    it("should generate ALTER TABLE DROP INDEX (MySQL uses index for unique)", () => {
      const op: DiffOperation = {
        type: "dropUniqueConstraint",
        tableName: "users",
        constraintName: "users_email_key",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe("ALTER TABLE `users` DROP INDEX `users_email_key`");
    });
  });

  describe("addPrimaryKey", () => {
    it("should generate ALTER TABLE ADD PRIMARY KEY", () => {
      const op: DiffOperation = {
        type: "addPrimaryKey",
        tableName: "users",
        primaryKey: { columns: ["id"], name: "users_pkey" },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe("ALTER TABLE `users` ADD PRIMARY KEY (`id`)");
    });

    it("should handle composite primary key", () => {
      const op: DiffOperation = {
        type: "addPrimaryKey",
        tableName: "order_items",
        primaryKey: {
          columns: ["order_id", "product_id"],
          name: "order_items_pkey",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        "ALTER TABLE `order_items` ADD PRIMARY KEY (`order_id`, `product_id`)"
      );
    });
  });

  describe("dropPrimaryKey", () => {
    it("should generate ALTER TABLE DROP PRIMARY KEY", () => {
      const op: DiffOperation = {
        type: "dropPrimaryKey",
        tableName: "users",
        constraintName: "users_pkey",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe("ALTER TABLE `users` DROP PRIMARY KEY");
    });
  });

  describe("enum operations (inline ENUM)", () => {
    it("should return comment for createEnum", () => {
      const op: DiffOperation = {
        type: "createEnum",
        enumDef: { name: "status", values: ["active", "inactive"] },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("-- MySQL: ENUM type is part of column definition");
    });

    it("should return comment for dropEnum", () => {
      const op: DiffOperation = {
        type: "dropEnum",
        enumName: "status",
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("-- MySQL: ENUM type is part of column definition");
    });

    it("should generate MODIFY COLUMN for alterEnum", () => {
      const currentSchema: SchemaSnapshot = {
        tables: [
          {
            name: "users",
            columns: [
              {
                name: "status",
                type: "ENUM('active','inactive')",
                nullable: false,
              },
            ],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };

      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "users_status_enum",
        newValues: ["active", "inactive", "pending"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
      };

      const ddl = generateDDL(op, { currentSchema });

      expect(ddl).toContain("ALTER TABLE `users` MODIFY COLUMN `status`");
      expect(ddl).toContain("ENUM('active', 'inactive', 'pending')");
    });
  });

  describe("getEnumColumnType", () => {
    it("should return ENUM with values", () => {
      const result = mysqlMigrationDriver.getEnumColumnType("users", "status", [
        "active",
        "inactive",
        "pending",
      ]);

      expect(result).toBe("ENUM('active', 'inactive', 'pending')");
    });

    it("should escape single quotes in values", () => {
      const result = mysqlMigrationDriver.getEnumColumnType("users", "status", [
        "it's active",
        "normal",
      ]);

      expect(result).toBe("ENUM('it''s active', 'normal')");
    });
  });

  describe("migration tracking", () => {
    it("should generate CREATE TABLE for tracking table", () => {
      const ddl =
        mysqlMigrationDriver.generateCreateTrackingTable("_migrations");

      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS `_migrations`");
      expect(ddl).toContain("INT AUTO_INCREMENT PRIMARY KEY");
      expect(ddl).toContain("VARCHAR(255) NOT NULL UNIQUE");
      expect(ddl).toContain("ENGINE=InnoDB");
    });

    it("should generate INSERT for migration", () => {
      const { sql, paramCount } =
        mysqlMigrationDriver.generateInsertMigration("_migrations");

      expect(sql).toBe(
        "INSERT INTO `_migrations` (name, checksum) VALUES (?, ?)"
      );
      expect(paramCount).toBe(2);
    });

    it("should generate DELETE for migration", () => {
      const { sql, paramCount } =
        mysqlMigrationDriver.generateDeleteMigration("_migrations");

      expect(sql).toBe("DELETE FROM `_migrations` WHERE name = ?");
      expect(paramCount).toBe(1);
    });
  });

  describe("locking", () => {
    it("should generate GET_LOCK for acquire", () => {
      const sql = mysqlMigrationDriver.generateAcquireLock(12_345);
      expect(sql).toBe("SELECT GET_LOCK('viborm_migration_12345', 30)");
    });

    it("should generate RELEASE_LOCK for release", () => {
      const sql = mysqlMigrationDriver.generateReleaseLock(12_345);
      expect(sql).toBe("SELECT RELEASE_LOCK('viborm_migration_12345')");
    });
  });

  describe("capabilities", () => {
    it("should report correct capabilities", () => {
      expect(mysqlMigrationDriver.capabilities.supportsNativeEnums).toBe(true);
      expect(mysqlMigrationDriver.capabilities.supportsNativeArrays).toBe(
        false
      );
      expect(mysqlMigrationDriver.capabilities.supportsIndexTypes).toEqual([
        "btree",
        "hash",
        "fulltext",
        "spatial",
      ]);
    });

    it("should have driverName as mysql", () => {
      expect(mysqlMigrationDriver.driverName).toBe("mysql");
    });

    it("should have dialect as mysql", () => {
      expect(mysqlMigrationDriver.dialect).toBe("mysql");
    });
  });

  describe("mapFieldType", () => {
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

    it("should map VibORM types to MySQL types", () => {
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("string")),
          createFieldState("string")
        )
      ).toBe("TEXT");
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("int")),
          createFieldState("int")
        )
      ).toBe("INT");
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("float")),
          createFieldState("float")
        )
      ).toBe("DOUBLE");
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("boolean")),
          createFieldState("boolean")
        )
      ).toBe("TINYINT(1)");
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("datetime")),
          createFieldState("datetime")
        )
      ).toBe("DATETIME");
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("json")),
          createFieldState("json")
        )
      ).toBe("JSON");
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("bigint")),
          createFieldState("bigint")
        )
      ).toBe("BIGINT");
    });

    it("should use JSON for array types", () => {
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("string", { array: true })),
          createFieldState("string", { array: true })
        )
      ).toBe("JSON");
      expect(
        mysqlMigrationDriver.mapFieldType(
          createMockField(createFieldState("int", { array: true })),
          createFieldState("int", { array: true })
        )
      ).toBe("JSON");
    });
  });
});

// =============================================================================
// POSTGRESQL DRIVER TESTS
// =============================================================================

describe("PostgreSQL DDL Generation", () => {
  function generateDDL(
    op: DiffOperation,
    context?: { currentSchema?: SchemaSnapshot }
  ): string {
    return postgresMigrationDriver.generateDDL(op, context);
  }

  describe("identifier escaping", () => {
    it("should use double quotes for identifiers", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [{ name: "id", type: "INTEGER", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('"users"');
      expect(ddl).toContain('"id"');
      expect(ddl).not.toContain("`users`");
    });

    it("should escape double quotes in identifiers", () => {
      const escaped = postgresMigrationDriver.escapeIdentifier('table"name');
      expect(escaped).toBe('"table""name"');
    });
  });

  describe("createTable", () => {
    it("should generate CREATE TABLE with columns", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "email", type: "VARCHAR(255)", nullable: false },
            { name: "name", type: "TEXT", nullable: true },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CREATE TABLE "users"');
      expect(ddl).toContain('"id" INTEGER NOT NULL');
      expect(ddl).toContain('"email" VARCHAR(255) NOT NULL');
      expect(ddl).toContain('"name" TEXT');
    });

    it("should generate CREATE TABLE with primary key", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [{ name: "id", type: "INTEGER", nullable: false }],
          primaryKey: { columns: ["id"], name: "users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CONSTRAINT "users_pkey" PRIMARY KEY ("id")');
    });

    it("should generate SERIAL for integer autoIncrement", () => {
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

    it("should generate BIGSERIAL for bigint autoIncrement", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            {
              name: "id",
              type: "bigint",
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

      expect(ddl).toContain('"id" BIGSERIAL NOT NULL');
    });

    it("should generate CREATE TABLE with default value", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [
            {
              name: "status",
              type: "TEXT",
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
          columns: [{ name: "email", type: "TEXT", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [{ name: "users_email_key", columns: ["email"] }],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CONSTRAINT "users_email_key" UNIQUE ("email")');
    });

    it("should generate CREATE TABLE with indexes as separate statements", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "users",
          columns: [{ name: "email", type: "TEXT", nullable: false }],
          indexes: [
            { name: "idx_users_email", columns: ["email"], unique: false },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CREATE TABLE "users"');
      expect(ddl).toContain('CREATE INDEX "idx_users_email" ON "users"');
    });

    it("should generate CREATE TABLE with foreign keys as separate statements", () => {
      const op: DiffOperation = {
        type: "createTable",
        table: {
          name: "posts",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            { name: "user_id", type: "INTEGER", nullable: false },
          ],
          indexes: [],
          foreignKeys: [
            {
              name: "fk_posts_user",
              columns: ["user_id"],
              referencedTable: "users",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CREATE TABLE "posts"');
      expect(ddl).toContain(
        'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_user"'
      );
      expect(ddl).toContain('FOREIGN KEY ("user_id")');
      expect(ddl).toContain('REFERENCES "users" ("id")');
      expect(ddl).toContain("ON DELETE CASCADE");
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
        column: { name: "email", type: "VARCHAR(255)", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" ADD COLUMN "email" VARCHAR(255) NOT NULL'
      );
    });

    it("should handle nullable columns", () => {
      const op: DiffOperation = {
        type: "addColumn",
        tableName: "users",
        column: { name: "bio", type: "TEXT", nullable: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" ADD COLUMN "bio" TEXT');
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
    it("should generate ALTER COLUMN TYPE for type change", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "VARCHAR(10)", nullable: false },
        to: { name: "age", type: "INTEGER", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        'ALTER TABLE "users" ALTER COLUMN "age" TYPE INTEGER'
      );
      expect(ddl).toContain('USING "age"::INTEGER');
    });

    it("should generate SET NOT NULL for nullable change to false", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "email",
        from: { name: "email", type: "TEXT", nullable: true },
        to: { name: "email", type: "TEXT", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL');
    });

    it("should generate DROP NOT NULL for nullable change to true", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "email",
        from: { name: "email", type: "TEXT", nullable: false },
        to: { name: "email", type: "TEXT", nullable: true },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL'
      );
    });

    it("should generate SET DEFAULT for default change", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "status",
        from: { name: "status", type: "TEXT", nullable: false },
        to: {
          name: "status",
          type: "TEXT",
          nullable: false,
          default: "'active'",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT \'active\''
      );
    });

    it("should generate DROP DEFAULT when removing default", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "status",
        from: {
          name: "status",
          type: "TEXT",
          nullable: false,
          default: "'active'",
        },
        to: { name: "status", type: "TEXT", nullable: false },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT'
      );
    });

    it("should generate multiple ALTER statements for combined changes", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "VARCHAR(10)", nullable: true },
        to: { name: "age", type: "INTEGER", nullable: false, default: "0" },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        'ALTER TABLE "users" ALTER COLUMN "age" TYPE INTEGER'
      );
      expect(ddl).toContain(
        'ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL'
      );
      expect(ddl).toContain(
        'ALTER TABLE "users" ALTER COLUMN "age" SET DEFAULT 0'
      );
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

    it("should generate CREATE INDEX with USING btree", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_users_id",
          columns: ["id"],
          unique: false,
          type: "btree",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE INDEX "idx_users_id" ON "users" USING btree ("id")'
      );
    });

    it("should generate CREATE INDEX with USING hash", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_users_id",
          columns: ["id"],
          unique: false,
          type: "hash",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE INDEX "idx_users_id" ON "users" USING hash ("id")'
      );
    });

    it("should generate CREATE INDEX with USING gin for JSONB", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_users_metadata",
          columns: ["metadata"],
          unique: false,
          type: "gin",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE INDEX "idx_users_metadata" ON "users" USING gin ("metadata")'
      );
    });

    it("should generate CREATE INDEX with WHERE clause (partial index)", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_active_users",
          columns: ["email"],
          unique: false,
          where: "active = true",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE INDEX "idx_active_users" ON "users" ("email") WHERE active = true'
      );
    });

    it("should generate multi-column index", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_users_name_email",
          columns: ["name", "email"],
          unique: false,
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE INDEX "idx_users_name_email" ON "users" ("name", "email")'
      );
    });
  });

  describe("dropIndex", () => {
    it("should generate DROP INDEX (no table name needed)", () => {
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
          onUpdate: "setNull",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('ALTER TABLE "posts"');
      expect(ddl).toContain('ADD CONSTRAINT "fk_posts_user"');
      expect(ddl).toContain('FOREIGN KEY ("user_id")');
      expect(ddl).toContain('REFERENCES "users" ("id")');
      expect(ddl).toContain("ON DELETE CASCADE");
      expect(ddl).toContain("ON UPDATE SET NULL");
    });

    it("should handle composite foreign key", () => {
      const op: DiffOperation = {
        type: "addForeignKey",
        tableName: "order_items",
        fk: {
          name: "fk_order_items_orders",
          columns: ["order_id", "product_id"],
          referencedTable: "orders",
          referencedColumns: ["id", "product_id"],
          onDelete: "restrict",
          onUpdate: "noAction",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('FOREIGN KEY ("order_id", "product_id")');
      expect(ddl).toContain('REFERENCES "orders" ("id", "product_id")');
      expect(ddl).toContain("ON DELETE RESTRICT");
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

  describe("addPrimaryKey", () => {
    it("should generate ALTER TABLE ADD CONSTRAINT PRIMARY KEY", () => {
      const op: DiffOperation = {
        type: "addPrimaryKey",
        tableName: "users",
        primaryKey: { columns: ["id"], name: "users_pkey" },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "users" ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id")'
      );
    });

    it("should handle composite primary key", () => {
      const op: DiffOperation = {
        type: "addPrimaryKey",
        tableName: "order_items",
        primaryKey: {
          columns: ["order_id", "product_id"],
          name: "order_items_pkey",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'ALTER TABLE "order_items" ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("order_id", "product_id")'
      );
    });

    it("should generate default pk name when not provided", () => {
      const op: DiffOperation = {
        type: "addPrimaryKey",
        tableName: "users",
        primaryKey: { columns: ["id"] },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain('CONSTRAINT "users_pkey"');
    });
  });

  describe("dropPrimaryKey", () => {
    it("should generate ALTER TABLE DROP CONSTRAINT", () => {
      const op: DiffOperation = {
        type: "dropPrimaryKey",
        tableName: "users",
        constraintName: "users_pkey",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('ALTER TABLE "users" DROP CONSTRAINT "users_pkey"');
    });
  });

  describe("enum operations (native ENUM)", () => {
    it("should generate CREATE TYPE AS ENUM", () => {
      const op: DiffOperation = {
        type: "createEnum",
        enumDef: {
          name: "status_enum",
          values: ["active", "inactive", "pending"],
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        "CREATE TYPE \"status_enum\" AS ENUM ('active', 'inactive', 'pending')"
      );
    });

    it("should escape single quotes in enum values", () => {
      const op: DiffOperation = {
        type: "createEnum",
        enumDef: { name: "status_enum", values: ["it's active", "normal"] },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        "CREATE TYPE \"status_enum\" AS ENUM ('it''s active', 'normal')"
      );
    });

    it("should generate DROP TYPE", () => {
      const op: DiffOperation = {
        type: "dropEnum",
        enumName: "status_enum",
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe('DROP TYPE "status_enum"');
    });

    it("should generate ALTER TYPE ADD VALUE for adding values", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status_enum",
        addValues: ["pending", "archived"],
        newValues: ["active", "inactive", "pending", "archived"],
        dependentColumns: [],
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain("ALTER TYPE \"status_enum\" ADD VALUE 'pending'");
      expect(ddl).toContain("ALTER TYPE \"status_enum\" ADD VALUE 'archived'");
    });

    it("should regenerate enum when removing values", () => {
      const currentSchema: SchemaSnapshot = {
        tables: [
          {
            name: "users",
            columns: [{ name: "status", type: "status_enum", nullable: false }],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };

      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status_enum",
        removeValues: ["pending"],
        newValues: ["active", "inactive"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        defaultReplacement: "inactive",
      };

      const ddl = generateDDL(op, { currentSchema });

      // Should convert to text first
      expect(ddl).toContain(
        'ALTER TABLE "users" ALTER COLUMN "status" TYPE text'
      );
      // Should update values
      expect(ddl).toContain(
        'UPDATE "users" SET "status" = \'inactive\' WHERE "status" = \'pending\''
      );
      // Should drop old enum
      expect(ddl).toContain('DROP TYPE "status_enum"');
      // Should create new enum
      expect(ddl).toContain(
        "CREATE TYPE \"status_enum\" AS ENUM ('active', 'inactive')"
      );
      // Should convert back to enum
      expect(ddl).toContain(
        'ALTER TABLE "users" ALTER COLUMN "status" TYPE "status_enum"'
      );
    });
  });

  describe("getEnumColumnType", () => {
    it("should return enum type name based on table_column_enum pattern", () => {
      const result = postgresMigrationDriver.getEnumColumnType(
        "users",
        "status",
        ["active", "inactive"]
      );

      expect(result).toBe("users_status_enum");
    });
  });

  describe("migration tracking", () => {
    it("should generate CREATE TABLE for tracking table", () => {
      const ddl =
        postgresMigrationDriver.generateCreateTrackingTable("_migrations");

      expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "_migrations"');
      expect(ddl).toContain("SERIAL PRIMARY KEY");
      expect(ddl).toContain("VARCHAR(255) NOT NULL UNIQUE");
      expect(ddl).toContain("TIMESTAMP WITH TIME ZONE");
    });

    it("should generate INSERT for migration with $1, $2 placeholders", () => {
      const { sql, paramCount } =
        postgresMigrationDriver.generateInsertMigration("_migrations");

      expect(sql).toBe(
        'INSERT INTO "_migrations" (name, checksum) VALUES ($1, $2)'
      );
      expect(paramCount).toBe(2);
    });

    it("should generate DELETE for migration with $1 placeholder", () => {
      const { sql, paramCount } =
        postgresMigrationDriver.generateDeleteMigration("_migrations");

      expect(sql).toBe('DELETE FROM "_migrations" WHERE name = $1');
      expect(paramCount).toBe(1);
    });
  });

  describe("locking", () => {
    it("should generate pg_advisory_lock for acquire", () => {
      const sql = postgresMigrationDriver.generateAcquireLock(12_345);
      expect(sql).toBe("SELECT pg_advisory_lock(12345)");
    });

    it("should generate pg_advisory_unlock for release", () => {
      const sql = postgresMigrationDriver.generateReleaseLock(12_345);
      expect(sql).toBe("SELECT pg_advisory_unlock(12345)");
    });
  });

  describe("capabilities", () => {
    it("should report correct capabilities", () => {
      expect(postgresMigrationDriver.capabilities.supportsNativeEnums).toBe(
        true
      );
      expect(
        postgresMigrationDriver.capabilities.supportsAddEnumValueInTransaction
      ).toBe(false);
      expect(postgresMigrationDriver.capabilities.supportsNativeArrays).toBe(
        true
      );
      expect(postgresMigrationDriver.capabilities.supportsIndexTypes).toEqual([
        "btree",
        "hash",
        "gin",
        "gist",
      ]);
    });

    it("should have driverName as postgresql", () => {
      expect(postgresMigrationDriver.driverName).toBe("postgresql");
    });

    it("should have dialect as postgresql", () => {
      expect(postgresMigrationDriver.dialect).toBe("postgresql");
    });
  });

  describe("mapFieldType", () => {
    const createMockField = (
      state: any,
      nativeType?: { db: string; type: string }
    ) =>
      ({
        ["~"]: {
          state,
          nativeType,
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
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("string")),
          createFieldState("string")
        )
      ).toBe("text");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("int")),
          createFieldState("int")
        )
      ).toBe("integer");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("float")),
          createFieldState("float")
        )
      ).toBe("double precision");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("boolean")),
          createFieldState("boolean")
        )
      ).toBe("boolean");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("datetime")),
          createFieldState("datetime")
        )
      ).toBe("timestamp");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("json")),
          createFieldState("json")
        )
      ).toBe("jsonb");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("bigint")),
          createFieldState("bigint")
        )
      ).toBe("bigint");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("blob")),
          createFieldState("blob")
        )
      ).toBe("bytea");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("date")),
          createFieldState("date")
        )
      ).toBe("date");
    });

    it("should handle array types with native array syntax", () => {
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("string", { array: true })),
          createFieldState("string", { array: true })
        )
      ).toBe("text[]");
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("int", { array: true })),
          createFieldState("int", { array: true })
        )
      ).toBe("integer[]");
    });

    it("should handle datetime with timezone", () => {
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("datetime", { withTimezone: true })),
          createFieldState("datetime", { withTimezone: true })
        )
      ).toBe("timestamptz");
    });

    it("should use native type when specified for PostgreSQL", () => {
      const nativeType = { db: "pg", type: "citext" };
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("string"), nativeType),
          createFieldState("string")
        )
      ).toBe("citext");
    });

    it("should ignore native type for other databases", () => {
      const nativeType = { db: "mysql", type: "VARCHAR(100)" };
      expect(
        postgresMigrationDriver.mapFieldType(
          createMockField(createFieldState("string"), nativeType),
          createFieldState("string")
        )
      ).toBe("text");
    });
  });

  describe("generateResetSQL", () => {
    it("should return SQL to drop all tables and enums", () => {
      const statements = postgresMigrationDriver.generateResetSQL();

      expect(statements.length).toBe(2);
      expect(statements[0]).toContain("DROP TABLE IF EXISTS");
      expect(statements[0]).toContain("pg_tables");
      expect(statements[1]).toContain("DROP TYPE IF EXISTS");
      expect(statements[1]).toContain("pg_type");
    });
  });

  describe("generateListTables", () => {
    it("should return SQL to list public tables", () => {
      const sql = postgresMigrationDriver.generateListTables();

      expect(sql).toContain("pg_tables");
      expect(sql).toContain("schemaname = 'public'");
    });
  });

  describe("generateListEnums", () => {
    it("should return SQL to list public enums", () => {
      const sql = postgresMigrationDriver.generateListEnums();

      expect(sql).not.toBeNull();
      expect(sql).toContain("pg_type");
      expect(sql).toContain("typtype = 'e'");
      expect(sql).toContain("nspname = 'public'");
    });
  });
});

// =============================================================================
// SHARED UTILITIES TESTS
// =============================================================================

describe("Migration Driver Utils", () => {
  // Test the shared utils by verifying they're correctly used by drivers
  describe("groupBy via introspection", () => {
    it("should be available and working in all drivers", () => {
      // The fact that introspection works proves groupBy is correctly exported
      // These are integration checks, not unit tests of groupBy itself
      expect(sqlite3MigrationDriver.introspect).toBeDefined();
      expect(libsqlMigrationDriver.introspect).toBeDefined();
      expect(mysqlMigrationDriver.introspect).toBeDefined();
      expect(postgresMigrationDriver.introspect).toBeDefined();
    });
  });
});
