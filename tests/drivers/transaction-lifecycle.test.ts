import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import { LibSQLDriver } from "@drivers/libsql";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { QueryResult } from "@drivers/types";
import {
  Client as PlanetScaleClient,
  type Config as PlanetScaleConfig,
} from "@planetscale/database";
import { sql } from "@sql";
import { describe, expect, test, vi } from "vitest";
import { executeSkippableWrite } from "../../src/query-engine/skippable-write";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve() {
      if (!resolver) throw new Error("Deferred resolver is unavailable");
      resolver();
    },
  };
}

class StructuredTransactionDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly statements: string[] = [];
  closeCount = 0;
  providerExecutions = 0;
  commitFailure: Error | undefined;
  rollbackFailure: Error | undefined;
  private heldQuery:
    | { gate: Deferred; started: Deferred; failure?: Error }
    | undefined;

  constructor() {
    super("sqlite", "structured-test");
    this.client = {};
  }

  holdQuery(failure?: Error): { started: Promise<void>; release(): void } {
    const gate = createDeferred();
    const started = createDeferred();
    this.heldQuery = { gate, started, ...(failure ? { failure } : {}) };
    return { started: started.promise, release: () => gate.resolve() };
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    this.closeCount++;
  }

  protected execute<T>(
    client: object,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.executeRaw(client, sql, params);
  }

  protected async executeRaw<T>(
    _client: object,
    sql: string,
    _params?: unknown[]
  ): Promise<QueryResult<T>> {
    this.providerExecutions++;
    if (sql === "HELD") {
      const heldQuery = this.heldQuery;
      if (!heldQuery) throw new Error("Held query was not configured");
      this.statements.push("QUERY_START");
      heldQuery.started.resolve();
      await heldQuery.gate.promise;
      if (heldQuery.failure) throw heldQuery.failure;
      this.statements.push("QUERY_END");
    }
    return { rows: [], rowCount: 0 };
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    let shouldClose = false;
    return runTransactionLifecycle({
      begin: () => this.statements.push("BEGIN"),
      callback: () => fn(client),
      commit: () => {
        this.statements.push("COMMIT");
        if (this.commitFailure) {
          shouldClose = true;
          throw this.commitFailure;
        }
      },
      rollback: () => {
        this.statements.push("ROLLBACK");
        if (this.rollbackFailure) {
          shouldClose = true;
          throw this.rollbackFailure;
        }
      },
      close: async () => {
        if (!shouldClose) return;
        await this.closeClient();
        this.client = null;
      },
    });
  }
}

class NoAtomicDriver extends StructuredTransactionDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;
}

describe("transaction structured scope", () => {
  test("drains an unawaited query before commit", async () => {
    const driver = new StructuredTransactionDriver();
    const held = driver.holdQuery();
    const transaction = driver.withTransaction(async (tx) => {
      const unobserved = tx._executeRaw("HELD");
      expect(unobserved).toBeDefined();
    });

    await held.started;
    expect(driver.statements).toEqual(["BEGIN", "QUERY_START"]);
    held.release();
    await transaction;
    expect(driver.statements).toEqual([
      "BEGIN",
      "QUERY_START",
      "QUERY_END",
      "COMMIT",
    ]);
  });

  test("an unawaited query failure prevents commit", async () => {
    const driver = new StructuredTransactionDriver();
    const held = driver.holdQuery(new Error("provider query failed"));
    const transaction = driver.withTransaction(async (tx) => {
      const unobserved = tx._executeRaw("HELD");
      expect(unobserved).toBeDefined();
    });

    await held.started;
    held.release();
    await expect(transaction).rejects.toMatchObject({
      name: "QueryError",
      code: "V2001",
    });
    expect(driver.statements).toContain("ROLLBACK");
    expect(driver.statements).not.toContain("COMMIT");
  });

  test("a pending unawaited nested transaction is drained and cannot fail silently", async () => {
    const driver = new StructuredTransactionDriver();
    const nestedStarted = createDeferred();
    const nestedGate = createDeferred();
    const transaction = driver.withTransaction(async (tx) => {
      const unobserved = tx.withTransaction(async () => {
        nestedStarted.resolve();
        await nestedGate.promise;
        throw new Error("unawaited nested failure");
      });
      expect(unobserved).toBeDefined();
      await nestedStarted.promise;
    });

    await nestedStarted.promise;
    nestedGate.resolve();
    await expect(transaction).rejects.toThrow("unawaited nested failure");
    expect(driver.statements).toContain("ROLLBACK");
    expect(driver.statements).not.toContain("COMMIT");
  });

  test("callback failure stays primary when an unawaited query also fails", async () => {
    const driver = new StructuredTransactionDriver();
    const held = driver.holdQuery(new Error("provider query failed"));
    const primaryError = new Error("callback failed");
    const transaction = driver.withTransaction(async (tx) => {
      const unobserved = tx._executeRaw("HELD");
      expect(unobserved).toBeDefined();
      throw primaryError;
    });

    await held.started;
    held.release();
    const thrown = await transaction.catch((error) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown).toMatchObject({ cause: primaryError });
    expect(thrown.errors[0]).toBe(primaryError);
    expect(thrown.errors[1]).toMatchObject({ name: "QueryError" });
    expect(driver.statements).not.toContain("COMMIT");
  });

  test("transaction-bound drivers close after success and failure", async () => {
    const driver = new StructuredTransactionDriver();
    let successfulScope: Driver<object, object> | undefined;
    await driver.withTransaction(async (tx) => {
      successfulScope = tx;
    });
    if (!successfulScope) throw new Error("Successful scope was not captured");
    await expect(successfulScope._executeRaw("SELECT 1")).rejects.toMatchObject(
      { name: "TransactionError" }
    );

    const primaryError = new Error("callback failed");
    let failedScope: Driver<object, object> | undefined;
    await expect(
      driver.withTransaction(async (tx) => {
        failedScope = tx;
        throw primaryError;
      })
    ).rejects.toBe(primaryError);
    if (!failedScope) throw new Error("Failed scope was not captured");
    await expect(failedScope._executeRaw("SELECT 1")).rejects.toMatchObject({
      name: "TransactionError",
    });
  });
});

describe("transaction entry gates and poison", () => {
  test("direct unsupported entry points reject before provider work", async () => {
    const driver = new NoAtomicDriver();
    await expect(
      driver._transaction(async () => undefined)
    ).rejects.toMatchObject({ name: "TransactionError" });
    await expect(driver._executeBatch([])).resolves.toEqual([]);
    await expect(
      driver._executeBatch([{ sql: "SELECT 1" }])
    ).rejects.toMatchObject({ name: "TransactionError" });
    expect(driver.providerExecutions).toBe(0);
  });

  test("removed options win before capability checks", async () => {
    const driver = new NoAtomicDriver();
    await expect(
      Reflect.apply(driver._transaction, driver, [async () => undefined, {}])
    ).rejects.toMatchObject({ code: "V5005" });
    await expect(
      Reflect.apply(driver._executeBatch, driver, [[], { timeout: 1 }])
    ).rejects.toMatchObject({ code: "V5005" });
    expect(driver.providerExecutions).toBe(0);
  });

  test("commit plus rollback failure stays inspectable and poisons the driver", async () => {
    const driver = new StructuredTransactionDriver();
    driver.commitFailure = new Error("private commit failure");
    driver.rollbackFailure = new Error("private rollback failure");

    const thrown = await driver
      .withTransaction(async () => "done")
      .catch((error) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.errors).toEqual([
      expect.objectContaining({ name: "QueryError", code: "V2001" }),
      expect.objectContaining({ name: "QueryError", code: "V2001" }),
    ]);
    expect(driver.closeCount).toBe(1);
    const executions = driver.providerExecutions;
    await expect(driver._executeRaw("SELECT 1")).rejects.toMatchObject({
      name: "TransactionError",
    });
    expect(driver.providerExecutions).toBe(executions);
    await driver.disconnect();
    expect(driver.closeCount).toBe(1);
    await expect(driver._executeRaw("SELECT 1")).rejects.toMatchObject({
      name: "TransactionError",
    });
  });
});

describe("provider transaction cleanup", () => {
  test("pg discards a connection when rollback fails", async () => {
    const rollbackError = new Error("rollback failed");
    const release = vi.fn();
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql === "ROLLBACK") throw rollbackError;
        return {};
      }),
      release,
    };
    const pool = { connect: vi.fn(async () => connection) };
    const driver = new PgDriver();
    const transaction = Reflect.get(driver, "transaction");

    await expect(
      Reflect.apply(transaction, driver, [
        pool,
        async () => {
          throw new Error("callback failed");
        },
      ])
    ).rejects.toBeInstanceOf(AggregateError);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(rollbackError);
  });

  test("pg poisons the pool driver when discarding the connection throws", async () => {
    const driver = new PgDriver();
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql === "ROLLBACK") throw new Error("rollback failed");
        return {};
      }),
      release: vi.fn(() => {
        throw new Error("release failed");
      }),
    };
    await expect(
      Reflect.apply(Reflect.get(driver, "transaction"), driver, [
        { connect: vi.fn(async () => connection) },
        async () => Promise.reject(new Error("callback failed")),
      ])
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(driver._executeRaw("SELECT 1")).rejects.toMatchObject({
      name: "TransactionError",
    });
  });

  test("pg releases normally after a callback failure and successful rollback", async () => {
    const releaseAfterRollback = vi.fn();
    const rollbackConnection = {
      query: vi.fn(async () => ({})),
      release: releaseAfterRollback,
    };
    const rollbackPool = {
      connect: vi.fn(async () => rollbackConnection),
    };
    const driver = new PgDriver();
    const transaction = Reflect.get(driver, "transaction");
    const callbackError = new Error("callback failed");

    await expect(
      Reflect.apply(transaction, driver, [
        rollbackPool,
        async () => Promise.reject(callbackError),
      ])
    ).rejects.toBe(callbackError);
    expect(releaseAfterRollback).toHaveBeenCalledWith();
  });

  test.each([
    "BEGIN",
    "COMMIT",
  ])("pg discards a connection after %s failure", async (failedStatement) => {
    const failure = new Error(`${failedStatement} failed`);
    const release = vi.fn();
    const callback = vi.fn(async () => undefined);
    const driver = new PgDriver();
    const transaction = Reflect.get(driver, "transaction");
    const connection = {
      query: vi.fn(async (sql: string) => {
        if (sql === failedStatement) throw failure;
        return {};
      }),
      release,
    };

    await expect(
      Reflect.apply(transaction, driver, [
        { connect: vi.fn(async () => connection) },
        callback,
      ])
    ).rejects.toBeInstanceOf(Error);
    expect(callback).toHaveBeenCalledTimes(failedStatement === "BEGIN" ? 0 : 1);
    expect(release).toHaveBeenCalledWith(failure);
  });

  test("mysql2 destroys rather than releases after rollback failure", async () => {
    const release = vi.fn();
    const destroy = vi.fn();
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => {
        throw new Error("rollback failed");
      }),
      release,
      destroy,
    };
    const pool = { getConnection: vi.fn(async () => connection) };
    const driver = new MySQL2Driver();
    const transaction = Reflect.get(driver, "transaction");

    await expect(
      Reflect.apply(transaction, driver, [
        pool,
        async () => {
          throw new Error("callback failed");
        },
      ])
    ).rejects.toBeInstanceOf(AggregateError);
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  test("mysql2 poisons the pool driver when destroying the connection throws", async () => {
    const driver = new MySQL2Driver();
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => Promise.reject(new Error("rollback failed"))),
      release: vi.fn(),
      destroy: vi.fn(() => {
        throw new Error("destroy failed");
      }),
    };
    await expect(
      Reflect.apply(Reflect.get(driver, "transaction"), driver, [
        { getConnection: vi.fn(async () => connection) },
        async () => Promise.reject(new Error("callback failed")),
      ])
    ).rejects.toBeInstanceOf(AggregateError);
    await expect(driver._executeRaw("SELECT 1")).rejects.toMatchObject({
      name: "TransactionError",
    });
  });

  test("mysql2 releases normally after a callback failure and successful rollback", async () => {
    const releaseAfterRollback = vi.fn();
    const rollbackConnection = {
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: releaseAfterRollback,
      destroy: vi.fn(),
    };
    const driver = new MySQL2Driver();
    const transaction = Reflect.get(driver, "transaction");
    const callbackError = new Error("callback failed");

    await expect(
      Reflect.apply(transaction, driver, [
        { getConnection: vi.fn(async () => rollbackConnection) },
        async () => Promise.reject(callbackError),
      ])
    ).rejects.toBe(callbackError);
    expect(releaseAfterRollback).toHaveBeenCalledOnce();
    expect(rollbackConnection.destroy).not.toHaveBeenCalled();
  });

  test.each([
    "begin",
    "commit",
  ])("mysql2 destroys a connection after %s failure", async (failedOperation) => {
    const failure = new Error(`${failedOperation} failed`);
    const callback = vi.fn(async () => undefined);
    const release = vi.fn();
    const destroy = vi.fn();
    const driver = new MySQL2Driver();
    const transaction = Reflect.get(driver, "transaction");
    const connection = {
      beginTransaction: vi.fn(async () => {
        if (failedOperation === "begin") throw failure;
      }),
      commit: vi.fn(async () => {
        if (failedOperation === "commit") throw failure;
      }),
      rollback: vi.fn(async () => undefined),
      release,
      destroy,
    };

    await expect(
      Reflect.apply(transaction, driver, [
        { getConnection: vi.fn(async () => connection) },
        callback,
      ])
    ).rejects.toBeInstanceOf(Error);
    expect(callback).toHaveBeenCalledTimes(failedOperation === "begin" ? 0 : 1);
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  test("libSQL closes remote transaction handles on every completion path", async () => {
    const transactionDriver = new LibSQLDriver({
      databaseUrl: "libsql://phase8.test",
    });
    const transaction = Reflect.get(transactionDriver, "transaction");

    for (const path of [
      "success",
      "callback-failure",
      "commit-failure",
      "rollback-failure",
    ]) {
      const callbackError = new Error("callback failed");
      const tx = {
        execute: vi.fn(),
        commit: vi.fn(async () => {
          if (path === "commit-failure") throw new Error("commit failed");
        }),
        rollback: vi.fn(async () => {
          if (path === "rollback-failure") {
            throw new Error("rollback failed");
          }
        }),
        close: vi.fn(),
      };
      const client = { transaction: vi.fn(async () => tx) };
      const invocation = Reflect.apply(transaction, transactionDriver, [
        client,
        async () => {
          if (path === "callback-failure" || path === "rollback-failure") {
            throw callbackError;
          }
          return "ok";
        },
      ]);

      if (path === "success") await expect(invocation).resolves.toBe("ok");
      else await expect(invocation).rejects.toBeInstanceOf(Error);
      expect(tx.close).toHaveBeenCalledOnce();
    }
  });

  test("PlanetScale keeps SINGLE, BEGIN, callback, and COMMIT on one SDK session", async () => {
    const requests: Array<{ query: string; session: unknown }> = [];
    const fetch: NonNullable<PlanetScaleConfig["fetch"]> = async (
      _input,
      init
    ) => {
      if (typeof init?.body !== "string") {
        throw new Error("PlanetScale request body was not JSON text");
      }
      const request: unknown = JSON.parse(init.body);
      if (!isRecord(request) || typeof request.query !== "string") {
        throw new Error("PlanetScale request was malformed");
      }
      requests.push({ query: request.query, session: request.session });
      const payload = {
        result: null,
        session: `session-${requests.length}`,
      };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
    const driver = new PlanetScaleDriver({
      client: new PlanetScaleClient({
        url: "https://user:password@phase8.test/database",
        fetch,
      }),
    });

    await driver.withTransaction(async (tx) => {
      await tx._executeRaw("INSERT INTO users (id) VALUES (1)");
    });

    expect(requests.map((request) => request.query)).toEqual([
      "SET transaction_mode = 'single'",
      "BEGIN",
      "INSERT INTO users (id) VALUES (1)",
      "COMMIT",
    ]);
    expect(requests.map((request) => request.session)).toEqual([
      null,
      "session-1",
      "session-2",
      "session-3",
    ]);
  });

  test("PlanetScale duplicate recovery rolls back one savepoint and continues", async () => {
    const requests: string[] = [];
    const driver = createPlanetScaleSavepointDriver(requests, "unique");

    await driver.withTransaction(async (tx) => {
      await expect(
        executeSkippableWrite(tx, sql.raw`INSERT DUPLICATE`, {
          operation: "createMany",
        })
      ).resolves.toEqual({ rows: [], rowCount: 0 });
      await expect(
        executeSkippableWrite(tx, sql.raw`INSERT FRESH`, {
          operation: "createMany",
        })
      ).resolves.toMatchObject({ rowCount: 1 });
    });

    expect(requests.map(statementKind)).toEqual([
      "SET_SINGLE",
      "BEGIN",
      "SAVEPOINT",
      "DUPLICATE",
      "ROLLBACK_TO_SAVEPOINT",
      "RELEASE_SAVEPOINT",
      "SAVEPOINT",
      "FRESH",
      "RELEASE_SAVEPOINT",
      "COMMIT",
    ]);
  });

  test("PlanetScale unrelated insert failure aborts the outer transaction", async () => {
    const requests: string[] = [];
    const driver = createPlanetScaleSavepointDriver(requests, "foreign-key");

    await expect(
      driver.withTransaction((tx) =>
        executeSkippableWrite(tx, sql.raw`INSERT UNRELATED_FAILURE`, {
          operation: "createMany",
        })
      )
    ).rejects.toMatchObject({ name: "ForeignKeyError" });

    expect(requests.map(statementKind)).toEqual([
      "SET_SINGLE",
      "BEGIN",
      "SAVEPOINT",
      "UNRELATED_FAILURE",
      "ROLLBACK_TO_SAVEPOINT",
      "RELEASE_SAVEPOINT",
      "ROLLBACK",
    ]);
  });
});

function createPlanetScaleSavepointDriver(
  requests: string[],
  failure: "unique" | "foreign-key"
): PlanetScaleDriver {
  let session = 0;
  const fetch: NonNullable<PlanetScaleConfig["fetch"]> = async (
    _input,
    init
  ) => {
    if (typeof init?.body !== "string") {
      throw new Error("PlanetScale request body was not JSON text");
    }
    const request: unknown = JSON.parse(init.body);
    if (!isRecord(request) || typeof request.query !== "string") {
      throw new Error("PlanetScale request was malformed");
    }
    requests.push(request.query);
    const error =
      request.query === "INSERT DUPLICATE" && failure === "unique"
        ? {
            code: "ALREADY_EXISTS",
            message:
              "Duplicate entry 'x' for key 'items.PRIMARY' (errno 1062) (sqlstate 23000)",
          }
        : request.query === "INSERT UNRELATED_FAILURE" &&
            failure === "foreign-key"
          ? {
              code: "FAILED_PRECONDITION",
              message:
                "Cannot add or update a child row: a foreign key constraint fails (errno 1452) (sqlstate 23000)",
            }
          : undefined;
    const payload = error
      ? { error, session: `session-${++session}` }
      : {
          result: {
            fields: [],
            rows: [],
            rowsAffected: "1",
            insertId: "0",
          },
          session: `session-${++session}`,
        };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return new PlanetScaleDriver({
    client: new PlanetScaleClient({
      url: "https://user:password@phase10.test/database",
      fetch,
    }),
  });
}

function statementKind(statement: string): string {
  if (statement === "SET transaction_mode = 'single'") return "SET_SINGLE";
  if (statement.startsWith("ROLLBACK TO SAVEPOINT")) {
    return "ROLLBACK_TO_SAVEPOINT";
  }
  if (statement.startsWith("RELEASE SAVEPOINT")) return "RELEASE_SAVEPOINT";
  if (statement.startsWith("SAVEPOINT")) return "SAVEPOINT";
  if (statement === "INSERT DUPLICATE") return "DUPLICATE";
  if (statement === "INSERT FRESH") return "FRESH";
  if (statement === "INSERT UNRELATED_FAILURE") return "UNRELATED_FAILURE";
  return statement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
