import { createClient } from "@client/client";
import { BunSQLDriver } from "@drivers/bun-sql";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import type { QueryResult } from "@drivers/exports";
import { LibSQLDriver } from "@drivers/libsql";
import { MySQL2Driver } from "@drivers/mysql2";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { PostgresDriver } from "@drivers/postgres";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { join, sql } from "@sql";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test, vi } from "vitest";

class UnknownCapacityDriver extends PGliteDriver {
  override readonly maxBindParametersPerStatement: number | undefined =
    undefined;
}

describe("driver bind-parameter capacity", () => {
  test.each([
    ["pglite", new PGliteDriver(), 32_767],
    ["pg", new PgDriver(), 65_535],
    ["postgres", new PostgresDriver(), 65_533],
    ["neon-http", new NeonHTTPDriver(), 65_535],
    ["bun-sql", new BunSQLDriver(), 65_535],
    ["mysql2", new MySQL2Driver(), 65_535],
    ["planetscale", new PlanetScaleDriver(), 65_535],
    ["sqlite3", new SQLite3Driver(), 32_766],
    ["libsql", new LibSQLDriver(), 32_766],
    ["bun-sqlite", new BunSQLiteDriver(), 32_766],
    ["d1", new D1Driver({ database: Object.create(null) }), 100],
  ])("%s declares its conservative statement capacity", (_name, driver, limit) => {
    expect(driver.maxBindParametersPerStatement).toBe(limit);
  });

  test("PGlite refuses its known overflowing bind count before provider dispatch", async () => {
    const query = vi.fn(async () => ({ rows: [], affectedRows: 0 }));
    const driver = new PGliteDriver();
    // The controlled handle can answer query(), but must never receive this
    // statement: exercising the provider bug would poison an actual session.
    Reflect.set(driver, "client", { query });
    const statement = sql`SELECT ${join(Array.from({ length: 32_768 }, () => sql`${1}`))}`;
    expect(statement.values).toHaveLength(32_768);
    await expect(driver._execute(statement)).rejects.toMatchObject({
      name: "UnsupportedOperationError",
      code: "V8003",
      message: expect.stringContaining(
        "32768 bound values, above the verified limit of 32767"
      ),
    });
    expect(query).not.toHaveBeenCalled();
  });

  test.each([
    [
      "postgres.js",
      new PostgresDriver().maxBindParametersPerStatement,
      21_845,
      65_532,
    ],
    [
      "PGlite",
      new PGliteDriver().maxBindParametersPerStatement,
      10_923,
      32_766,
    ],
  ])("public createMany chunks before %s's known overflow", async (_name, limit, count, firstChunk) => {
    class ThresholdDriver extends PlanningDriver {
      readonly dispatched: number[] = [];
      constructor() {
        super("postgresql", {
          maxBindParametersPerStatement: limit,
        });
      }
      protected override async execute<T>(
        _client: null,
        _statement: string,
        parameters: unknown[]
      ): Promise<QueryResult<T>> {
        this.dispatched.push(parameters.length);
        return { rows: [], rowCount: parameters.length / 3 };
      }
    }
    const driver = new ThresholdDriver();
    const entry = s.model({
      id: s.int().id(),
      first: s.int(),
      second: s.int(),
    });
    const client = createClient({ schema: { entry }, driver });
    try {
      const rows = Array.from({ length: count }, (_, id) => ({
        id,
        first: id,
        second: id,
      }));
      expect(await client.entry.createMany({ data: rows })).toEqual({ count });
      expect(driver.dispatched).toEqual([firstChunk, 3]);
    } finally {
      await client.$disconnect();
    }
  });

  test("an unverified custom driver fails safe", () => {
    expect(new UnknownCapacityDriver().maxBindParametersPerStatement).toBe(
      undefined
    );
  });
});
