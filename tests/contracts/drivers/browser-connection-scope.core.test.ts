import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import {
  runTransactionLifecycle,
  type TransactionOptionSupport,
} from "@drivers/shared";
import type { QueryResult } from "@drivers/types";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:async_hooks", () => {
  throw new Error("AsyncLocalStorage is unavailable in this runtime");
});

class BrowserConnectionDriver extends Driver<object, object> {
  readonly adapter = new SQLiteAdapter();
  readonly events: string[] = [];
  protected override readonly serializeTransactions = true;
  constructor() {
    super("sqlite", "browser-test");
  }
  protected async initClient() {
    return {};
  }
  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }
  protected async execute<T>(
    _client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    this.events.push(statement);
    return { rows: [], rowCount: 0 };
  }
  protected executeRaw<T>(
    client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, statement);
  }
  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "serializable-only",
      maxWait: "queue",
      timeout: true,
    };
  }
  protected transaction<T>(
    client: object,
    body: (client: object) => Promise<T>
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => this.events.push("BEGIN"),
      callback: () => body(client),
      commit: () => this.events.push("COMMIT"),
      rollback: () => this.events.push("ROLLBACK"),
    });
  }
}

afterEach(() => vi.useRealTimers());

describe("serialized transactions without async-context support", () => {
  it("bounds originating-client reentry and recovers instead of deadlocking", async () => {
    vi.useFakeTimers();
    const driver = new BrowserConnectionDriver();
    let started: () => void = () => undefined;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const work = driver.withTransaction(async (tx) => {
      await tx._executeRaw("INSIDE");
      started();
      await driver._executeRaw("REENTRY");
    });
    const rejected = work.catch((error: unknown) => error);
    await start;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await rejected).toMatchObject({ code: "V5002" });
    await driver._executeRaw("AFTER");
    expect(driver.events).toEqual(["BEGIN", "INSIDE", "ROLLBACK", "AFTER"]);
  });

  it("queues independent work and honors an explicit shorter maxWait", async () => {
    vi.useFakeTimers();
    const driver = new BrowserConnectionDriver();
    let release: () => void = () => undefined;
    const body = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = driver.withTransaction(async () => {
      started();
      await body;
    });
    await start;
    const outside = driver._executeRaw("OUTSIDE");
    const bounded = driver
      .withTransaction(async () => undefined, { maxWait: 10 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await bounded).toMatchObject({ code: "V5002" });
    release();
    await first;
    await outside;
    expect(driver.events).toEqual(["BEGIN", "COMMIT", "OUTSIDE"]);
  });
});
