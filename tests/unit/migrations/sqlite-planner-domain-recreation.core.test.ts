import { VibORMErrorCode } from "@src/errors";
import {
  sqlite3MigrationDriver,
  sqliteTableBearsRelations,
} from "@src/migrations/drivers/sqlite";
import type {
  ColumnDef,
  DiffOperation,
  ForeignKeyDef,
  TableDef,
} from "@src/migrations/types";
import { describe, expect, test } from "vitest";
import { ddlContext } from "./_estate";

const ID_COLUMN: ColumnDef = { name: "id", type: "INTEGER", nullable: false };

/** The one table every recreation in this file rebuilds. */
function ledger(column: ColumnDef): TableDef {
  return {
    name: "ledger",
    columns: [ID_COLUMN, column],
    indexes: [],
    foreignKeys: [],
    uniqueConstraints: [],
  };
}

function recreate(from: ColumnDef, to: ColumnDef): readonly string[] {
  const operation: DiffOperation = {
    type: "alterColumn",
    tableName: "ledger",
    columnName: from.name,
    from,
    to,
  };
  return sqlite3MigrationDriver.compileStatements(
    operation,
    ddlContext("live", { currentSchema: { tables: [ledger(from)] } })
  );
}

function refusalFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("the conversion was accepted but a refusal was expected");
}

const DECIMAL_2 = { precision: 10, scale: 2 };
const DECIMAL_4 = { precision: 10, scale: 4 };

describe("SQLite recreation domain conversions", () => {
  test.each([
    {
      name: "an unmarked BLOB column",
      from: { name: "at", type: "BLOB", nullable: true },
      reason: "BLOB storage",
    },
    {
      name: "a fixed-decimal column",
      from: {
        name: "at",
        type: "INTEGER",
        nullable: true,
        decimal: DECIMAL_2,
      },
      reason: "a fixed-decimal domain at",
    },
  ])("refuses to adopt $name as a SQLite DateTime", ({ from, reason }) => {
    const to: ColumnDef = {
      name: "at",
      type: "TEXT",
      nullable: true,
      dateTime: "text",
    };

    expect(refusalFrom(() => recreate(from, to))).toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      message: expect.stringContaining(reason),
    });
  });

  test.each([
    {
      name: "TEXT storage into a scalar domain",
      from: { name: "amount", type: "TEXT", nullable: true },
      to: {
        name: "amount",
        type: "INTEGER",
        nullable: true,
        decimal: DECIMAL_2,
      },
      reason: "unmarked TEXT storage as a fixed-decimal scalar",
    },
    {
      name: "TEXT storage into a list domain",
      from: { name: "amount", type: "TEXT", nullable: true },
      to: { name: "amount", type: "TEXT", nullable: true, decimal: DECIMAL_2 },
      reason: "unmarked TEXT storage as a fixed-decimal list",
    },
  ])("refuses to adopt $name", ({ from, to, reason }) => {
    expect(refusalFrom(() => recreate(from, to))).toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      message: expect.stringContaining(reason),
    });
  });

  test("adopts a scalar INTEGER by rescaling it into the target coefficient", () => {
    const statements = recreate(
      { name: "amount", type: "INTEGER", nullable: true },
      { name: "amount", type: "INTEGER", nullable: true, decimal: DECIMAL_2 }
    );
    const insert = statements.find((statement) =>
      statement.startsWith("INSERT INTO")
    );

    expect(statements[0]).toBe("PRAGMA foreign_keys=OFF");
    expect(statements.at(-1)).toBe("PRAGMA foreign_keys=ON");
    expect(insert).toContain('"amount" * 100');
    expect(insert).toContain('FROM "ledger"');
  });

  test("a move between decimal storage shapes copies the stored value untouched", () => {
    const statements = recreate(
      { name: "amount", type: "INTEGER", nullable: true, decimal: DECIMAL_2 },
      { name: "amount", type: "TEXT", nullable: true, decimal: DECIMAL_4 }
    );
    const insert = statements.find((statement) =>
      statement.startsWith("INSERT INTO")
    );

    expect(insert).toBe(
      'INSERT INTO "__new_ledger" ("id", "amount") SELECT "id", "amount" FROM "ledger"'
    );
    expect(statements).toContain('DROP TABLE "ledger"');
    expect(statements).toContain(
      'ALTER TABLE "__new_ledger" RENAME TO "ledger"'
    );
  });
});

const userTable: TableDef = {
  name: "user",
  columns: [ID_COLUMN],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

const postUserFk: ForeignKeyDef = {
  name: "post_user_fk",
  columns: ["user_id"],
  referencedTable: "user",
  referencedColumns: ["id"],
  onDelete: "cascade",
  onUpdate: "restrict",
};

const postTable: TableDef = {
  name: "post",
  columns: [ID_COLUMN, { name: "user_id", type: "INTEGER", nullable: false }],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
};

const postWithForeignKey: TableDef = {
  ...postTable,
  foreignKeys: [postUserFk],
};

describe("SQLite relation-bearing detection", () => {
  test("a rebuilt definition that already carries a foreign key bears relations", () => {
    expect(sqliteTableBearsRelations("post", [], postWithForeignKey)).toBe(
      true
    );
  });

  test("a table that carries its own outbound foreign key bears relations", () => {
    expect(
      sqliteTableBearsRelations("post", [userTable, postWithForeignKey])
    ).toBe(true);
  });

  test("a foreign key added earlier in the batch makes the referenced table relation-bearing", () => {
    const tables = [userTable, postTable];
    const addForeignKey: DiffOperation = {
      type: "addForeignKey",
      tableName: "post",
      fk: postUserFk,
    };

    expect(sqliteTableBearsRelations("user", tables)).toBe(false);
    expect(
      sqliteTableBearsRelations("user", tables, undefined, [addForeignKey])
    ).toBe(true);
    expect(tables[1]?.foreignKeys).toEqual([]);
  });
});
