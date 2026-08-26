import { D1Driver } from "@drivers/d1";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PlanetScaleDriver } from "@drivers/planetscale";
import type { BatchQuery } from "@drivers/types";
import { isVibORMError, QueryError } from "@errors";
import { createOfficialTestExecutionContext } from "@tests/unit/instrumentation/_official-context";
import { describe, expect, it, vi } from "vitest";

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject(error): void {
      if (!rejectPromise) throw new Error("deferred rejection is unavailable");
      rejectPromise(error);
    },
    resolve(value): void {
      if (!resolvePromise)
        throw new Error("deferred resolution is unavailable");
      resolvePromise(value);
    },
  };
}

function createSignal(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  const deferred = createDeferred<void>();
  return {
    promise: deferred.promise,
    resolve(): void {
      deferred.resolve();
    },
  };
}

async function captureQueryError(
  promise: Promise<unknown>
): Promise<QueryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error("expected QueryError");
}

describe("provider execution-context concurrency", () => {
  it("keeps D1 statement context immutable across a delayed native batch", async () => {
    const started = createSignal();
    const providerResults = createDeferred<unknown>();
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...params: unknown[]) => ({ params, sql })),
      })),
      batch: vi.fn(async () => {
        started.resolve();
        return providerResults.promise;
      }),
    } as unknown as ConstructorParameters<typeof D1Driver>[0]["database"];
    const driver = new D1Driver({ database });
    const clientReady = createDeferred<typeof database>();
    Reflect.set(driver, "client", null);
    Reflect.set(driver, "initClient", () => clientReady.promise);
    const officialContext = (values: BatchQuery["context"]) =>
      createOfficialTestExecutionContext(
        { diagnostics: { includeParams: true, includeSql: true } },
        values ?? {}
      );
    const firstSource = {
      model: "user",
      operation: "findMany",
      correlationId: "d1-first",
    };
    const secondSource = {
      model: "post",
      operation: "findMany",
      correlationId: "d1-second",
    };
    const firstContext = officialContext(firstSource);
    const secondContext = officialContext(secondSource);
    const binary = new Uint8Array([1, 2]);
    const secondQuery: BatchQuery = {
      sql: "SELECT id FROM posts",
      params: [binary],
      context: secondContext,
    };
    const queries: BatchQuery[] = [
      { sql: "SELECT id FROM users", params: [], context: firstContext },
      secondQuery,
    ];

    const failure = captureQueryError(
      driver._executeBatch(
        queries,
        undefined,
        officialContext({
          model: "$transaction",
          operation: "$transaction([...])",
          correlationId: "d1-outer",
        })
      )
    );
    await Promise.resolve();
    expect(database.prepare).not.toHaveBeenCalled();
    secondSource.model = "mutated-model";
    secondSource.operation = "mutated-operation";
    secondSource.correlationId = "mutated-correlation";
    secondQuery.sql = "SELECT private_mutation";
    binary[0] = 9;
    clientReady.resolve(database);
    await started.promise;
    providerResults.resolve([
      {
        success: true,
        results: [],
        meta: { changes: 0, last_row_id: 0 },
      },
      {
        success: true,
        results: null,
        meta: { changes: 0, last_row_id: 0 },
      },
    ]);

    await expect(failure).resolves.toMatchObject({
      meta: {
        driver: "d1",
        model: "post",
        operation: "findMany",
        correlationId: "d1-second",
        query: "SELECT id FROM posts",
        params: [{ byteLength: 2, bytes: [1, 2], type: "binary" }],
      },
    });
  });

  it("keeps Neon row-count failures on the originating batch statement", async () => {
    const started = createSignal();
    const providerResults = createDeferred<unknown>();
    type SubmittedQuery = { sql: string; params: unknown[] };
    let submitted: SubmittedQuery[] = [];
    const transaction = vi.fn(
      async (
        buildQueries: (
          execute: (sql: string, params: unknown[]) => SubmittedQuery
        ) => SubmittedQuery[]
      ) => {
        submitted = buildQueries((sql, params) => ({ sql, params }));
        started.resolve();
        return providerResults.promise;
      }
    );
    const client = Object.assign(vi.fn(), { transaction });
    const driver = new NeonHTTPDriver();
    Reflect.set(driver, "client", client);
    const secondContext = {
      model: "post",
      operation: "findMany",
      correlationId: "neon-second",
    };
    const secondQuery: BatchQuery = {
      sql: "SELECT id FROM posts WHERE id = $1",
      params: ["post-id"],
      context: secondContext,
    };
    const queries: BatchQuery[] = [
      {
        sql: "SELECT id FROM users WHERE id = $1",
        params: ["user-id"],
        context: {
          model: "user",
          operation: "findMany",
          correlationId: "neon-first",
        },
      },
      secondQuery,
    ];

    const failure = captureQueryError(
      driver._executeBatch(queries, undefined, {
        model: "$transaction",
        operation: "$transaction([...])",
        correlationId: "neon-outer",
      })
    );
    await started.promise;
    secondContext.model = "mutated-model";
    secondContext.operation = "mutated-operation";
    secondContext.correlationId = "mutated-correlation";
    secondQuery.params = ["private-mutation"];
    providerResults.resolve([
      {
        fields: [],
        command: "SELECT",
        rowCount: 0,
        rows: [],
        rowAsArray: false,
      },
      {
        fields: [],
        command: "SELECT",
        rowCount: null,
        rows: [],
        rowAsArray: false,
      },
    ]);

    expect(submitted).toEqual([
      { sql: "SELECT id FROM users WHERE id = $1", params: ["user-id"] },
      { sql: "SELECT id FROM posts WHERE id = $1", params: ["post-id"] },
    ]);
    await expect(failure).resolves.toMatchObject({
      meta: {
        driver: "neon-http",
        model: "post",
        operation: "findMany",
        correlationId: "neon-second",
      },
    });
  });

  it("attributes Neon statement construction failures to their batch position", async () => {
    type SubmittedQuery = { sql: string; params: unknown[] };
    const transaction = vi.fn(
      async (
        buildQueries: (
          execute: (sql: string, params: unknown[]) => SubmittedQuery
        ) => SubmittedQuery[]
      ) =>
        buildQueries((sql, params) => {
          if (sql === "SELECT broken") {
            const nested = params[0];
            if (typeof nested === "object" && nested !== null) {
              Object.assign(nested, { value: "provider-mutated" });
            }
            throw new Error("private Neon statement construction failure");
          }
          return { sql, params };
        })
    );
    const client = Object.assign(vi.fn(), { transaction });
    const driver = new NeonHTTPDriver();
    Reflect.set(driver, "client", client);
    const officialContext = (values: BatchQuery["context"]) =>
      createOfficialTestExecutionContext(
        { diagnostics: { includeParams: true } },
        values ?? {}
      );

    const parameter = { value: "original" };
    const execution = driver._executeBatch(
      [
        {
          sql: "SELECT valid",
          context: officialContext({
            model: "user",
            operation: "findMany",
            correlationId: "neon-first-construction",
          }),
        },
        {
          sql: "SELECT broken",
          params: [parameter],
          context: officialContext({
            model: "post",
            operation: "findMany",
            correlationId: "neon-second-construction",
          }),
        },
      ],
      undefined,
      officialContext({
        model: "$transaction",
        operation: "$transaction([...])",
        correlationId: "neon-outer-construction",
      })
    );
    parameter.value = "caller-mutated";
    const error = await captureQueryError(execution);

    expect(error.meta).toMatchObject({
      driver: "neon-http",
      model: "post",
      operation: "findMany",
      correlationId: "neon-second-construction",
      params: [{ value: "original" }],
    });
    expect(JSON.stringify(error)).not.toContain("private Neon");
  });

  it("keeps reverse-completing PlanetScale calls independently attributed", async () => {
    const firstStarted = createSignal();
    const secondStarted = createSignal();
    const firstResult = createDeferred<{
      rows: unknown[];
      rowsAffected: number;
      insertId: string;
    }>();
    const secondResult = createDeferred<{
      rows: unknown[];
      rowsAffected: number;
      insertId: string;
    }>();
    const client = {
      execute(sql: string) {
        if (sql === "first") {
          firstStarted.resolve();
          return firstResult.promise;
        }
        secondStarted.resolve();
        return secondResult.promise;
      },
    };
    const driver = new PlanetScaleDriver();
    Reflect.set(driver, "client", client);
    const firstContext = mutableContext(
      "user",
      "findMany",
      "planetscale-first"
    );
    const secondContext = mutableContext(
      "post",
      "delete",
      "planetscale-second"
    );

    const first = driver._executeRaw("first", [], firstContext);
    const second = driver
      ._executeRaw("second", [], secondContext)
      .catch((error) => error);
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    firstContext.model = "mutated-first";
    secondContext.model = "mutated-second";
    secondContext.operation = "mutated-operation";
    secondContext.correlationId = "mutated-correlation";
    secondResult.reject(
      Object.assign(new Error("private provider failure"), {
        code: "ER_LOCK_DEADLOCK",
        detail: "private provider detail",
        errno: 1213,
      })
    );
    const failed = await second;
    firstResult.resolve({
      rows: [{ id: "first" }],
      rowsAffected: 1,
      insertId: "0",
    });

    await expect(first).resolves.toEqual({
      rows: [{ id: "first" }],
      rowCount: 1,
    });
    expect(failed).toMatchObject({
      meta: {
        driver: "planetscale",
        model: "post",
        operation: "delete",
        correlationId: "planetscale-second",
        providerCode: "ER_LOCK_DEADLOCK",
        providerErrno: 1213,
      },
    });
    if (!isVibORMError(failed)) throw new Error("expected a VibORMError");
    const serialized = JSON.stringify(failed.toJSON());
    expect(serialized).not.toContain("private provider failure");
    expect(serialized).not.toContain("private provider detail");
  });
});

function mutableContext(
  model: string,
  operation: string,
  correlationId: string
): {
  model: string;
  operation: string;
  correlationId: string;
} {
  return { model, operation, correlationId };
}
