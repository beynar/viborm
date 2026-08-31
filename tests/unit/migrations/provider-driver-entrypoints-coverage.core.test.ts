import { PostgresAdapter } from "@src/adapters/databases/postgres/postgres-adapter";
import { VibORMErrorCode } from "@src/errors";
import { getMigrationDriver } from "@src/migrations/drivers";
import {
  MySQLMigrationDriver,
  mysqlMigrationDriver,
} from "@src/migrations/drivers/mysql";
import {
  PostgresMigrationDriver,
  postgresMigrationDriver,
} from "@src/migrations/drivers/postgres";
import type {
  DiffOperation,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { s } from "@src/schema";
import type { ScalarState } from "@src/schema/scalars";
import { describe, expect, test } from "vitest";
import {
  ddlContext,
  mysqlEstateDriver,
  pgEstateDriver,
  RecordingDriver,
} from "./_estate";

const EMPTY_TABLE: TableDef = {
  name: "account",
  columns: [{ name: "id", type: "integer", nullable: false }],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

describe("provider migration-driver public entrypoints", () => {
  test("MySQL convenience entrypoints preserve compiled statement order", () => {
    const driver = getMigrationDriver(
      mysqlEstateDriver({ namespace: "billing", attested: true })
    );
    const create: DiffOperation = {
      type: "createTable",
      table: {
        ...EMPTY_TABLE,
        primaryKey: { columns: ["id"] },
        uniqueConstraints: [{ name: "account_id_key", columns: ["id"] }],
        foreignKeys: [
          {
            name: "account_parent_fk",
            columns: ["id"],
            referencedTable: "parent",
            referencedColumns: ["id"],
            onDelete: "cascade",
            onUpdate: "setNull",
          },
        ],
      },
    };
    const alter: DiffOperation = {
      type: "alterColumn",
      tableName: "account",
      columnName: "id",
      from: { name: "id", type: "integer", nullable: false },
      to: { name: "id", type: "BIGINT", nullable: false },
    };

    expect(driver.generateCreateTable(create, ddlContext("live"))).toContain(
      "CONSTRAINT `account_id_key` UNIQUE (`id`)"
    );
    expect(driver.generateCreateTable(create, ddlContext("live"))).toContain(
      "ON UPDATE SET NULL"
    );
    expect(driver.generateAlterColumn(alter, ddlContext("live"))).toBe(
      "ALTER TABLE `billing`.`account` MODIFY COLUMN `id` BIGINT NOT NULL"
    );
    expect(driver.generateSelectTarget()).toBe("USE `billing`");
  });

  test("MySQL identifies a decimal-list narrowing as an irreversible inverse", () => {
    const reason = mysqlMigrationDriver.getIrreversibleRollbackReason({
      type: "alterColumn",
      tableName: "account",
      columnName: "amounts",
      from: {
        name: "amounts",
        type: "JSON",
        nullable: false,
        decimal: { precision: 12, scale: 2 },
      },
      to: {
        name: "amounts",
        type: "JSON",
        nullable: false,
        decimal: { precision: 10, scale: 2 },
      },
    });

    expect(reason).toContain("cannot automatically roll back");
  });

  test("MySQL enum entrypoint handles absent and stale catalog context", () => {
    const driver = getMigrationDriver(
      mysqlEstateDriver({ namespace: "billing", attested: true })
    );
    const context = ddlContext("live", {
      currentSchema: {
        tables: [
          {
            ...EMPTY_TABLE,
            columns: [
              {
                name: "state",
                type: "ENUM('active','retired')",
                nullable: false,
                default: "'active'",
              },
            ],
          },
        ],
      },
    });

    expect(
      driver.generateAlterEnum(
        { type: "alterEnum", enumName: "state" },
        context
      )
    ).toContain("no new values provided");
    expect(
      driver.generateAlterEnum(
        { type: "alterEnum", enumName: "state", newValues: ["active"] },
        context
      )
    ).toContain("no dependent columns found");

    const rendered = driver.generateAlterEnum(
      {
        type: "alterEnum",
        enumName: "state",
        newValues: ["active"],
        removeValues: ["retired"],
        dependentColumns: [
          { tableName: "account", columnName: "state" },
          { tableName: "account", columnName: "missing" },
        ],
        columnValueReplacements: {
          "account.state": { retired: null },
        },
      },
      context
    );
    expect(rendered).toContain(
      "UPDATE `billing`.`account` SET `state` = NULL WHERE `state` = 'retired'"
    );
    expect(rendered).toContain("DEFAULT 'active'");
    expect(rendered).toContain('column "missing" not found');
  });

  test("PostgreSQL convenience entrypoints and rename compilation retain estate identity", () => {
    const driver = getMigrationDriver(pgEstateDriver("billing"));
    const create: DiffOperation = {
      type: "createTable",
      table: { ...EMPTY_TABLE, primaryKey: { columns: ["id"] } },
    };
    const alter: DiffOperation = {
      type: "alterColumn",
      tableName: "account",
      columnName: "id",
      from: { name: "id", type: "integer", nullable: false },
      to: {
        name: "id",
        type: "bigint",
        nullable: true,
        default: "7",
      },
    };
    const currentSchema: SchemaSnapshot = {
      tables: [
        {
          ...EMPTY_TABLE,
          primaryKey: { name: "account_pkey", columns: ["id"] },
        },
      ],
    };

    expect(driver.generateCreateTable(create, ddlContext("artifact"))).toBe(
      'CREATE TABLE "billing"."account" (\n  "id" integer NOT NULL,\n  PRIMARY KEY ("id")\n)'
    );
    expect(driver.generateAlterColumn(alter, ddlContext("artifact"))).toContain(
      'ALTER TABLE "billing"."account" ALTER COLUMN "id" TYPE bigint'
    );
    expect(
      driver.compileRenameTable(
        { type: "renameTable", from: "account", to: "customer" },
        ddlContext("live", { currentSchema })
      )
    ).toEqual([
      'ALTER TABLE "billing"."account" RENAME TO "customer"',
      'ALTER TABLE "billing"."customer" RENAME CONSTRAINT "account_pkey" TO "customer_pkey"',
    ]);
    expect(
      driver.generateAlterEnum(
        { type: "alterEnum", enumName: "state", addValues: ["pending"] },
        ddlContext("artifact")
      )
    ).toBe('ALTER TYPE "billing"."state" ADD VALUE \'pending\'');
  });

  test("PostgreSQL delegates predicate canonicalization through the bound table", async () => {
    const execution = pgEstateDriver("billing");
    execution.respond = (sql) =>
      sql.includes("pg_get_viewdef") ? [{ d0: "(active = true)" }] : [];
    const driver = getMigrationDriver(execution);

    await expect(
      driver.canonicalizeIndexPredicates?.(
        "account",
        ["active = true"],
        (sql, params) => execution._executeRaw(sql, params)
      )
    ).resolves.toEqual(["(active = true)"]);
    expect(execution.statements).toContain(
      'CREATE OR REPLACE TEMP VIEW "viborm_index_predicate_0" AS SELECT 1 AS c FROM "billing"."account" WHERE active = true'
    );
  });

  test("PostGIS preflight isolates a provider failure behind its public error", async () => {
    const execution = new RecordingDriver(
      "postgresql",
      "pg",
      new PostgresAdapter("billing", true)
    );
    const driver = getMigrationDriver(execution);
    const pointSnapshot: SchemaSnapshot = {
      tables: [
        {
          ...EMPTY_TABLE,
          columns: [
            {
              name: "location",
              type: "geography(Point,4326)",
              nullable: false,
            },
          ],
        },
      ],
    };
    const providerFailure = new Error("catalog unavailable");
    let providerCalls = 0;

    const failure = await driver
      .preflightSchemaRequirements([pointSnapshot], () => {
        providerCalls += 1;
        return Promise.reject(providerFailure);
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("could not prove"),
    });
    expect(failure).not.toBe(providerFailure);
    expect(String(failure)).not.toContain(providerFailure.message);
    expect(providerCalls).toBe(1);
  });
});

class ExposedMySQLMigrationDriver extends MySQLMigrationDriver {
  booleanDefault(value: boolean): string {
    return this.formatBooleanDefault(value);
  }

  generatedDefault(value: ScalarState["autoGenerate"]): string | undefined {
    return this.getAutoGenerateExpression(value);
  }
}

class ExposedPostgresMigrationDriver extends PostgresMigrationDriver {
  generatedDefault(value: ScalarState["autoGenerate"]): string | undefined {
    return this.getAutoGenerateExpression(value);
  }
}

describe("coverage low value", () => {
  test("covers dialect-specific scalar formatting hooks", () => {
    const mysql = new ExposedMySQLMigrationDriver();
    const postgres = new ExposedPostgresMigrationDriver();

    expect(mysql.booleanDefault(true)).toBe("1");
    expect(mysql.booleanDefault(false)).toBe("0");
    expect(mysql.generatedDefault({ kind: "now" })).toBe("CURRENT_TIMESTAMP");
    expect(mysql.generatedDefault({ kind: "uuid" })).toBeUndefined();
    expect(postgres.generatedDefault({ kind: "uuid" })).toBe(
      "gen_random_uuid()"
    );
    expect(postgres.generatedDefault({ kind: "now" })).toBe("NOW()");
  });

  test("covers native scalar transport spelling", () => {
    const mysqlNative = s.string({ db: "mysql", type: "VARCHAR(17)" });
    const postgresNative = s.string({ db: "pg", type: "citext" }).array();

    expect(
      mysqlMigrationDriver.mapScalarType(mysqlNative, mysqlNative["~"].state)
    ).toBe("VARCHAR(17)");
    expect(
      postgresMigrationDriver.mapScalarType(
        postgresNative,
        postgresNative["~"].state
      )
    ).toBe("citext[]");
  });

  test("refuses structurally impossible auto-increment declarations", () => {
    expect(() =>
      mysqlMigrationDriver.generateCreateTable(
        {
          type: "createTable",
          table: {
            ...EMPTY_TABLE,
            columns: [
              {
                name: "id",
                type: "",
                nullable: false,
                autoIncrement: true,
              },
            ],
          },
        },
        ddlContext("artifact")
      )
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.INVALID_INPUT })
    );
    expect(() =>
      postgresMigrationDriver.generateCreateTable(
        {
          type: "createTable",
          table: {
            ...EMPTY_TABLE,
            columns: [
              {
                name: "id",
                type: "text",
                nullable: false,
                autoIncrement: true,
              },
            ],
          },
        },
        ddlContext("artifact")
      )
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.INVALID_INPUT })
    );
  });

  test("covers malformed lock proofs and unbound MySQL branches", () => {
    expect(postgresMigrationDriver.provesLockReleased([null])).toBe(false);
    expect(postgresMigrationDriver.provesLockReleased([17])).toBe(false);
    expect(mysqlMigrationDriver.generateSelectTarget()).toBeNull();
    expect(() => mysqlMigrationDriver.generateAcquireLock(1)).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_INVALID_STATE })
    );
    expect(() => mysqlMigrationDriver.generateReleaseLock(1)).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.MIGRATION_INVALID_STATE })
    );
    expect(() =>
      Reflect.apply(
        mysqlMigrationDriver.escapeIdentifier,
        mysqlMigrationDriver,
        [null]
      )
    ).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.INVALID_INPUT })
    );
  });

  test("covers optional index and foreign-key clauses", () => {
    const driver = getMigrationDriver(pgEstateDriver("billing"));
    expect(
      driver.generateCreateIndex(
        {
          type: "createIndex",
          tableName: "account",
          index: { name: "account_id_idx", columns: ["id"], unique: false },
        },
        ddlContext("artifact")
      )
    ).toBe('CREATE INDEX "account_id_idx" ON "billing"."account" ("id")');
    expect(
      driver.generateAddForeignKey(
        {
          type: "addForeignKey",
          tableName: "account",
          fk: {
            name: "account_parent_fk",
            columns: ["id"],
            referencedTable: "parent",
            referencedColumns: ["id"],
            onUpdate: "cascade",
          },
        },
        ddlContext("artifact")
      )
    ).toContain("ON UPDATE CASCADE");
  });
});
