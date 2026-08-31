import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import { runProviderManagedTransaction } from "@drivers/shared/transactions";
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

class PrematureProviderDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly callbackStarted = createDeferred();
  readonly closeStarted = createDeferred();
  readonly releaseCallback = createDeferred();
  ignoredCallback: Promise<unknown> | undefined;
  providerExecutions = 0;

  constructor() {
    super("sqlite", "premature-provider-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
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
    _sql: string,
    _params?: unknown[]
  ): Promise<QueryResult<T>> {
    this.providerExecutions++;
    return { rows: [], rowCount: 0 };
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return Reflect.apply(runProviderManagedTransaction, undefined, [
      {
        run: async (providerCallback: (tx: object) => Promise<T>) => {
          this.ignoredCallback = providerCallback(client);
          await this.callbackStarted.promise;
          return undefined;
        },
        callback: fn,
        close: async () => {
          this.closeStarted.resolve();
        },
      },
    ]);
  }
}

describe("provider-managed transaction contract", () => {
  test("propagates the callback failure when the provider preserves it", async () => {
    const callbackFailure = new Error("callback failed");
    const close = vi.fn(async () => undefined);

    await expect(
      runProviderManagedTransaction({
        run: async (providerCallback) => providerCallback({}),
        callback: async () => Promise.reject(callbackFailure),
        close,
      })
    ).rejects.toBe(callbackFailure);
    expect(close).not.toHaveBeenCalled();
  });

  test("announces ready-to-commit and committed around provider success", async () => {
    const phases = {
      readyToCommit: vi.fn(),
      committed: vi.fn(),
    };

    await expect(
      runProviderManagedTransaction({
        run: async (providerCallback) => providerCallback({}),
        callback: async () => "application result",
        close: vi.fn(async () => undefined),
        phases,
      })
    ).resolves.toBe("application result");
    expect(phases.readyToCommit).toHaveBeenCalledOnce();
    expect(phases.committed).toHaveBeenCalledOnce();
    expect(phases.readyToCommit.mock.invocationCallOrder[0]).toBeLessThan(
      phases.committed.mock.invocationCallOrder[0]!
    );
  });

  test("cleanup closes and retains close failure", async () => {
    const callbackError = new Error("callback failed");
    const cleanupError = new Error("provider cleanup failed");
    const closeError = new Error("provider close failed");
    const close = vi.fn(async () => Promise.reject(closeError));

    const thrown = await runProviderManagedTransaction<void, object>({
      run: async (callback: (tx: object) => Promise<void>) => {
        try {
          await callback({});
        } catch {
          throw cleanupError;
        }
      },
      callback: async () => Promise.reject(callbackError),
      close,
    }).catch((error) => error);

    expect(close).toHaveBeenCalledOnce();
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.cause).toBe(callbackError);
    expect(thrown.errors).toEqual([callbackError, cleanupError, closeError]);
  });

  test("setup failure closes before callback dispatch", async () => {
    const setupFailure = new Error("provider begin failed");
    const callback = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    await expect(
      runProviderManagedTransaction({
        run: async () => Promise.reject(setupFailure),
        callback,
        close,
      })
    ).rejects.toBe(setupFailure);
    expect(callback).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("success cannot omit the callback", async () => {
    const callback = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    await expect(
      runProviderManagedTransaction({
        run: async () => undefined,
        callback,
        close,
      })
    ).rejects.toMatchObject({ name: "TransactionError" });
    expect(callback).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("success cannot invoke the callback twice", async () => {
    const callback = vi.fn(async () => "result");
    const close = vi.fn(async () => undefined);

    await expect(
      runProviderManagedTransaction({
        run: async (providerCallback) => {
          const result = await providerCallback({});
          await providerCallback({}).catch(() => undefined);
          return result;
        },
        callback,
        close,
      })
    ).rejects.toMatchObject({ name: "TransactionError" });
    expect(callback).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test.each([
    "resolve",
    "reject",
  ])("provider %s cannot settle before the callback", async (providerSettlement) => {
    const callbackStarted = createDeferred();
    const closeStarted = createDeferred();
    const releaseCallback = createDeferred();
    const publicSettled = vi.fn();
    let ignoredCallback: Promise<unknown> | undefined;
    const callback = vi.fn(async () => {
      callbackStarted.resolve();
      await releaseCallback.promise;
      return "callback result";
    });
    const close = vi.fn(async () => {
      closeStarted.resolve();
    });

    const invocation = runProviderManagedTransaction({
      run: async (providerCallback) => {
        ignoredCallback = providerCallback({});
        await callbackStarted.promise;
        if (providerSettlement === "reject") {
          throw new Error("provider failed early");
        }
        return "provider result";
      },
      callback,
      close,
    });
    const settlement = invocation.then(publicSettled, publicSettled);

    await closeStarted.promise;
    expect(ignoredCallback).toBeDefined();
    expect(close).toHaveBeenCalledOnce();
    expect(publicSettled).not.toHaveBeenCalled();
    releaseCallback.resolve();
    await expect(invocation).rejects.toBeInstanceOf(Error);
    await settlement;
    expect(publicSettled).toHaveBeenCalledOnce();
  });

  test("success cannot swallow a callback rejection", async () => {
    const callbackFailure = new Error("callback failed");
    const close = vi.fn(async () => undefined);

    const thrown = await runProviderManagedTransaction<string, object>({
      run: async (providerCallback) => {
        await providerCallback({}).catch(() => undefined);
        return "provider result";
      },
      callback: async () => Promise.reject(callbackFailure),
      close,
    }).catch((error) => error);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.cause).toBe(callbackFailure);
    expect(thrown.errors[0]).toBe(callbackFailure);
    expect(thrown.errors[1]).toMatchObject({ name: "TransactionError" });
    expect(close).toHaveBeenCalledOnce();
  });

  test("returns the callback result instead of a provider-transformed value", async () => {
    await expect(
      runProviderManagedTransaction({
        run: async (providerCallback) => {
          await providerCallback({});
          return "provider result";
        },
        callback: async () => "callback result",
        close: vi.fn(async () => undefined),
      })
    ).resolves.toBe("callback result");
  });

  test("premature provider completion poisons subsequent base work", async () => {
    const driver = new PrematureProviderDriver();
    const publicSettled = vi.fn();
    const invocation = driver.withTransaction(async () => {
      driver.callbackStarted.resolve();
      await driver.releaseCallback.promise;
    });
    const settlement = invocation.then(publicSettled, publicSettled);

    await driver.closeStarted.promise;
    expect(driver.ignoredCallback).toBeDefined();
    expect(publicSettled).not.toHaveBeenCalled();
    driver.releaseCallback.resolve();
    await expect(invocation).rejects.toMatchObject({
      name: "TransactionError",
    });
    await settlement;
    await expect(driver._executeRaw("SELECT 1")).rejects.toMatchObject({
      name: "TransactionError",
    });
    expect(driver.providerExecutions).toBe(0);
  });
});
