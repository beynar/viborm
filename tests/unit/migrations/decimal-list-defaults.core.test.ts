/**
 * Literal fixed-decimal list defaults cross the migration boundary.
 *
 * Core coverage owns deterministic serialization, DDL, and catalog parsing.
 * Live default application and convergence live in
 * `decimal-list-defaults.test.ts`.
 */

import { getMigrationDriver, type MigrationDriver } from "@migrations/drivers";
import { libsqlMigrationDriver } from "@migrations/drivers/libsql";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { serializeModels } from "@migrations/serializer";
import type { ColumnDef, SchemaSnapshot } from "@migrations/types";
import { s } from "@schema";
import v from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, it } from "vitest";
import { d1EstateDriver, ddlContextFor, mysqlEstateDriver } from "./_estate";

const TABLE = "decimal_list_defaults";
const LOGICAL_DEFAULT = ["1.20", "-3.40", "0.00", "90071992547409.93"];
const POSTGRES_DEFAULT = "'{1.20,-3.40,0.00,90071992547409.93}'";
const JSON_DEFAULT = '\'["120","-340","0","9007199254740993"]\'';
const MYSQL_DEFAULT = `(${JSON_DEFAULT})`;

function defaultSchema() {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amounts: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .default(LOGICAL_DEFAULT),
        empty: s.decimal({ precision: 16, scale: 2 }).array().default([]),
        generated: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .default(() => ["4.20"]),
        nullable: s
          .decimal({ precision: 16, scale: 2 })
          .array()
          .nullable()
          .default(null),
        nullableScalar: s
          .decimal({ precision: 16, scale: 2 })
          .nullable()
          .default(null),
      })
      .map(TABLE),
  };
}

function snapshotFor(driver: MigrationDriver): SchemaSnapshot {
  return serializeModels(defaultSchema(), { migrationDriver: driver });
}

function columnsFor(driver: MigrationDriver): Map<string, ColumnDef> {
  const table = snapshotFor(driver).tables[0];
  if (table === undefined) throw new Error("decimal default table is missing");
  return new Map(table.columns.map((column) => [column.name, column]));
}

function createTableSql(driver: MigrationDriver): string {
  const table = snapshotFor(driver).tables[0];
  if (table === undefined) throw new Error("decimal default table is missing");
  return driver.generateDDL(
    { type: "createTable", table },
    ddlContextFor("artifact", { tables: [] })
  );
}

describe("literal decimal-list default serialization", () => {
  it("returns fresh trusted list defaults without exposing retained metadata", () => {
    const amounts = s
      .decimal({ precision: 16, scale: 2 })
      .array()
      .default(["1.20", "-3.40"]);
    const schema = {
      ledger: s.model({ id: s.string().id(), amounts }).map(TABLE),
    };
    const state = amounts["~"].state;
    const create = getScalarSchemas(state).create;
    const priorCreate = v.decimal(state);
    expect(create.acceptsUndefined).toBe(priorCreate.acceptsUndefined);
    for (const direction of ["input", "output"] as const) {
      expect(
        create["~standard"].jsonSchema[direction]({ target: "draft-07" })
      ).toEqual(
        priorCreate["~standard"].jsonSchema[direction]({
          target: "draft-07",
        })
      );
    }

    const first = create["~standard"].validate(undefined);
    if (first.issues) throw new Error(first.issues[0]?.message);
    first.value[0] = "poison";
    const second = create["~standard"].validate(undefined);
    if (second.issues) throw new Error(second.issues[0]?.message);

    expect(second.value).not.toBe(first.value);
    expect(second.value).toEqual(["1.2", "-3.4"]);
    expect(state.default).toEqual(["1.2", "-3.4"]);
    const snapshot = serializeModels(schema, {
      migrationDriver: sqlite3MigrationDriver,
    });
    expect(snapshot.tables[0]?.columns[1]?.default).toBe(`'["120","-340"]'`);
  });

  it("renders native PostgreSQL arrays with scale-preserving members", () => {
    const columns = columnsFor(postgresMigrationDriver);
    expect(columns.get("amounts")?.default).toBe(POSTGRES_DEFAULT);
    expect(columns.get("empty")?.default).toBe("'{}'");
  });

  it("renders coefficient-string JSON on MySQL without admitting generic JSON", () => {
    const columns = columnsFor(mysqlMigrationDriver);
    expect(columns.get("amounts")?.default).toBe(MYSQL_DEFAULT);
    expect(columns.get("empty")?.default).toBe("('[]')");

    const table = snapshotFor(mysqlMigrationDriver).tables[0];
    if (table === undefined)
      throw new Error("decimal default table is missing");
    const genericJson: ColumnDef = {
      name: "generic_json",
      type: "JSON",
      nullable: false,
      default: "('{}')",
    };
    const sql = mysqlMigrationDriver.generateDDL(
      {
        type: "createTable",
        table: { ...table, columns: [...table.columns, genericJson] },
      },
      ddlContextFor("artifact", { tables: [] })
    );
    expect(sql).toContain(`\`amounts\` JSON NOT NULL DEFAULT ${MYSQL_DEFAULT}`);
    expect(sql).toContain("`generic_json` JSON NOT NULL");
    expect(sql).not.toContain("`generic_json` JSON NOT NULL DEFAULT");
  });

  it("renders coefficient-string JSON on SQLite, LibSQL, and D1", () => {
    for (const driver of [
      sqlite3MigrationDriver,
      libsqlMigrationDriver,
      getMigrationDriver(d1EstateDriver()),
    ]) {
      const columns = columnsFor(driver);
      expect(columns.get("amounts")?.default).toBe(JSON_DEFAULT);
      expect(columns.get("empty")?.default).toBe("'[]'");
    }
  });

  it("keeps function defaults application-only and provider-readable null defaults", () => {
    for (const driver of [postgresMigrationDriver, sqlite3MigrationDriver]) {
      const columns = columnsFor(driver);
      expect(columns.get("generated")?.default).toBeUndefined();
      expect(columns.get("nullable")?.default).toBe("NULL");
      expect(columns.get("nullableScalar")?.default).toBe("NULL");
    }

    const mysqlColumns = columnsFor(mysqlMigrationDriver);
    expect(mysqlColumns.get("generated")?.default).toBeUndefined();
    expect(mysqlColumns.get("nullable")?.default).toBeUndefined();
    expect(mysqlColumns.get("nullableScalar")?.default).toBeUndefined();
  });
});

describe("literal decimal-list default DDL", () => {
  it("emits the exact provider expressions", () => {
    expect(createTableSql(postgresMigrationDriver)).toContain(
      `"amounts" NUMERIC(16,2)[] NOT NULL DEFAULT ${POSTGRES_DEFAULT}`
    );
    expect(createTableSql(mysqlMigrationDriver)).toContain(
      `\`amounts\` JSON NOT NULL DEFAULT ${MYSQL_DEFAULT}`
    );
    for (const driver of [sqlite3MigrationDriver, libsqlMigrationDriver]) {
      expect(createTableSql(driver)).toContain(
        `"amounts" TEXT NOT NULL DEFAULT ${JSON_DEFAULT}`
      );
    }
  });
});

interface CatalogCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function mysqlCatalog(
  defaultValue: string,
  comment: string
): {
  readonly calls: CatalogCall[];
  readonly read: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
} {
  const calls: CatalogCall[] = [];
  return {
    calls,
    read<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params: params ?? [] });
      let answers: unknown[] = [];
      if (sql.includes("information_schema.SCHEMATA")) {
        answers = [{ SCHEMA_NAME: "billing" }];
      } else if (sql.includes("information_schema.TABLES")) {
        answers = [{ TABLE_NAME: TABLE }];
      } else if (sql.includes("information_schema.COLUMNS")) {
        answers = [
          {
            TABLE_NAME: TABLE,
            COLUMN_NAME: "amounts",
            DATA_TYPE: "json",
            COLUMN_TYPE: "json",
            IS_NULLABLE: "NO",
            COLUMN_DEFAULT: defaultValue,
            CHARACTER_MAXIMUM_LENGTH: null,
            NUMERIC_PRECISION: null,
            NUMERIC_SCALE: null,
            EXTRA: "DEFAULT_GENERATED",
            COLUMN_COMMENT: comment,
          },
        ];
      }
      const rows: T[] = [];
      for (const answer of answers) {
        rows.push(Object.assign(Object.create(null), answer));
      }
      return Promise.resolve({ rows });
    },
  };
}

describe("provider default introspection", () => {
  it("normalizes only MySQL's owned decimal-list catalog spelling", async () => {
    const catalog = mysqlCatalog(
      `_utf8mb4\\'["120","-340","0","9007199254740993"]\\'`,
      "viborm:decimal(16,2)"
    );
    const driver = getMigrationDriver(
      mysqlEstateDriver({ namespace: "billing", attested: true })
    );
    const snapshot = await driver.introspect(catalog.read);
    expect(snapshot.tables[0]?.columns[0]?.default).toBe(MYSQL_DEFAULT);

    const generic = mysqlCatalog(`_utf8mb4\\'["120","-340"]\\'`, "");
    const genericSnapshot = await driver.introspect(generic.read);
    expect(genericSnapshot.tables[0]?.columns[0]?.default).toBe(
      `_utf8mb4\\'["120","-340"]\\'`
    );

    const respelled = mysqlCatalog(
      `_utf8mb4\\'[ "120", "-340" ]\\'`,
      "viborm:decimal(16,2)"
    );
    const respelledSnapshot = await driver.introspect(respelled.read);
    expect(respelledSnapshot.tables[0]?.columns[0]?.default).toBe(
      `_utf8mb4\\'[ "120", "-340" ]\\'`
    );
  });
});
