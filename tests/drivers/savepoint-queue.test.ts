import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { describe, expect, test } from "vitest";
import { Driver, TransactionBoundDriver } from "../../src/drivers/driver";
import { SavepointQueue } from "../../src/drivers/savepoint-queue";
import type { QueryResult } from "../../src/drivers/types";

describe("SavepointQueue", () => {
  test("executes single operation immediately", async () => {
    const queue = new SavepointQueue();
    const result = await queue.enqueue(async () => "hello");
    expect(result).toBe("hello");
  });

  test("operations enqueued in same tick execute sequentially", async () => {
    const queue = new SavepointQueue();
    const executionOrder: number[] = [];

    // Enqueue multiple operations in the same tick
    const promises = [
      queue.enqueue(async () => {
        executionOrder.push(1);
        await new Promise((r) => setTimeout(r, 10));
        executionOrder.push(2);
        return "first";
      }),
      queue.enqueue(async () => {
        executionOrder.push(3);
        await new Promise((r) => setTimeout(r, 5));
        executionOrder.push(4);
        return "second";
      }),
      queue.enqueue(async () => {
        executionOrder.push(5);
        return "third";
      }),
    ];

    const results = await Promise.all(promises);

    // Operations should execute in order: first completes, then second, then third
    expect(executionOrder).toEqual([1, 2, 3, 4, 5]);
    expect(results).toEqual(["first", "second", "third"]);
  });

  test("errors in one operation do not affect others", async () => {
    const queue = new SavepointQueue();
    const executionOrder: string[] = [];

    const promises = [
      queue.enqueue(async () => {
        executionOrder.push("first-start");
        executionOrder.push("first-end");
        return "success-1";
      }),
      queue.enqueue(async () => {
        executionOrder.push("second-start");
        throw new Error("intentional failure");
      }),
      queue.enqueue(async () => {
        executionOrder.push("third-start");
        executionOrder.push("third-end");
        return "success-3";
      }),
    ];

    const results = await Promise.allSettled(promises);

    // All operations should have executed
    expect(executionOrder).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "third-start",
      "third-end",
    ]);

    // Check results
    expect(results[0]).toEqual({ status: "fulfilled", value: "success-1" });
    expect(results[1]?.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      "intentional failure"
    );
    expect(results[2]).toEqual({ status: "fulfilled", value: "success-3" });
  });

  test("operations from different ticks are still serialized", async () => {
    const queue = new SavepointQueue();
    const executionOrder: number[] = [];

    // First batch in tick 1
    const promise1 = queue.enqueue(async () => {
      executionOrder.push(1);
      await new Promise((r) => setTimeout(r, 20));
      executionOrder.push(2);
      return "first";
    });

    // Wait a tick, then enqueue more
    await new Promise((r) => setTimeout(r, 5));

    const promise2 = queue.enqueue(async () => {
      executionOrder.push(3);
      return "second";
    });

    const results = await Promise.all([promise1, promise2]);

    // Second operation waits for first to complete
    expect(executionOrder).toEqual([1, 2, 3]);
    expect(results).toEqual(["first", "second"]);
  });

  test("queue processes all items even with many concurrent enqueues", async () => {
    const queue = new SavepointQueue();
    const count = 100;
    const executed: number[] = [];

    const promises = Array.from({ length: count }, (_, i) =>
      queue.enqueue(async () => {
        executed.push(i);
        return i;
      })
    );

    const results = await Promise.all(promises);

    // All operations should execute in order
    expect(executed).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(results).toEqual(Array.from({ length: count }, (_, i) => i));
  });

  test("returns correct values from async functions", async () => {
    const queue = new SavepointQueue();

    const results = await Promise.all([
      queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { id: 1, name: "Alice" };
      }),
      queue.enqueue(async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { id: 2, name: "Bob" };
      }),
    ]);

    expect(results).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
  });

  test("handles synchronous functions", async () => {
    const queue = new SavepointQueue();

    const results = await Promise.all([
      queue.enqueue(async () => 1),
      queue.enqueue(async () => 2),
      queue.enqueue(async () => 3),
    ]);

    expect(results).toEqual([1, 2, 3]);
  });

  test("can be reused after draining", async () => {
    const queue = new SavepointQueue();

    // First batch
    const batch1 = await Promise.all([
      queue.enqueue(async () => "a"),
      queue.enqueue(async () => "b"),
    ]);
    expect(batch1).toEqual(["a", "b"]);

    // Wait for queue to fully drain
    await new Promise((r) => setTimeout(r, 10));

    // Second batch
    const batch2 = await Promise.all([
      queue.enqueue(async () => "c"),
      queue.enqueue(async () => "d"),
    ]);
    expect(batch2).toEqual(["c", "d"]);
  });

  test("simulates savepoint scenario - nested transactions", async () => {
    const queue = new SavepointQueue();
    const operations: string[] = [];

    // Simulate what happens in TransactionBoundDriver
    const nestedTransaction = async (name: string) => {
      return queue.enqueue(async () => {
        operations.push(`SAVEPOINT ${name}`);
        // Simulate some work
        await new Promise((r) => setTimeout(r, 5));
        operations.push(`RELEASE SAVEPOINT ${name}`);
        return `${name} completed`;
      });
    };

    // Multiple concurrent nested transactions (like Promise.all in user code)
    const results = await Promise.all([
      nestedTransaction("sp_1"),
      nestedTransaction("sp_2"),
      nestedTransaction("sp_3"),
    ]);

    // Savepoints should be created and released in order (stack-safe)
    expect(operations).toEqual([
      "SAVEPOINT sp_1",
      "RELEASE SAVEPOINT sp_1",
      "SAVEPOINT sp_2",
      "RELEASE SAVEPOINT sp_2",
      "SAVEPOINT sp_3",
      "RELEASE SAVEPOINT sp_3",
    ]);

    expect(results).toEqual([
      "sp_1 completed",
      "sp_2 completed",
      "sp_3 completed",
    ]);
  });

  test("simulates savepoint scenario with rollback", async () => {
    const queue = new SavepointQueue();
    const operations: string[] = [];

    const nestedTransaction = async (
      name: string,
      shouldFail: boolean
    ): Promise<string> => {
      return queue.enqueue(async () => {
        operations.push(`SAVEPOINT ${name}`);
        await new Promise((r) => setTimeout(r, 2));

        if (shouldFail) {
          operations.push(`ROLLBACK TO SAVEPOINT ${name}`);
          throw new Error(`${name} failed`);
        }

        operations.push(`RELEASE SAVEPOINT ${name}`);
        return `${name} completed`;
      });
    };

    const results = await Promise.allSettled([
      nestedTransaction("sp_1", false),
      nestedTransaction("sp_2", true), // This one fails
      nestedTransaction("sp_3", false),
    ]);

    // Each savepoint is properly handled even with failures
    expect(operations).toEqual([
      "SAVEPOINT sp_1",
      "RELEASE SAVEPOINT sp_1",
      "SAVEPOINT sp_2",
      "ROLLBACK TO SAVEPOINT sp_2",
      "SAVEPOINT sp_3",
      "RELEASE SAVEPOINT sp_3",
    ]);

    expect(results[0]).toEqual({
      status: "fulfilled",
      value: "sp_1 completed",
    });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({
      status: "fulfilled",
      value: "sp_3 completed",
    });
  });
});

type CleanupFailurePoint =
  | "both"
  | "create"
  | "release-success-and-recovery"
  | "rollback"
  | "release-after-rollback"
  | undefined;

class SavepointFailureDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly statements: string[] = [];
  readonly rollbackError = new Error("private rollback cleanup detail");
  readonly releaseError = new Error("private release cleanup detail");
  private readonly failurePoint: CleanupFailurePoint;
  private hasRolledBack = false;

  constructor(failurePoint: CleanupFailurePoint) {
    super("sqlite", "savepoint-failure");
    this.failurePoint = failurePoint;
  }

  createTransactionDriver(): TransactionBoundDriver<object, object> {
    return new TransactionBoundDriver(this, {});
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to release.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(
    _client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);

    if (statement.startsWith("SAVEPOINT") && this.failurePoint === "create") {
      throw new Error("savepoint response was lost");
    }

    if (statement.startsWith("ROLLBACK TO SAVEPOINT")) {
      this.hasRolledBack = true;
      if (this.failurePoint === "rollback" || this.failurePoint === "both") {
        throw this.rollbackError;
      }
    }

    if (
      statement.startsWith("RELEASE SAVEPOINT") &&
      ((this.hasRolledBack &&
        (this.failurePoint === "release-after-rollback" ||
          this.failurePoint === "both")) ||
        this.failurePoint === "release-success-and-recovery")
    ) {
      throw this.releaseError;
    }

    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn({});
  }
}

describe("nested transaction failure contracts", () => {
  test("preserves the callback failure and exposes rollback failure as secondary context", async () => {
    const driver = new SavepointFailureDriver("rollback");
    const primaryError = new Error("nested callback failed");
    let thrown: unknown;

    try {
      await driver
        .createTransactionDriver()
        .withTransaction(async () => Promise.reject(primaryError));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) {
      throw new Error("expected an AggregateError");
    }
    expect(thrown.cause).toBe(primaryError);
    expect(thrown.message).toBe(primaryError.message);
    expect(thrown.errors[0]).toBe(primaryError);
    expect(thrown.errors[1]).toMatchObject({
      name: "QueryError",
      code: "V2001",
      meta: { driver: "savepoint-failure" },
    });
    expect(driver.statements.map(statementKind)).toEqual([
      "SAVEPOINT",
      "ROLLBACK",
      "RELEASE",
    ]);
  });

  test("preserves the callback failure and exposes post-rollback release failure", async () => {
    const driver = new SavepointFailureDriver("release-after-rollback");
    const primaryError = new Error("nested callback failed");
    let thrown: unknown;

    try {
      await driver
        .createTransactionDriver()
        .withTransaction(async () => Promise.reject(primaryError));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) {
      throw new Error("expected an AggregateError");
    }
    expect(thrown.cause).toBe(primaryError);
    expect(thrown.message).toBe(primaryError.message);
    expect(thrown.errors[0]).toBe(primaryError);
    expect(thrown.errors[1]).toMatchObject({
      name: "QueryError",
      code: "V2001",
      meta: { driver: "savepoint-failure" },
    });
    expect(driver.statements.map(statementKind)).toEqual([
      "SAVEPOINT",
      "ROLLBACK",
      "RELEASE",
    ]);
  });

  test("preserves rollback and release failures in cleanup order", async () => {
    const driver = new SavepointFailureDriver("both");
    const primaryError = new Error("nested callback failed");
    const txDriver = driver.createTransactionDriver();
    let thrown: unknown;

    try {
      await txDriver.withTransaction(async () => Promise.reject(primaryError));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) {
      throw new Error("expected an AggregateError");
    }
    expect(thrown.cause).toBe(primaryError);
    expect(thrown.errors).toHaveLength(3);
    expect(thrown.errors[0]).toBe(primaryError);
    expect(thrown.errors.slice(1)).toEqual([
      expect.objectContaining({ name: "QueryError", code: "V2001" }),
      expect.objectContaining({ name: "QueryError", code: "V2001" }),
    ]);
    expect(driver.statements.map(statementKind)).toEqual([
      "SAVEPOINT",
      "ROLLBACK",
      "RELEASE",
    ]);
    expect(() => txDriver.assertTransactionCommittable()).toThrow(thrown);
    await expect(txDriver._executeRaw("SELECT 1")).rejects.toBe(thrown);
  });

  test("ordinary callback rollback leaves the parent scope usable", async () => {
    const driver = new SavepointFailureDriver(undefined);
    const txDriver = driver.createTransactionDriver();
    const primaryError = new Error("nested callback failed");

    await expect(
      txDriver.withTransaction(async () => Promise.reject(primaryError))
    ).rejects.toBe(primaryError);
    await expect(txDriver._executeRaw("SELECT 1")).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
    expect(() => txDriver.assertTransactionCommittable()).not.toThrow();
  });

  test("a failed SAVEPOINT create poisons the parent scope", async () => {
    const driver = new SavepointFailureDriver("create");
    const txDriver = driver.createTransactionDriver();
    let callbackCalled = false;

    await expect(
      txDriver.withTransaction(async () => {
        callbackCalled = true;
      })
    ).rejects.toMatchObject({ name: "QueryError", code: "V2001" });
    expect(callbackCalled).toBe(false);
    expect(driver.statements.map(statementKind)).toEqual(["SAVEPOINT"]);
    expect(() => txDriver.assertTransactionCommittable()).toThrow();
    await expect(txDriver._executeRaw("SELECT 1")).rejects.toMatchObject({
      name: "QueryError",
      code: "V2001",
    });
  });

  test("successful callback release failure retains recovery cleanup failure", async () => {
    const driver = new SavepointFailureDriver("release-success-and-recovery");
    const txDriver = driver.createTransactionDriver();
    const thrown = await txDriver
      .withTransaction(async () => "result")
      .catch((error) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.errors).toEqual([
      expect.objectContaining({ name: "QueryError", code: "V2001" }),
      expect.objectContaining({ name: "QueryError", code: "V2001" }),
    ]);
    expect(driver.statements.map(statementKind)).toEqual([
      "SAVEPOINT",
      "RELEASE",
      "ROLLBACK",
      "RELEASE",
    ]);
    expect(() => txDriver.assertTransactionCommittable()).toThrow(thrown);
  });

  test("rejects removed options before opening a savepoint", async () => {
    const driver = new SavepointFailureDriver(undefined);
    let callbackCalled = false;
    let thrown: unknown;

    try {
      const txDriver = driver.createTransactionDriver();
      await Reflect.apply(txDriver.withTransaction, txDriver, [
        async () => {
          callbackCalled = true;
        },
        { isolationLevel: "serializable" },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect({
      callbackCalled,
      errorName: thrown instanceof Error ? thrown.name : undefined,
      statements: driver.statements,
    }).toEqual({
      callbackCalled: false,
      errorName: "TransactionError",
      statements: [],
    });
  });
});

function statementKind(statement: string): string {
  if (statement.startsWith("ROLLBACK TO SAVEPOINT")) return "ROLLBACK";
  if (statement.startsWith("RELEASE SAVEPOINT")) return "RELEASE";
  if (statement.startsWith("SAVEPOINT")) return "SAVEPOINT";
  return "OTHER";
}
