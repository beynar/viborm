import { createClient } from "@client/client";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { getSQLiteType } from "../../src/migrations/drivers/type-mapping";
import { createInMemorySQLite3Driver } from "../fixtures/drivers/sqlite3";

/**
 * The SQLite decimal column type, and the migration that changes it (W6-U1).
 *
 * `REAL` had NUMERIC affinity, so a fractional decimal was rounded into a
 * double AS IT WAS STORED — the value in the file was not the value written.
 * `TEXT` keeps the canonical spelling byte-exact. The change is breaking for
 * an existing database, so the second half of this file pins that the differ
 * SURFACES it rather than leaving a REAL column silently in place.
 */

// Top-level so Biome's useTopLevelRegex rule is satisfied.
const AMOUNT_TEXT = /"amount"\s+TEXT/i;
const AMOUNT_REAL = /"amount"\s+REAL/i;
const REBUILD_CREATE = /CREATE TABLE "__new_decimal_migration_ledger"/;
const REBUILD_COPY = /INSERT INTO "__new_decimal_migration_ledger"/;
const REBUILD_RENAME = /RENAME TO "decimal_migration_ledger"/;

describe("SQLite decimal column type", () => {
  test("a decimal column maps to TEXT, not REAL", () => {
    expect(getSQLiteType({ type: "decimal", array: false })).toBe("TEXT");
  });

  test("a float column still maps to REAL — only decimal moved", () => {
    // Guards the fix at the site that caused the bug: getSQLiteType used to
    // route `decimal` to the FLOAT default, which made the decimal entry in
    // SQLITE_TYPE_DEFAULTS dead code and the first TEXT mapping a no-op.
    expect(getSQLiteType({ type: "float", array: false })).toBe("REAL");
  });

  test("push creates the column as TEXT", async () => {
    const ledger = s
      .model({ id: s.string().id(), amount: s.decimal() })
      .map("decimal_ddl_ledger");
    const client = createClient({
      schema: { ledger },
      driver: createInMemorySQLite3Driver(),
    });

    const result = await push(client, { force: true });
    const createSql = result.sql.join("\n");
    expect(createSql).toMatch(AMOUNT_TEXT);
    expect(createSql).not.toMatch(AMOUNT_REAL);

    await client.$disconnect();
  });

  test("an existing REAL column is SURFACED as an alterColumn, not left alone", async () => {
    // ONE driver, so the second push really does see the first push's table —
    // a fresh driver would give an empty database and report a createTable,
    // which would make this test pass for the wrong reason.
    const driver = createInMemorySQLite3Driver();

    // Stand in for a database created before W6-U1: same table, same column
    // name, but the old approximate type.
    const legacy = s
      .model({ id: s.string().id(), amount: s.float() })
      .map("decimal_migration_ledger");
    const legacyClient = createClient({ schema: { legacy }, driver });
    const legacyPush = await push(legacyClient, { force: true });
    expect(legacyPush.sql.join("\n")).toMatch(AMOUNT_REAL);

    const upgraded = s
      .model({ id: s.string().id(), amount: s.decimal() })
      .map("decimal_migration_ledger");
    const upgradedClient = createClient({ schema: { upgraded }, driver });
    const result = await push(upgradedClient, { force: true, dryRun: true });

    // The whole point: the type change is REPORTED, naming the column and BOTH
    // types. A silent migration would leave a REAL column in place and go on
    // rounding every write into a double.
    const alteration = result.operations.find(
      (op) => op.type === "alterColumn" && op.columnName === "amount"
    );
    expect(alteration).toMatchObject({
      type: "alterColumn",
      tableName: "decimal_migration_ledger",
      columnName: "amount",
      from: { type: "REAL" },
      to: { type: "TEXT" },
    });

    // Not mistaken for a fresh table — the table already exists, and the change
    // is realized by SQLite's rebuild dance (SQLite cannot ALTER a column type),
    // which COPIES the existing rows rather than dropping them.
    expect(result.operations.some((op) => op.type === "createTable")).toBe(
      false
    );
    const sql = result.sql.join("\n");
    expect(sql).toMatch(REBUILD_CREATE);
    expect(sql).toMatch(REBUILD_COPY);
    expect(sql).toMatch(REBUILD_RENAME);

    await legacyClient.$disconnect();
  });
});
