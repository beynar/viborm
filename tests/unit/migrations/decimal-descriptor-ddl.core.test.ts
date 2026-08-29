/**
 * The physical decimal, on all three dialects.
 *
 * One declared domain, three storages: `NUMERIC(p,s)` on PostgreSQL,
 * `DECIMAL(p,s)` on MySQL, and a signed `INTEGER` coefficient on SQLite whose
 * declared precision is made real by a reserved CHECK — because SQLite ignores
 * the numbers in `DECIMAL(10,5)` and rounds a fractional value into a double as
 * it stores it. This file pins the bytes each one emits, and the two facts a
 * byte-sensitive differ depends on: no space after the comma, and a descriptor
 * that rides on `ColumnDef` beside the physical type rather than inside it.
 *
 * It replaces `decimal-sqlite-text.core.test.ts`, whose every assertion (a TEXT
 * decimal column, a REAL-to-TEXT migration) names a representation this program
 * deleted. The one claim of that file which is still true — that an approximate
 * number is still REAL, so the decimal mapping did not swallow its neighbour —
 * is folded in below.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import type { MigrationDriver } from "@src/migrations/drivers";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { getSQLiteType } from "@src/migrations/drivers/type-mapping";
import { serializeModels } from "@src/migrations/serializer";
import type { ColumnDef, SchemaSnapshot } from "@src/migrations/types";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";
import { ddlContextFor } from "./_estate";

/** A space after the comma is a second spelling of one domain (trap: churn). */
const SPACED_TYPE_ARGUMENT = /\(\s*\d+\s*,\s+\d+\s*\)/;
const AMOUNT_REAL = /"amount"\s+REAL/i;

function ledger() {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amount: s.decimal({ precision: 10, scale: 5 }),
        optional: s.decimal({ precision: 10, scale: 5 }).nullable(),
        seeded: s.decimal({ precision: 10, scale: 5 }).default("12.34"),
        rate: s.decimal({ precision: 4, scale: 0 }),
        samples: s.decimal({ precision: 10, scale: 2 }).array(),
        approximate: s.number(),
      })
      .map("decimal_ddl_ledger"),
  };
}

function snapshotFor(driver: MigrationDriver): SchemaSnapshot {
  return serializeModels(ledger(), { migrationDriver: driver });
}

function columnsOf(driver: MigrationDriver): Map<string, ColumnDef> {
  const table = snapshotFor(driver).tables[0];
  return new Map((table?.columns ?? []).map((column) => [column.name, column]));
}

function createTableSql(driver: MigrationDriver): string {
  const table = snapshotFor(driver).tables[0];
  if (!table) throw new Error("no table serialized");
  return driver.generateDDL(
    { type: "createTable", table },
    ddlContextFor("artifact", { tables: [] })
  );
}

describe("the physical decimal type", () => {
  test("PostgreSQL stores NUMERIC(p,s), and a list stores NUMERIC(p,s)[]", () => {
    const columns = columnsOf(postgresMigrationDriver);
    expect(columns.get("amount")?.type).toBe("NUMERIC(10,5)");
    expect(columns.get("rate")?.type).toBe("NUMERIC(4,0)");
    expect(columns.get("samples")?.type).toBe("NUMERIC(10,2)[]");
  });

  test("MySQL stores DECIMAL(p,s), and a list stores JSON", () => {
    const columns = columnsOf(mysqlMigrationDriver);
    expect(columns.get("amount")?.type).toBe("DECIMAL(10,5)");
    // Never bare `DECIMAL`: MySQL reads that as DECIMAL(10,0) and truncates
    // every fraction — and never `DECIMAL(65,30)`, which was a domain no model
    // ever declared.
    expect(columns.get("rate")?.type).toBe("DECIMAL(4,0)");
    expect(columns.get("samples")?.type).toBe("JSON");
  });

  test("SQLite stores the INTEGER coefficient, and a list stores TEXT", () => {
    const columns = columnsOf(sqlite3MigrationDriver);
    expect(columns.get("amount")?.type).toBe("INTEGER");
    // TEXT rather than the blanket JSON every other SQLite list gets: the
    // list's CHECK asserts `typeof = 'text'`, and the literal type `JSON` has
    // NUMERIC affinity.
    expect(columns.get("samples")?.type).toBe("TEXT");
    // The retired representations are gone in both directions.
    expect(columns.get("amount")?.type).not.toBe("TEXT");
    expect(columns.get("amount")?.type).not.toBe("REAL");
  });

  test("an approximate number is still REAL — only the decimal moved", () => {
    // The control the deleted SQLite-TEXT suite carried: `getSQLiteType` once
    // routed `decimal` to the approximate-number default, which made the
    // decimal entry dead code and the first mapping a no-op.
    expect(getSQLiteType({ type: "number", array: false })).toBe("REAL");
    expect(columnsOf(sqlite3MigrationDriver).get("approximate")?.type).toBe(
      "REAL"
    );
  });

  test("every emitted type spells the domain without a space", () => {
    for (const driver of [
      postgresMigrationDriver,
      mysqlMigrationDriver,
      sqlite3MigrationDriver,
    ]) {
      expect(createTableSql(driver)).not.toMatch(SPACED_TYPE_ARGUMENT);
    }
  });
});

describe("the descriptor rides beside the physical type", () => {
  test("every dialect carries the declared domain on the column", () => {
    for (const driver of [
      postgresMigrationDriver,
      mysqlMigrationDriver,
      sqlite3MigrationDriver,
    ]) {
      const columns = columnsOf(driver);
      expect(columns.get("amount")?.decimal).toEqual({
        precision: 10,
        scale: 5,
      });
      expect(columns.get("samples")?.decimal).toEqual({
        precision: 10,
        scale: 2,
      });
      expect(columns.get("approximate")?.decimal).toBeUndefined();
    }
  });

  test("the SQLite CHECK is a column constraint, never part of the type", () => {
    // The enum column type folds its CHECK into `ColumnDef.type`, and the
    // measured cost is a table recreation on every push forever: PRAGMA
    // table_info reports only the type-name production, so the desired
    // `TEXT CHECK(...)` never equals the introspected `TEXT`.
    expect(columnsOf(sqlite3MigrationDriver).get("amount")?.type).not.toContain(
      "CHECK"
    );
    expect(createTableSql(sqlite3MigrationDriver)).toContain(
      'CONSTRAINT "viborm_decimal_amount_10_5" CHECK'
    );
  });
});

describe("the SQLite reserved CHECK", () => {
  const sql = createTableSql(sqlite3MigrationDriver);

  test("bounds the coefficient at the declared precision", () => {
    expect(sql).toContain(`"amount" BETWEEN -9999999999 AND 9999999999`);
    expect(sql).toContain(`typeof("amount") = 'integer'`);
  });

  test("admits NULL only for a nullable column", () => {
    expect(sql).toContain(
      `CONSTRAINT "viborm_decimal_optional_10_5" CHECK ("optional" IS NULL OR (`
    );
    expect(sql).not.toContain(`CHECK ("amount" IS NULL OR (`);
  });

  test("verifies TEXT and a top-level JSON array for a list", () => {
    expect(sql).toContain(
      `CONSTRAINT "viborm_decimal_samples_10_2" CHECK (typeof("samples") = 'text' AND json_valid("samples") AND json_type("samples") = 'array')`
    );
  });
});

describe("the MySQL list marker", () => {
  const sql = createTableSql(mysqlMigrationDriver);

  test("carries the domain of a JSON list, and only of a list", () => {
    expect(sql).toContain(`COMMENT 'viborm:decimal(10,2)'`);
    // A scalar spells its domain in its own type; a second carrier would be a
    // second answer to what the column is.
    expect(sql).not.toContain(`COMMENT 'viborm:decimal(10,5)'`);
  });
});

describe("the DDL default", () => {
  test("PostgreSQL and MySQL pad the fraction to the scale", () => {
    // NOT canonical text: canonical strips trailing zeros, and MySQL reads a
    // DECIMAL(p,s) default back from information_schema padded to the scale, so
    // emitting `12.34` would make the differ see a change on every push.
    expect(columnsOf(postgresMigrationDriver).get("seeded")?.default).toBe(
      "12.34000"
    );
    expect(columnsOf(mysqlMigrationDriver).get("seeded")?.default).toBe(
      "12.34000"
    );
  });

  test("SQLite defaults to the coefficient it stores", () => {
    expect(columnsOf(sqlite3MigrationDriver).get("seeded")?.default).toBe(
      "1234000"
    );
  });
});

/**
 * How the provider refused a statement.
 *
 * VibORM normalizes a SQLite constraint failure into `CheckConstraintError`
 * with the provider's own code on `meta`, and does not carry the constraint
 * NAME through. So the live legs below prove that the check FIRED and which
 * KIND it was; which constraint carries the descriptor is a fact about the
 * emitted DDL, pinned above where the DDL is the subject.
 */
async function refusalOf(
  driver: { _executeRaw: (sql: string) => Promise<unknown> },
  sql: string
): Promise<string> {
  try {
    await driver._executeRaw(sql);
  } catch (error) {
    const meta = (error as { meta?: { providerCode?: unknown } }).meta;
    return `${(error as Error).constructor.name}:${String(meta?.providerCode)}`;
  }
  throw new Error(`expected a refusal for: ${sql}`);
}

describe("a live SQLite estate", () => {
  test("creates the checked INTEGER and refuses a value outside it", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: ledger(), driver });

    const result = await push(client, { force: true });
    expect(result.sql.join("\n")).toContain(
      'CONSTRAINT "viborm_decimal_amount_10_5" CHECK'
    );

    // The check is the precision. SQLite would otherwise accept any integer
    // and any spelling at all in a column it declared INTEGER.
    // A coefficient one digit past the declared precision.
    expect(
      await refusalOf(
        driver,
        `INSERT INTO "decimal_ddl_ledger" ("id","amount","optional","seeded","rate","samples","approximate") VALUES ('a', 99999999999, NULL, 0, 0, '[]', 1.5)`
      )
    ).toBe("CheckConstraintError:SQLITE_CONSTRAINT_CHECK");

    // TEXT in a column SQLite only declared INTEGER: affinity converts a
    // numeric-looking string, so `typeof` is what refuses this one.
    expect(
      await refusalOf(
        driver,
        `INSERT INTO "decimal_ddl_ledger" ("id","amount","optional","seeded","rate","samples","approximate") VALUES ('b', '12.34', NULL, 0, 0, '[]', 1.5)`
      )
    ).toBe("CheckConstraintError:SQLITE_CONSTRAINT_CHECK");

    // The list check refuses anything that is not a top-level JSON array.
    expect(
      await refusalOf(
        driver,
        `INSERT INTO "decimal_ddl_ledger" ("id","amount","optional","seeded","rate","samples","approximate") VALUES ('d', 1, NULL, 0, 0, 'not json', 1.5)`
      )
    ).toBe("CheckConstraintError:SQLITE_CONSTRAINT_CHECK");

    await expect(
      driver._executeRaw(
        `INSERT INTO "decimal_ddl_ledger" ("id","amount","optional","seeded","rate","samples","approximate") VALUES ('c', 1234000, NULL, 0, 0, '["1"]', 1.5)`
      )
    ).resolves.toBeDefined();

    await client.$disconnect();
  });

  test("no decimal column is created as TEXT or REAL", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: ledger(), driver });
    const result = await push(client, { force: true });
    expect(result.sql.join("\n")).not.toMatch(AMOUNT_REAL);
    await client.$disconnect();
  });
});
