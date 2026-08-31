import { VibORMErrorCode } from "@src/errors";
import {
  getMigrationDriver,
  hasMigrationDriver,
  listMigrationDrivers,
  MigrationDriver,
} from "@src/migrations/drivers";
import type {
  AlterEnumOperation,
  CreateTableOperation,
  DDLContext,
} from "@src/migrations/drivers/base";
import { libsqlMigrationDriver } from "@src/migrations/drivers/libsql";
import {
  SQLite3MigrationDriver,
  sqlite3MigrationDriver,
  sqliteTableBearsRelations,
} from "@src/migrations/drivers/sqlite";
import {
  readSqliteDecimalConstraint,
  sqliteColumnDefinitionCarriesDecimalDescriptor,
  sqliteDecimalCheck,
} from "@src/migrations/drivers/sqlite/decimal";
import {
  readSqliteGeoPointColumn,
  SQLITE_GEO_POINT_TYPE,
  sqliteGeoPointCheck,
} from "@src/migrations/drivers/sqlite/geo-point";
import {
  readSqliteIdentifier,
  skipSqlNonStructuralRegion,
} from "@src/migrations/drivers/sqlite/sql-lexing";
import type {
  ColumnDef,
  DiffOperation,
  ForeignKeyDef,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import { d1EstateDriver, ddlContext } from "@tests/unit/migrations/_estate";
import { describe, expect, test } from "vitest";

const escapeIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

const idColumn: ColumnDef = {
  name: "id",
  type: "INTEGER",
  nullable: false,
};

const userTable: TableDef = {
  name: "user",
  columns: [idColumn],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

const foreignKey: ForeignKeyDef = {
  name: "post_user_fk",
  columns: ["user_id"],
  referencedTable: "user",
  referencedColumns: ["id"],
  onDelete: "cascade",
  onUpdate: "restrict",
};

const postTable: TableDef = {
  name: "post",
  columns: [idColumn, { name: "user_id", type: "INTEGER", nullable: false }],
  indexes: [],
  foreignKeys: [foreignKey],
  uniqueConstraints: [],
};

const postSchema: SchemaSnapshot = { tables: [userTable, postTable] };

class BaseMethodProbe extends SQLite3MigrationDriver {
  baseBoolean(value: boolean): string {
    return MigrationDriver.prototype.formatBooleanDefault.call(this, value);
  }

  baseColumnType(column: ColumnDef, context: DDLContext): string {
    return MigrationDriver.prototype.formatColumnType.call(
      this,
      column,
      context
    );
  }

  sqliteBoolean(value: boolean): string {
    return super.formatBooleanDefault(value);
  }
}

describe("migration driver base contracts", () => {
  test("the registry exposes all built-in drivers", () => {
    const names = listMigrationDrivers().map((driver) => driver.driverName);
    expect(names).toEqual(
      expect.arrayContaining(["postgresql", "sqlite3", "libsql", "mysql"])
    );
    expect(hasMigrationDriver("sqlite3")).toBe(true);
    expect(hasMigrationDriver("missing-driver")).toBe(false);
    expect(getMigrationDriver(d1EstateDriver()).driverName).toBe("sqlite3");
  });

  test("base compilation filters provider-empty statements", () => {
    const create: CreateTableOperation = {
      type: "createTable",
      table: userTable,
    };
    const alter: AlterEnumOperation = {
      type: "alterEnum",
      enumName: "role",
    };
    const context = ddlContext("artifact");

    expect(
      MigrationDriver.prototype.compileCreateTable.call(
        sqlite3MigrationDriver,
        create,
        context
      )
    ).toHaveLength(1);
    expect(
      MigrationDriver.prototype.compileAlterEnum.call(
        sqlite3MigrationDriver,
        alter,
        context
      )
    ).toEqual(['-- SQLite: no new values provided for enum "role"']);
  });

  test("base formatting and lock proofs keep conservative defaults", () => {
    const probe = new BaseMethodProbe();
    const context = ddlContext("artifact");
    expect(probe.baseBoolean(true)).toBe("true");
    expect(probe.baseBoolean(false)).toBe("false");
    expect(probe.sqliteBoolean(true)).toBe("1");
    expect(probe.sqliteBoolean(false)).toBe("0");
    expect(probe.baseColumnType(idColumn, context)).toBe("INTEGER");
    expect(
      MigrationDriver.prototype.provesLockAcquired.call(probe, [{ ok: true }])
    ).toBe(false);
    expect(
      MigrationDriver.prototype.provesLockReleased.call(probe, [{ ok: true }])
    ).toBe(false);
    expect(
      MigrationDriver.prototype.generateDropEnumSQL.call(probe, "role")
    ).toBeNull();
  });
});

describe("SQLite recreation boundaries", () => {
  test("replays every preceding table mutation before relation analysis", () => {
    const operations: DiffOperation[] = [
      {
        type: "createTable",
        table: { ...userTable, name: "temporary" },
      },
      { type: "dropTable", tableName: "temporary" },
      { type: "renameTable", from: "unrelated", to: "renamed" },
      {
        type: "renameColumn",
        tableName: "unrelated",
        from: "old",
        to: "new",
      },
      {
        type: "addColumn",
        tableName: "user",
        column: { name: "label", type: "TEXT", nullable: true },
      },
      {
        type: "alterColumn",
        tableName: "user",
        columnName: "label",
        from: { name: "label", type: "TEXT", nullable: true },
        to: { name: "label", type: "TEXT", nullable: false, default: "''" },
      },
      {
        type: "createIndex",
        tableName: "user",
        index: { name: "user_label_idx", columns: ["label"], unique: false },
      },
      {
        type: "addForeignKey",
        tableName: "user",
        fk: { ...foreignKey, name: "self_fk", columns: ["id"] },
      },
      {
        type: "addUniqueConstraint",
        tableName: "user",
        constraint: { name: "user_label_key", columns: ["label"] },
      },
      {
        type: "addPrimaryKey",
        tableName: "user",
        primaryKey: { name: "user_pkey", columns: ["id"] },
      },
      { type: "dropIndex", tableName: "user", indexName: "user_label_idx" },
      { type: "dropForeignKey", tableName: "user", fkName: "self_fk" },
      {
        type: "dropUniqueConstraint",
        tableName: "user",
        constraintName: "user_label_key",
      },
      {
        type: "dropPrimaryKey",
        tableName: "user",
        constraintName: "user_pkey",
      },
      { type: "dropColumn", tableName: "user", columnName: "label" },
    ];

    expect(
      sqliteTableBearsRelations("user", [userTable], undefined, operations)
    ).toBe(false);
  });

  test.each([
    {
      name: "alter column",
      operation: {
        type: "alterColumn",
        tableName: "missing",
        columnName: "id",
        from: idColumn,
        to: { ...idColumn, type: "TEXT" },
      } satisfies DiffOperation,
      message: "Cannot alter column",
    },
    {
      name: "add foreign key",
      operation: {
        type: "addForeignKey",
        tableName: "missing",
        fk: foreignKey,
      } satisfies DiffOperation,
      message: "Cannot add foreign key",
    },
    {
      name: "drop foreign key",
      operation: {
        type: "dropForeignKey",
        tableName: "missing",
        fkName: foreignKey.name,
      } satisfies DiffOperation,
      message: "Cannot drop foreign key",
    },
    {
      name: "add unique constraint",
      operation: {
        type: "addUniqueConstraint",
        tableName: "missing",
        constraint: { name: "missing_key", columns: ["id"] },
      } satisfies DiffOperation,
      message: "Cannot add unique constraint",
    },
    {
      name: "drop unique constraint",
      operation: {
        type: "dropUniqueConstraint",
        tableName: "missing",
        constraintName: "missing_key",
      } satisfies DiffOperation,
      message: "Cannot drop unique constraint",
    },
    {
      name: "add primary key",
      operation: {
        type: "addPrimaryKey",
        tableName: "missing",
        primaryKey: { columns: ["id"] },
      } satisfies DiffOperation,
      message: "Cannot add primary key",
    },
    {
      name: "drop primary key",
      operation: {
        type: "dropPrimaryKey",
        tableName: "missing",
        constraintName: "missing_pkey",
      } satisfies DiffOperation,
      message: "Cannot drop primary key",
    },
  ])("refuses $name without an authenticated current table", ({
    operation,
    message,
  }) => {
    expect(() =>
      sqlite3MigrationDriver.generateDDL(operation, {
        destination: "live",
        currentSchema: { tables: [] },
      })
    ).toThrow(message);
  });

  test("refuses non-integer SQLite auto-increment", () => {
    expect(() =>
      sqlite3MigrationDriver.generateDDL(
        {
          type: "createTable",
          table: {
            ...userTable,
            columns: [
              {
                name: "id",
                type: "TEXT",
                nullable: false,
                autoIncrement: true,
              },
            ],
          },
        },
        ddlContext("live")
      )
    ).toThrow(expect.objectContaining({ code: VibORMErrorCode.INVALID_INPUT }));
  });
});

describe("LibSQL column rewrite boundaries", () => {
  function generate(
    operation: DiffOperation,
    currentSchema: SchemaSnapshot
  ): string {
    return libsqlMigrationDriver.generateDDL(operation, {
      destination: "live",
      currentSchema,
    });
  }

  test("preserves defaults, GeoPoint proof, and both referential actions", () => {
    const location: ColumnDef = {
      name: "location",
      type: SQLITE_GEO_POINT_TYPE,
      nullable: true,
      default: "NULL",
    };
    const schema: SchemaSnapshot = {
      tables: [
        userTable,
        {
          name: "place",
          columns: [idColumn, location],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };

    const ddl = generate(
      {
        type: "addForeignKey",
        tableName: "place",
        fk: {
          ...foreignKey,
          name: "place_location_fk",
          columns: ["location"],
          referencedColumns: ["id"],
        },
      },
      schema
    );

    expect(ddl).toContain("DEFAULT NULL");
    expect(ddl).toContain('CONSTRAINT "viborm_geo" CHECK');
    expect(ddl).toContain("ON DELETE CASCADE");
    expect(ddl).toContain("ON UPDATE RESTRICT");
  });

  test.each([
    {
      name: "missing source table",
      operation: {
        type: "dropForeignKey",
        tableName: "missing",
        fkName: foreignKey.name,
      } satisfies DiffOperation,
      schema: { tables: [] },
      message: 'table "missing" not found',
    },
    {
      name: "missing constraint",
      operation: {
        type: "dropForeignKey",
        tableName: "post",
        fkName: "missing_fk",
      } satisfies DiffOperation,
      schema: postSchema,
      message: 'constraint "missing_fk" not found',
    },
    {
      name: "missing source column on add",
      operation: {
        type: "addForeignKey",
        tableName: "post",
        fk: { ...foreignKey, columns: ["missing"] },
      } satisfies DiffOperation,
      schema: postSchema,
      message: 'column "missing" not found',
    },
    {
      name: "missing source column on drop",
      operation: {
        type: "dropForeignKey",
        tableName: "post",
        fkName: "missing_column_fk",
      } satisfies DiffOperation,
      schema: {
        tables: [
          {
            ...postTable,
            foreignKeys: [
              {
                ...foreignKey,
                name: "missing_column_fk",
                columns: ["missing"],
              },
            ],
          },
        ],
      },
      message: 'column "missing" not found',
    },
  ])("refuses $name", ({ operation, schema, message }) => {
    expect(() => generate(operation, schema)).toThrow(message);
  });

  test("falls back to table recreation for a compound foreign-key drop", () => {
    const compound: ForeignKeyDef = {
      ...foreignKey,
      name: "post_compound_fk",
      columns: ["id", "user_id"],
      referencedColumns: ["id", "id"],
    };
    const schema: SchemaSnapshot = {
      tables: [{ ...postTable, foreignKeys: [compound] }, userTable],
    };

    expect(
      generate(
        {
          type: "dropForeignKey",
          tableName: "post",
          fkName: compound.name,
        },
        schema
      )
    ).toContain('CREATE TABLE "__new_post"');
  });
});

describe("SQLite structural carrier readers", () => {
  test("recognizes only the exact decimal descriptor owned by its column", () => {
    const descriptor = { precision: 10, scale: 2 };
    const column: ColumnDef = {
      name: "amount",
      type: "INTEGER",
      nullable: false,
      decimal: descriptor,
    };
    const check = sqliteDecimalCheck(
      column,
      descriptor,
      "scalar",
      escapeIdentifier
    );
    const sql = `CREATE TABLE "ledger" ("amount" INTEGER NOT NULL ${check})`;

    expect(
      sqliteColumnDefinitionCarriesDecimalDescriptor(sql, column.name)
    ).toBe(true);
    expect(sqliteColumnDefinitionCarriesDecimalDescriptor(sql, "other")).toBe(
      false
    );
    expect(readSqliteDecimalConstraint(sql, column, escapeIdentifier)).toEqual(
      column.decimal
    );
  });

  test("ignores a malformed decimal descriptor tail", () => {
    const sql =
      'CREATE TABLE "ledger" ("amount" INTEGER CONSTRAINT "viborm_decimal_amount_bad" CHECK (1))';
    expect(sqliteColumnDefinitionCarriesDecimalDescriptor(sql, "amount")).toBe(
      false
    );
  });

  test("recognizes a canonical nullable GeoPoint carrier", () => {
    const column: ColumnDef = {
      name: "location",
      type: SQLITE_GEO_POINT_TYPE,
      nullable: true,
    };
    const check = sqliteGeoPointCheck(column, escapeIdentifier);
    const sql = `CREATE TABLE "place" ("location" ${SQLITE_GEO_POINT_TYPE} ${check})`;

    expect(readSqliteGeoPointColumn(sql, column, escapeIdentifier)).toBe(true);
    expect(
      readSqliteGeoPointColumn(
        sql,
        { ...column, type: "TEXT" },
        escapeIdentifier
      )
    ).toBe(false);
  });

  test.each([
    {
      name: "missing proof",
      sql: `CREATE TABLE "place" ("location" ${SQLITE_GEO_POINT_TYPE})`,
    },
    {
      name: "forged proof",
      sql: `CREATE TABLE "place" ("location" ${SQLITE_GEO_POINT_TYPE} CONSTRAINT "viborm_geo" CHECK (1))`,
    },
  ])("refuses a reserved GeoPoint type with $name", ({ sql }) => {
    expect(() =>
      readSqliteGeoPointColumn(
        sql,
        {
          name: "location",
          type: SQLITE_GEO_POINT_TYPE,
          nullable: false,
        },
        escapeIdentifier
      )
    ).toThrow(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
  });
});

describe("SQLite stored-SQL token boundaries", () => {
  test.each([
    ['  -- comment\n"quo""ted" rest', 'quo"ted', true],
    [" /* comment */ [bracketed] rest", "bracketed", true],
    [" bare_name rest", "bare_name", false],
  ])("reads %s", (sql, value, quoted) => {
    expect(readSqliteIdentifier(sql, 0)).toMatchObject({ value, quoted });
  });

  test("refuses an unterminated or absent identifier", () => {
    expect(readSqliteIdentifier('"unterminated', 0)).toBeUndefined();
    expect(readSqliteIdentifier(" +", 0)).toBeUndefined();
  });

  test.each([
    ["'unterminated", 0, "'unterminated".length],
    ['"unterminated', 0, '"unterminated'.length],
    ["/* unterminated", 0, "/* unterminated".length],
  ])("skips the complete unterminated region in %s", (sql, index, end) => {
    expect(skipSqlNonStructuralRegion(sql, index)).toBe(end);
  });
});

describe("coverage low value", () => {
  test("keeps a forged unknown DDL operation fail closed", () => {
    expect(() =>
      Reflect.apply(
        sqlite3MigrationDriver.compileStatements,
        sqlite3MigrationDriver,
        [{ type: "unknown" }, ddlContext("live")]
      )
    ).toThrow(
      expect.objectContaining({ code: VibORMErrorCode.INTERNAL_ERROR })
    );
  });

  test("keeps direct SQLite compatibility renderers aligned with compilation", () => {
    const context = {
      destination: "live",
      currentSchema: postSchema,
    } satisfies DDLContext;
    expect(
      sqlite3MigrationDriver.generateCreateTable(
        { type: "createTable", table: userTable },
        context
      )
    ).toContain('CREATE TABLE "user"');
    expect(
      sqlite3MigrationDriver.generateRenameColumn(
        { type: "renameColumn", tableName: "user", from: "id", to: "key" },
        context
      )
    ).toContain("RENAME COLUMN");
    expect(
      sqlite3MigrationDriver.generateAlterColumn(
        {
          type: "alterColumn",
          tableName: "user",
          columnName: "id",
          from: idColumn,
          to: { ...idColumn, type: "TEXT" },
        },
        context
      )
    ).toContain('CREATE TABLE "__new_user"');
    expect(
      sqlite3MigrationDriver.generateAddForeignKey(
        { type: "addForeignKey", tableName: "post", fk: foreignKey },
        context
      )
    ).toContain('CREATE TABLE "__new_post"');
    expect(
      sqlite3MigrationDriver.generateDropForeignKey(
        {
          type: "dropForeignKey",
          tableName: "post",
          fkName: foreignKey.name,
        },
        context
      )
    ).toContain('CREATE TABLE "__new_post"');
    expect(
      sqlite3MigrationDriver.generateAddUniqueConstraint(
        {
          type: "addUniqueConstraint",
          tableName: "user",
          constraint: { name: "user_id_key", columns: ["id"] },
        },
        context
      )
    ).toContain('CREATE TABLE "__new_user"');
    expect(
      sqlite3MigrationDriver.generateDropUniqueConstraint(
        {
          type: "dropUniqueConstraint",
          tableName: "user",
          constraintName: "user_id_key",
        },
        {
          ...context,
          currentSchema: {
            tables: [
              {
                ...userTable,
                uniqueConstraints: [{ name: "user_id_key", columns: ["id"] }],
              },
            ],
          },
        }
      )
    ).toContain('CREATE TABLE "__new_user"');
    expect(
      sqlite3MigrationDriver.generateAddPrimaryKey(
        {
          type: "addPrimaryKey",
          tableName: "user",
          primaryKey: { columns: ["id"] },
        },
        context
      )
    ).toContain('CREATE TABLE "__new_user"');
    expect(
      sqlite3MigrationDriver.generateDropPrimaryKey(
        {
          type: "dropPrimaryKey",
          tableName: "user",
          constraintName: "user_pkey",
        },
        {
          ...context,
          currentSchema: {
            tables: [
              {
                ...userTable,
                primaryKey: { name: "user_pkey", columns: ["id"] },
              },
            ],
          },
        }
      )
    ).toContain('CREATE TABLE "__new_user"');
    expect(
      sqlite3MigrationDriver.generateDropEnum(
        { type: "dropEnum", enumName: "role" },
        context
      )
    ).toContain("no dependent columns");
    expect(
      sqlite3MigrationDriver.generateAlterEnum(
        { type: "alterEnum", enumName: "role" },
        context
      )
    ).toContain("no new values provided");
  });

  test("keeps direct LibSQL compatibility renderers aligned with compilation", () => {
    const decimalFrom: ColumnDef = {
      name: "amount",
      type: "INTEGER",
      nullable: false,
      decimal: { precision: 10, scale: 2 },
    };
    const decimalTo: ColumnDef = {
      ...decimalFrom,
      decimal: { precision: 10, scale: 4 },
    };
    const ledger: TableDef = {
      ...userTable,
      name: "ledger",
      columns: [decimalFrom],
    };
    expect(
      libsqlMigrationDriver.generateAlterColumn(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "amount",
          from: decimalFrom,
          to: decimalTo,
        },
        {
          destination: "live",
          currentSchema: { tables: [ledger] },
        }
      )
    ).toContain('CREATE TABLE "__new_ledger"');

    const compound: ForeignKeyDef = {
      ...foreignKey,
      name: "post_compound_fk",
      columns: ["id", "user_id"],
      referencedColumns: ["id", "id"],
    };
    const compoundSchema: SchemaSnapshot = {
      tables: [{ ...postTable, foreignKeys: [compound] }, userTable],
    };
    expect(
      libsqlMigrationDriver.generateAddForeignKey(
        { type: "addForeignKey", tableName: "post", fk: compound },
        { destination: "live", currentSchema: compoundSchema }
      )
    ).toContain('CREATE TABLE "__new_post"');
    expect(
      libsqlMigrationDriver.generateDropForeignKey(
        {
          type: "dropForeignKey",
          tableName: "post",
          fkName: compound.name,
        },
        { destination: "live", currentSchema: compoundSchema }
      )
    ).toContain('CREATE TABLE "__new_post"');
  });

  test("keeps malformed empty LibSQL foreign-key arrays fail closed", () => {
    const malformed: DiffOperation = {
      type: "dropForeignKey",
      tableName: "post",
      fkName: "empty_fk",
    };
    const schema: SchemaSnapshot = {
      tables: [
        {
          ...postTable,
          foreignKeys: [{ ...foreignKey, name: "empty_fk", columns: [] }],
        },
      ],
    };
    expect(() =>
      libsqlMigrationDriver.generateDDL(malformed, {
        destination: "live",
        currentSchema: schema,
      })
    ).toThrow("columns array is empty");
  });
});
