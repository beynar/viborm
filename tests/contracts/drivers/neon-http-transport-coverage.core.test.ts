import { NeonHTTPDriver } from "@drivers/neon-http";
import { QueryError } from "@errors";
import { sql } from "@sql";
import { beforeEach, describe, expect, test, vi } from "vitest";

interface CapturedNeonOptions {
  arrayMode: false;
  fetchOptions?: RequestInit;
  fullResults: true;
  types: {
    getTypeParser: (oid: number, format?: string) => (value: string) => unknown;
  };
}

const neonProvider = vi.hoisted(() => {
  const state: {
    batchResults: unknown[];
    singleResult: unknown;
    synchronousFailureSql: string | undefined;
  } = {
    batchResults: [],
    singleResult: undefined,
    synchronousFailureSql: undefined,
  };
  const fallbackParser = vi.fn((value: string) => `fallback:${value}`);
  const getTypeParser = vi.fn(
    (_oid: number, _format?: string) => fallbackParser
  );
  const transaction = vi.fn(
    async (
      callback: (
        query: (sql: string, params: unknown[]) => unknown
      ) => unknown[]
    ) => {
      let resultIndex = 0;
      const query = vi.fn((statement: string, _params: unknown[]) => {
        if (statement === state.synchronousFailureSql) {
          throw new Error("provider rejected statement synchronously");
        }
        const result = state.batchResults[resultIndex];
        resultIndex += 1;
        return Promise.resolve(result);
      });
      return Promise.all(callback(query));
    }
  );
  const query = Object.assign(
    vi.fn(async () => state.singleResult),
    { transaction }
  );
  const neon = vi.fn((_url: string, _options: CapturedNeonOptions) => query);

  return { fallbackParser, getTypeParser, neon, query, state, transaction };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: neonProvider.neon,
  types: { getTypeParser: neonProvider.getTypeParser },
}));

function fullResult(
  rows: Record<string, unknown>[] = [],
  rowCount: number | null = null,
  command = "SELECT"
) {
  return { command, fields: [], rowAsArray: false, rowCount, rows };
}

async function captureQueryError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error("Expected a malformed Neon payload to fail.");
}

beforeEach(() => {
  vi.clearAllMocks();
  neonProvider.state.batchResults = [];
  neonProvider.state.singleResult = fullResult();
  neonProvider.state.synchronousFailureSql = undefined;
});

describe("Neon HTTP controlled transport execution", () => {
  test("initializes the HTTP query with UTC-safe parsers and executes typed and raw statements", async () => {
    neonProvider.state.singleResult = fullResult([{ id: 7 }], null);
    const fetchOptions = { cache: "no-store" as const };
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgres://local.test/viborm",
      options: { fetchOptions },
    });

    await expect(
      driver._execute<{ id: number }>(sql`SELECT ${7}`, {
        operation: "findMany",
      })
    ).resolves.toEqual({ rows: [{ id: 7 }], rowCount: 1 });
    await expect(driver._executeRaw("DELETE FROM events")).resolves.toEqual({
      rows: [{ id: 7 }],
      rowCount: 1,
    });

    expect(neonProvider.neon).toHaveBeenCalledWith(
      "postgres://local.test/viborm",
      expect.objectContaining({
        arrayMode: false,
        fetchOptions,
        fullResults: true,
      })
    );
    expect(neonProvider.query).toHaveBeenNthCalledWith(1, "SELECT $1", [7], {
      arrayMode: false,
      fullResults: true,
    });
    expect(neonProvider.query).toHaveBeenNthCalledWith(
      2,
      "DELETE FROM events",
      [],
      { arrayMode: false, fullResults: true }
    );

    const options = neonProvider.neon.mock.calls[0]?.[1];
    const types = options?.types;
    if (!types) throw new Error("Expected Neon type parser options.");
    const timestampParser = types.getTypeParser(1114);
    const dateParser = types.getTypeParser(1082, "text");
    const binaryParser = types.getTypeParser(1114, "binary");
    const ordinaryParser = types.getTypeParser(23);

    expect(timestampParser("2026-08-31 10:20:30")).toBe("2026-08-31 10:20:30");
    expect(dateParser("2026-08-31")).toBe("2026-08-31");
    expect(binaryParser("value")).toBe("fallback:value");
    expect(ordinaryParser("42")).toBe("fallback:42");
    expect(neonProvider.getTypeParser).toHaveBeenCalledTimes(2);

    await driver.disconnect();
  });

  test("submits a native batch in order and normalizes command row counts", async () => {
    neonProvider.state.batchResults = [
      fullResult([{ id: 1 }], null, "SELECT"),
      fullResult([], 2, "UPDATE"),
    ];
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgres://local.test/viborm",
    });

    await expect(
      driver._executeBatch([
        {
          sql: "SELECT id FROM events WHERE id = $1",
          params: [1],
          context: { model: "event", operation: "findMany" },
        },
        {
          sql: "UPDATE events SET active = $1",
          params: [false],
          context: { model: "event", operation: "updateMany" },
        },
      ])
    ).resolves.toEqual([
      { rows: [{ id: 1 }], rowCount: 1 },
      { rows: [], rowCount: 2 },
    ]);

    const callback = neonProvider.transaction.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
  });

  test("attributes a synchronous batch submission failure to its statement", async () => {
    neonProvider.state.synchronousFailureSql = "BROKEN";
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgres://local.test/viborm",
    });

    await expect(
      driver._executeBatch([
        { sql: "SELECT 1" },
        {
          sql: "BROKEN",
          params: ["secret"],
          context: {
            correlationId: "batch-2",
            model: "event",
            operation: "deleteMany",
          },
        },
      ])
    ).rejects.toMatchObject({
      meta: {
        correlationId: "batch-2",
        driver: "neon-http",
        model: "event",
        operation: "deleteMany",
        statementIndex: 1,
      },
    });
  });

  test.each([
    ["missing full-result fields", { command: "SELECT", rows: [] }],
    ["array-mode rows", fullResult([], 0)],
    ["non-object rows", { ...fullResult([], 1), rows: [null] }],
  ])("rejects %s", async (_label, payload) => {
    if (_label === "array-mode rows") {
      Object.assign(payload, { rowAsArray: true });
    }
    neonProvider.state.singleResult = payload;
    const error = await captureQueryError(
      new NeonHTTPDriver({
        databaseUrl: "postgres://local.test/viborm",
      })._executeRaw("SELECT 1", undefined, {
        correlationId: "malformed-neon",
        model: "event",
        operation: "findMany",
      })
    );

    expect(error.message).toContain("malformed result payload");
    expect(error.meta).toMatchObject({
      correlationId: "malformed-neon",
      driver: "neon-http",
      model: "event",
      operation: "findMany",
    });
  });

  test("rejects native-batch result cardinality drift after provider completion", async () => {
    neonProvider.state.batchResults = [fullResult([], 0)];
    const error = await captureQueryError(
      new NeonHTTPDriver({
        databaseUrl: "postgres://local.test/viborm",
      })._executeBatch([{ sql: "SELECT 1" }, { sql: "SELECT 2" }], undefined, {
        correlationId: "batch-cardinality",
        operation: "transaction",
      })
    );

    expect(error.message).toContain(
      "expected 2 statement results but received 1"
    );
    expect(error.meta).toMatchObject({
      correlationId: "batch-cardinality",
      driver: "neon-http",
      operation: "transaction",
    });
  });

  test("refuses initialization without the required URL before provider work", async () => {
    await expect(new NeonHTTPDriver()._connect()).rejects.toThrow(
      "Neon HTTP driver requires a databaseUrl"
    );
    expect(neonProvider.neon).not.toHaveBeenCalled();
  });
});
