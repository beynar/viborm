/**
 * SQLite accepts `DDLContext.destination` and ignores it (plan §10 dialect
 * controls, §12.20).
 *
 * SQLite has no namespace, so "live" and "artifact" are the same statement.
 * That is an absence claim, and an absence claim needs a census: this suite
 * walks EVERY operation the dispatcher can route and asserts the two
 * destinations render the same bytes, then asserts the corpus covered every
 * arm — so a future qualification added to one SQLite renderer cannot hide in
 * an operation nobody listed.
 */

import type { DiffOperation, SchemaSnapshot } from "@migrations/types";
import { libsqlMigrationDriver } from "@src/migrations/drivers/libsql";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { describe, expect, it } from "vitest";
import { ddlContextFor } from "./_estate";

const CURRENT: SchemaSnapshot = {
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: "INTEGER", nullable: false },
        { name: "org_id", type: "INTEGER", nullable: false },
        { name: "status", type: "TEXT", nullable: true },
      ],
      primaryKey: { columns: ["id"] },
      indexes: [{ name: "idx_users_org", columns: ["org_id"], unique: false }],
      foreignKeys: [
        {
          name: "users_org_fk",
          columns: ["org_id"],
          referencedTable: "orgs",
          referencedColumns: ["id"],
        },
      ],
      uniqueConstraints: [{ name: "users_status_key", columns: ["status"] }],
    },
  ],
  enums: [{ name: "users_status_enum", values: ["a", "b"] }],
};

const OPERATIONS: DiffOperation[] = [
  {
    type: "createTable",
    table: {
      name: "orgs",
      columns: [{ name: "id", type: "INTEGER", nullable: false }],
      primaryKey: { columns: ["id"] },
      indexes: [{ name: "idx_orgs_id", columns: ["id"], unique: true }],
      foreignKeys: [],
      uniqueConstraints: [],
    },
  },
  { type: "dropTable", tableName: "users" },
  { type: "renameTable", from: "users", to: "accounts" },
  {
    type: "addColumn",
    tableName: "users",
    column: { name: "email", type: "TEXT", nullable: true },
  },
  { type: "dropColumn", tableName: "users", columnName: "status" },
  { type: "renameColumn", tableName: "users", from: "status", to: "state" },
  {
    type: "alterColumn",
    tableName: "users",
    columnName: "status",
    from: { name: "status", type: "TEXT", nullable: true },
    to: { name: "status", type: "TEXT", nullable: false },
  },
  {
    type: "createIndex",
    tableName: "users",
    index: { name: "idx_users_status", columns: ["status"], unique: false },
  },
  { type: "dropIndex", tableName: "users", indexName: "idx_users_org" },
  {
    type: "addForeignKey",
    tableName: "users",
    fk: {
      name: "users_status_fk",
      columns: ["status"],
      referencedTable: "states",
      referencedColumns: ["id"],
    },
  },
  { type: "dropForeignKey", tableName: "users", fkName: "users_org_fk" },
  {
    type: "addUniqueConstraint",
    tableName: "users",
    constraint: { name: "users_org_key", columns: ["org_id"] },
  },
  {
    type: "dropUniqueConstraint",
    tableName: "users",
    constraintName: "users_status_key",
  },
  {
    type: "addPrimaryKey",
    tableName: "users",
    primaryKey: { columns: ["id"] },
  },
  { type: "dropPrimaryKey", tableName: "users", constraintName: "PRIMARY" },
  { type: "createEnum", enumDef: { name: "kind_enum", values: ["x", "y"] } },
  {
    type: "dropEnum",
    enumName: "users_status_enum",
    dependentColumns: [{ tableName: "users", columnName: "status" }],
  },
  {
    type: "alterEnum",
    enumName: "users_status_enum",
    newValues: ["a"],
    removeValues: ["b"],
    dependentColumns: [{ tableName: "users", columnName: "status" }],
    valueReplacements: { b: "a" },
  },
];

/** Every arm `MigrationDriver.generateDDL` can dispatch to. */
const EVERY_OPERATION_TYPE = [
  "createTable",
  "dropTable",
  "renameTable",
  "addColumn",
  "dropColumn",
  "renameColumn",
  "alterColumn",
  "createIndex",
  "dropIndex",
  "addForeignKey",
  "dropForeignKey",
  "addUniqueConstraint",
  "dropUniqueConstraint",
  "addPrimaryKey",
  "dropPrimaryKey",
  "createEnum",
  "dropEnum",
  "alterEnum",
];

const DRIVERS = [
  { name: "sqlite3", driver: sqlite3MigrationDriver },
  { name: "libsql", driver: libsqlMigrationDriver },
];

describe("SQLite ignores the DDL destination", () => {
  it("covers every dispatched operation", () => {
    expect([...new Set(OPERATIONS.map((op) => op.type))].sort()).toEqual(
      [...EVERY_OPERATION_TYPE].sort()
    );
  });

  for (const { name, driver } of DRIVERS) {
    for (const op of OPERATIONS) {
      it(`${name} renders ${op.type} identically for live and artifact`, () => {
        const live = driver.generateDDL(op, ddlContextFor("live", CURRENT));
        const artifact = driver.generateDDL(
          op,
          ddlContextFor("artifact", CURRENT)
        );
        expect(live).toBe(artifact);
        // A SQLite estate has no database to name, so nothing may ever appear
        // between two quoted identifiers.
        expect(live).not.toContain('"."');
      });
    }

    it(`${name} keeps its tracking and inventory statements destination-free`, () => {
      expect(
        driver.generateCreateTrackingTable("_viborm_migrations")
      ).toContain('"_viborm_migrations"');
      expect(driver.generateSelectAppliedMigrations("_viborm_migrations")).toBe(
        'SELECT name, checksum, applied_at FROM "_viborm_migrations" ORDER BY id ASC'
      );
      expect(driver.generateInsertMigration("_viborm_migrations").sql).toBe(
        'INSERT INTO "_viborm_migrations" (name, checksum) VALUES (?, ?)'
      );
      expect(driver.generateDeleteMigration("_viborm_migrations").sql).toBe(
        'DELETE FROM "_viborm_migrations" WHERE name = ?'
      );
      expect(driver.generateClearMigrations("_viborm_migrations")).toBe(
        'DELETE FROM "_viborm_migrations"'
      );
      expect(driver.generateDropTableSQL("users")).toBe(
        'DROP TABLE IF EXISTS "users"'
      );
      expect(driver.generateInventoryTables().sql).not.toContain('"."');
    });

    it(`${name} proves an absent tracking table positively and never a namespace`, async () => {
      const probe = driver.generateTrackingTableProbe("_viborm_migrations");
      expect(probe?.sql).toContain("sqlite_schema");
      expect(probe?.params).toEqual(["_viborm_migrations"]);

      // The base no-op stands: SQLite has no namespace to prove, so nothing is
      // executed and nothing is refused.
      const calls: string[] = [];
      await driver.proveNamespaceExists((sql) => {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      });
      expect(calls).toEqual([]);
    });
  }
});
