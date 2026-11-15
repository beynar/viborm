/**
 * SQL Server: a pool the caller supplies, connected or not, as the driver
 * page shows it. The driver connects it on first use and never closes it.
 * Set MSSQL_TEST_CONNECTION_STRING to run.
 */

import { createClient } from "@client/client";
import { MssqlDriver } from "@drivers/mssql";
import { ConnectionError } from "@errors";
import { s } from "@schema";
import { sql } from "@sql";
import sqlServer from "mssql";
import { describe, expect, test } from "vitest";
import { TEST_CONNECTION_STRING } from "./mssql-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const poolOf = (url: string) => {
  const parsed = new URL(url);
  return new sqlServer.ConnectionPool({
    server: parsed.hostname,
    port: Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    options: { encrypt: false, trustServerCertificate: true },
  });
};

describeIf("SQL Server with a supplied pool", () => {
  test("an unconnected pool is connected on first use, and left open", async () => {
    const pool = poolOf(TEST_CONNECTION_STRING!);
    expect(pool.connected).toBe(false);
    const db = createClient({
      schema: { one: s.model({ id: s.int().id() }).map("unused") },
      driver: new MssqlDriver({ pool }),
    });
    try {
      const [row] = await db.$queryRaw<{ one: number }>(sql`SELECT 1 AS one`);
      expect(row).toEqual({ one: 1 });
      await expect(
        db.$transaction(async (tx) =>
          tx.$queryRaw<{ two: number }>(sql`SELECT 2 AS two`)
        )
      ).resolves.toEqual([{ two: 2 }]);
      await db.$disconnect();
      // The pool is the caller's: still open after the client is gone.
      expect(pool.connected).toBe(true);
    } finally {
      await pool.close();
    }
  });

  test("a pool the caller closed, before or after handing it over, is never reopened: a typed ConnectionError", async () => {
    const schema = { one: s.model({ id: s.int().id() }).map("unused") };
    const before = poolOf(TEST_CONNECTION_STRING!);
    await before.connect();
    await before.close();
    const late = createClient({
      schema,
      driver: new MssqlDriver({ pool: before }),
    });
    await expect(late.$queryRaw(sql`SELECT 1 AS one`)).rejects.toBeInstanceOf(
      ConnectionError
    );
    expect(before.connected).toBe(false);
    await late.$disconnect();

    const after = poolOf(TEST_CONNECTION_STRING!);
    const used = createClient({
      schema,
      driver: new MssqlDriver({ pool: after }),
    });
    await used.$queryRaw(sql`SELECT 1 AS one`);
    await after.close();
    await expect(used.$queryRaw(sql`SELECT 1 AS one`)).rejects.toBeInstanceOf(
      ConnectionError
    );
    expect(after.connected).toBe(false);
    await used.$disconnect();
  });
});
