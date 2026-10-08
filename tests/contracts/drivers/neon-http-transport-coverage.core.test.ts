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
import type { BatchQuery, QueryExecutionContext } from "@drivers/types";
import { QueryError } from "@errors";
import type { NeonQueryFunction } from "@neondatabase/serverless";
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
    invalidBatchEnvelope: boolean;
    singleResult: unknown;
    /** Every statement handed to the submitted-query builder, in order. */
    submitted: { params: unknown[]; sql: string }[];
    /** The statement that builder refuses synchronously. */
    synchronousFailureSql: string | undefined;
  } = {
    batchResults: [],
    providerResultCount: undefined,
    invalidBatchEnvelope: false,
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
      build:
        | ((submit: {
            query: (sql: string, params: unknown[]) => unknown;
          }) => unknown[])
        | { queryData: { query: string; params: unknown[] } }[]
    ) => {
      const submit = (statement: string, params: unknown[]) => {
        state.submitted.push({ params, sql: statement });
        if (statement === state.synchronousFailureSql) {
          throw new Error("provider rejected statement synchronously");
        }
        return Promise.resolve(state.batchResults[state.submitted.length - 1]);
      };
      const results = await Promise.all(
        typeof build === "function"
          ? build({ query: submit })
          : build.map((query) =>
              submit(query.queryData.query, query.queryData.params)
            )
      );
      if (state.invalidBatchEnvelope) return null;
      return state.providerResultCount === undefined
        ? results
        : results.slice(0, state.providerResultCount);
    }
  );
  const query = vi.fn(
    (_sql: string, _params: unknown[], _options?: CapturedNeonOptions) => {
      if (_sql === state.synchronousFailureSql)
        throw new Error("provider rejected statement synchronously");
      return Object.assign(Promise.resolve(state.singleResult), {
        queryData: { query: _sql, params: _params },
        opts: _options,
      });
    }
  );
  Object.assign(query, { query, transaction });
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
  neonProvider.state.invalidBatchEnvelope = false;
  neonProvider.state.singleResult = fullResult([], 0);
  neonProvider.state.submitted = [];
  neonProvider.state.synchronousFailureSql = undefined;
});

/** Subclass hooks may omit context; they retain the same strict provider boundary. */
class HookProbe extends NeonHTTPDriver {
  open() {
    return this.initClient();
  }
  typed(client: NeonQueryFunction<false, true>) {
    return this.execute(client, "SELECT 1", []);
  }
  raw(client: NeonQueryFunction<false, true>) {
    return this.executeRaw(client, "SELECT 1", undefined);
  }
  batch(
    client: NeonQueryFunction<false, true>,
    queries: BatchQuery[],
    context?: QueryExecutionContext,
    committed?: () => Promise<void>
  ) {
    return this.executeBatch(client, queries, context, committed);
  }
}

describe("Neon HTTP controlled transport execution", () => {
  test("contextless subclass hooks retain exact rows and one commit notification", async () => {
    const driver = new HookProbe({
      databaseUrl: "postgres://local.test/viborm",
    });
    const client = await driver.open();
    neonProvider.state.singleResult = fullResult([{ id: 1 }], 1);
    await expect(driver.typed(client)).resolves.toEqual({
      rows: [{ id: 1 }],
      rowCount: 1,
    });
    await expect(driver.raw(client)).resolves.toEqual({
      rows: [{ id: 1 }],
      rowCount: 1,
    });
    neonProvider.state.batchResults = [fullResult([{ id: 2 }], 1)];
    const committed = vi.fn(async () => undefined);
    await expect(
      driver.batch(client, [{ sql: "SELECT 2" }], undefined, committed)
    ).resolves.toEqual([{ rows: [{ id: 2 }], rowCount: 1 }]);
    expect(committed).toHaveBeenCalledOnce();
    expect(neonProvider.transaction).toHaveBeenCalledOnce();
  });

  test("refuses a malformed batch envelope after acknowledgement without inventing results or replaying", async () => {
    const driver = new HookProbe({
      databaseUrl: "postgres://local.test/viborm",
    });
    const client = await driver.open();
    neonProvider.state.invalidBatchEnvelope = true;
    const committed = vi.fn(async () => undefined);
    const failure = await captureQueryError(
      driver.batch(client, [{ sql: "SELECT 1" }], {}, committed)
    );
    expect(failure.message).toContain(
      "expected 1 statement results but received 0"
    );
    expect(failure.meta).toMatchObject({
      driver: "neon-http",
      operation: "execute",
    });
    expect(committed).toHaveBeenCalledOnce();
    expect(neonProvider.transaction).toHaveBeenCalledOnce();
  });

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
      types: expect.objectContaining({ getTypeParser: expect.any(Function) }),
    });
    expect(neonProvider.query).toHaveBeenNthCalledWith(
      2,
      "SELECT id FROM events",
      [],
      {
        arrayMode: false,
        fullResults: true,
        types: expect.objectContaining({ getTypeParser: expect.any(Function) }),
      }
    );

    const options = neonProvider.query.mock.calls[0]?.[2];
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
    await expect(new NeonHTTPDriver()._connect()).rejects.toMatchObject({
      name: "ClientInitializationError",
      message: "Neon HTTP driver requires a databaseUrl",
    });

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
