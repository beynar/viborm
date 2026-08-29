/**
 * DDL Generation Tests for All Migration Drivers
 *
 * Tests SQLite3, LibSQL, MySQL, and PostgreSQL drivers for DDL generation.
 */

import { getMigrationDriver } from "@src/migrations/drivers";
import { libsqlMigrationDriver } from "@src/migrations/drivers/libsql";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import type { DiffOperation, SchemaSnapshot } from "@src/migrations/types";
import type { ScalarState, ScalarType } from "@src/schema/scalars/common";
import {
  d1EstateDriver,
  ddlContext,
  mysqlEstateDriver,
  pgEstateDriver,
} from "@tests/unit/migrations/_estate";
import { describe, expect, it } from "vitest";

const SQLITE_INLINE_TABLE_PK = /PRIMARY KEY \("id"\)/;
const MYSQL_TEXT_COLUMN_DEFAULT = /`content` TEXT[^)]*DEFAULT/;
const MYSQL_BLOB_COLUMN_DEFAULT = /`data` BLOB[^)]*DEFAULT/;

/** The bounded, database-scoped MySQL lock name (section 3.5), by shape. */
const MYSQL_ACQUIRE_LOCK_SHAPE =
  /^SELECT GET_LOCK\('viborm_migration_billing_[0-9a-f]{8}', 30\) AS acquired$/;
const MYSQL_RELEASE_LOCK_SHAPE =
  /^SELECT RELEASE_LOCK\('viborm_migration_billing_[0-9a-f]{8}'\) AS released$/;
const UNBOUND_LOCK_SCOPE = /not bound to a database/;
/** The two decimal-conversion refusals, by the fact each one names. */
const BATCH_ONLY_SUBSTRATE = /one native batch/;
const IMPLICIT_DDL_COMMIT = /commits each DDL statement/;
const TARGET_DOMAIN = /precision 10, scale 4/;
const SEPARATE_RENAME = /rename.*separate/i;

// =============================================================================
// SQLITE3 DRIVER TESTS
// =============================================================================

describe("SQLite3 DDL Generation", () => {
  function generateDDL(
    op: DiffOperation,
    context?: { currentSchema?: SchemaSnapshot }
  ): string {
    return sqlite3MigrationDriver.generateDDL(
      op,
      ddlContext("artifact", context)
    );
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

      expect(ddl).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
      // Should not have separate table-level PRIMARY KEY clause for single INTEGER autoincrement PK
      expect(ddl).not.toMatch(SQLITE_INLINE_TABLE_PK);
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

  describe("alterColumn (decimal conversion)", () => {
    const decimalSchema = (
      precision: number,
      scale: number,
      type = "INTEGER"
    ): SchemaSnapshot => ({
      tables: [
        {
          name: "ledger",
          columns: [
            { name: "id", type: "INTEGER", nullable: false },
            {
              name: "amount",
              type,
              nullable: false,
              decimal: { precision, scale },
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    });

    function convert(
      from: { precision: number; scale: number },
      to: { precision: number; scale: number },
      type = "INTEGER"
    ): string {
      return generateDDL(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "amount",
          from: { name: "amount", type, nullable: false, decimal: from },
          to: { name: "amount", type, nullable: false, decimal: to },
        },
        { currentSchema: decimalSchema(from.precision, from.scale, type) }
      );
    }

    it("rescales the coefficient when the scale rises, guarded against int64 overflow", () => {
      const ddl = convert(
        { precision: 10, scale: 2 },
        { precision: 10, scale: 4 }
      );
      // The guard is evaluated BEFORE the multiplication: SQLite answers an
      // int64 overflow with a REAL, which is the representation this whole
      // type exists to avoid.
      expect(ddl).toContain(
        `SELECT "id", CASE WHEN "amount" IS NULL THEN NULL WHEN typeof("amount") = 'integer' AND "amount" BETWEEN -99999999 AND 99999999 THEN "amount" * 100 ELSE 'viborm:decimal-out-of-domain' END FROM "ledger"`
      );
    });

    it("requires the dropped digits to be zero when the scale falls", () => {
      const ddl = convert(
        { precision: 10, scale: 4 },
        { precision: 10, scale: 2 }
      );
      expect(ddl).toContain(`"amount" % 100 = 0`);
      expect(ddl).toContain(`THEN "amount" / 100 `);
    });

    it("copies the value unchanged when only the precision moves", () => {
      const ddl = convert(
        { precision: 12, scale: 2 },
        { precision: 10, scale: 2 }
      );
      expect(ddl).toContain(
        `AND "amount" BETWEEN -9999999999 AND 9999999999 THEN "amount" ELSE`
      );
      expect(ddl).not.toContain("% 1 = 0");
    });

    it("leaves an unchanged descriptor as a bare identifier", () => {
      const ddl = generateDDL(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "amount",
          from: {
            name: "amount",
            type: "INTEGER",
            nullable: false,
            decimal: { precision: 10, scale: 2 },
          },
          to: {
            name: "amount",
            type: "INTEGER",
            nullable: true,
            decimal: { precision: 10, scale: 2 },
          },
        },
        { currentSchema: decimalSchema(10, 2) }
      );
      expect(ddl).toContain('SELECT "id", "amount" FROM "ledger"');
      expect(ddl).not.toContain("CASE WHEN");
    });

    it("converts a list member by member, in array order", () => {
      const ddl = convert(
        { precision: 10, scale: 2 },
        { precision: 10, scale: 4 },
        "TEXT"
      );
      // `json_each` reports each member's array position, and the inner
      // ORDER BY is what carries order and duplicates through the aggregate.
      expect(ddl).toContain(
        `FROM json_each("__viborm_source"."amount") AS "m"`
      );
      expect(ddl).toContain(`ORDER BY "m"."key"`);
      expect(ddl).toContain("json_group_array(");
      // The coefficient grammar, in SQL: `012`, `+1`, `-0`, `1.0` and non-
      // numeric text all cast to an integer whose text is not the member.
      expect(ddl).toContain(
        `CAST(CAST("m"."value" AS INTEGER) AS TEXT) = "m"."value"`
      );
      // One bad member routes the WHOLE column, never half of it.
      expect(ddl).toContain("'viborm:decimal-list-out-of-domain'");
    });

    it("never splits a conversion across the statement separator", () => {
      // `push/executor.ts` and `generate/index.ts` both split generated DDL on
      // ";\n", so a conversion carrying that pair would become two broken
      // statements.
      const ddl = convert(
        { precision: 10, scale: 2 },
        { precision: 10, scale: 4 },
        "TEXT"
      );
      for (const statement of ddl.split(";\n")) {
        expect(statement).not.toContain(";");
      }
    });

    it("refuses a relation-bearing rebuild on a batch-only substrate", () => {
      // D1: `PRAGMA foreign_keys=OFF` is a no-op inside a transaction and a
      // batch has no outside to run it in, so the rebuild would drop a table
      // whose references are still enforced.
      const d1 = getMigrationDriver(d1EstateDriver());
      const related: SchemaSnapshot = {
        tables: [
          ...decimalSchema(10, 2).tables,
          {
            name: "entries",
            columns: [{ name: "ledger_id", type: "INTEGER", nullable: false }],
            indexes: [],
            foreignKeys: [
              {
                name: "entries_ledger_fk",
                columns: ["ledger_id"],
                referencedTable: "ledger",
                referencedColumns: ["id"],
              },
            ],
            uniqueConstraints: [],
          },
        ],
      };
      const op: DiffOperation = {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: {
          name: "amount",
          type: "INTEGER",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
        to: {
          name: "amount",
          type: "INTEGER",
          nullable: false,
          decimal: { precision: 10, scale: 4 },
        },
      };

      expect(() =>
        d1.generateDDL(op, ddlContext("live", { currentSchema: related }))
      ).toThrow(BATCH_ONLY_SUBSTRATE);

      // Nothing was rendered, so nothing could have run: the refusal is before
      // effects, and it names the substrate rather than the feature.
      expect(() =>
        d1.generateDDL(op, ddlContext("live", { currentSchema: related }))
      ).toThrow(TARGET_DOMAIN);

      // A table nothing references has nothing the disabled enforcement could
      // damage, so ordinary descriptor changes stay available on D1.
      expect(
        d1.generateDDL(
          op,
          ddlContext("live", { currentSchema: decimalSchema(10, 2) })
        )
      ).toContain('CREATE TABLE "__new_ledger"');
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

    // Plan §10.6: `IndexType` now spells `fulltext`/`spatial` because MySQL's
    // whole round trip already did. The per-dialect refusal is what keeps the
    // widened union honest, and it is stated here rather than assumed.
    it("refuses a fulltext index by name — SQLite has none", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "posts",
        index: {
          name: "idx_posts_body",
          columns: ["body"],
          unique: false,
          type: "fulltext",
        },
      };

      expect(() => generateDDL(op)).toThrow(
        'Index "idx_posts_body" uses unsupported index type "fulltext". Supported types for sqlite: btree'
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

    // Phase 2 Unit 2.2: SQLite has had partial indexes since 3.8.0, but the
    // driver dropped the predicate silently. The index it built then indexed
    // rows the schema excluded, and — because introspection now reads the
    // predicate back — the differ would re-create it on every push forever.
    it("should generate CREATE INDEX with WHERE clause (partial index)", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_active_users",
          columns: ["email"],
          unique: false,
          where: "active = 1",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE INDEX "idx_active_users" ON "users" ("email") WHERE active = 1'
      );
    });

    it("should generate CREATE UNIQUE INDEX with WHERE clause", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_one_active_email",
          columns: ["email"],
          unique: true,
          where: "active = 1",
        },
      };

      const ddl = generateDDL(op);

      expect(ddl).toBe(
        'CREATE UNIQUE INDEX "idx_one_active_email" ON "users" ("email") WHERE active = 1'
      );
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

  // Both pins CHANGED DELIBERATELY: the add used to emit a standalone
  // `CREATE UNIQUE INDEX`, which introspection reads back with `origin = "c"`
  // and files under `indexes`, so the next push planned the add again beside a
  // `dropIndex` on the same name and died on "index already exists"; the drop
  // used to emit `DROP INDEX` on the `sqlite_autoindex_…` name every
  // introspection reports, which SQLite refuses outright. A unique constraint
  // is INLINE in `CREATE TABLE` on SQLite, so both halves go through a table
  // recreation. Behaviour witnessed in `sqlite-unique-constraint.test.ts`.
  const usersSchema: SchemaSnapshot = {
    tables: [
      {
        name: "users",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "email", type: "TEXT", nullable: false },
        ],
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [{ name: "users_email_key", columns: ["email"] }],
      },
    ],
  };

  describe("addUniqueConstraint", () => {
    it("should recreate the table with the constraint inline", () => {
      const op: DiffOperation = {
        type: "addUniqueConstraint",
        tableName: "users",
        constraint: { name: "users_email_key", columns: ["email"] },
      };

      const ddl = generateDDL(op, {
        currentSchema: {
          tables: [{ ...usersSchema.tables[0]!, uniqueConstraints: [] }],
        },
      });

      expect(ddl).toContain('CREATE TABLE "__new_users"');
      expect(ddl).toContain('CONSTRAINT "users_email_key" UNIQUE ("email")');
      expect(ddl).toContain('DROP TABLE "users"');
      expect(ddl).not.toContain("CREATE UNIQUE INDEX");
    });
  });

  describe("dropUniqueConstraint", () => {
    it("should recreate the table without the constraint", () => {
      const op: DiffOperation = {
        type: "dropUniqueConstraint",
        tableName: "users",
        constraintName: "users_email_key",
      };

      const ddl = generateDDL(op, { currentSchema: usersSchema });

      expect(ddl).toContain('CREATE TABLE "__new_users"');
      expect(ddl).not.toContain('CONSTRAINT "users_email_key"');
      expect(ddl).not.toContain("DROP INDEX");
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
    return libsqlMigrationDriver.generateDDL(
      op,
      ddlContext("artifact", context)
    );
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

    it("falls back to table recreation for a decimal descriptor change", () => {
      // The native ALTER rewrites the DECLARATION and copies nothing, and by
      // LibSQL's own contract it validates only rows written afterwards — so
      // every existing coefficient would keep meaning a number at the old
      // scale. §9.6 states it: LibSQL cannot take a native ALTER route that
      // skips conversion.
      const currentSchema: SchemaSnapshot = {
        tables: [
          {
            name: "ledger",
            columns: [
              {
                name: "amount",
                type: "INTEGER",
                nullable: false,
                decimal: { precision: 10, scale: 2 },
              },
            ],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };
      const ddl = generateDDL(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "amount",
          from: {
            name: "amount",
            type: "INTEGER",
            nullable: false,
            decimal: { precision: 10, scale: 2 },
          },
          to: {
            name: "amount",
            type: "INTEGER",
            nullable: false,
            decimal: { precision: 10, scale: 4 },
          },
        },
        { currentSchema }
      );

      expect(ddl).not.toContain("ALTER COLUMN");
      expect(ddl).toContain('CREATE TABLE "__new_ledger"');
      expect(ddl).toContain(`"amount" * 100`);
    });

    it("keeps the reserved CHECK when it rewrites a column for a foreign key", () => {
      // `ALTER COLUMN ... TO` replaces the WHOLE definition, and the reserved
      // constraint is the only carrier of the declared domain on this dialect.
      const currentSchema: SchemaSnapshot = {
        tables: [
          {
            name: "entries",
            columns: [
              {
                name: "amount",
                type: "INTEGER",
                nullable: false,
                decimal: { precision: 10, scale: 2 },
              },
            ],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };
      const ddl = generateDDL(
        {
          type: "addForeignKey",
          tableName: "entries",
          fk: {
            name: "entries_amount_fk",
            columns: ["amount"],
            referencedTable: "buckets",
            referencedColumns: ["id"],
          },
        },
        { currentSchema }
      );

      expect(ddl).toContain('CONSTRAINT "viborm_decimal_amount_10_2" CHECK');
      expect(ddl).toContain("REFERENCES");
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
    return mysqlMigrationDriver.generateDDL(
      op,
      ddlContext("artifact", context)
    );
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
      expect(ddl).toContain("COLLATE=utf8mb4_0900_bin");
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
      expect(ddl).not.toMatch(MYSQL_TEXT_COLUMN_DEFAULT);
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
      expect(ddl).not.toMatch(MYSQL_BLOB_COLUMN_DEFAULT);
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

    it("validates a decimal conversion before the column moves, and releases after", () => {
      const ddl = generateDDL({
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: {
          name: "amount",
          type: "DECIMAL(12,2)",
          nullable: false,
          decimal: { precision: 12, scale: 2 },
        },
        to: {
          name: "amount",
          type: "DECIMAL(10,2)",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
      });

      // The order is the design: the constraint proves every existing row fits
      // BEFORE the column moves — MySQL commits each DDL statement, so there is
      // no boundary to take a bad conversion back — and it is only dropped
      // AFTER, so no concurrent write can land a value the target would round
      // while the conversion is in flight. That is "while writes are excluded"
      // spelled without `LOCK TABLES`, which the artifact classifier refuses.
      expect(ddl.split(";\n")).toEqual([
        "ALTER TABLE `ledger` ADD CONSTRAINT `viborm_decimal_s_10_2` CHECK (`amount` IS NULL OR `amount` = CAST(`amount` AS DECIMAL(10,2)))",
        "ALTER TABLE `ledger` MODIFY COLUMN `amount` DECIMAL(10,2) NOT NULL",
        "ALTER TABLE `ledger` DROP CHECK `viborm_decimal_s_10_2`",
      ]);
      expect(ddl).not.toContain("LOCK TABLES");
    });

    it("refuses a direct rename-plus-conversion shape before rendering its unauthenticatable bracket", () => {
      const operation: DiffOperation = {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: {
          name: "amount",
          type: "DECIMAL(12,2)",
          nullable: false,
          decimal: { precision: 12, scale: 2 },
        },
        to: {
          name: "total",
          type: "DECIMAL(10,2)",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
      };

      expect(() => generateDDL(operation)).toThrow(SEPARATE_RENAME);
    });

    it("takes the ordinary MODIFY when a column stops being a decimal", () => {
      // Losing the decimal nature altogether is a scalar-type change, not a
      // descriptor change: the destructive predicates already gate it, and
      // there is no target domain to validate against. Routing it through the
      // conversion bracket would refuse a change §7.3 never spoke about.
      const ddl = generateDDL({
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: {
          name: "amount",
          type: "DECIMAL(10,2)",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
        to: { name: "amount", type: "TEXT", nullable: false },
      });

      expect(ddl).toBe(
        "ALTER TABLE `ledger` MODIFY COLUMN `amount` TEXT NOT NULL"
      );
    });

    it("refuses a list conversion that would have to rewrite the members", () => {
      const rescale: DiffOperation = {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "samples",
        from: {
          name: "samples",
          type: "JSON",
          nullable: false,
          decimal: { precision: 10, scale: 2 },
        },
        to: {
          name: "samples",
          type: "JSON",
          nullable: false,
          decimal: { precision: 10, scale: 4 },
        },
      };

      // The members are unscaled coefficients, so a different scale makes the
      // same integer name a different number. MySQL has neither a transaction
      // its DDL takes part in nor a CHECK that can quantify over the members of
      // a JSON array, so the rewrite could be neither validated first nor
      // undone after — and it refuses instead of doing it.
      expect(() => generateDDL(rescale)).toThrow(IMPLICIT_DDL_COMMIT);
      expect(() => generateDDL(rescale)).toThrow(TARGET_DOMAIN);
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

    it("should throw error for HASH index type (not supported by InnoDB)", () => {
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

      expect(() => generateDDL(op)).toThrow(
        'Index "idx_users_id" uses unsupported index type "hash"'
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

    it("should throw error when UNIQUE is combined with FULLTEXT", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "posts",
        index: {
          name: "idx_posts_content",
          columns: ["content"],
          unique: true,
          type: "fulltext",
        },
      };

      expect(() => generateDDL(op)).toThrow(
        "Cannot combine UNIQUE with FULLTEXT"
      );
    });

    it("should throw error when UNIQUE is combined with SPATIAL", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "locations",
        index: {
          name: "idx_locations_geo",
          columns: ["geo"],
          unique: true,
          type: "spatial",
        },
      };

      expect(() => generateDDL(op)).toThrow(
        "Cannot combine UNIQUE with SPATIAL"
      );
    });

    // Phase 2 Unit 2.2: MySQL has no partial index. Emitting the index without
    // its predicate would index rows the schema excluded, so the declaration is
    // refused rather than silently reduced.
    it("should throw error for a partial index (no MySQL equivalent)", () => {
      const op: DiffOperation = {
        type: "createIndex",
        tableName: "users",
        index: {
          name: "idx_active_users",
          columns: ["email"],
          unique: false,
          where: "active = 1",
        },
      };

      expect(() => generateDDL(op)).toThrow(
        'Index "idx_active_users" declares a partial index predicate (where: "active = 1"). MySQL does not support partial indexes.'
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

  describe("locking", () => {
    // MySQL named locks are per-SERVER, so the lock identity is derived from
    // the bound DATABASE, not from the numeric id (section 3.5). The unbound
    // singleton has no scope to name and refuses; its scoped-name, collision
    // and result-parsing arms are pinned in
    // `pinned-migration-session.core.test.ts`.
    const lockDriver = getMigrationDriver(
      mysqlEstateDriver({ namespace: "billing", attested: true })
    );

    it("should generate GET_LOCK for acquire, scoped to the bound database", () => {
      const sql = lockDriver.generateAcquireLock(12_345);
      expect(sql).toMatch(MYSQL_ACQUIRE_LOCK_SHAPE);
    });

    it("should generate RELEASE_LOCK for release, on the same name", () => {
      const sql = lockDriver.generateReleaseLock(12_345);
      expect(sql).toMatch(MYSQL_RELEASE_LOCK_SHAPE);
    });

    it("refuses to name a lock for an unbound driver", () => {
      expect(() => mysqlMigrationDriver.generateAcquireLock(12_345)).toThrow(
        UNBOUND_LOCK_SCOPE
      );
    });
  });

  /**
   * MySQL HAS ONE UNIQUE NAMESPACE — the canonicalization that makes a
   * unique-bearing schema converge on a second push.
   *
   * `information_schema` reports a single unique object twice: as a UNIQUE
   * constraint in TABLE_CONSTRAINTS and as its backing index in STATISTICS.
   * Before this canonicalization the differ saw a phantom in whichever bucket
   * the desired schema had not used, and planned a drop for it on EVERY push.
   * Measured on docker MySQL 8 before the fix:
   *   declared unique constraint → [dropIndex "<t>_<cols>_key"]
   *   declared unique index      → [dropUniqueConstraint "<declared name>"]
   * Both are now empty; the live proof is the second-push-empty arm of every
   * MySQL provider contract.
   *
   * These pins own the DESIRED half. The introspection half is pinned by those
   * same provider contracts, which is the only place a real information_schema
   * exists to read.
   */
  describe("unique canonicalization (finalizeTable)", () => {
    const tableWithUnique = {
      name: "widgets",
      columns: [
        { name: "id", type: "VARCHAR(191)", nullable: false },
        { name: "email", type: "VARCHAR(191)", nullable: false },
      ],
      primaryKey: { columns: ["id"] },
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [{ name: "widgets_email_key", columns: ["email"] }],
    };

    it("rewrites a unique constraint into a unique index", () => {
      const finalized = mysqlMigrationDriver.finalizeTable(tableWithUnique);

      expect(finalized.uniqueConstraints).toEqual([]);
      expect(finalized.indexes).toEqual([
        { name: "widgets_email_key", columns: ["email"], unique: true },
      ]);
    });

    it("keeps declared indexes and appends the rewritten uniques after them", () => {
      const finalized = mysqlMigrationDriver.finalizeTable({
        ...tableWithUnique,
        indexes: [
          { name: "widgets_email_idx", columns: ["email"], unique: false },
        ],
      });

      expect(finalized.indexes).toEqual([
        { name: "widgets_email_idx", columns: ["email"], unique: false },
        { name: "widgets_email_key", columns: ["email"], unique: true },
      ]);
    });

    it("never puts two entries under one index name", () => {
      // A schema may spell BOTH a unique constraint and an index under the same
      // name. Two entries with one name put two CREATE INDEX statements into
      // the snapshot, and the second fails the whole push — so the declared
      // index wins and the constraint folds into it.
      const finalized = mysqlMigrationDriver.finalizeTable({
        ...tableWithUnique,
        indexes: [
          { name: "widgets_email_key", columns: ["email"], unique: false },
        ],
      });

      expect(finalized.indexes).toEqual([
        { name: "widgets_email_key", columns: ["email"], unique: false },
      ]);
      expect(finalized.uniqueConstraints).toEqual([]);
    });

    it("still widens TEXT columns that a unique constraint keys", () => {
      // The pre-existing TEXT→VARCHAR(191) rewrite reads `uniqueConstraints`,
      // so it must run against the ORIGINAL table, not the emptied one.
      const finalized = mysqlMigrationDriver.finalizeTable({
        ...tableWithUnique,
        columns: [
          { name: "id", type: "VARCHAR(191)", nullable: false },
          { name: "email", type: "TEXT", nullable: false },
        ],
      });

      expect(
        finalized.columns.find((column) => column.name === "email")?.type
      ).toBe("VARCHAR(191)");
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

  describe("mapScalarType", () => {
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

    it("should map VibORM types to MySQL types", () => {
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("string")),
          createScalarState("string")
        )
      ).toBe("TEXT");
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("int")),
          createScalarState("int")
        )
      ).toBe("INT");
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("number")),
          createScalarState("number")
        )
      ).toBe("DOUBLE");
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("boolean")),
          createScalarState("boolean")
        )
      ).toBe("TINYINT(1)");
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("datetime")),
          createScalarState("datetime")
        )
      ).toBe("DATETIME(3)");
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("json")),
          createScalarState("json")
        )
      ).toBe("JSON");
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("bigint")),
          createScalarState("bigint")
        )
      ).toBe("BIGINT");
    });

    it("should use JSON for array types", () => {
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("string", { array: true })),
          createScalarState("string", { array: true })
        )
      ).toBe("JSON");
      expect(
        mysqlMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("int", { array: true })),
          createScalarState("int", { array: true })
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
    return postgresMigrationDriver.generateDDL(
      op,
      ddlContext("artifact", context)
    );
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

  describe("locking", () => {
    it("should generate pg_advisory_lock for acquire, with a stable alias", () => {
      const sql = postgresMigrationDriver.generateAcquireLock(12_345);
      expect(sql).toBe("SELECT pg_advisory_lock(12345) AS acquired");
    });

    it("should generate pg_advisory_unlock for release, with a stable alias", () => {
      const sql = postgresMigrationDriver.generateReleaseLock(12_345);
      expect(sql).toBe("SELECT pg_advisory_unlock(12345) AS released");
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

  describe("mapScalarType", () => {
    const createMockScalar = (
      state: any,
      nativeType?: { db: string; type: string }
    ) =>
      ({
        ["~"]: {
          state,
          nativeType,
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
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("datetime")),
          createScalarState("datetime")
        )
      ).toBe("timestamp");
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
          createMockScalar(createScalarState("blob")),
          createScalarState("blob")
        )
      ).toBe("bytea");
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("date")),
          createScalarState("date")
        )
      ).toBe("date");
    });

    it("should handle array types with native array syntax", () => {
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

    it("should handle datetime with timezone", () => {
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(
            createScalarState("datetime", { withTimezone: true })
          ),
          createScalarState("datetime", { withTimezone: true })
        )
      ).toBe("timestamptz");
    });

    it("should use native type when specified for PostgreSQL", () => {
      const nativeType = { db: "pg", type: "citext" };
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("string"), nativeType),
          createScalarState("string")
        )
      ).toBe("citext");
    });

    it("should ignore native type for other databases", () => {
      const nativeType = { db: "mysql", type: "VARCHAR(100)" };
      expect(
        postgresMigrationDriver.mapScalarType(
          createMockScalar(createScalarState("string"), nativeType),
          createScalarState("string")
        )
      ).toBe("text");
    });
  });

  // The catalog builders below read the ESTATE's schema, so they are asked of
  // a bound driver. The registered singleton is bound to no estate and refuses
  // rather than inventing one — its own control is in
  // `postgres-namespace.core.test.ts`.
  const boundDriver = getMigrationDriver(pgEstateDriver("billing"));

  // `generateResetSQL()` is gone: §6.2 leaves one live-namespace reset owner
  // (`src/migrations/live-reset.ts`), and the dialect's contribution to it is
  // the bound inventory below plus the drop renderers.

  describe("generateInventoryTables", () => {
    it("should BIND the bound schema into the table inventory", () => {
      const inventory = boundDriver.generateInventoryTables();

      expect(inventory.sql).toContain("information_schema.tables");
      expect(inventory.sql).toContain("pg_catalog.pg_depend");
      expect(inventory.sql).not.toContain("'billing'");
      expect(inventory.params).toEqual(["billing"]);
    });
  });

  describe("generateInventoryEnums", () => {
    it("should BIND the bound schema into the enum inventory", () => {
      const inventory = boundDriver.generateInventoryEnums();

      expect(inventory).not.toBeNull();
      expect(inventory?.sql).toContain("pg_type");
      expect(inventory?.sql).toContain("typtype = 'e'");
      expect(inventory?.sql).not.toContain("'billing'");
      expect(inventory?.params).toEqual(["billing"]);
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
