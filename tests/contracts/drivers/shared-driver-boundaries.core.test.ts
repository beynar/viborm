import {
  assertStatementBindParameterCapacity,
  normalizedBindParameterLimit,
} from "@drivers/bind-parameter-capacity";
import { attachCommitCertainty } from "@drivers/driver-error-context";
import {
  ASSERTION_MARKER,
  batchMayContainAssertionCollision,
} from "@drivers/error-mapping";
import { normalizePostgresRowCount } from "@drivers/shared/postgres-result";
import {
  nestedTransactionDispatchError,
  runSavepoint,
  unsupportedCallbackTransactionError,
} from "@drivers/shared/transactions";
import { QueryError, UnsupportedOperationError } from "@errors";
import { sql } from "@sql";
import { describe, expect, test, vi } from "vitest";

const SAVEPOINT_STATEMENT = /^SAVEPOINT sp_[0-9a-f]{32}$/;
const postgresContext = {
  correlationId: "postgres-result-correlation",
  model: "entry",
  operation: "executeRaw",
  provider: "fixture-postgres",
};

describe("driver bind parameter capacity", () => {
  test.each([
    [undefined, undefined],
    [null, undefined],
    [0, undefined],
    [-1, undefined],
    [1.5, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    ["100", undefined],
    [1, 1],
    [65_535, 65_535],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizedBindParameterLimit(input)).toBe(expected);
  });

  test("accepts an exact limit and refuses one indivisible excess before dispatch", () => {
    const statement = sql`SELECT ${1}, ${2}`;

    expect(() =>
      assertStatementBindParameterCapacity(
        statement,
        "fixture",
        undefined,
        "write"
      )
    ).not.toThrow();
    expect(() =>
      assertStatementBindParameterCapacity(statement, "fixture", 2, "write")
    ).not.toThrow();
    expect(() =>
      assertStatementBindParameterCapacity(statement, "fixture", 1, "write")
    ).toThrowError(
      expect.objectContaining({
        name: "UnsupportedOperationError",
        message:
          "Driver 'fixture' cannot execute this write because one indivisible statement needs 2 bound values, above the verified limit of 1.",
      })
    );
    expect(() =>
      assertStatementBindParameterCapacity(statement, "fixture", 1, "write")
    ).toThrow(UnsupportedOperationError);
  });
});

describe("PostgreSQL provider result metadata", () => {
  test.each([
    ["SELECT", 2, 2],
    ["select 2", 2, 2],
    ["UPDATE 7", 7, 7],
    ["COPY 3", 3, 3],
    ["CREATE TABLE", null, 2],
    ["BEGIN", null, 2],
    ["VACUUM", null, 2],
  ] as const)("normalizes %s count %s", (command, count, expected) => {
    expect(
      normalizePostgresRowCount(
        count,
        command,
        [{ id: 1 }, { id: 2 }],
        postgresContext
      )
    ).toBe(expected);
  });

  test.each([
    ["a non-array row payload", 0, "SELECT", {}],
    ["an absent command", 0, undefined, []],
    ["an empty command", 0, "  ", []],
    ["a non-word command", 0, "SELECT;", []],
    ["an unknown command", 0, "UPSERT", []],
    ["a null counted result", null, "SELECT", []],
    ["a malformed count", "01", "UPDATE", []],
  ])("refuses %s", (_label, count, command, rows) => {
    expect(() =>
      normalizePostgresRowCount(count, command, rows, postgresContext)
    ).toThrow(QueryError);
    expect(() =>
      normalizePostgresRowCount(count, command, rows, postgresContext)
    ).toThrow('Driver "fixture-postgres" returned');
  });
});

describe("batch assertion attribution", () => {
  test.each([
    ["postgresql", "SELECT total / divisor", true],
    ["postgresql", "SELECT total + divisor", false],
    ["mysql", "SELECT JSON_EXTRACT(value, '$.id')", true],
    ["mysql", "SELECT value + 1", false],
    ["sqlite", "SELECT value -> '$.id'", true],
    ["sqlite", "SELECT value + 1", false],
  ] as const)("%s classifies %s with collision=%s", (dialect, statement, expected) => {
    expect(
      batchMayContainAssertionCollision([{ sql: statement }], dialect)
    ).toBe(expected);
  });

  test("ignores the assertion statement's own failure signature", () => {
    expect(
      batchMayContainAssertionCollision(
        [
          { sql: `SELECT 1 / 0 AS ${ASSERTION_MARKER}` },
          { sql: "SELECT id FROM entries" },
        ],
        "postgresql"
      )
    ).toBe(false);
  });
});

describe("transaction commit certainty", () => {
  test.each([
    "may-have-committed",
    "committed",
  ] as const)("clones a query failure with durable state %s", (commitCertainty) => {
    const cause = new Error("provider transport failed");
    const original = new QueryError("write failed", {
      cause,
      meta: {
        correlationId: "write-correlation",
        driver: "fixture",
        model: "entry",
        operation: "create",
      },
    });

    const clone = attachCommitCertainty(original, commitCertainty);

    expect(clone).toBeInstanceOf(QueryError);
    expect(clone).not.toBe(original);
    expect(clone.originalCause).toMatchObject({
      message: "Underlying error details redacted",
      name: "Error",
    });
    expect(clone.meta).toEqual({
      commitCertainty,
      correlationId: "write-correlation",
      driver: "fixture",
      model: "entry",
      operation: "create",
    });
    expect(original.meta).not.toHaveProperty("commitCertainty");
  });
});

describe("transaction capability failures", () => {
  test.each([
    [nestedTransactionDispatchError, "$transaction"],
    [unsupportedCallbackTransactionError, "$transaction(callback)"],
  ])("attributes the refusal to its public transaction form", (build, method) => {
    expect(build("fixture-driver")).toMatchObject({
      meta: { driver: "fixture-driver", method },
      name: "TransactionError",
    });
  });
});

describe("savepoint lifecycle", () => {
  test("creates and releases one private savepoint around success", async () => {
    const statements: string[] = [];
    const callback = vi.fn(async () => "done");

    await expect(
      runSavepoint((statement) => statements.push(statement), callback)
    ).resolves.toBe("done");

    expect(callback).toHaveBeenCalledOnce();
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(SAVEPOINT_STATEMENT);
    expect(statements[1]).toBe(
      statements[0]?.replace("SAVEPOINT ", "RELEASE SAVEPOINT ")
    );
  });

  test("keeps callback failure primary after rollback and release", async () => {
    const statements: string[] = [];
    const primary = new Error("callback failed");

    await expect(
      runSavepoint(
        (statement) => statements.push(statement),
        async () => Promise.reject(primary)
      )
    ).rejects.toBe(primary);

    const savepoint = statements[0]?.replace("SAVEPOINT ", "");
    expect(statements).toEqual([
      `SAVEPOINT ${savepoint}`,
      `ROLLBACK TO SAVEPOINT ${savepoint}`,
      `RELEASE SAVEPOINT ${savepoint}`,
    ]);
  });

  test("contains a failed release with rollback and one final release", async () => {
    const statements: string[] = [];
    const releaseFailure = new Error("release failed");
    let releases = 0;

    await expect(
      runSavepoint(
        (statement) => {
          statements.push(statement);
          if (statement.startsWith("RELEASE SAVEPOINT") && releases++ === 0) {
            throw releaseFailure;
          }
        },
        async () => "done"
      )
    ).rejects.toBe(releaseFailure);

    const savepoint = statements[0]?.replace("SAVEPOINT ", "");
    expect(statements).toEqual([
      `SAVEPOINT ${savepoint}`,
      `RELEASE SAVEPOINT ${savepoint}`,
      `ROLLBACK TO SAVEPOINT ${savepoint}`,
      `RELEASE SAVEPOINT ${savepoint}`,
    ]);
  });
});
