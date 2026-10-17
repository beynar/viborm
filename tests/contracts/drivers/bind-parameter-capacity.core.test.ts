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
import { join, raw, sql } from "@sql";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test, vi } from "vitest";

/** The seventh distinct value's placeholder, as each dialect numbers it. */
const SEVENTH_SQLITE = /\?7\b/;
const SEVENTH_POSTGRES = /\$7\b/;
const FIRST_POSTGRES = /\$1\b/g;

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
    // Distinct values: equal ones would bind once, numbered, and fit.
    const statement = sql`SELECT ${join(Array.from({ length: 32_768 }, (_, index) => sql`${index}`))}`;
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

  /** 150 binds over the budget of 100, holding 7 distinct values. */
  const repeated = Array.from({ length: 150 }, (_, index) => index % 7);
  const overBudget = () =>
    sql`SELECT ${join(repeated.map((value, index) => sql`${value} AS ${raw(`c${index}`)}`))}`;

  test("SQLite: over the budget, equal values bind once and are referenced by number", async () => {
    const driver = new LibSQLDriver({ databaseUrl: ":memory:" });
    Reflect.defineProperty(driver, "maxBindParametersPerStatement", {
      value: 100,
    });
    const execute = vi.spyOn(
      driver as unknown as {
        execute: (c: unknown, s: string, p: unknown[]) => Promise<unknown>;
      },
      "execute"
    );
    try {
      const statement = overBudget();
      expect(statement.values).toHaveLength(150);
      const result = await driver._execute<Record<string, unknown>>(statement);
      const [, text, parameters] = execute.mock.calls[0]!;
      expect(parameters).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(text).toMatch(SEVENTH_SQLITE);
      expect(
        Object.values(result.rows[0]!).map((value) => Number(value))
      ).toEqual(repeated);
      // Within the budget, the statement's text and values are unchanged.
      execute.mockClear();
      await driver._execute(sql`SELECT ${1} AS a, ${1} AS b`);
      expect(execute.mock.calls[0]![2]).toEqual([1, 1]);
      // Distinct values past the budget are still refused whole.
      await expect(
        driver._execute(
          sql`SELECT ${join(Array.from({ length: 101 }, (_, index) => sql`${index}`))}`
        )
      ).rejects.toMatchObject({ name: "UnsupportedOperationError" });
    } finally {
      await driver._disconnect();
    }
  });

  test("PostgreSQL: over the budget, equal values bind once and are referenced as $n", async () => {
    // A planning transport: a real PostgreSQL binds `$n` by position, as
    // every provider suite's statements do; here, what the driver sends.
    const sent: [string, unknown[]][] = [];
    class Recording extends PlanningDriver {
      constructor() {
        super("postgresql", { maxBindParametersPerStatement: 100 });
      }
      protected override async execute<T>(
        _client: null,
        statement: string,
        parameters: unknown[]
      ): Promise<QueryResult<T>> {
        sent.push([statement, parameters]);
        return { rows: [], rowCount: 0 };
      }
    }
    const driver = new Recording();
    await driver._execute(overBudget());
    const [text, parameters] = sent[0]!;
    expect(parameters).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(text).toMatch(SEVENTH_POSTGRES);
    expect(text.match(FIRST_POSTGRES)).toHaveLength(22);
  });

  test("SQLite3: better-sqlite3 reads ?NNN as a name, so over the budget the statement is refused whole", async () => {
    const driver = new SQLite3Driver();
    Reflect.defineProperty(driver, "maxBindParametersPerStatement", {
      value: 100,
    });
    try {
      const statement = sql`SELECT ${join(Array.from({ length: 150 }, (_, index) => sql`${index % 7} AS ${raw(`c${index}`)}`))}`;
      await expect(driver._execute(statement)).rejects.toMatchObject({
        name: "UnsupportedOperationError",
      });
    } finally {
      await driver._disconnect();
    }
  });

  test("an unverified custom driver fails safe", () => {
    expect(new UnknownCapacityDriver().maxBindParametersPerStatement).toBe(
      undefined
    );
  });
});
