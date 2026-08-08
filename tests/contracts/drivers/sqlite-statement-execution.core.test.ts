import { createClient } from "@client/client";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { s } from "@schema";
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
        meta: { changes: result.changes },
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
    const { all, boundValues, driver, run } = createD1StatementDriver({
      rows,
      changes,
      lastInsertRowid: 91,
    });

    try {
      const result = await driver._executeRaw(sql, ["returning"]);

      expect(result.rows).toEqual(rows);
      expect(result.rowCount).toBe(changes || rows.length);
      expect(result).not.toHaveProperty("insertId");
      expect(boundValues).toEqual(["returning"]);
      expect(run).toHaveBeenCalledOnce();
      expect(all).not.toHaveBeenCalled();
    } finally {
      await driver.disconnect();
    }
  });

  test("normalizes mixed mutation and reader results from native batch", async () => {
    const { batch, driver, preparedSql } = createD1BatchDriver([
      { rows: [], changes: 2 },
      { rows: [{ id: 1 }, { id: 2 }], changes: 0 },
    ]);

    try {
      const results = await driver._executeBatch([
        { sql: "UPDATE returning_events SET note = ?", params: ["updated"] },
        { sql: "SELECT id FROM returning_events" },
      ]);

      expect(results).toEqual([
        { rows: [], rowCount: 2 },
        { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 },
      ]);
      expect(preparedSql).toEqual([
        "UPDATE returning_events SET note = ?",
        "SELECT id FROM returning_events",
      ]);
      expect(batch).toHaveBeenCalledOnce();
    } finally {
      await driver.disconnect();
    }
  });
});

describe("SQLite3 provider statement metadata", () => {
  test("returns rows for CTE, PRAGMA, EXPLAIN, and every DML RETURNING form", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });

    try {
      await driver._executeRaw(
        `CREATE TABLE "returning_events" ("id" INTEGER PRIMARY KEY, "note" TEXT NOT NULL)`
      );
      await driver._executeRaw(
        `INSERT INTO "returning_events" ("note") VALUES (?)`,
        ["returning parameter"]
      );

      const cte = await driver._executeRaw<{ value: number }>(
        `WITH "returning_cte" AS (SELECT 1 AS "value") SELECT "value" FROM "returning_cte"`
      );
      const leadingComment = await driver._executeRaw<{ value: number }>(
        `/* returning is only a leading comment */ SELECT 1 AS "value"`
      );
      const empty = await driver._executeRaw<{ value: number }>(
        `SELECT 1 AS "value" WHERE 0`
      );
      const pragma = await driver._executeRaw<{ name: string }>(
        `PRAGMA table_info("returning_events")`
      );
      const pragmaSetter = await driver._executeRaw<{
        journal_mode: string;
      }>("PRAGMA journal_mode = MEMORY");
      const nonReaderPragma = await driver._executeRaw(
        "PRAGMA foreign_keys = ON"
      );
      const explain = await driver._executeRaw(
        `EXPLAIN SELECT * FROM "returning_events"`
      );
      const inserted = await driver._executeRaw<{ id: number; note: string }>(
        `INSERT INTO "returning_events" ("note") VALUES ('inserted') RETURNING "id", "note"`
      );
      const updated = await driver._executeRaw<{ id: number; note: string }>(
        `UPDATE "returning_events" SET "note" = 'updated' WHERE "id" = 1 RETURNING "id", "note"`
      );
      const deleted = await driver._executeRaw<{ id: number }>(
        `DELETE FROM "returning_events" WHERE "id" = 1 RETURNING "id"`
      );
      const cteInsert = await driver._executeRaw(
        `WITH "returning_source"("note") AS (VALUES ('cte')) INSERT INTO "returning_events" ("note") SELECT "note" FROM "returning_source"`
      );
      const lineCommentInsert = await driver._executeRaw(
        "INSERT INTO returning_events (note) VALUES ('line') -- returning is only a comment\n"
      );

      expect(cte.rows).toEqual([{ value: 1 }]);
      expect(leadingComment.rows).toEqual([{ value: 1 }]);
      expect(empty).toEqual({ rows: [], rowCount: 0 });
      expect(pragma.rows.map((column) => column.name)).toEqual(["id", "note"]);
      expect(pragmaSetter.rows).toEqual([{ journal_mode: "memory" }]);
      expect(nonReaderPragma).toEqual({ rows: [], rowCount: 0 });
      expect(explain.rows.length).toBeGreaterThan(0);
      expect(inserted).toMatchObject({
        rows: [{ id: 2, note: "inserted" }],
        rowCount: 1,
      });
      expect(updated).toMatchObject({
        rows: [{ id: 1, note: "updated" }],
        rowCount: 1,
      });
      expect(deleted).toMatchObject({ rows: [{ id: 1 }], rowCount: 1 });
      expect(cteInsert).toEqual({ rows: [], rowCount: 1 });
      expect(lineCommentInsert).toEqual({ rows: [], rowCount: 1 });
    } finally {
      await driver.disconnect();
    }
  });

  test("does not expose a sticky inserted id on later UPDATE or DELETE results", async () => {
    const driver = new SQLite3Driver({ dataDir: ":memory:" });

    try {
      await driver._executeRaw(
        `CREATE TABLE "events" ("id" INTEGER PRIMARY KEY, "note" TEXT NOT NULL)`
      );
      await driver._executeRaw(`INSERT INTO "events" ("note") VALUES ('one')`);

      const updated = await driver._executeRaw(
        `UPDATE "events" SET "note" = 'two' WHERE "id" = 1`
      );
      const deleted = await driver._executeRaw(
        `DELETE FROM "events" WHERE "id" = 1`
      );

      expect(updated).toEqual({ rows: [], rowCount: 1 });
      expect(deleted).toEqual({ rows: [], rowCount: 1 });
    } finally {
      await driver.disconnect();
    }
  });
});

describe("SQLite3 public returning_events regression", () => {
  test("pushes the mapped table and creates a generated-id row", async () => {
    const event = s
      .model({
        id: s.int().id().increment(),
        note: s.string(),
      })
      .map("returning_events");
    const client = createClient({
      schema: { event },
      driver: new SQLite3Driver({ dataDir: ":memory:" }),
    });

    try {
      await push(client, { force: true });
      const created = await client.event.create({
        data: { note: "returning is ordinary data" },
      });

      expect(created).toEqual({ id: 1, note: "returning is ordinary data" });
      await expect(client.event.findMany({})).resolves.toEqual([created]);
    } finally {
      await client.$disconnect();
    }
  });
});
