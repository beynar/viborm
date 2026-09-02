import { VibORMErrorCode } from "@src/errors";
import {
  getMySQLType,
  getPostgresType,
  getSQLiteType,
  type ScalarTypeContext,
} from "@src/migrations/drivers/type-mapping";
import {
  formatAmbiguousChangeDescription,
  formatDestructiveOperation,
  formatOperation,
  formatOperations,
} from "@src/migrations/push/format";
import type {
  AmbiguousChange,
  ColumnDef,
  DiffOperation,
  TableDef,
} from "@src/migrations/types";
import { describe, expect, test } from "vitest";

const idColumn: ColumnDef = {
  name: "id",
  type: "TEXT",
  nullable: false,
};

const userTable: TableDef = {
  name: "user",
  columns: [idColumn],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

describe("migration operation formatting", () => {
  test.each<{ operation: DiffOperation; text: string }>([
    {
      operation: { type: "createTable", table: userTable },
      text: '+ Create table "user" with 1 columns',
    },
    {
      operation: { type: "dropTable", tableName: "user" },
      text: '- Drop table "user"',
    },
    {
      operation: { type: "renameTable", from: "user", to: "account" },
      text: '~ Rename table "user" → "account"',
    },
    {
      operation: { type: "addColumn", tableName: "user", column: idColumn },
      text: '+ Add column "id" (TEXT) to "user"',
    },
    {
      operation: { type: "dropColumn", tableName: "user", columnName: "id" },
      text: '- Drop column "id" from "user"',
    },
    {
      operation: {
        type: "renameColumn",
        tableName: "user",
        from: "id",
        to: "user_id",
      },
      text: '~ Rename column "id" → "user_id" in "user"',
    },
    {
      operation: {
        type: "alterColumn",
        tableName: "user",
        columnName: "id",
        from: idColumn,
        to: { ...idColumn, type: "INTEGER" },
      },
      text: '~ Alter column "id" in "user"',
    },
    {
      operation: {
        type: "createIndex",
        tableName: "user",
        index: { name: "user_id_idx", columns: ["id"], unique: false },
      },
      text: '+ Create index "user_id_idx" on "user"',
    },
    {
      operation: { type: "dropIndex", tableName: "user", indexName: "idx" },
      text: '- Drop index "idx"',
    },
    {
      operation: {
        type: "addForeignKey",
        tableName: "user",
        fk: {
          name: "user_parent_fk",
          columns: ["id"],
          referencedTable: "user",
          referencedColumns: ["id"],
        },
      },
      text: '+ Add foreign key "user_parent_fk" to "user"',
    },
    {
      operation: {
        type: "dropForeignKey",
        tableName: "user",
        fkName: "user_parent_fk",
      },
      text: '- Drop foreign key "user_parent_fk" from "user"',
    },
    {
      operation: {
        type: "addUniqueConstraint",
        tableName: "user",
        constraint: { name: "user_id_key", columns: ["id"] },
      },
      text: '+ Add unique constraint "user_id_key" to "user"',
    },
    {
      operation: {
        type: "dropUniqueConstraint",
        tableName: "user",
        constraintName: "user_id_key",
      },
      text: '- Drop unique constraint "user_id_key" from "user"',
    },
    {
      operation: {
        type: "addPrimaryKey",
        tableName: "user",
        primaryKey: { columns: ["id"] },
      },
      text: '+ Add primary key to "user"',
    },
    {
      operation: {
        type: "dropPrimaryKey",
        tableName: "user",
        constraintName: "user_pkey",
      },
      text: '- Drop primary key "user_pkey" from "user"',
    },
    {
      operation: {
        type: "createEnum",
        enumDef: { name: "role", values: ["user", "admin"] },
      },
      text: '+ Create enum "role" with values [user, admin]',
    },
    {
      operation: { type: "dropEnum", enumName: "role" },
      text: '- Drop enum "role"',
    },
    {
      operation: {
        type: "alterEnum",
        enumName: "role",
        addValues: ["owner"],
        removeValues: ["admin"],
      },
      text: '~ Alter enum "role" (add: owner; remove: admin)',
    },
    {
      operation: { type: "alterEnum", enumName: "role" },
      text: '~ Alter enum "role" ()',
    },
  ])("formats $operation.type", ({ operation, text }) => {
    expect(formatOperation(operation)).toBe(text);
  });

  test("formats operation collections and the empty plan", () => {
    expect(formatOperations([])).toBe("No changes detected.");
    expect(
      formatOperations([
        { type: "dropTable", tableName: "user" },
        { type: "dropEnum", enumName: "role" },
      ])
    ).toBe('- Drop table "user"\n- Drop enum "role"');
  });

  test.each<{ operation: DiffOperation; text: string }>([
    {
      operation: { type: "dropTable", tableName: "user" },
      text: '[destructive] Drop table "user"',
    },
    {
      operation: { type: "dropColumn", tableName: "user", columnName: "id" },
      text: '[destructive] Drop column "id" from "user"',
    },
    {
      operation: {
        type: "alterColumn",
        tableName: "user",
        columnName: "id",
        from: idColumn,
        to: { ...idColumn, nullable: true },
      },
      text: '[destructive] Alter column "id" in "user"',
    },
    {
      operation: { type: "dropEnum", enumName: "role" },
      text: "[destructive] dropEnum",
    },
  ])("formats destructive $operation.type", ({ operation, text }) => {
    expect(formatDestructiveOperation(operation)).toBe(text);
  });

  test.each<{ change: AmbiguousChange; text: string }>([
    {
      change: {
        type: "ambiguousColumn",
        tableName: "user",
        droppedColumn: idColumn,
        addedColumn: { ...idColumn, name: "user_id" },
      },
      text: '[ambiguous] Column "id" → "user_id" in "user"',
    },
    {
      change: {
        type: "ambiguousTable",
        droppedTable: "user",
        addedTable: "account",
        droppedTableDef: userTable,
        addedTableDef: { ...userTable, name: "account" },
      },
      text: '[ambiguous] Table "user" → "account"',
    },
  ])("formats $change.type", ({ change, text }) => {
    expect(formatAmbiguousChangeDescription(change)).toBe(text);
  });
});

describe("migration scalar type mapping", () => {
  test.each<{
    context: ScalarTypeContext;
    postgres: string;
    sqlite: string;
    mysql: string;
  }>([
    {
      context: { type: "string" },
      postgres: "text",
      sqlite: "TEXT",
      mysql: "TEXT",
    },
    {
      context: { type: "int" },
      postgres: "integer",
      sqlite: "INTEGER",
      mysql: "INT",
    },
    {
      context: { type: "number" },
      postgres: "double precision",
      sqlite: "REAL",
      mysql: "DOUBLE",
    },
    {
      context: { type: "decimal", decimal: { precision: 12, scale: 3 } },
      postgres: "NUMERIC(12,3)",
      sqlite: "INTEGER",
      mysql: "DECIMAL(12,3)",
    },
    {
      context: { type: "boolean" },
      postgres: "boolean",
      sqlite: "INTEGER",
      mysql: "TINYINT(1)",
    },
    {
      context: { type: "datetime" },
      postgres: "timestamp",
      sqlite: "TEXT",
      mysql: "DATETIME(3)",
    },
    {
      context: { type: "datetime", withTimezone: true },
      postgres: "timestamptz",
      sqlite: "TEXT",
      mysql: "DATETIME(3)",
    },
    {
      context: { type: "date" },
      postgres: "date",
      sqlite: "TEXT",
      mysql: "DATE",
    },
    {
      context: { type: "time" },
      postgres: "time",
      sqlite: "TEXT",
      mysql: "TIME(3)",
    },
    {
      context: { type: "time", withTimezone: true },
      postgres: "timetz",
      sqlite: "TEXT",
      mysql: "TIME(3)",
    },
    {
      context: { type: "bigint" },
      postgres: "bigint",
      sqlite: "INTEGER",
      mysql: "BIGINT",
    },
    {
      context: { type: "json" },
      postgres: "jsonb",
      sqlite: "JSON",
      mysql: "JSON",
    },
    {
      context: { type: "blob" },
      postgres: "bytea",
      sqlite: "BLOB",
      mysql: "BLOB",
    },
    {
      context: { type: "vector" },
      postgres: "vector",
      sqlite: "JSON",
      mysql: "JSON",
    },
    {
      context: { type: "vector", dimension: 3 },
      postgres: "vector(3)",
      sqlite: "JSON",
      mysql: "JSON",
    },
    {
      context: { type: "point" },
      postgres: "geography(Point,4326)",
      sqlite: "VIBORM_GEO_TEXT",
      mysql: "POINT SRID 4326",
    },
    {
      context: { type: "enum" },
      postgres: "text",
      sqlite: "TEXT",
      mysql: "TEXT",
    },
  ])("maps $context.type", ({ context, postgres, sqlite, mysql }) => {
    expect(getPostgresType(context)).toBe(postgres);
    expect(getSQLiteType(context)).toBe(sqlite);
    expect(getMySQLType(context)).toBe(mysql);
  });

  test.each([
    [{ type: "int", array: true }, "integer[]", "JSON", "JSON"],
    [
      {
        type: "decimal",
        array: true,
        decimal: { precision: 8, scale: 2 },
      },
      "NUMERIC(8,2)[]",
      "TEXT",
      "JSON",
    ],
  ] satisfies [
    ScalarTypeContext,
    string,
    string,
    string,
  ][])("maps array contexts", (context, postgres, sqlite, mysql) => {
    expect(getPostgresType(context)).toBe(postgres);
    expect(getSQLiteType(context)).toBe(sqlite);
    expect(getMySQLType(context)).toBe(mysql);
  });
});

describe("coverage low value", () => {
  test.each([
    [getPostgresType, "text"],
    [getSQLiteType, "TEXT"],
    [getMySQLType, "TEXT"],
  ])("retains the fallback for an unknown scalar kind", (mapType, expected) => {
    expect(mapType({ type: "unknown" })).toBe(expected);
  });

  test.each([
    getPostgresType,
    getSQLiteType,
    getMySQLType,
  ])("refuses a descriptor-free decimal domain", (mapType) => {
    let caught: unknown;
    try {
      mapType({ type: "decimal" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: VibORMErrorCode.INVALID_INPUT });
  });
});
