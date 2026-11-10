/**
 * PostgreSQL DDL Generation Tests
 */

import { VibORMErrorCode } from "@errors";
import { getMigrationDriver } from "@migrations/drivers";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import type { DiffOperation, EnumDependentCheck } from "@src/migrations/types";
import type { ScalarState, ScalarType } from "@src/schema/scalars/common";
import { ddlContext, pgEstateDriver } from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";

// =============================================================================
// HELPERS
// =============================================================================

const RENAME_FIRST = /Push the rename on its own, then the enum change/;

function generateDDL(op: DiffOperation): string {
  return postgresMigrationDriver.generateDDL(op, ddlContext("artifact"));
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
    it("should generate DROP TABLE with no CASCADE (section 6.1)", () => {
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

    it("validates a decimal conversion before the type moves, and never a bare rounding cast", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: {
          name: "amount",
          type: "numeric(10,4)",
          nullable: false,
          decimal: { precision: 10, scale: 4 },
        },
        to: {
          name: "amount",
          type: "NUMERIC(10,2)",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
      };

      // `ALTER ... TYPE numeric(10,2) USING amount::numeric(10,2)` on its own
      // ROUNDS 123.4560 to 123.46 and reports success, which §7.3 forbids
      // outright. The constraint refuses those rows first; because it is only
      // dropped afterwards, no concurrent write can land one while the
      // conversion is in flight. All four statements are one PostgreSQL
      // transaction, so a refusal takes the whole thing back.
      expect(generateDDL(op).split(";\n")).toEqual([
        'LOCK TABLE "ledger" IN ACCESS EXCLUSIVE MODE',
        'ALTER TABLE "ledger" ADD CONSTRAINT "viborm_decimal_s_10_2" CHECK ("amount" IS NULL OR ("amount" NOT IN (\'NaN\'::numeric, \'Infinity\'::numeric, \'-Infinity\'::numeric) AND "amount" = "amount"::NUMERIC(10,2)))',
        'ALTER TABLE "ledger" ALTER COLUMN "amount" TYPE NUMERIC(10,2) USING "amount"::NUMERIC(10,2)',
        'ALTER TABLE "ledger" DROP CONSTRAINT "viborm_decimal_s_10_2"',
      ]);
    });

    it("validates an array's members through the same element cast", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "samples",
        from: {
          name: "samples",
          type: "numeric(10,4)[]",
          nullable: true,
          decimal: { precision: 10, scale: 4 },
        },
        to: {
          name: "samples",
          type: "NUMERIC(10,2)[]",
          nullable: true,
          decimal: { precision: 10, scale: 2 },
        },
      };

      // PostgreSQL compares arrays element-wise by value. The explicit NULL
      // and non-finite member proofs preserve invariants a cast cannot establish.
      expect(generateDDL(op)).toContain(
        'CHECK ("samples" IS NULL OR (array_position("samples", NULL) IS NULL AND array_position("samples", \'NaN\'::numeric) IS NULL AND array_position("samples", \'Infinity\'::numeric) IS NULL AND array_position("samples", \'-Infinity\'::numeric) IS NULL AND "samples" = "samples"::NUMERIC(10,2)[]))'
      );
    });

    it("leaves a non-decimal alteration exactly as it was", () => {
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "text", nullable: false },
        to: { name: "age", type: "integer", nullable: false },
      };

      expect(generateDDL(op)).toBe(
        'ALTER TABLE "users" ALTER COLUMN "age" TYPE integer USING "age"::integer'
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
        tableName: "users",
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

    it("should recreate enum when removing values", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending"],
        newValues: ["active", "inactive"],
        dependentColumns: [
          { tableName: "users", columnName: "status" },
          { tableName: "orders", columnName: "order_status" },
        ],
        // Provide replacement to avoid warning comment
        defaultReplacement: "active",
      };

      const ddl = generateDDL(op);
      const statements = ddl.split(";\n");

      // Should convert columns to text first
      expect(statements[0]).toBe(
        'ALTER TABLE "users" ALTER COLUMN "status" TYPE text USING "status"::text'
      );
      expect(statements[1]).toBe(
        'ALTER TABLE "orders" ALTER COLUMN "order_status" TYPE text USING "order_status"::text'
      );

      // Should UPDATE with default replacement
      expect(statements[2]).toBe(
        `UPDATE "users" SET "status" = 'active' WHERE "status" = 'pending'`
      );
      expect(statements[3]).toBe(
        `UPDATE "orders" SET "order_status" = 'active' WHERE "order_status" = 'pending'`
      );

      // Should drop the old enum
      expect(statements[4]).toBe('DROP TYPE "status"');

      // Should create the new enum with correct values
      expect(statements[5]).toBe(
        "CREATE TYPE \"status\" AS ENUM ('active', 'inactive')"
      );

      // Should convert columns back to enum type
      expect(statements[6]).toBe(
        'ALTER TABLE "users" ALTER COLUMN "status" TYPE "status" USING "status"::"status"'
      );
      expect(statements[7]).toBe(
        'ALTER TABLE "orders" ALTER COLUMN "order_status" TYPE "status" USING "order_status"::"status"'
      );
    });

    it("should recreate enum without dependent columns", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "unused_status",
        removeValues: ["old_value"],
        newValues: ["new_value"],
      };

      const ddl = generateDDL(op);
      const statements = ddl.split(";\n");

      // Should just drop and recreate
      expect(statements[0]).toBe('DROP TYPE "unused_status"');
      expect(statements[1]).toBe(
        "CREATE TYPE \"unused_status\" AS ENUM ('new_value')"
      );
    });

    it("should handle both add and remove values", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        addValues: ["new_value"],
        removeValues: ["old_value"],
        newValues: ["active", "inactive", "new_value"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
      };

      const ddl = generateDDL(op);

      // When removing values, the entire enum must be recreated
      // (addValues is ignored in favor of newValues)
      expect(ddl).toContain('DROP TYPE "status"');
      expect(ddl).toContain(
        "CREATE TYPE \"status\" AS ENUM ('active', 'inactive', 'new_value')"
      );
    });

    it("should throw error when removeValues provided without newValues", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending"],
      };

      expect(() => generateDDL(op)).toThrow(
        'Cannot alter enum "status" without its full destination values'
      );
    });

    it("should generate UPDATE statements for value replacements", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending", "archived"],
        newValues: ["active", "inactive"],
        dependentColumns: [
          { tableName: "users", columnName: "status" },
          { tableName: "orders", columnName: "order_status" },
        ],
        valueReplacements: {
          pending: "active",
          archived: "inactive",
        },
      };

      const ddl = generateDDL(op);
      const statements = ddl.split(";\n");

      // Should have: 2 ALTER to text + 4 UPDATEs (2 values × 2 tables) + DROP + CREATE + 2 ALTER back = 10
      expect(statements).toHaveLength(10);

      // Check UPDATE statements are generated
      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'active' WHERE "status" = 'pending'`
      );
      expect(ddl).toContain(
        `UPDATE "orders" SET "order_status" = 'active' WHERE "order_status" = 'pending'`
      );
      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'inactive' WHERE "status" = 'archived'`
      );
      expect(ddl).toContain(
        `UPDATE "orders" SET "order_status" = 'inactive' WHERE "order_status" = 'archived'`
      );
    });

    it("should handle NULL replacement values", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["deprecated"],
        newValues: ["active", "inactive"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        valueReplacements: {
          deprecated: null,
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        `UPDATE "users" SET "status" = NULL WHERE "status" = 'deprecated'`
      );
    });

    it("should only generate UPDATEs for values with replacements", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending", "archived"],
        newValues: ["active", "inactive"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        valueReplacements: {
          pending: "active",
          // No replacement for 'archived' - will fail at runtime if data exists
        },
      };

      const ddl = generateDDL(op);

      // Should have UPDATE for pending only
      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'active' WHERE "status" = 'pending'`
      );
      expect(ddl).not.toContain(`WHERE "status" = 'archived'`);
    });

    it("should use defaultReplacement for values without explicit mapping", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending", "archived", "deleted"],
        newValues: ["active", "inactive"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        valueReplacements: {
          pending: "inactive", // explicit mapping
        },
        defaultReplacement: "active", // used for archived and deleted
      };

      const ddl = generateDDL(op);

      // pending uses explicit replacement
      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'inactive' WHERE "status" = 'pending'`
      );
      // archived and deleted use defaultReplacement
      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'active' WHERE "status" = 'archived'`
      );
      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'active' WHERE "status" = 'deleted'`
      );
    });

    it("should use defaultReplacement alone without valueReplacements", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending", "archived"],
        newValues: ["active", "inactive"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        defaultReplacement: "active",
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'active' WHERE "status" = 'pending'`
      );
      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'active' WHERE "status" = 'archived'`
      );
    });

    it("should handle null as defaultReplacement", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending"],
        newValues: ["active", "inactive"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        defaultReplacement: null,
      };

      const ddl = generateDDL(op);

      expect(ddl).toContain(
        `UPDATE "users" SET "status" = NULL WHERE "status" = 'pending'`
      );
    });

    it("leaves an unmapped enum value visible to the provider rather than inventing NULL", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending", "archived"],
        newValues: ["active", "inactive"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        valueReplacements: { pending: "active" },
      };
      const ddl = generateDDL(op);
      expect(ddl).toContain(
        `UPDATE "users" SET "status" = 'active' WHERE "status" = 'pending'`
      );
      expect(ddl).not.toContain(`SET "status" = NULL`);
      expect(ddl).not.toContain(`WHERE "status" = 'archived'`);
      // Planning requires complete per-column consent; this low-level DDL
      // remains atomic and the final enum cast refuses an unmapped stored value.
      expect(ddl).toContain('TYPE "status" USING "status"::"status"');
    });

    describe("dependent CHECK constraints", () => {
      const note: EnumDependentCheck = {
        tableName: "items",
        name: "note_of_a",
        definition: `CHECK (((kind <> 'a'::kind) OR (note IS NOT NULL)))`,
        values: ["a"],
      };
      const unchecked: EnumDependentCheck = {
        tableName: "items",
        name: "Unchecked",
        definition: `CHECK ((kind = ANY (ARRAY['a'::kind, 'c'::kind]))) NOT VALID`,
        values: ["a", "c"],
      };
      const removal = (
        dependentChecks: EnumDependentCheck[]
      ): DiffOperation => ({
        type: "alterEnum",
        enumName: "kind",
        removeValues: ["b"],
        newValues: ["a", "c"],
        dependentColumns: [{ tableName: "items", columnName: "kind" }],
        valueReplacements: { b: "a" },
        dependentChecks,
      });

      it("drops each before the text conversion and adds it back, as read, after the cast back", () => {
        const statements = postgresMigrationDriver.compileStatements(
          removal([note, unchecked]),
          ddlContext("live", {
            currentSchema: {
              tables: [
                {
                  name: "items",
                  columns: [
                    { name: "kind", type: "kind", nullable: false },
                    { name: "note", type: "text", nullable: true },
                  ],
                  indexes: [],
                  foreignKeys: [],
                  uniqueConstraints: [],
                },
              ],
              enums: [{ name: "kind", values: ["a", "b", "c"] }],
            },
          })
        );
        expect(statements).toEqual([
          'ALTER TABLE "items" DROP CONSTRAINT "note_of_a"',
          'ALTER TABLE "items" DROP CONSTRAINT "Unchecked"',
          'ALTER TABLE "items" ALTER COLUMN "kind" TYPE text USING "kind"::text',
          `UPDATE "items" SET "kind" = 'a' WHERE "kind" = 'b'`,
          'DROP TYPE "kind"',
          "CREATE TYPE \"kind\" AS ENUM ('a', 'c')",
          'ALTER TABLE "items" ALTER COLUMN "kind" TYPE "kind" USING "kind"::"kind"',
          `ALTER TABLE "items" ADD CONSTRAINT "note_of_a" CHECK (((kind <> 'a'::kind) OR (note IS NOT NULL)))`,
          `ALTER TABLE "items" ADD CONSTRAINT "Unchecked" CHECK ((kind = ANY (ARRAY['a'::kind, 'c'::kind]))) NOT VALID`,
        ]);
      });

      it("leaves them alone when values are only added in place", () => {
        expect(
          generateDDL({
            type: "alterEnum",
            enumName: "kind",
            addValues: ["d"],
            newValues: ["a", "b", "c", "d"],
            dependentColumns: [{ tableName: "items", columnName: "kind" }],
            dependentChecks: [note],
          })
        ).toBe(`ALTER TYPE "kind" ADD VALUE 'd'`);
      });

      it("refuses one naming a removed value, naming the constraint", () => {
        const names = { ...note, values: ["a", "b"] };
        expect(() => generateDDL(removal([names]))).toThrow(
          expect.objectContaining({
            code: VibORMErrorCode.MIGRATION_INVALID_STATE,
            message: expect.stringContaining(
              `CHECK constraint "note_of_a" on "items" names the value 'b'`
            ),
          })
        );
      });

      it("refuses one whose table or columns an earlier rename in the batch moved", () => {
        for (const preceding of [
          { type: "renameTable", from: "items", to: "things" },
          {
            type: "renameColumn",
            tableName: "items",
            from: "note",
            to: "remark",
          },
        ] satisfies DiffOperation[])
          expect(() =>
            postgresMigrationDriver.compileStatements(
              removal([note]),
              ddlContext("live", { precedingOperations: [preceding] })
            )
          ).toThrow(RENAME_FIRST);
      });

      it("reads the values a deparsed definition names as constants of the enum", async () => {
        const rows = [
          [
            "scalar",
            `CHECK (((kind <> 'a'::billing.kind) OR (note IS NOT NULL)))`,
          ],
          [
            "list",
            `CHECK ((kind = ANY (ARRAY['a'::billing.kind, 'it''s'::billing.kind])))`,
          ],
          ["array", `CHECK ((tags @> '{b,"c d"}'::billing.kind[]))`],
          // Text, another type, and a label inside a quoted identifier name none.
          ["text", `CHECK (((kind)::text <> 'x'::text))`],
          ["other", `CHECK ((other <> 'y'::billing.kindred))`],
          ["quoted", `CHECK (("it's 'z'::billing.kind" IS NOT NULL))`],
        ].map(([name, definition]) => ({
          enumName: "kind",
          tableName: "items",
          name,
          definition,
          type: "billing.kind",
        }));
        const seen: unknown[][] = [];
        const checks = await getMigrationDriver(
          pgEstateDriver("billing")
        ).readEnumDependentChecks?.(
          ["kind"],
          async <T>(_: string, params?: unknown[]) => {
            seen.push(params ?? []);
            return { rows: rows as T[] };
          }
        );
        expect(seen).toEqual([["billing", '{"kind"}']]);
        expect(checks?.map(({ name, values }) => [name, values])).toEqual([
          ["scalar", ["a"]],
          ["list", ["a", "it's"]],
          ["array", ["b", "c d"]],
          ["text", []],
          ["other", []],
          ["quoted", []],
        ]);
        expect(checks?.[0]).toEqual({
          enumName: "kind",
          tableName: "items",
          name: "scalar",
          definition: rows[0]?.definition,
          values: ["a"],
        });
      });
    });

    it("should not add warning when all values have replacements", () => {
      const op: DiffOperation = {
        type: "alterEnum",
        enumName: "status",
        removeValues: ["pending"],
        newValues: ["active", "inactive"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        defaultReplacement: "active",
      };

      const ddl = generateDDL(op);

      expect(ddl).not.toContain("-- WARNING:");
    });
  });

  describe("mapScalarType", () => {
    // Helper to create mock scalar with minimal state
    const createMockScalar = (state: any) =>
      ({
        ["~"]: {
          state,
          nativeType: undefined,
        },
      }) as any;

    const createScalarState = <T extends ScalarType>(
      type: T,
      overrides: Partial<ScalarState<T>> = {}
    ): ScalarState<T> => ({
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
      base: {} as never,
      withTimezone: false,
      ...overrides,
    });

    it("should map VibORM types to PostgreSQL types", () => {
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("string")),
          createScalarState("string")
        )
      ).toBe("text");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("int")),
          createScalarState("int")
        )
      ).toBe("integer");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("number")),
          createScalarState("number")
        )
      ).toBe("double precision");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("boolean")),
          createScalarState("boolean")
        )
      ).toBe("boolean");
      // datetime without timezone (default false) -> timestamp
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("datetime")),
          createScalarState("datetime")
        )
      ).toBe("timestamp(3)");
      // datetime with timezone -> timestamptz
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(
            createScalarState("datetime", { withTimezone: true })
          ),
          createScalarState("datetime", { withTimezone: true })
        )
      ).toBe("timestamptz(3)");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("json")),
          createScalarState("json")
        )
      ).toBe("jsonb");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("bigint")),
          createScalarState("bigint")
        )
      ).toBe("bigint");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("vector")),
          createScalarState("vector")
        )
      ).toBe("vector");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("vector", { dimension: 3 })),
          createScalarState("vector", { dimension: 3 })
        )
      ).toBe("vector(3)");
    });

    it("should handle array types", () => {
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("string", { array: true })),
          createScalarState("string", { array: true })
        )
      ).toBe("text[]");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("int", { array: true })),
          createScalarState("int", { array: true })
        )
      ).toBe("integer[]");
    });

    it("should handle auto-increment", () => {
      // mapScalarType returns base type; DDL generator converts to serial/bigserial
      // based on ColumnDef.autoIncrement flag
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(
            createScalarState("int", { autoGenerate: { kind: "increment" } })
          ),
          createScalarState("int", { autoGenerate: { kind: "increment" } })
        )
      ).toBe("integer");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(
            createScalarState("bigint", { autoGenerate: { kind: "increment" } })
          ),
          createScalarState("bigint", { autoGenerate: { kind: "increment" } })
        )
      ).toBe("bigint");
    });

    it("should handle time with and without timezone", () => {
      // time without timezone (default) -> time
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("time")),
          createScalarState("time")
        )
      ).toBe("time(3)");
      // time with timezone -> timetz
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("time", { withTimezone: true })),
          createScalarState("time", { withTimezone: true })
        )
      ).toBe("timetz(3)");
    });
  });
});
