import { createClient } from "@client/client";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import { describe, expect, test, vi } from "vitest";

type BunSQLiteOptions = NonNullable<
  ConstructorParameters<typeof BunSQLiteDriver>[0]
>;
type BunSQLiteClient = NonNullable<BunSQLiteOptions["client"]>;
type D1Database = ConstructorParameters<typeof D1Driver>[0]["database"];

interface StatementResult {
  rows: Record<string, unknown>[];
  changes: number;
  lastInsertRowid?: number | bigint;
}

function createBunStatementDriver(
  columnNames: string[],
  result: StatementResult
) {
  const all = vi.fn(() => result.rows);
  const run = vi.fn(() => ({
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid ?? 0,
  }));
  const statement = {
    columnNames,
    all,
    get: vi.fn(() => result.rows[0] ?? null),
    run,
    // Real bun:sqlite statements carry this; the typed read path calls it so
    // INTEGER values past 2^53 survive. Whether each path opts in is pinned by
    // sqlite-integer-safety.test.ts — these cases are about result metadata.
    safeIntegers: vi.fn(() => statement),
    values: vi.fn(() => []),
  };
  const database = {
    query: vi.fn(() => statement),
    prepare: vi.fn(() => statement),
    run: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    transaction:
      <T>(fn: () => T) =>
      () =>
        fn(),
  };

  return {
    all,
    driver: new BunSQLiteDriver({
      // The real provider contract is private to the driver. This controlled
      // fake implements only the statement surface exercised by execution.
      client: database as unknown as BunSQLiteClient,
    }),
    run,
  };
}

function createD1StatementDriver(result: StatementResult) {
  const boundValues: unknown[] = [];
  const all = vi.fn(async () => {
    throw new Error("D1 execution must use the unified run() result");
  });
  const run = vi.fn(async () => ({
    success: true,
    results: result.rows,
    meta: {
      changes: result.changes,
      last_row_id: Number(result.lastInsertRowid ?? 0),
    },
  }));
  const statement = {
    all,
    bind(...values: unknown[]) {
      boundValues.push(...values);
      return statement;
    },
    run,
  };
  const database = {
    prepare: vi.fn(() => statement),
  };

  return {
    all,
    boundValues,
    driver: new D1Driver({ database: database as unknown as D1Database }),
    run,
  };
}

function createD1BatchDriver(results: StatementResult[]) {
  const preparedSql: string[] = [];
  const database = {
    batch: vi.fn(async () =>
      results.map((result) => ({
        success: true,
        results: result.rows,
        meta: {
          changes: result.changes,
          last_row_id: Number(result.lastInsertRowid ?? 0),
        },
      }))
    ),
    prepare(sql: string) {
      preparedSql.push(sql);
      const statement = {
        bind() {
          return statement;
        },
      };
      return statement;
    },
  };

  return {
    batch: database.batch,
    driver: new D1Driver({ database: database as unknown as D1Database }),
    preparedSql,
  };
}

const resultProducerCases = [
  {
    label: "SELECT",
    sql: `SELECT 'returning' AS "value"`,
    columnNames: ["value"],
    changes: 0,
  },
  {
    label: "empty SELECT",
    sql: `SELECT 1 AS "value" WHERE 0`,
    columnNames: ["value"],
    changes: 0,
    empty: true,
  },
  {
    label: "leading-comment SELECT",
    sql: `/* returning is only a leading comment */ SELECT 1 AS "value"`,
    columnNames: ["value"],
    changes: 0,
  },
  {
    label: "INSERT RETURNING",
    sql: `INSERT INTO "returning_events" DEFAULT VALUES RETURNING "id"`,
    columnNames: ["id"],
    changes: 1,
  },
  {
    label: "UPDATE RETURNING",
    sql: `UPDATE "returning_events" SET "note" = 'x' RETURNING "id"`,
    columnNames: ["id"],
    changes: 1,
  },
  {
    label: "DELETE RETURNING",
    sql: `DELETE FROM "returning_events" RETURNING "id"`,
    columnNames: ["id"],
    changes: 1,
  },
  {
    label: "CTE",
    sql: `WITH "returning_cte" AS (SELECT 1 AS "value") SELECT "value" FROM "returning_cte"`,
    columnNames: ["value"],
    changes: 0,
  },
  {
    label: "PRAGMA query",
    sql: `PRAGMA table_info("returning_events")`,
    columnNames: ["cid", "name"],
    changes: 0,
  },
  {
    label: "row-producing PRAGMA setter",
    sql: "PRAGMA journal_mode = MEMORY",
    columnNames: ["journal_mode"],
    changes: 0,
  },
  {
    label: "EXPLAIN",
    sql: `EXPLAIN SELECT * FROM "returning_events"`,
    columnNames: ["addr", "opcode"],
    changes: 0,
  },
] as const;

const nonReaderCases = [
  {
    label: "identifier",
    sql: `CREATE TABLE "returning_events" ("id" INTEGER PRIMARY KEY)`,
    changes: 0,
  },
  {
    label: "comment",
    sql: "INSERT INTO events DEFAULT VALUES /* returning is a comment */",
    changes: 1,
  },
  {
    label: "line comment",
    sql: "INSERT INTO events DEFAULT VALUES -- returning is a comment\n",
    changes: 1,
  },
  {
    label: "literal",
    sql: `INSERT INTO events (note) VALUES ('returning is data')`,
    changes: 1,
  },
  {
    label: "PRAGMA setter",
    sql: "PRAGMA foreign_keys = ON",
    changes: 0,
  },
  {
    label: "CTE INSERT",
    sql: `WITH "returning_cte"("note") AS (VALUES ('cte')) INSERT INTO events ("note") SELECT "note" FROM "returning_cte"`,
    changes: 1,
  },
  {
    label: "ordinary UPDATE",
    sql: `UPDATE events SET note = 'updated'`,
    changes: 2,
  },
  {
    label: "ordinary DELETE",
    sql: "DELETE FROM events",
    changes: 2,
  },
] as const;

describe("Bun SQLite statement execution", () => {
  test.each(
    resultProducerCases
  )("uses provider result metadata for $label", async (statementCase) => {
    const { sql, columnNames } = statementCase;
    const rows = "empty" in statementCase ? [] : [{ value: sql }];
    const { all, driver, run } = createBunStatementDriver([...columnNames], {
      rows,
      changes: 0,
    });

    try {
      const result = await driver._executeRaw(sql, ["returning"]);

      expect(result).toEqual({ rows, rowCount: rows.length });
      expect(all).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
    } finally {
      await driver.disconnect();
    }
  });

  test.each(
    nonReaderCases
  )("uses mutation execution for the $label non-reader", async ({
    sql,
    changes,
  }) => {
    const { all, driver, run } = createBunStatementDriver([], {
      rows: [],
      changes,
      lastInsertRowid: 91,
    });

    try {
      const result = await driver._executeRaw(sql);

      expect(result).toEqual({ rows: [], rowCount: changes });
      expect(result).not.toHaveProperty("insertId");
      expect(run).toHaveBeenCalledOnce();
      expect(all).not.toHaveBeenCalled();
    } finally {
      await driver.disconnect();
    }
  });
});

describe("D1 statement execution", () => {
  test.each([
    ...resultProducerCases,
    ...nonReaderCases,
  ])("uses unified run() results for $label", async (statementCase) => {
    const { sql } = statementCase;
    const isResultProducer = "columnNames" in statementCase;
    const rows =
      isResultProducer && !("empty" in statementCase) ? [{ value: sql }] : [];
    const { changes } = statementCase;
    const isInsert = sql.toUpperCase().includes("INSERT INTO");
    const { all, boundValues, driver, run } = createD1StatementDriver({
      rows,
      changes,
      lastInsertRowid: isInsert ? 91 : 0,
    });

    try {
      const result = await driver._executeRaw(sql, ["returning"]);

      expect(result.rows).toEqual(rows);
      expect(result.rowCount).toBe(changes || rows.length);
      if (isInsert) expect(result.insertId).toBe(91);
      else expect(result).not.toHaveProperty("insertId");
      expect(boundValues).toEqual(["returning"]);
      expect(run).toHaveBeenCalledOnce();
      expect(all).not.toHaveBeenCalled();
    } finally {
      await driver.disconnect();
    }
  });

  test("normalizes mixed mutation and reader results from native batch", async () => {
    const { batch, driver, preparedSql } = createD1BatchDriver([
      { rows: [], changes: 1, lastInsertRowid: 12 },
      { rows: [{ id: 1 }, { id: 2 }], changes: 0 },
    ]);

    try {
      const results = await driver._executeBatch([
        {
          sql: "INSERT INTO returning_events(note) VALUES (?)",
          params: ["inserted"],
        },
        { sql: "SELECT id FROM returning_events" },
      ]);

      expect(results).toEqual([
        { rows: [], rowCount: 1, insertId: 12 },
        { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 },
      ]);
      expect(preparedSql).toEqual([
        "INSERT INTO returning_events(note) VALUES (?)",
        "SELECT id FROM returning_events",
      ]);
      expect(batch).toHaveBeenCalledOnce();
    } finally {
      await driver.disconnect();
    }
  });

  test("native batch keeps tagged and unsafe raw result ordering", async () => {
    const { batch, driver, preparedSql } = createD1BatchDriver([
      { rows: [{ arm: "tagged" }], changes: 0 },
      { rows: [{ arm: "unsafe" }], changes: 0 },
    ]);
    const client = createClient({ schema: {}, driver });
    const executeBatch = vi.spyOn(driver, "_executeBatch");

    try {
      const results = await client.$transaction([
        client.$queryRaw<{ arm: string }>`SELECT ${"tagged"} AS arm`,
        client.$queryRawUnsafe<{ arm: string }>("SELECT ? AS arm", "unsafe"),
      ]);

      expect(results).toEqual([[{ arm: "tagged" }], [{ arm: "unsafe" }]]);
      expect(preparedSql).toEqual(["SELECT ? AS arm", "SELECT ? AS arm"]);
      expect(batch).toHaveBeenCalledOnce();
      const submitted = executeBatch.mock.calls[0]?.[0] ?? [];
      expect(submitted.map((query) => Object.keys(query))).toEqual([
        ["sql", "params", "context"],
        ["sql", "params", "context"],
      ]);
    } finally {
      await client.$disconnect();
    }
  });
});
