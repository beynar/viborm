import { D1Driver } from "@drivers/d1";
import { QueryError } from "@errors";
import { createOfficialTestExecutionContext } from "@tests/unit/instrumentation/_official-context";
import { describe, expect, test, vi } from "vitest";

type D1Database = ConstructorParameters<typeof D1Driver>[0]["database"];

interface NullD1Result {
  success: true;
  results: null;
  meta: { changes: number; last_row_id: number };
}

function nullResult(changes = 0, lastRowId = 0): NullD1Result {
  return {
    success: true,
    results: null,
    meta: { changes, last_row_id: lastRowId },
  };
}

function createSingleResultDriver(result: NullD1Result): D1Driver {
  const statement = {
    bind() {
      return statement;
    },
    run: vi.fn(async () => result),
  };
  const database = {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
  return new D1Driver({ database });
}

function createBatchDriver(
  executeBatch: () => Promise<NullD1Result[]>
): D1Driver {
  const database = {
    prepare: vi.fn(() => {
      const statement = {
        bind() {
          return statement;
        },
      };
      return statement;
    }),
    batch: vi.fn(executeBatch),
  } as unknown as D1Database;
  return new D1Driver({ database });
}

function createBatchResultDriver(results: NullD1Result[]): D1Driver {
  return createBatchDriver(() => Promise.resolve(results));
}

function createBatchRejectingDriver(error: Error): D1Driver {
  return createBatchDriver(() => Promise.reject(error));
}

async function captureMalformedResult(
  promise: Promise<unknown>
): Promise<QueryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QueryError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected D1 null results to be rejected.");
}

describe("D1 binding null-result statement contracts", () => {
  test("publishes the concrete generated row id reported by D1", async () => {
    await expect(
      createSingleResultDriver(nullResult(1, 42))._executeRaw(
        "INSERT INTO events DEFAULT VALUES"
      )
    ).resolves.toEqual({ rows: [], rowCount: 1, insertId: 42 });
  });

  test("does not publish D1's sticky row id for a later non-insert statement", async () => {
    await expect(
      createSingleResultDriver(nullResult(1, 42))._executeRaw(
        "UPDATE events SET note = 'later'"
      )
    ).resolves.toEqual({ rows: [], rowCount: 1 });
  });

  test("accepts a signed SQLite row id without publishing it as generated identity", async () => {
    await expect(
      createSingleResultDriver(nullResult(1, -7))._executeRaw(
        "INSERT INTO events DEFAULT VALUES"
      )
    ).resolves.toEqual({ rows: [], rowCount: 1 });
  });

  test.each([
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
  ])("rejects a non-safe D1 last_row_id (%s)", async (lastRowId) => {
    await expect(
      createSingleResultDriver(nullResult(1, lastRowId))._executeRaw(
        "INSERT INTO events DEFAULT VALUES"
      )
    ).rejects.toThrow("a safe-integer last_row_id");
  });

  test.each([
    ["DDL", "CREATE TABLE events (id INTEGER)", 0],
    [
      "literal containing RETURNING",
      "INSERT INTO events (note) VALUES ('RETURNING is data')",
      1,
    ],
    [
      "block comment containing RETURNING",
      "INSERT INTO events DEFAULT VALUES /* RETURNING id */",
      1,
    ],
    [
      "line comment containing RETURNING",
      "INSERT INTO events DEFAULT VALUES -- RETURNING id\n",
      1,
    ],
    [
      "quoted RETURNING identifier",
      'INSERT INTO "returning" DEFAULT VALUES',
      1,
    ],
    [
      "non-returning CTE mutation",
      "WITH source(value) AS (VALUES ('RETURNING')) INSERT INTO events(note) SELECT value FROM source",
      1,
    ],
    ["known non-returning PRAGMA", "PRAGMA foreign_keys = ON", 0],
    ["double-quoted PRAGMA setter", 'PRAGMA "foreign_keys" = ON', 0],
    ["backtick-quoted PRAGMA setter", "PRAGMA `foreign_keys` = ON", 0],
    ["bracket-quoted PRAGMA setter", "PRAGMA [foreign_keys] = ON", 0],
    ["known no-row PRAGMA command", "PRAGMA optimize", 0],
    ["parenthesized non-returning PRAGMA", "PRAGMA foreign_keys(ON)", 0],
    ["deferred-FK PRAGMA setter", "PRAGMA defer_foreign_keys(ON)", 0],
    ["recursive-trigger PRAGMA setter", "PRAGMA recursive_triggers = ON", 0],
    ["case-sensitive-LIKE PRAGMA setter", "PRAGMA case_sensitive_like(ON)", 0],
    ["ignore-checks PRAGMA setter", "PRAGMA ignore_check_constraints = ON", 0],
    ["legacy-alter PRAGMA setter", "PRAGMA legacy_alter_table(ON)", 0],
    ["reverse-order PRAGMA setter", "PRAGMA reverse_unordered_selects = ON", 0],
    ["colon named parameter", "UPDATE events SET note = :returning", 1],
    ["at-sign named parameter", "UPDATE events SET note = @returning", 1],
    ["dollar named parameter", "UPDATE events SET note = $returning", 1],
  ])("accepts null for %s", async (_label, sql, changes) => {
    await expect(
      createSingleResultDriver(nullResult(changes))._executeRaw(sql)
    ).resolves.toEqual({ rows: [], rowCount: changes });
  });

  test.each([
    ["SELECT", "SELECT 1"],
    ["leading-comment SELECT", "/* RETURNING */ SELECT 1"],
    ["EXPLAIN", "EXPLAIN SELECT 1"],
    ["INSERT RETURNING", "INSERT INTO events DEFAULT VALUES RETURNING id"],
    ["UPDATE RETURNING", "UPDATE events SET note = 'x' RETURNING id"],
    ["DELETE RETURNING", "DELETE FROM events RETURNING id"],
    ["read PRAGMA", "PRAGMA table_info(events)"],
    ["row-producing PRAGMA setter", "PRAGMA journal_mode = MEMORY"],
    ["unknown statement", "UNKNOWN STATEMENT"],
    ["multiple statements", "CREATE TABLE a(id); CREATE TABLE b(id)"],
  ])("rejects null for %s", async (_label, sql) => {
    const error = await captureMalformedResult(
      createSingleResultDriver(nullResult())._executeRaw(sql)
    );

    expect(error.meta).toMatchObject({
      driver: "d1",
      operation: "executeRaw",
    });
    expect(error.meta).not.toHaveProperty("query");
    expect(error.meta).not.toHaveProperty("params");
  });

  test("rejects null when the engine operation promises rows", async () => {
    const driver = createSingleResultDriver(nullResult());

    const error = await captureMalformedResult(
      driver._executeRaw("CREATE TABLE events (id INTEGER)", undefined, {
        operation: "findMany",
      })
    );

    expect(error.meta).toMatchObject({
      driver: "d1",
      operation: "findMany",
    });
  });

  test("classifies each native batch statement independently", async () => {
    const driver = createBatchResultDriver([nullResult(1), nullResult(0)]);

    await expect(
      driver._executeBatch([
        {
          sql: "INSERT INTO events(note) VALUES ('RETURNING is data')",
        },
        { sql: "PRAGMA foreign_keys = ON" },
      ])
    ).resolves.toEqual([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
  });

  test("acknowledges commit before normalizing a malformed batch result", async () => {
    const driver = createBatchResultDriver([
      {
        success: true,
        results: null,
        meta: { changes: -1, last_row_id: 0 },
      },
    ]);
    const committed = vi.fn(() => Promise.resolve());

    await expect(
      driver._executeBatch(
        [{ sql: "UPDATE events SET note = 'updated'" }],
        undefined,
        undefined,
        committed
      )
    ).rejects.toBeInstanceOf(QueryError);
    expect(committed).toHaveBeenCalledOnce();
  });

  test("attributes statement preparation failures to their batch position", async () => {
    const batch = vi.fn();
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind(...params: unknown[]) {
            if (sql === "SELECT broken") {
              const nested = params[0];
              if (typeof nested === "object" && nested !== null) {
                Object.assign(nested, { value: "provider-mutated" });
              }
              throw new Error("private statement preparation failure");
            }
            return statement;
          },
        };
        return statement;
      }),
      batch,
    } as unknown as D1Database;
    const driver = new D1Driver({ database });
    const officialContext = (values: Record<string, string>) =>
      createOfficialTestExecutionContext(
        { diagnostics: { includeParams: true } },
        values
      );

    const parameter = { value: "original" };
    const execution = driver._executeBatch(
      [
        {
          sql: "SELECT valid",
          context: officialContext({
            model: "user",
            operation: "findMany",
            correlationId: "d1-first-correlation",
          }),
        },
        {
          sql: "SELECT broken",
          params: [parameter],
          context: officialContext({
            model: "post",
            operation: "findMany",
            correlationId: "d1-second-correlation",
          }),
        },
      ],
      undefined,
      officialContext({
        model: "$transaction",
        operation: "$transaction([...])",
        correlationId: "d1-outer-correlation",
      })
    );
    parameter.value = "caller-mutated";
    const error = await captureMalformedResult(execution);

    expect(error.meta).toMatchObject({
      driver: "d1",
      model: "post",
      operation: "findMany",
      correlationId: "d1-second-correlation",
      params: [{ value: "original" }],
    });
    expect(JSON.stringify(error)).not.toContain("private statement");
    expect(batch).not.toHaveBeenCalled();
  });

  test("attributes a one-statement native provider rejection without guessing across an opaque batch", async () => {
    const statementContext = {
      model: "post",
      operation: "findMany",
      correlationId: "d1-statement-correlation",
    };
    const batchContext = {
      model: "$transaction",
      operation: "$transaction([...])",
      correlationId: "d1-batch-correlation",
    };

    const attributable = await captureMalformedResult(
      createBatchRejectingDriver(
        new Error("D1 rejected the native batch")
      )._executeBatch(
        [{ sql: "SELECT id FROM posts", context: statementContext }],
        undefined,
        batchContext
      )
    );
    expect(attributable.meta).toMatchObject({
      driver: "d1",
      ...statementContext,
      statementIndex: 0,
    });

    const opaque = await captureMalformedResult(
      createBatchRejectingDriver(
        new Error("D1 rejected the native batch")
      )._executeBatch(
        [
          { sql: "SELECT id FROM users", context: { model: "user" } },
          { sql: "SELECT id FROM posts", context: statementContext },
        ],
        undefined,
        batchContext
      )
    );
    expect(opaque.meta).toMatchObject({ driver: "d1", ...batchContext });
    expect(opaque.meta).not.toHaveProperty("statementIndex");
  });

  test("rejects a row-producing statement at its own batch position", async () => {
    const driver = createBatchResultDriver([nullResult(1), nullResult(0)]);

    const error = await captureMalformedResult(
      driver._executeBatch(
        [
          { sql: "UPDATE events SET note = 'updated'" },
          {
            sql: "SELECT id FROM events",
            context: {
              model: "event",
              operation: "findMany",
              correlationId: "d1-query-correlation",
            },
          },
        ],
        undefined,
        {
          model: "$transaction",
          operation: "$transaction([...])",
          correlationId: "d1-batch-correlation",
        }
      )
    );

    expect(error.meta).toMatchObject({
      driver: "d1",
      model: "event",
      operation: "findMany",
      correlationId: "d1-query-correlation",
    });
  });
});
