import { BunSQLDriver } from "@drivers/bun-sql";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import { LibSQLDriver } from "@drivers/libsql";
import { MySQL2Driver } from "@drivers/mysql2";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { PostgresDriver } from "@drivers/postgres";
import { SQLite3Driver } from "@drivers/sqlite3";
import { describe, expect, test } from "vitest";

class UnknownCapacityDriver extends PGliteDriver {
  override readonly maxBindParametersPerStatement: number | undefined =
    undefined;
}

describe("driver bind-parameter capacity", () => {
  test.each([
    ["pglite", new PGliteDriver(), 65_535],
    ["pg", new PgDriver(), 65_535],
    ["postgres", new PostgresDriver(), 65_535],
    ["neon-http", new NeonHTTPDriver(), 65_535],
    ["bun-sql", new BunSQLDriver(), 65_535],
    ["mysql2", new MySQL2Driver(), 65_535],
    ["planetscale", new PlanetScaleDriver(), 65_535],
    ["sqlite3", new SQLite3Driver(), 999],
    ["libsql", new LibSQLDriver(), 999],
    ["bun-sqlite", new BunSQLiteDriver(), 999],
    ["d1", new D1Driver({ database: Object.create(null) }), 100],
  ])("%s declares its conservative statement capacity", (_name, driver, limit) => {
    expect(driver.maxBindParametersPerStatement).toBe(limit);
  });

  test("an unverified custom driver fails safe", () => {
    expect(new UnknownCapacityDriver().maxBindParametersPerStatement).toBe(
      undefined
    );
  });
});
