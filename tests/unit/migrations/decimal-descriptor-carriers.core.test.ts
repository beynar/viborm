/**
 * Deterministic fixed-decimal carrier contracts.
 *
 * These tests exercise parsers and DDL renderers only. Live SQLite and PGlite
 * lifecycle contracts live in decimal-descriptor-carriers.test.ts.
 */

import { readMysqlDecimalListMarker } from "@migrations/decimal";
import { getMigrationDriver } from "@migrations/drivers";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { readSqliteDecimalConstraint } from "@migrations/drivers/sqlite/decimal";
import { skipSqlNonStructuralRegion } from "@migrations/drivers/sqlite/sql-lexing";
import type { DiffOperation, SchemaSnapshot } from "@migrations/types";
import { describe, expect, it } from "vitest";
import { d1EstateDriver, ddlContext, ddlContextFor } from "./_estate";

const esc = (name: string) => `"${name.replace(/"/g, '""')}"`;
const dec = (precision: number, scale: number) => ({ precision, scale });
const sqliteColumn = (name: string, type = "INTEGER", nullable = true) => ({
  name,
  type,
  nullable,
});
const ORPHANED_CARRIER = /viborm_decimal_amount_10_2/;
const SQUATTED_CARRIER = /viborm_decimal_qty_4_1/;
const BATCH_SUBSTRATE = /one native batch/;
const TARGET_DOMAIN = /precision 10, scale 4/;
const SCALAR_WORD = /scalar/;
const LIST_WORD = /list/;
const AMBIGUOUS_CARRIER = /more than one fixed-decimal descriptor/i;
const INVALID_STORED_DESCRIPTOR = /invalid fixed-decimal descriptor/i;
const REFUSED_BEFORE_EFFECTS = /refused before any statement runs/i;

/** The name on the left of every `"a"."b"` in a rendering. */
const QUALIFIER = /"([^"]*)"\."/g;

describe("the reserved-constraint reader parses clauses, not text", () => {
  function storedConstraint(
    column: string,
    precision: number,
    scale: number
  ): string {
    const bound = (10n ** BigInt(precision) - 1n).toString();
    return (
      `CONSTRAINT "viborm_decimal_${column}_${precision}_${scale}" CHECK ` +
      `("${column}" IS NULL OR (typeof("${column}") = 'integer' AND ` +
      `"${column}" BETWEEN -${bound} AND ${bound}))`
    );
  }

  /** Exactly what `generateColumnDef` emits for a nullable scalar. */
  function storedDdl(
    column: string,
    precision: number,
    scale: number,
    extra = ""
  ): string {
    return `CREATE TABLE "t" (${extra}"${column}" INTEGER ${storedConstraint(column, precision, scale)})`;
  }

  it("reads the descriptor this module itself wrote", () => {
    expect(
      readSqliteDecimalConstraint(
        storedDdl("amount", 10, 2),
        sqliteColumn("amount"),
        esc
      )
    ).toEqual(dec(10, 2));
  });

  it("finds every non-structural SQLite region boundary", () => {
    const line = "-- reserved\nCONSTRAINT";
    const block = "/* reserved */CONSTRAINT";
    const unterminatedBlock = "/* reserved";

    expect(skipSqlNonStructuralRegion(line, 0)).toBe(line.indexOf("\n"));
    expect(skipSqlNonStructuralRegion("-- reserved", 0)).toBe(
      "-- reserved".length
    );
    expect(skipSqlNonStructuralRegion(block, 0)).toBe(block.indexOf("*/") + 2);
    expect(skipSqlNonStructuralRegion(unterminatedBlock, 0)).toBe(
      unterminatedBlock.length
    );
    for (const quoted of [
      "'reserved''literal'",
      '"reserved""identifier"',
      "`reserved``identifier`",
      "[reserved identifier]",
    ]) {
      expect(skipSqlNonStructuralRegion(quoted, 0)).toBe(quoted.length);
    }
    expect(skipSqlNonStructuralRegion("CONSTRAINT", 0)).toBe(0);
  });

  it("A3 ignores a string literal that merely spells the reserved name", () => {
    const sql =
      `CREATE TABLE "t" ("note" TEXT DEFAULT 'CONSTRAINT "viborm_decimal_note_10_2" CHECK', ` +
      `"id" TEXT)`;
    expect(
      readSqliteDecimalConstraint(sql, sqliteColumn("note", "TEXT"), esc)
    ).toBeUndefined();
  });

  it("ignores reserved names inside SQL comments", () => {
    const lineComment =
      `CREATE TABLE "t" ("amount" INTEGER, ` +
      `-- CONSTRAINT "viborm_decimal_amount_10_2" CHECK (typeof("amount") = 'integer')\n` +
      `"note" TEXT)`;
    const blockComment =
      `CREATE TABLE "t" ("amount" INTEGER ` +
      `/* CONSTRAINT "viborm_decimal_amount_10_2" CHECK (typeof("amount") = 'integer') */, ` +
      `"note" TEXT)`;

    expect(
      readSqliteDecimalConstraint(lineComment, sqliteColumn("amount"), esc)
    ).toBeUndefined();
    expect(
      readSqliteDecimalConstraint(blockComment, sqliteColumn("amount"), esc)
    ).toBeUndefined();
  });

  it("still refuses a real reserved constraint whose name follows a comment", () => {
    const sql =
      `CREATE TABLE "t" ("amount" INTEGER CONSTRAINT /* trivia */ ` +
      `"viborm_decimal_amount_10_2" CHECK (typeof("amount") = 'integer'))`;

    expect(() =>
      readSqliteDecimalConstraint(
        sql,
        sqliteColumn("amount", "INTEGER", false),
        esc
      )
    ).toThrow(ORPHANED_CARRIER);
  });

  it("A8 is not fooled by a decoy that precedes the real constraint", () => {
    const sql = storedDdl(
      "amount",
      10,
      2,
      `"note" TEXT DEFAULT 'CONSTRAINT "viborm_decimal_amount_99_9"', `
    );
    expect(
      readSqliteDecimalConstraint(sql, sqliteColumn("amount"), esc)
    ).toEqual(dec(10, 2));
  });

  it("A4 refuses a user constraint that squats the reserved namespace", () => {
    const sql = `CREATE TABLE "t" ("qty" TEXT CONSTRAINT "viborm_decimal_qty_4_1" CHECK (length("qty") > 0))`;
    expect(() =>
      readSqliteDecimalConstraint(sql, sqliteColumn("qty", "TEXT"), esc)
    ).toThrow(SQUATTED_CARRIER);
  });

  it.each([
    [0, 0],
    [2, 3],
    [19, 0],
  ])("refuses an invalid reserved descriptor (%i,%i) before re-rendering it", (precision, scale) => {
    const sql = storedDdl("amount", precision, scale);
    expect(() =>
      readSqliteDecimalConstraint(sql, sqliteColumn("amount"), esc)
    ).toThrow(`viborm_decimal_amount_${precision}_${scale}`);
  });

  it("refuses two exact reserved descriptors on one column as ambiguous", () => {
    const sql =
      `CREATE TABLE "t" ("amount" INTEGER ` +
      `${storedConstraint("amount", 10, 2)} ` +
      `${storedConstraint("amount", 12, 2)})`;
    expect(() =>
      readSqliteDecimalConstraint(sql, sqliteColumn("amount"), esc)
    ).toThrow(AMBIGUOUS_CARRIER);
  });

  it("refuses a reserved name bound to a DIFFERENT column than it names", () => {
    // Exactly the state a native `ALTER TABLE … RENAME COLUMN` leaves behind:
    // SQLite rewrites the CHECK body's references and keeps the old name.
    const sql = `CREATE TABLE "t" ("total" INTEGER CONSTRAINT "viborm_decimal_amount_10_2" CHECK (typeof("total") = 'integer'))`;
    expect(() =>
      readSqliteDecimalConstraint(sql, sqliteColumn("total"), esc)
    ).toThrow(ORPHANED_CARRIER);
  });

  it("A5/A6 keeps reading columns whose names embed a prefix or a keyword", () => {
    const embedded = storedDdl("a_9", 10, 2, `"a" INTEGER, `);
    expect(
      readSqliteDecimalConstraint(embedded, sqliteColumn("a"), esc)
    ).toBeUndefined();
    expect(
      readSqliteDecimalConstraint(embedded, sqliteColumn("a_9"), esc)
    ).toEqual(dec(10, 2));

    const keyword = storedDdl("CHECK CONSTRAINT", 10, 2);
    expect(
      readSqliteDecimalConstraint(
        keyword,
        sqliteColumn("CHECK CONSTRAINT"),
        esc
      )
    ).toEqual(dec(10, 2));
  });


});

describe("the MySQL list marker admits only a physical decimal domain", () => {
  it.each([
    "viborm:decimal(0,0)",
    "viborm:decimal(2,3)",
    "viborm:decimal(66,0)",
    "viborm:decimal(35,31)",
    "viborm:decimal(9007199254740992,0)",
    `viborm:decimal(${"9".repeat(400)},0)`,
  ])("refuses the invalid reserved marker %s", (marker) => {
    expect(() => readMysqlDecimalListMarker(marker)).toThrow(
      INVALID_STORED_DESCRIPTOR
    );
  });
});

describe("D1 refuses a relation-bearing decimal reconstruction", () => {
  const related = (amount: Record<string, unknown>): SchemaSnapshot => ({
    tables: [
      {
        name: "ledger",
        columns: [
          { name: "id", type: "INTEGER", nullable: false },
          { name: "amount", type: "INTEGER", nullable: true, ...amount },
        ],
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [],
      },
      {
        name: "entries",
        columns: [{ name: "ledger_id", type: "INTEGER", nullable: false }],
        indexes: [],
        foreignKeys: [
          {
            name: "fk",
            columns: ["ledger_id"],
            referencedTable: "ledger",
            referencedColumns: ["id"],
          },
        ],
        uniqueConstraints: [],
      },
    ],
  });

  it("G2 refuses when the SOURCE side carries no descriptor", () => {
    const driver = d1EstateDriver();
    const op: DiffOperation = {
      type: "alterColumn",
      tableName: "ledger",
      columnName: "amount",
      from: { name: "amount", type: "INTEGER", nullable: true },
      to: {
        name: "amount",
        type: "INTEGER",
        nullable: true,
        decimal: dec(10, 4),
      },
    };
    expect(() =>
      getMigrationDriver(driver).generateDDL(
        op,
        ddlContext("live", { currentSchema: related({}) })
      )
    ).toThrow(BATCH_SUBSTRATE);
  });

  it("still refuses when both sides carry one", () => {
    const driver = d1EstateDriver();
    const op: DiffOperation = {
      type: "alterColumn",
      tableName: "ledger",
      columnName: "amount",
      from: {
        name: "amount",
        type: "INTEGER",
        nullable: true,
        decimal: dec(10, 2),
      },
      to: {
        name: "amount",
        type: "INTEGER",
        nullable: true,
        decimal: dec(10, 4),
      },
    };
    expect(() =>
      getMigrationDriver(driver).generateDDL(
        op,
        ddlContext("live", { currentSchema: related({ decimal: dec(10, 2) }) })
      )
    ).toThrow(TARGET_DOMAIN);
  });

  it("refuses the rename that now rebuilds the table", () => {
    const driver = d1EstateDriver();
    expect(() =>
      getMigrationDriver(driver).generateDDL(
        {
          type: "renameColumn",
          tableName: "ledger",
          from: "amount",
          to: "total",
        },
        ddlContext("live", { currentSchema: related({ decimal: dec(10, 2) }) })
      )
    ).toThrow(BATCH_SUBSTRATE);
  });

  it("does not classify an unrelated reconstruction as a decimal change", () => {
    const driver = d1EstateDriver();
    const current = related({ decimal: dec(10, 2) });
    const ledger = current.tables[0]!;
    ledger.columns.push({ name: "note", type: "TEXT", nullable: true });

    expect(
      getMigrationDriver(driver).generateDDL(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "note",
          from: { name: "note", type: "TEXT", nullable: true },
          to: { name: "note", type: "TEXT", nullable: false },
        },
        ddlContext("live", { currentSchema: current })
      )
    ).toContain('CREATE TABLE "__new_ledger"');
  });

  it("replays a table rename before checking inbound relations", () => {
    const driver = d1EstateDriver();
    const current = related({ decimal: dec(10, 2) });

    expect(() =>
      getMigrationDriver(driver).generateDDL(
        {
          type: "renameColumn",
          tableName: "account",
          from: "amount",
          to: "total",
        },
        ddlContext("live", {
          currentSchema: current,
          precedingOperations: [
            { type: "renameTable", from: "ledger", to: "account" },
          ],
        })
      )
    ).toThrow(BATCH_SUBSTRATE);
  });

  it("refuses an inbound relation created earlier in the same batch", () => {
    const driver = d1EstateDriver();
    const current = related({ decimal: dec(10, 2) });
    current.tables.splice(1, 1);
    const child = related({ decimal: dec(10, 2) }).tables[1]!;

    expect(() =>
      getMigrationDriver(driver).generateDDL(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "amount",
          from: current.tables[0]!.columns[1]!,
          to: {
            ...current.tables[0]!.columns[1]!,
            decimal: dec(10, 4),
          },
        },
        ddlContext("live", {
          currentSchema: current,
          precedingOperations: [{ type: "createTable", table: child }],
        })
      )
    ).toThrow(BATCH_SUBSTRATE);
  });

  it("drops a same-batch relation from the census and keeps it through a rename", () => {
    const current = related({ decimal: dec(10, 2) });
    current.tables.splice(1, 1);
    const untouched = related({ decimal: dec(10, 2) });
    untouched.tables.splice(1, 1);
    const child = related({ decimal: dec(10, 2) }).tables[1]!;
    const alteration: DiffOperation = {
      type: "alterColumn",
      tableName: "ledger",
      columnName: "amount",
      from: current.tables[0]!.columns[1]!,
      to: {
        ...current.tables[0]!.columns[1]!,
        decimal: dec(10, 4),
      },
    };

    const droppedDriver = d1EstateDriver();
    expect(() =>
      getMigrationDriver(droppedDriver).generateDDL(
        alteration,
        ddlContext("live", {
          currentSchema: current,
          precedingOperations: [
            { type: "createTable", table: child },
            { type: "dropTable", tableName: "entries" },
          ],
        })
      )
    ).not.toThrow();

    const renamedDriver = d1EstateDriver();
    expect(() =>
      getMigrationDriver(renamedDriver).generateDDL(
        alteration,
        ddlContext("live", {
          currentSchema: current,
          precedingOperations: [
            { type: "createTable", table: child },
            { type: "renameTable", from: "entries", to: "line_items" },
          ],
        })
      )
    ).toThrow(BATCH_SUBSTRATE);
    expect(current).toEqual(untouched);
  });
});

describe("MySQL adopts a modifier-bearing DECIMAL column", () => {
  const ctx = ddlContext("live");

  it("H4 converges instead of wedging on `decimal(10,2) unsigned`", () => {
    const ddl = mysqlMigrationDriver.generateDDL(
      {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: {
          name: "amount",
          type: "decimal(10,2) unsigned",
          nullable: true,
          decimal: dec(10, 2),
        },
        to: {
          name: "amount",
          type: "DECIMAL(10,2)",
          nullable: true,
          decimal: dec(10, 2),
        },
      },
      ctx
    );
    expect(ddl).toContain("MODIFY COLUMN");
    expect(ddl).toContain("DECIMAL(10,2)");
  });

  it("H5 refuses a storage-shape move without claiming the domain moved", () => {
    let message = "";
    try {
      mysqlMigrationDriver.generateDDL(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "amount",
          from: {
            name: "amount",
            type: "DECIMAL(10,2)",
            nullable: true,
            decimal: dec(10, 2),
          },
          to: {
            name: "amount",
            type: "JSON",
            nullable: true,
            decimal: dec(10, 2),
          },
        },
        ctx
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(
      "from precision 10, scale 2 to precision 10, scale 2"
    );
    // The truthful reason: the storage SHAPE moved, not the domain.
    expect(message).toMatch(SCALAR_WORD);
    expect(message).toMatch(LIST_WORD);
  });
});

describe("MySQL adopts only exact unmarked decimal sources", () => {
  const ctx = ddlContext("live");
  const target = {
    name: "amount",
    type: "DECIMAL(10,2)",
    nullable: true,
    decimal: dec(10, 2),
  } as const;

  it.each([
    "INT",
    "BIGINT",
    "BIGINT UNSIGNED",
  ])("validates %s before adopting it as DECIMAL", (sourceType) => {
    const ddl = mysqlMigrationDriver.generateDDL(
      {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "amount",
        from: { name: "amount", type: sourceType, nullable: true },
        to: target,
      },
      ctx
    );
    expect(ddl.split(";\n")).toEqual([
      "ALTER TABLE `ledger` ADD CONSTRAINT `viborm_decimal_s_10_2` CHECK (`amount` IS NULL OR `amount` = CAST(`amount` AS DECIMAL(10,2)))",
      "ALTER TABLE `ledger` MODIFY COLUMN `amount` DECIMAL(10,2)",
      "ALTER TABLE `ledger` DROP CHECK `viborm_decimal_s_10_2`",
    ]);
  });

  it.each([
    "FLOAT",
    "DOUBLE",
    "TEXT",
    "VARCHAR(255)",
  ])("refuses %s before emitting an implicitly rounding MODIFY", (sourceType) => {
    expect(() =>
      mysqlMigrationDriver.generateDDL(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "amount",
          from: { name: "amount", type: sourceType, nullable: true },
          to: target,
        },
        ctx
      )
    ).toThrow(REFUSED_BEFORE_EFFECTS);
  });

  it("refuses an unmarked JSON source before adopting a decimal-list marker", () => {
    expect(() =>
      mysqlMigrationDriver.generateDDL(
        {
          type: "alterColumn",
          tableName: "ledger",
          columnName: "amounts",
          from: { name: "amounts", type: "JSON", nullable: true },
          to: {
            name: "amounts",
            type: "JSON",
            nullable: true,
            decimal: dec(10, 2),
          },
        },
        ctx
      )
    ).toThrow(REFUSED_BEFORE_EFFECTS);
  });
});

// =============================================================================
// P2-1 — the list conversion's correlated alias is not a namespace
// =============================================================================

describe("a decimal LIST conversion qualifies only its own correlated alias", () => {
  it("F1 renders `json_each` members through an alias, never a namespace", () => {
    const snapshot: SchemaSnapshot = {
      tables: [
        {
          name: "ledger",
          columns: [
            {
              name: "samples",
              type: "TEXT",
              nullable: true,
              decimal: dec(10, 2),
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    const ddl = sqlite3MigrationDriver.generateDDL(
      {
        type: "alterColumn",
        tableName: "ledger",
        columnName: "samples",
        from: {
          name: "samples",
          type: "TEXT",
          nullable: true,
          decimal: dec(10, 2),
        },
        to: {
          name: "samples",
          type: "TEXT",
          nullable: true,
          decimal: dec(10, 4),
        },
      },
      ddlContextFor("artifact", snapshot)
    );
    expect(ddl).toContain("json_each");
    // Every qualifier in the rendering is an alias the same statement opened.
    for (const [, qualifier] of ddl.matchAll(QUALIFIER)) {
      expect(ddl).toContain(`AS "${qualifier}"`);
    }
  });
});
