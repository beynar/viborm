import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { QueryResult } from "@drivers/types";
import { describe, expect, test, vi } from "vitest";

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

class ConnectionScopeDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly events: string[] = [];
  closeCount = 0;
  commitFailure: Error | undefined;
  protected override readonly serializeTransactions = true;

  constructor() {
    super("sqlite", "connection-scope-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    this.closeCount++;
    this.events.push("CLOSE");
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
    this.events.push(sql);
    return { rows: [], rowCount: 0 };
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    let shouldClose = false;
    return runTransactionLifecycle({
      begin: () => this.events.push("BEGIN"),
      callback: () => fn(client),
      commit: () => {
        this.events.push("COMMIT");
        if (this.commitFailure) {
          shouldClose = true;
          throw this.commitFailure;
        }
      },
      rollback: () => this.events.push("ROLLBACK"),
      close: async () => {
        if (!shouldClose) return;
        await this.closeClient();
        this.client = null;
      },
    });
  }
}

class FailingInitDriver extends ConnectionScopeDriver {
  lifecycleCalls = 0;

  constructor() {
    super();
    this.client = null;
  }

  protected override async initClient(): Promise<object> {
    throw new Error("connection failed");
  }

  protected override transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    this.lifecycleCalls++;
    return super.transaction(client, fn);
  }
}

describe("single-connection transaction scheduling", () => {
  test("client initialization failure is not misclassified as cleanup poison", async () => {
    const driver = new FailingInitDriver();
    const callback = vi.fn(async () => undefined);

    await expect(driver._transaction(callback)).rejects.toMatchObject({
      name: "ConnectionError",
    });
    expect(callback).not.toHaveBeenCalled();
    expect(driver.lifecycleCalls).toBe(0);
    expect(driver.closeCount).toBe(0);
    await expect(driver._transaction(callback)).rejects.toMatchObject({
      name: "ConnectionError",
    });
    expect(driver.lifecycleCalls).toBe(0);
  });

  test.each([
    { completion: "COMMIT", shouldFail: false },
    { completion: "ROLLBACK", shouldFail: true },
  ])("same-tick outside work queued before activation runs after $completion", async ({
    completion,
    shouldFail,
  }) => {
    const driver = new ConnectionScopeDriver();
    const started = createDeferred();
    const release = createDeferred();
    const callbackFailure = new Error("callback failed");
    const transaction = driver.withTransaction(async () => {
      driver.events.push("CALLBACK");
      started.resolve();
      await release.promise;
      if (shouldFail) throw callbackFailure;
    });
    const outsideQuery = driver._executeRaw("OUTSIDE");

    await started.promise;
    expect(driver.events).toEqual(["BEGIN", "CALLBACK"]);
    release.resolve();
    if (shouldFail) await expect(transaction).rejects.toBe(callbackFailure);
    else await expect(transaction).resolves.toBeUndefined();
    await outsideQuery;
    expect(driver.events).toEqual(["BEGIN", "CALLBACK", completion, "OUTSIDE"]);
  });

  test("active lease rejects originating-client work without poisoning the transaction", async () => {
    const driver = new ConnectionScopeDriver();
    await driver.withTransaction(async (tx) => {
      await expect(driver._executeRaw("OUTER_RAW")).rejects.toMatchObject({
        name: "TransactionError",
      });
      await expect(
        driver._executeBatch([{ sql: "OUTER_BATCH" }])
      ).rejects.toMatchObject({ name: "TransactionError" });
      await expect(driver._connect()).rejects.toMatchObject({
        name: "TransactionError",
      });
      await tx._executeRaw("TX_QUERY");
    });

    expect(driver.events).toEqual(["BEGIN", "TX_QUERY", "COMMIT"]);
    await expect(driver._executeRaw("AFTER")).resolves.toMatchObject({
      rowCount: 0,
    });
    expect(driver.events.at(-1)).toBe("AFTER");
  });

  test("disconnect after BEGIN rejects without closing the active connection", async () => {
    const driver = new ConnectionScopeDriver();
    await driver.withTransaction(async (tx) => {
      await expect(driver.disconnect()).rejects.toMatchObject({
        name: "TransactionError",
      });
      expect(driver.closeCount).toBe(0);
      await tx._executeRaw("TX_QUERY");
    });

    expect(driver.events).toEqual(["BEGIN", "TX_QUERY", "COMMIT"]);
    expect(driver.closeCount).toBe(0);
  });

  test("a second transaction started after BEGIN rejects before its callback", async () => {
    const driver = new ConnectionScopeDriver();
    const nestedCallback = vi.fn(async () => undefined);
    await driver.withTransaction(async (tx) => {
      await expect(
        driver.withTransaction(nestedCallback)
      ).rejects.toMatchObject({ name: "TransactionError" });
      await tx._executeRaw("TX_QUERY");
    });

    expect(nestedCallback).not.toHaveBeenCalled();
    expect(driver.events).toEqual(["BEGIN", "TX_QUERY", "COMMIT"]);
  });

  test("a pre-queued waiter rejects poison without using the closed client", async () => {
    const driver = new ConnectionScopeDriver();
    driver.commitFailure = new Error("commit failed");
    const started = createDeferred();
    const release = createDeferred();
    const first = driver.withTransaction(async () => {
      started.resolve();
      await release.promise;
    });
    const waitingCallback = vi.fn(async () => undefined);
    const waiting = driver.withTransaction(waitingCallback);

    await started.promise;
    release.resolve();
    await expect(first).rejects.toMatchObject({ name: "QueryError" });
    await expect(waiting).rejects.toMatchObject({ name: "TransactionError" });
    expect(waitingCallback).not.toHaveBeenCalled();
    expect(driver.events).toEqual(["BEGIN", "COMMIT", "ROLLBACK", "CLOSE"]);
    expect(driver.closeCount).toBe(1);
  });

  test("an early unawaited nested failure prevents the outer commit", async () => {
    const driver = new ConnectionScopeDriver();

    await expect(
      driver.withTransaction(async (tx) => {
        const unobserved = tx.withTransaction(async () => {
          throw new Error("early nested failure");
        });
        expect(unobserved).toBeDefined();
        await tx.withTransaction(async () => undefined);
      })
    ).rejects.toThrow("early nested failure");
    expect(driver.events).toContain("ROLLBACK");
    expect(driver.events).not.toContain("COMMIT");
  });

  test("a chained rejection handler leaves the outer transaction usable", async () => {
    const driver = new ConnectionScopeDriver();

    await driver.withTransaction(async (tx) => {
      const nested = tx.withTransaction(async () => {
        throw new Error("caught nested failure");
      });
      await nested
        .then((value) => value)
        .catch((error: unknown) => {
          expect(error).toBeInstanceOf(Error);
        });
      await tx._executeRaw("AFTER_NESTED");
    });

    expect(driver.events).toContain("AFTER_NESTED");
    expect(driver.events.at(-1)).toBe("COMMIT");
  });
});
