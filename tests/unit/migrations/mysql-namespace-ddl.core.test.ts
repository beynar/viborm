/**
 * MySQL live-versus-artifact table qualification (plan §5.1).
 *
 * The whole MySQL half of the namespace feature is one decision made in one
 * place: a `"live"` statement names `` `database`.`table` ``, an `"artifact"`
 * statement names the table relative, and a driver with no database renders the
 * relative form for both. These suites pin all three answers for every position
 * §5.1 lists, plus the control/inventory statements that only ever run live.
 */

import { getMigrationDriver } from "@migrations/drivers";
import type { DiffOperation, SchemaSnapshot } from "@migrations/types";
import { createControlTableSQL } from "@src/migrations/control";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { describe, expect, it } from "vitest";
import { ddlContext, ddlContextFor, mysqlEstateDriver } from "./_estate";

const BILLING = getMigrationDriver(
  mysqlEstateDriver({ namespace: "billing", attested: true })
);
const ANALYTICS = getMigrationDriver(
  mysqlEstateDriver({ namespace: "analytics", attested: true })
);
/** The registered singleton is never bound to an estate — §12.21's unbound case. */
const UNBOUND = mysqlMigrationDriver;

const LIVE = ddlContext("live");
const ARTIFACT = ddlContext("artifact");

const usersTable = {
  name: "users",
  columns: [
    { name: "id", type: "INT", nullable: false },
    { name: "org_id", type: "INT", nullable: false },
  ],
  primaryKey: { columns: ["id"], name: "PRIMARY" },
  indexes: [{ name: "idx_users_org", columns: ["org_id"], unique: false }],
  foreignKeys: [
    {
      name: "users_org_fk",
      columns: ["org_id"],
      referencedTable: "orgs",
      referencedColumns: ["id"],
      onDelete: "cascade" as const,
    },
  ],
  uniqueConstraints: [],
};

/**
 * One operation per §5.1 table position. Each entry states the live spelling;
 * the artifact spelling is derived by stripping the two database prefixes, so a
 * renderer that qualified an artifact cannot pass by accident.
 */
const POSITIONS: Array<{ name: string; op: DiffOperation; live: string }> = [
  {
    name: "createTable + its inline REFERENCES and separate CREATE INDEX",
    op: { type: "createTable", table: usersTable },
    live: [
      "CREATE TABLE `billing`.`users` (",
      "  `id` INT NOT NULL,",
      "  `org_id` INT NOT NULL,",
      "  PRIMARY KEY (`id`),",
      "  CONSTRAINT `users_org_fk` FOREIGN KEY (`org_id`) REFERENCES `billing`.`orgs` (`id`) ON DELETE CASCADE",
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;",
      "CREATE INDEX `idx_users_org` ON `billing`.`users` (`org_id`)",
    ].join("\n"),
  },
  {
    name: "dropTable",
    op: { type: "dropTable", tableName: "users" },
    live: "DROP TABLE IF EXISTS `billing`.`users`",
  },
  {
    name: "renameTable qualifies BOTH sides",
    op: { type: "renameTable", from: "users", to: "accounts" },
    live: "RENAME TABLE `billing`.`users` TO `billing`.`accounts`",
  },
  {
    name: "addColumn",
    op: {
      type: "addColumn",
      tableName: "users",
      column: { name: "email", type: "VARCHAR(255)", nullable: false },
    },
    live: "ALTER TABLE `billing`.`users` ADD COLUMN `email` VARCHAR(255) NOT NULL",
  },
  {
    name: "dropColumn",
    op: { type: "dropColumn", tableName: "users", columnName: "email" },
    live: "ALTER TABLE `billing`.`users` DROP COLUMN `email`",
  },
  {
    name: "renameColumn",
    op: {
      type: "renameColumn",
      tableName: "users",
      from: "email",
      to: "mail",
    },
    live: "ALTER TABLE `billing`.`users` RENAME COLUMN `email` TO `mail`",
  },
  {
    name: "alterColumn (MODIFY)",
    op: {
      type: "alterColumn",
      tableName: "users",
      columnName: "email",
      from: { name: "email", type: "VARCHAR(100)", nullable: true },
      to: { name: "email", type: "VARCHAR(255)", nullable: false },
    },
    live: "ALTER TABLE `billing`.`users` MODIFY COLUMN `email` VARCHAR(255) NOT NULL",
  },
  {
    name: "alterColumn (CHANGE, renamed)",
    op: {
      type: "alterColumn",
      tableName: "users",
      columnName: "email",
      from: { name: "email", type: "VARCHAR(255)", nullable: false },
      to: { name: "mail", type: "VARCHAR(255)", nullable: false },
    },
    live: "ALTER TABLE `billing`.`users` CHANGE COLUMN `email` `mail` VARCHAR(255) NOT NULL",
  },
  {
    name: "createIndex keeps a bare index name",
    op: {
      type: "createIndex",
      tableName: "users",
      index: { name: "idx_users_email", columns: ["email"], unique: true },
    },
    live: "CREATE UNIQUE INDEX `idx_users_email` ON `billing`.`users` (`email`)",
  },
  {
    name: "dropIndex qualifies the table, not the index",
    op: {
      type: "dropIndex",
      tableName: "users",
      indexName: "idx_users_email",
    },
    live: "DROP INDEX `idx_users_email` ON `billing`.`users`",
  },
  {
    name: "addForeignKey qualifies both the target and the reference",
    op: {
      type: "addForeignKey",
      tableName: "users",
      fk: {
        name: "users_org_fk",
        columns: ["org_id"],
        referencedTable: "orgs",
        referencedColumns: ["id"],
        onUpdate: "restrict",
      },
    },
    live: "ALTER TABLE `billing`.`users` ADD CONSTRAINT `users_org_fk` FOREIGN KEY (`org_id`) REFERENCES `billing`.`orgs` (`id`) ON UPDATE RESTRICT",
  },
  {
    name: "dropForeignKey",
    op: {
      type: "dropForeignKey",
      tableName: "users",
      fkName: "users_org_fk",
    },
    live: "ALTER TABLE `billing`.`users` DROP FOREIGN KEY `users_org_fk`",
  },
  {
    name: "addUniqueConstraint",
    op: {
      type: "addUniqueConstraint",
      tableName: "users",
      constraint: { name: "users_email_key", columns: ["email"] },
    },
    live: "ALTER TABLE `billing`.`users` ADD CONSTRAINT `users_email_key` UNIQUE (`email`)",
  },
  {
    name: "dropUniqueConstraint",
    op: {
      type: "dropUniqueConstraint",
      tableName: "users",
      constraintName: "users_email_key",
    },
    live: "ALTER TABLE `billing`.`users` DROP INDEX `users_email_key`",
  },
  {
    name: "addPrimaryKey",
    op: {
      type: "addPrimaryKey",
      tableName: "users",
      primaryKey: { columns: ["id"] },
    },
    live: "ALTER TABLE `billing`.`users` ADD PRIMARY KEY (`id`)",
  },
  {
    name: "dropPrimaryKey",
    op: {
      type: "dropPrimaryKey",
      tableName: "users",
      constraintName: "PRIMARY",
    },
    live: "ALTER TABLE `billing`.`users` DROP PRIMARY KEY",
  },
];

/** The artifact spelling of a live string: the same bytes without the database. */
const relative = (live: string): string => live.replaceAll("`billing`.", "");

describe("MySQL live DDL qualifies every §5.1 table position", () => {
  for (const { name, op, live } of POSITIONS) {
    it(`qualifies ${name}`, () => {
      expect(BILLING.generateDDL(op, LIVE)).toBe(live);
    });
  }

  it("quotes the database and the object separately, never as one name", () => {
    const ddl = BILLING.generateDDL(
      { type: "dropTable", tableName: "users" },
      LIVE
    );
    expect(ddl).toContain("`billing`.`users`");
    expect(ddl).not.toContain("`billing.users`");
  });

  it("carries the database into a bound driver's enum replacement UPDATE", () => {
    const currentSchema: SchemaSnapshot = {
      tables: [
        {
          name: "users",
          columns: [{ name: "status", type: "ENUM('a','b')", nullable: true }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    const ddl = BILLING.generateDDL(
      {
        type: "alterEnum",
        enumName: "users$status$enum",
        newValues: ["a"],
        removeValues: ["b"],
        dependentColumns: [{ tableName: "users", columnName: "status" }],
        valueReplacements: { b: "a" },
      },
      ddlContextFor("live", currentSchema)
    );
    expect(ddl).toBe(
      [
        "UPDATE `billing`.`users` SET `status` = 'a' WHERE `status` = 'b';",
        "ALTER TABLE `billing`.`users` MODIFY COLUMN `status` ENUM('a')",
      ].join("\n")
    );
  });
});

describe("MySQL artifacts stay database-relative and portable", () => {
  for (const { name, op, live } of POSITIONS) {
    it(`renders ${name} relative`, () => {
      expect(BILLING.generateDDL(op, ARTIFACT)).toBe(relative(live));
    });
  }

  it("emits identical artifact bytes from two different databases", () => {
    for (const { op } of POSITIONS) {
      expect(ANALYTICS.generateDDL(op, ARTIFACT)).toBe(
        BILLING.generateDDL(op, ARTIFACT)
      );
    }
  });

  it("emits DIFFERENT live bytes from two different databases", () => {
    const op: DiffOperation = { type: "dropTable", tableName: "users" };
    expect(ANALYTICS.generateDDL(op, LIVE)).toBe(
      "DROP TABLE IF EXISTS `analytics`.`users`"
    );
    expect(ANALYTICS.generateDDL(op, LIVE)).not.toBe(
      BILLING.generateDDL(op, LIVE)
    );
  });

  it("names no database anywhere in an artifact", () => {
    for (const { op } of POSITIONS) {
      const artifact = BILLING.generateDDL(op, ARTIFACT);
      expect(artifact).not.toContain("billing");
      expect(artifact).not.toContain("`.`");
    }
  });
});

describe("unbound MySQL output is byte-identical in both destinations", () => {
  for (const { name, op, live } of POSITIONS) {
    it(`renders ${name} bare for live AND artifact`, () => {
      const bare = relative(live);
      expect(UNBOUND.generateDDL(op, ARTIFACT)).toBe(bare);
      expect(UNBOUND.generateDDL(op, LIVE)).toBe(bare);
    });
  }

  it("matches a bound driver's artifact rendering exactly", () => {
    for (const { op } of POSITIONS) {
      expect(UNBOUND.generateDDL(op, LIVE)).toBe(
        BILLING.generateDDL(op, ARTIFACT)
      );
    }
  });
});

describe("MySQL control and inventory statements are live-only", () => {
  it("qualifies the control tables in create and clear", () => {
    const sql = createControlTableSQL(BILLING, "_viborm_migration");
    expect(sql.state).toContain(
      "CREATE TABLE IF NOT EXISTS `billing`.`_viborm_migration_state`"
    );
    expect(sql.log).toContain(
      "CREATE TABLE IF NOT EXISTS `billing`.`_viborm_migration_log`"
    );
    expect(BILLING.generateClearMigrations("_viborm_migration_state")).toBe(
      "DELETE FROM `billing`.`_viborm_migration_state`"
    );
  });

  it("qualifies the reset drop helper and its foreign-key drop", () => {
    // No CASCADE arm survives (§6.1): MySQL parsed it and did nothing, and
    // the containment program now materializes the foreign-key drops instead.
    expect(BILLING.generateDropTableSQL("users")).toBe(
      "DROP TABLE IF EXISTS `billing`.`users`"
    );
    expect(
      BILLING.generateDDL(
        { type: "dropForeignKey", tableName: "users", fkName: "users_org_fk" },
        ddlContext("live")
      )
    ).toBe("ALTER TABLE `billing`.`users` DROP FOREIGN KEY `users_org_fk`");
  });

  it("BINDS the table inventory on the bound database, never DATABASE()", () => {
    const inventory = BILLING.generateInventoryTables();
    expect(inventory.sql).toBe(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
    );
    expect(inventory.sql).not.toContain("DATABASE()");
    expect(inventory.sql).not.toContain("'billing'");
    expect(inventory.params).toEqual(["billing"]);
    expect(ANALYTICS.generateInventoryTables().params).toEqual(["analytics"]);
  });

  it("refuses the inventory outright on an unbound driver", () => {
    // The other arm of the pin above, and the ONE declared exception to the
    // §12.21 unbound byte-freeze (plan §14, 2026-08-27). At baseline this
    // statement read `WHERE TABLE_SCHEMA = DATABASE()` — the ambient default
    // this feature removes — and a vacuous `= NULL` filter would be worse
    // still: `reset` would inventory nothing, drop nothing, and report success
    // over a database it never looked at. No admitted command path reaches an
    // unbound live inventory, so the refusal is what an unreachable arm should
    // do when it is reached anyway.
    let refusal: unknown;
    try {
      UNBOUND.generateInventoryTables();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: "V11009",
      meta: { dialect: "mysql", type: "unbound-database" },
    });
  });

  it("leaves every one of them bare on an unbound driver", () => {
    expect(UNBOUND.generateClearMigrations("_viborm_migration_state")).toBe(
      "DELETE FROM `_viborm_migration_state`"
    );
    expect(UNBOUND.generateDropTableSQL("users")).toBe(
      "DROP TABLE IF EXISTS `users`"
    );
    expect(
      UNBOUND.generateDDL(
        { type: "dropForeignKey", tableName: "users", fkName: "users_org_fk" },
        ddlContext("live")
      )
    ).toBe("ALTER TABLE `users` DROP FOREIGN KEY `users_org_fk`");
  });
});
