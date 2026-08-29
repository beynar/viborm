/**
 * The descriptor's CARRIERS, and what happens when one of them is absent,
 * moved, or forged.
 *
 * §7.2 puts one logical descriptor beside the active physical type, and on
 * three of the four families that descriptor rides in something other than the
 * column type: a reserved SQLite CHECK constraint whose NAME carries the
 * numbers, a MySQL column-comment marker, a PostgreSQL typmod. Every witness
 * here is about the carrier rather than the value:
 *
 * - a RENAME moves the column, so the carrier has to move with it or the next
 *   push reads a column with no domain and reinterprets every stored
 *   coefficient (§7.3: "No descriptor change rounds existing data");
 * - an ABSENT source descriptor is a real transition, not a reason to skip the
 *   conversion — PostgreSQL validates against the target domain alone, SQLite
 *   converts a logical integer into a coefficient, and D1 refuses the rebuild;
 * - a FORGED carrier — a user constraint in VibORM's reserved namespace, or a
 *   string literal that spells one — is refused loudly rather than read as a
 *   descriptor.
 *
 * Live on sqlite3 and PGlite; MySQL's half is a rendering claim.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { readMysqlDecimalListMarker } from "@migrations/decimal";
import { getMigrationDriver } from "@migrations/drivers";
import { mysqlMigrationDriver } from "@migrations/drivers/mysql";
import { sqlite3MigrationDriver } from "@migrations/drivers/sqlite";
import { readSqliteDecimalConstraint } from "@migrations/drivers/sqlite/decimal";
import { skipSqlNonStructuralRegion } from "@migrations/drivers/sqlite/sql-lexing";
import type {
  DiffOperation,
  ResolveChange,
  SchemaSnapshot,
} from "@migrations/types";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { d1EstateDriver, ddlContext, ddlContextFor } from "./_estate";

const esc = (name: string) => `"${name.replace(/"/g, '""')}"`;
const dec = (precision: number, scale: number) => ({ precision, scale });
const sqliteColumn = (name: string, type = "INTEGER", nullable = true) => ({
  name,
  type,
  nullable,
});

/** Refusal fingerprints, hoisted so no matcher builds a regex per call. */
const ORPHANED_CARRIER = /viborm_decimal_amount_10_2/;
const SQUATTED_CARRIER = /viborm_decimal_qty_4_1/;
const BATCH_SUBSTRATE = /one native batch/;
const TARGET_DOMAIN = /precision 10, scale 4/;
const SCALAR_WORD = /scalar/;
const LIST_WORD = /list/;
const AMBIGUOUS_CARRIER = /more than one fixed-decimal descriptor/i;
const INVALID_STORED_DESCRIPTOR = /invalid fixed-decimal descriptor/i;
const UNMARKED_TEXT_STORAGE = /unmarked TEXT storage/i;
const REFUSED_BEFORE_EFFECTS = /refused before any statement runs/i;
const CHANGE_REJECTED = /Change rejected/;

/** The name on the left of every `"a"."b"` in a rendering. */
const QUALIFIER = /"([^"]*)"\."/g;

function ledgerModel(field: string, precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        [field]: s.decimal({ precision, scale }).nullable(),
      })
      .map("carriers"),
  };
}

function tableLedgerModel(table: string, precision: number, scale: number) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amount: s.decimal({ precision, scale }).nullable(),
        label: s.string(),
      })
      .map(table),
  };
}

function nestedRenameLedgerModel(
  table: string,
  field: string,
  precision: number,
  scale: number
) {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        code: s.string().nullable(),
        label: s.string().nullable(),
        state: s.string().nullable(),
        owner: s.string().nullable(),
        created: s.string().nullable(),
        note: s.string().nullable(),
        [field]: s.decimal({ precision, scale }).nullable(),
      })
      .map(table),
  };
}

function renameResolver(seen: string[]) {
  return (change: ResolveChange) => {
    seen.push(`${change.type}:${change.description ?? ""}`);
    if (change.type === "ambiguous") return change.rename();
    if (change.type === "destructive") return change.proceed();
    return change.reject();
  };
}

// =============================================================================
// P0-1 — a renamed decimal column keeps its carrier
// =============================================================================

describe("a decimal column's reserved constraint survives a rename", () => {
  it("renames and converts the carrier in one push, then converges", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: ledgerModel("amount", 10, 2),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "carriers" ("id","amount") VALUES ('a', 12345)`
    );

    // The same logical field, renamed AND rescaled: 12345 means 123.45 at
    // scale 2 and must mean 123.45 at scale 4 too, i.e. 1234500.
    const after = createClient({ schema: ledgerModel("total", 10, 4), driver });
    const seen: string[] = [];
    const rename = await push(after, {
      force: true,
      resolve: renameResolver(seen),
    });
    expect(rename.operations.map((operation) => operation.type)).toEqual([
      "renameColumn",
      "alterColumn",
    ]);

    const renamed = await driver._executeRaw<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='carriers'`
    );
    // The carrier is named after the column it constrains. SQLite rewrites
    // column REFERENCES inside a CHECK on RENAME COLUMN but never a constraint
    // NAME, so the native rename would leave `viborm_decimal_amount_10_2`
    // behind on a column called `total`.
    expect(renamed.rows[0]?.sql).toContain("viborm_decimal_total_10_4");
    expect(renamed.rows[0]?.sql).not.toContain("viborm_decimal_amount_10_2");

    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "carriers"`
    );
    expect(stored.rows[0]?.total).toBe(1_234_500);

    const second = await push(after, { force: true });
    expect(second.operations).toEqual([]);
    expect(seen.map((entry) => entry.split(":", 1)[0])).toEqual([
      "ambiguous",
      "destructive",
    ]);
    await after.$disconnect();
  });

  it("carries a partial-index predicate through the native rename replay", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .index(["amount"], {
            name: "indexed_amount",
            where: '"amount" > 0',
          })
          .map("indexed_carriers"),
      },
      driver,
    });
    await push(before, { force: true });

    const after = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            total: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .index(["total"], {
            name: "indexed_amount",
            where: '"total" > 0',
          })
          .map("indexed_carriers"),
      },
      driver,
    });
    const renamed = await push(after, {
      resolve: (change: ResolveChange) =>
        change.type === "ambiguous" ? change.rename() : change.reject(),
    });

    expect(renamed.operations.map((operation) => operation.type)).toEqual([
      "renameColumn",
    ]);
    const storedIndex = await driver._executeRaw<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='indexed_amount'`
    );
    expect(storedIndex.rows[0]?.sql).toContain('WHERE "total" > 0');
    await after.$disconnect();
  });

  it("refuses loudly when a carrier was orphaned outside VibORM", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: ledgerModel("amount", 10, 2),
      driver,
    });
    await push(client, { force: true });
    await driver._executeRaw(
      `INSERT INTO "carriers" ("id","amount") VALUES ('a', 12345)`
    );
    // SQLite rewrites the CHECK body's column references and leaves the
    // constraint NAME alone, so a hand-run rename detaches the carrier.
    await driver._executeRaw(
      `ALTER TABLE "carriers" RENAME COLUMN "amount" TO "total"`
    );

    const moved = createClient({ schema: ledgerModel("total", 10, 4), driver });
    await expect(push(moved, { force: true })).rejects.toThrow(
      ORPHANED_CARRIER
    );
    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "carriers"`
    );
    expect(stored.rows[0]?.total).toBe(12_345);
    await moved.$disconnect();
  });

  it("converges on the SECOND push when only the name moved", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: ledgerModel("amount", 10, 2),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "carriers" ("id","amount") VALUES ('a', 12345)`
    );

    const after = createClient({ schema: ledgerModel("total", 10, 2), driver });
    const seen: string[] = [];
    await push(after, { force: true, resolve: renameResolver(seen) });

    // §9.6: "Second push is empty on every admitted provider."
    const second = await push(after, { force: true });
    expect(second.operations).toEqual([]);
    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "carriers"`
    );
    expect(stored.rows[0]?.total).toBe(12_345);
    await after.$disconnect();
  });
});

describe("the carrier survives every route that rewrites a column", () => {
  // The reader proves ownership by RE-RENDERING the clause, so a route that
  // re-spells the stored definition would stop it being readable. LibSQL's
  // native `ALTER COLUMN … TO` replaces the whole declaration and is the only
  // route that is not this driver's own `CREATE TABLE`.
  for (const substrate of [
    { name: "sqlite3", create: createInMemorySQLite3Driver },
  ]) {
    it(`${substrate.name} keeps it readable across a nullability change`, async () => {
      const driver = substrate.create();
      const model = (nullable: boolean) => ({
        m: s
          .model({
            id: s.string().id(),
            amount: nullable
              ? s.decimal({ precision: 10, scale: 2 }).nullable()
              : s.decimal({ precision: 10, scale: 2 }),
          })
          .map("nullswap"),
      });
      const before = createClient({ schema: model(true), driver });
      await push(before, { force: true });
      await driver._executeRaw(
        `INSERT INTO "nullswap" ("id","amount") VALUES ('a', 12345)`
      );

      const after = createClient({ schema: model(false), driver });
      await push(after, { force: true });
      // A descriptor the reader can no longer own would re-plan this forever.
      expect((await push(after, { force: true })).operations).toEqual([]);
      const stored = await driver._executeRaw<{ amount: number | bigint }>(
        `SELECT "amount" FROM "nullswap"`
      );
      expect(Number(stored.rows[0]?.amount)).toBe(12_345);
      await after.$disconnect();
    });
  }
});

describe("a renamed table keeps and converts its decimal carrier", () => {
  for (const substrate of [
    { name: "sqlite3", create: createInMemorySQLite3Driver },
  ]) {
    it(`${substrate.name} applies the rename and descriptor change in one push`, async () => {
      const driver = substrate.create();
      const before = createClient({
        schema: tableLedgerModel("ledger_before", 10, 2),
        driver,
      });
      await push(before, { force: true });
      await driver._executeRaw(
        `INSERT INTO "ledger_before" ("id","amount","label") VALUES ('a',12345,'kept')`
      );

      const after = createClient({
        schema: tableLedgerModel("ledger_after", 10, 4),
        driver,
      });
      const seen: string[] = [];
      const first = await push(after, {
        force: true,
        resolve: renameResolver(seen),
      });
      expect(first.operations.map((operation) => operation.type)).toEqual([
        "renameTable",
        "alterColumn",
      ]);
      const stored = await driver._executeRaw<{
        amount: number | bigint;
        label: string;
      }>(`SELECT "amount", "label" FROM "ledger_after"`);
      expect(
        stored.rows.map((row) => ({
          amount: Number(row.amount),
          label: row.label,
        }))
      ).toEqual([{ amount: 1_234_500, label: "kept" }]);
      expect((await push(after, { force: true })).operations).toEqual([]);
      await after.$disconnect();
    });
  }
});

describe("an outer table rename exposes its inner column decision", () => {
  it("asks for both renames, then asks before the revealed narrowing", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: nestedRenameLedgerModel("nested_before", "amount", 12, 2),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "nested_before" ("id","amount") VALUES ('a',12345)`
    );

    const after = createClient({
      schema: nestedRenameLedgerModel("nested_after", "total", 10, 2),
      driver,
    });
    const seen: string[] = [];
    const first = await push(after, {
      resolve: (change: ResolveChange) => {
        if (change.type === "enumValueRemoval") return change.reject();
        seen.push(`${change.type}:${change.operation}`);
        if (change.type === "ambiguous") return change.rename();
        return change.proceed();
      },
    });

    expect(seen).toEqual([
      "ambiguous:renameTable",
      "ambiguous:renameColumn",
      "destructive:alterColumn",
    ]);
    expect(first.operations.map((operation) => operation.type)).toEqual([
      "renameTable",
      "renameColumn",
      "alterColumn",
    ]);
    const stored = await driver._executeRaw<{ total: number }>(
      `SELECT "total" FROM "nested_after"`
    );
    expect(stored.rows).toEqual([{ total: 12_345 }]);
    await after.$disconnect();
  });

  it("treats addAndDrop as the destructive authorization it already is", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: ledgerModel("amount", 10, 2),
      driver,
    });
    await push(before, { force: true });
    const after = createClient({
      schema: ledgerModel("total", 10, 2),
      driver,
    });
    const seen: string[] = [];

    const pushed = await push(after, {
      resolve: (change: ResolveChange) => {
        seen.push(change.type);
        if (change.type === "ambiguous") return change.addAndDrop();
        return change.reject();
      },
    });

    expect(seen).toEqual(["ambiguous"]);
    expect(pushed.operations.map((operation) => operation.type)).toEqual([
      "dropColumn",
      "addColumn",
    ]);
    await after.$disconnect();
  });

  it("rejects the revealed narrowing before either rename runs", async () => {
    const driver = createInMemorySQLite3Driver();
    const before = createClient({
      schema: nestedRenameLedgerModel("rejected_before", "amount", 12, 2),
      driver,
    });
    await push(before, { force: true });
    await driver._executeRaw(
      `INSERT INTO "rejected_before" ("id","amount") VALUES ('a',12345)`
    );
    const after = createClient({
      schema: nestedRenameLedgerModel("rejected_after", "total", 10, 2),
      driver,
    });
    const seen: string[] = [];

    await expect(
      push(after, {
        resolve: (change: ResolveChange) => {
          if (change.type === "enumValueRemoval") return change.reject();
          seen.push(`${change.type}:${change.operation}`);
          if (change.type === "ambiguous") return change.rename();
          return change.reject();
        },
      })
    ).rejects.toThrow(CHANGE_REJECTED);
    expect(seen).toEqual([
      "ambiguous:renameTable",
      "ambiguous:renameColumn",
      "destructive:alterColumn",
    ]);
    const tables = await driver._executeRaw<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'rejected_%' ORDER BY name`
    );
    expect(tables.rows).toEqual([{ name: "rejected_before" }]);
    const columns = await driver._executeRaw<{ name: string }>(
      `PRAGMA table_info("rejected_before")`
    );
    expect(columns.rows.map((column) => column.name)).toContain("amount");
    expect(columns.rows.map((column) => column.name)).not.toContain("total");
    await after.$disconnect();
  });
});

// =============================================================================
// P1-2 / P2-5 — the reserved-constraint reader
// =============================================================================

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

  it("N1 a user default that spells the reserved name cannot override the real descriptor", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({
      schema: {
        m: s
          .model({
            // Sorted before `amount`, so a first-hit substring scan finds it.
            aaa: s
              .string()
              .default('CONSTRAINT "viborm_decimal_amount_10_4" CHECK'),
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("n1"),
      },
      driver,
    });
    await push(client, { force: true });
    await driver._executeRaw(
      `INSERT INTO "n1" ("id","aaa","amount") VALUES ('a','x', 12300)`
    );

    const second = await push(client, { force: true });
    expect(second.operations).toEqual([]);
    const stored = await driver._executeRaw<{ amount: number }>(
      `SELECT "amount" FROM "n1"`
    );
    expect(stored.rows[0]?.amount).toBe(12_300);
    await client.$disconnect();
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

// =============================================================================
// P1-1 / SQLite adoption — an absent SOURCE descriptor
// =============================================================================

describe("adopting a column that carries no descriptor", () => {
  it("SQLite converts the logical integer into a coefficient", async () => {
    const driver = createInMemorySQLite3Driver();
    const plain = createClient({
      schema: {
        m: s
          .model({ id: s.string().id(), amount: s.int().nullable() })
          .map("adopt"),
      },
      driver,
    });
    await push(plain, { force: true });
    await driver._executeRaw(
      `INSERT INTO "adopt" ("id","amount") VALUES ('a', 123)`
    );

    const adopted = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("adopt"),
      },
      driver,
    });
    await push(adopted, { force: true });
    const stored = await driver._executeRaw<{ amount: number }>(
      `SELECT "amount" FROM "adopt"`
    );
    // 123 meant one hundred and twenty-three; at scale 2 that is 12300.
    expect(stored.rows[0]?.amount).toBe(12_300);
    expect((await push(adopted, { force: true })).operations).toEqual([]);
    await adopted.$disconnect();
  });

  it("SQLite refuses an adoption the target domain cannot hold, and keeps the data", async () => {
    const driver = createInMemorySQLite3Driver();
    const plain = createClient({
      schema: {
        m: s
          .model({ id: s.string().id(), amount: s.int().nullable() })
          .map("adopt2"),
      },
      driver,
    });
    await push(plain, { force: true });
    // 10^9 at scale 2 needs 11 digits; the target holds 10.
    await driver._executeRaw(
      `INSERT INTO "adopt2" ("id","amount") VALUES ('a', 1000000000)`
    );

    const adopted = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("adopt2"),
      },
      driver,
    });
    await expect(push(adopted, { force: true })).rejects.toThrow();
    const stored = await driver._executeRaw<{ amount: number }>(
      `SELECT "amount" FROM "adopt2"`
    );
    expect(stored.rows[0]?.amount).toBe(1_000_000_000);
    await adopted.$disconnect();
  });

  it("refuses a TEXT scalar before SQLite affinity can reinterpret it", async () => {
    const driver = createInMemorySQLite3Driver();
    await driver._executeRaw(
      `CREATE TABLE "adopt_text" ("id" TEXT NOT NULL PRIMARY KEY, "amount" TEXT)`
    );
    await driver._executeRaw(
      `INSERT INTO "adopt_text" ("id","amount") VALUES ('a', '123')`
    );
    const adopted = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("adopt_text"),
      },
      driver,
    });

    await expect(push(adopted, { force: true })).rejects.toThrow(
      UNMARKED_TEXT_STORAGE
    );
    const preserved = await driver._executeRaw<{
      amount: string;
      storage: string;
    }>(`SELECT "amount", typeof("amount") AS "storage" FROM "adopt_text"`);
    expect(preserved.rows).toEqual([{ amount: "123", storage: "text" }]);
    await adopted.$disconnect();
  });

  it("refuses every unmarked list before a valid container can gain a scale", async () => {
    const driver = createInMemorySQLite3Driver();
    await driver._executeRaw(
      `CREATE TABLE "adopt_list" ("id" TEXT NOT NULL PRIMARY KEY, "samples" TEXT)`
    );
    await driver._executeRaw(
      `INSERT INTO "adopt_list" ("id","samples") VALUES ('a', '["120"]')`
    );
    const adopted = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            samples: s.decimal({ precision: 10, scale: 2 }).array().nullable(),
          })
          .map("adopt_list"),
      },
      driver,
    });

    await expect(push(adopted, { force: true })).rejects.toThrow(
      UNMARKED_TEXT_STORAGE
    );
    const preserved = await driver._executeRaw<{ samples: string }>(
      `SELECT "samples" FROM "adopt_list"`
    );
    expect(preserved.rows).toEqual([{ samples: '["120"]' }]);
    await adopted.$disconnect();
  });
});

describe("PostgreSQL validates against the target domain alone", () => {
  let db: PGlite;
  beforeAll(() => {
    db = new PGlite();
  });
  afterAll(async () => {
    await db.close();
  });

  it("refuses an unconstrained numeric whose value the target would round", async () => {
    await db.exec(`DROP TABLE IF EXISTS "pgadopt"`);
    await db.exec(
      `CREATE TABLE "pgadopt" ("id" TEXT NOT NULL PRIMARY KEY, "amount" numeric)`
    );
    await db.exec(
      `INSERT INTO "pgadopt" ("id","amount") VALUES ('a', 123.456789)`
    );
    const client = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("pgadopt"),
      },
      driver: new PGliteDriver({ client: db }),
    });
    await expect(push(client, { force: true })).rejects.toThrow();
    const rows = await db.query<{ v: string }>(
      `SELECT "amount"::text AS v FROM "pgadopt"`
    );
    // §7.3: "No descriptor change rounds existing data."
    expect(rows.rows[0]?.v).toBe("123.456789");
    await client.$disconnect();
  });

  it("adopts an unconstrained numeric whose values all fit, and converges", async () => {
    await db.exec(`DROP TABLE IF EXISTS "pgadopt2"`);
    await db.exec(
      `CREATE TABLE "pgadopt2" ("id" TEXT NOT NULL PRIMARY KEY, "amount" numeric)`
    );
    await db.exec(
      `INSERT INTO "pgadopt2" ("id","amount") VALUES ('a', 123.45)`
    );
    const client = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("pgadopt2"),
      },
      driver: new PGliteDriver({ client: db }),
    });
    await push(client, { force: true });
    const rows = await db.query<{ v: string }>(
      `SELECT "amount"::text AS v FROM "pgadopt2"`
    );
    expect(rows.rows[0]?.v).toBe("123.45");
    expect((await push(client, { force: true })).operations).toEqual([]);
    await client.$disconnect();
  });

  it("renames a table and moves its typmod in one convergent push", async () => {
    await db.exec(`DROP TABLE IF EXISTS "pg_table_before", "pg_table_after"`);
    const before = createClient({
      schema: tableLedgerModel("pg_table_before", 10, 2),
      driver: new PGliteDriver({ client: db }),
    });
    await push(before, { force: true });
    await db.exec(
      `INSERT INTO "pg_table_before" ("id","amount","label") VALUES ('a',123.45,'kept')`
    );

    const after = createClient({
      schema: tableLedgerModel("pg_table_after", 10, 4),
      driver: new PGliteDriver({ client: db }),
    });
    const seen: string[] = [];
    const first = await push(after, {
      force: true,
      resolve: renameResolver(seen),
    });
    expect(first.operations.map((operation) => operation.type)).toEqual([
      "renameTable",
      "alterColumn",
    ]);
    const rows = await db.query<{ amount: string; label: string }>(
      `SELECT "amount"::text AS "amount", "label" FROM "pg_table_after"`
    );
    expect(rows.rows).toEqual([{ amount: "123.4500", label: "kept" }]);
    expect((await push(after, { force: true })).operations).toEqual([]);
    await after.$disconnect();
  });

  it("retargets an enum-removal decision through accepted table and column renames", async () => {
    await db.exec(
      `DROP TABLE IF EXISTS "enum_before", "enum_after"; DROP TYPE IF EXISTS "closure_state"`
    );
    const before = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            code: s.string().nullable(),
            label: s.string().nullable(),
            owner: s.string().nullable(),
            created: s.string().nullable(),
            note: s.string().nullable(),
            status: s.enum(["active", "retired"]).name("closure_state"),
          })
          .map("enum_before"),
      },
      driver: new PGliteDriver({ client: db }),
    });
    await push(before, { force: true });
    await db.exec(
      `INSERT INTO "enum_before" ("id","status") VALUES ('a','retired')`
    );

    const after = createClient({
      schema: {
        ledger: s
          .model({
            id: s.string().id(),
            code: s.string().nullable(),
            label: s.string().nullable(),
            owner: s.string().nullable(),
            created: s.string().nullable(),
            note: s.string().nullable(),
            state: s.enum(["active"]).name("closure_state"),
          })
          .map("enum_after"),
      },
      driver: new PGliteDriver({ client: db }),
    });
    const enumTargets: string[] = [];
    await push(after, {
      resolve: (change: ResolveChange) => {
        if (change.type === "ambiguous") return change.rename();
        if (change.type === "enumValueRemoval") {
          enumTargets.push(`${change.tableName}.${change.columnName}`);
          return change.mapValues({ retired: "active" });
        }
        return change.reject();
      },
    });

    expect(enumTargets).toEqual(["enum_after.state"]);
    const rows = await db.query<{ state: string }>(
      `SELECT "state" FROM "enum_after"`
    );
    expect(rows.rows).toEqual([{ state: "active" }]);
    await after.$disconnect();
  });
});

// =============================================================================
// P1-3 — D1 refuses decimal descriptor and carrier reconstructions
// =============================================================================

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

// =============================================================================
// P2-2 — the push prompt names both domains
// =============================================================================

describe("the destructive prompt a user actually meets", () => {
  it("J2 names both decimal domains for a narrowing change", async () => {
    const driver = createInMemorySQLite3Driver();
    const wide = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 12, scale: 2 }).nullable(),
          })
          .map("j2"),
      },
      driver,
    });
    await push(wide, { force: true });
    const narrow = createClient({
      schema: {
        m: s
          .model({
            id: s.string().id(),
            amount: s.decimal({ precision: 10, scale: 2 }).nullable(),
          })
          .map("j2"),
      },
      driver,
    });
    const seen: string[] = [];
    await push(narrow, {
      resolve: (change: ResolveChange) => {
        seen.push(change.description ?? "");
        return change.type === "destructive"
          ? change.proceed()
          : change.reject();
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("precision 12, scale 2");
    expect(seen[0]).toContain("precision 10, scale 2");
    await narrow.$disconnect();
  });
});

// =============================================================================
// P2-3 — MySQL tolerates a type modifier and says something true
// =============================================================================

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
