import { createClient } from "@client/client";
import type { AnyDriver, BatchQuery } from "@drivers";
import { LibSQLDriver } from "@drivers/libsql";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { sql } from "@sql";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { describe, expect, test } from "vitest";

const EXACT = 9_007_199_254_740_993n;
const ROUNDED = 9_007_199_254_740_992;

const measurement = s
  .model({
    id: s.string().id(),
    views: s.bigInt(),
  })
  .map("measurements");

function prepareOperation(operation: unknown, driver: AnyDriver): BatchQuery {
  const capability = readTestTransactionOperation(operation);
  if (capability === undefined) {
    throw new Error("Expected a transaction operation");
  }
  const prepared = capability.prepare(driver);
  if (!prepared) {
    throw new Error("Expected one prepared statement");
  }
  return prepared;
}

describe("SQLite3 provider integer safety", () => {
  test("execute reads exactly past 2^53 while raw stays native", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });

    try {
      await driver._executeRaw(
        `CREATE TABLE "measurements" ("views" INTEGER NOT NULL)`
      );
      await driver._executeRaw(`INSERT INTO "measurements" VALUES (?)`, [
        EXACT,
      ]);

      const typed = await driver._execute<{ views: bigint }>(
        sql`SELECT "views" FROM "measurements"`
      );
      const raw = await driver._executeRaw<{ views: number }>(
        `SELECT "views" FROM "measurements"`
      );

      expect(typed.rows[0]?.views).toBe(EXACT);
      expect(raw.rows[0]?.views).toBe(ROUNDED);
    } finally {
      await driver.disconnect();
    }
  });

  test("fallback batches preserve typed and unsafe ordering", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({ schema: { measurement }, driver });

    try {
      await driver._executeRaw(
        `CREATE TABLE "measurements" ("id" TEXT PRIMARY KEY, "views" INTEGER NOT NULL)`
      );
      await driver._executeRaw(`INSERT INTO "measurements" VALUES (?, ?)`, [
        "m-1",
        EXACT,
      ]);

      const typedDirect = await client.measurement.findMany({
        select: { views: true },
      });
      const taggedDirect = await client.$queryRaw<{
        views: bigint;
      }>`SELECT "views" FROM "measurements"`;
      const unsafeDirect = await client.$queryRawUnsafe<{ views: number }>(
        `SELECT "views" FROM "measurements"`
      );

      expect(typedDirect[0]?.views).toBe(EXACT);
      expect(taggedDirect[0]?.views).toBe(EXACT);
      expect(unsafeDirect[0]?.views).toBe(ROUNDED);

      const batch = await driver._executeBatch<{ views: bigint | number }>([
        prepareOperation(
          client.measurement.findMany({ select: { views: true } }),
          driver
        ),
        prepareOperation(
          client.$queryRawUnsafe<{ views: number }>(
            `SELECT "views" FROM "measurements"`
          ),
          driver
        ),
        prepareOperation(
          client.$queryRaw<{
            views: bigint;
          }>`SELECT "views" FROM "measurements"`,
          driver
        ),
      ]);

      expect(batch.map((result) => result.rows[0]?.views)).toEqual([
        EXACT,
        ROUNDED,
        EXACT,
      ]);
    } finally {
      await client.$disconnect();
    }
  });
});

describe("LibSQL provider integer-mode control", () => {
  test("its connection-wide bigint mode keeps every fallback batch arm exact", async () => {
    const driver = new LibSQLDriver();
    const client = createClient({ schema: { measurement }, driver });

    try {
      await driver._executeRaw(
        `CREATE TABLE "measurements" ("id" TEXT PRIMARY KEY, "views" INTEGER NOT NULL)`
      );
      await driver._executeRaw(`INSERT INTO "measurements" VALUES (?, ?)`, [
        "m-1",
        EXACT,
      ]);

      const batch = await driver._executeBatch<{ views: bigint }>([
        prepareOperation(
          client.measurement.findMany({ select: { views: true } }),
          driver
        ),
        prepareOperation(
          client.$queryRawUnsafe<{ views: bigint }>(
            `SELECT "views" FROM "measurements"`
          ),
          driver
        ),
        prepareOperation(
          client.$queryRaw<{
            views: bigint;
          }>`SELECT "views" FROM "measurements"`,
          driver
        ),
      ]);

      expect(batch.map((result) => result.rows[0]?.views)).toEqual([
        EXACT,
        EXACT,
        EXACT,
      ]);
    } finally {
      await client.$disconnect();
    }
  });
});
