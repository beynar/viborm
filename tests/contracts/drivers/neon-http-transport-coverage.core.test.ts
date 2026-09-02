/**
 * The Neon HTTP transport, driven through a controlled stand-in for
 * `@neondatabase/serverless`.
 *
 * A core test takes no hosted credential, so the provider module is replaced by
 * a fake whose surface is EXACTLY what `src/drivers/neon-http/index.ts` calls:
 * `neon(url, options)` returning a query function that also carries
 * `transaction`, plus the `types.getTypeParser` the UTC-safe wrapper delegates
 * to. Everything asserted here is local driver code — parser installation,
 * statement submission, result validation, failure attribution.
 *
 * What a fake CANNOT prove is deliberately absent: durable commit, cross-
 * statement visibility, and hosted error attribution stay with
 * `tests/providers/hosted/neon-http.test.ts`.
 */

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
    /** One provider result per submitted statement, in submission order. */
    batchResults: unknown[];
    /**
     * How many results the request actually comes back with. Neon answers a
     * batch with whatever the server sent, which is the only way the driver's
     * post-commit cardinality check (`index.ts:306`) can ever be reached.
     */
    providerResultCount: number | undefined;
    singleResult: unknown;
    /** Every statement handed to the submitted-query builder, in order. */
    submitted: { params: unknown[]; sql: string }[];
    /** The statement that builder refuses synchronously. */
    synchronousFailureSql: string | undefined;
  } = {
    batchResults: [],
    providerResultCount: undefined,
    singleResult: undefined,
    submitted: [],
    synchronousFailureSql: undefined,
  };
  const fallbackParser = vi.fn((value: string) => `fallback:${value}`);
  const getTypeParser = vi.fn(
    (_oid: number, _format?: string) => fallbackParser
  );
  const transaction = vi.fn(
    async (
      build: (submit: (sql: string, params: unknown[]) => unknown) => unknown[]
    ) => {
      const submit = (statement: string, params: unknown[]) => {
        state.submitted.push({ params, sql: statement });
        if (statement === state.synchronousFailureSql) {
          throw new Error("provider rejected statement synchronously");
        }
        return Promise.resolve(state.batchResults[state.submitted.length - 1]);
      };
      const results = await Promise.all(build(submit));
      return state.providerResultCount === undefined
        ? results
        : results.slice(0, state.providerResultCount);
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

/**
 * One well-formed `fullResults` payload. `rowCount` is REQUIRED because
 * `normalizePostgresRowCount` (`src/drivers/shared/postgres-result.ts:104`)
 * refuses a null count for a counted command tag: defaulting it would build a
 * malformed payload while reading like a valid one.
 */
function fullResult(
  rows: Record<string, unknown>[],
  rowCount: number | null,
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
  throw new Error("Expected the Neon driver to refuse this provider answer.");
}

beforeEach(() => {
  vi.clearAllMocks();
  neonProvider.state.batchResults = [];
  neonProvider.state.providerResultCount = undefined;
  neonProvider.state.singleResult = fullResult([], 0);
  neonProvider.state.submitted = [];
  neonProvider.state.synchronousFailureSql = undefined;
});

describe("Neon HTTP controlled transport execution", () => {
  test("initializes the HTTP query with UTC-safe parsers and executes typed and raw statements", async () => {
    neonProvider.state.singleResult = fullResult([{ id: 7 }], 1);
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
    await expect(driver._executeRaw("SELECT id FROM events")).resolves.toEqual({
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
      "SELECT id FROM events",
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

    // Identity for the two text timestamp OIDs — a delegated parser would
    // answer "fallback:…" here — and delegation for everything else.
    expect(timestampParser("2026-08-31 10:20:30")).toBe("2026-08-31 10:20:30");
    expect(dateParser("2026-08-31")).toBe("2026-08-31");
    expect(binaryParser("value")).toBe("fallback:value");
    expect(ordinaryParser("42")).toBe("fallback:42");
  });

  test("submits one native batch in statement order and counts an empty mutation from its command tag", async () => {
    neonProvider.state.batchResults = [
      fullResult([{ id: 1 }], 1),
      fullResult([], 2, "UPDATE"),
    ];
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgres://local.test/viborm",
    });

    // The UPDATE answers with no rows, so its count of 2 can only have come
    // from the command tag — reading `rows.length` would report 0.
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

    // One request, carrying both statements in the order they were given.
    expect(neonProvider.transaction).toHaveBeenCalledOnce();
    expect(neonProvider.state.submitted).toEqual([
      { params: [1], sql: "SELECT id FROM events WHERE id = $1" },
      { params: [false], sql: "UPDATE events SET active = $1" },
    ]);
  });

  test("attributes a synchronous batch submission failure to its statement", async () => {
    neonProvider.state.synchronousFailureSql = "BROKEN";
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgres://local.test/viborm",
    });

    // Only the refused statement carries a correlation id, which is what lets
    // `findUniqueExecutionContextIndex` name it; the same id on both statements
    // would leave the failure at batch scope instead.
    await expect(
      driver._executeBatch([
        { sql: "SELECT 1" },
        {
          sql: "BROKEN",
          params: ["e2"],
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
    ["array-mode rows", { ...fullResult([], 0), rowAsArray: true }],
    ["non-object rows", { ...fullResult([], 1), rows: [null] }],
  ])("rejects %s", async (_label, payload) => {
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
    neonProvider.state.batchResults = [fullResult([], 0), fullResult([], 0)];
    // Both statements are submitted, but the request comes back one result
    // short — the drift `executeBatch` can only see after the round trip.
    neonProvider.state.providerResultCount = 1;
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

  test("refuses to connect without the required URL, before it builds an HTTP query", async () => {
    // `initClient` throws a plain Error, so the generic connection lifecycle
    // wraps it (`error-mapping.ts:415`) and `sanitizeErrorCause` redacts the
    // driver's own wording: "Database connection failed" IS the public answer.
    await expect(new NeonHTTPDriver()._connect()).rejects.toThrow(
      "Database connection failed"
    );

    expect(neonProvider.neon).not.toHaveBeenCalled();
  });
});

describe("coverage low value", () => {
  test("closing an HTTP transport is a no-op the lifecycle still runs", async () => {
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgres://local.test/viborm",
    });
    await driver._connect();

    // `closeClient` has nothing to close over HTTP (`index.ts:205`). Executing
    // it is not evidence for a behavioral contract; the lifecycle contract it
    // belongs to is owned by the generic disconnect tests.
    await expect(driver.disconnect()).resolves.toBeUndefined();
  });
});
