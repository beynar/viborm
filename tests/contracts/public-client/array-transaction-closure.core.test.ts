/**
 * Array-transaction boundaries the earlier contracts leave open: a member that
 * is not an operation at all, an empty observed array, the commit certainty an
 * INTERCEPTED array reports from a fallback transaction's own lifecycle phases,
 * and the two native closures — a member with no atomic batch form, and a
 * provider result window that does not match the submitted statements.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { getExecutionTransactionPhases } from "@drivers/execution-context";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import { InvalidTransactionInputError, TransactionError } from "@errors";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({
  id: s.int().id().increment(),
  code: s.string().unique(),
  label: s.string(),
});
const schema = { record };

/** A callback-transaction driver that publishes real lifecycle phases. */
class ArrayLifecycleDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly failurePoint: "commit" | "close" | undefined;

  constructor(failurePoint?: "commit" | "close") {
    super("sqlite", `array-lifecycle-${failurePoint ?? "clean"}`);
    this.failurePoint = failurePoint;
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => undefined,
      callback: () => callback(client),
      commit: () => {
        if (this.failurePoint === "commit") {
          throw new Error("array commit failed");
        }
      },
      rollback: () => undefined,
      close: () => {
        if (this.failurePoint === "close") {
          throw new Error("array close failed");
        }
      },
      phases: getExecutionTransactionPhases(context),
    });
  }
}

/** An atomic-batch-only driver whose result window can be made too short. */
class ArrayNativeDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly batches: BatchQuery[][] = [];
  dropLastResult = false;

  constructor() {
    super("sqlite", "array-native-closure");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("ArrayNativeDriver accepts only batch execution.");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("ArrayNativeDriver accepts only batch execution.");
  }

  protected async transaction<T>(): Promise<T> {
    throw new Error("ArrayNativeDriver has no callback transaction.");
  }

  protected async executeBatch<T>(
    _client: object,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries);
    const results = queries.map(() => ({ rows: [] as T[], rowCount: 1 }));
    return this.dropLastResult ? results.slice(0, -1) : results;
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function trackedClient<DriverType extends Driver<object, object>>(
  driver: DriverType
) {
  const client = createClient({ schema, driver });
  clients.push(client);
  return client;
}

function runUnsafeArrayTransaction(
  client: object,
  candidates: readonly unknown[]
): Promise<unknown> {
  const transaction = Reflect.get(client, "$transaction");
  if (typeof transaction !== "function") {
    throw new Error("Expected $transaction");
  }
  return Reflect.apply(transaction, client, [candidates]);
}

/** Let every settled observation onion run before reading what it recorded. */
function flushObservations(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("array transaction member admission", () => {
  test("refuses an array member that is not an object at all", async () => {
    const client = trackedClient(new ArrayLifecycleDriver());

    await expect(
      runUnsafeArrayTransaction(client, [null])
    ).rejects.toBeInstanceOf(InvalidTransactionInputError);
    await expect(
      runUnsafeArrayTransaction(client, ["not-an-operation"])
    ).rejects.toBeInstanceOf(InvalidTransactionInputError);
  });

  test("resolves an empty observed array without opening a transaction", async () => {
    const base = trackedClient(new ArrayLifecycleDriver());
    const units: string[] = [];
    const client = base.$extends({
      name: "closure-empty-observed",
      async observe(unit, proceed) {
        const completion = await proceed();
        units.push(`${unit.kind}:${unit.operation}:${completion.status}`);
      },
    });

    await expect(client.$transaction([])).resolves.toEqual([]);
    await flushObservations();
    expect(units).toEqual(["batch:$transaction([...]):success"]);
  });
});

describe("intercepted array fallback commit certainty", () => {
  test.each([
    ["commit", "may-have-committed"],
    ["close", "committed"],
  ] as const)("reports an intercepted array's %s-stage failure as %s", async (failurePoint, expectedCertainty) => {
    const base = trackedClient(new ArrayLifecycleDriver(failurePoint));
    const facts: Array<string | undefined> = [];
    const client = base.$extends({
      name: `closure-intercepted-${failurePoint}`,
      query: {
        record: {
          async findMany({ proceed }) {
            return await proceed();
          },
        },
      },
      observe(unit, proceed) {
        if (unit.kind !== "batch") return;
        proceed().then((completion) => {
          facts.push(completion.commitCertainty);
        });
      },
    });

    await expect(
      client.$transaction([client.record.findMany()])
    ).rejects.toThrow();
    await flushObservations();
    expect(facts).toEqual([expectedCertainty]);
  });
});

describe("native array closures", () => {
  test("closes every observation when an observed member cannot be batched", async () => {
    const driver = new ArrayNativeDriver();
    const base = trackedClient(driver);
    const units: string[] = [];
    const client = base.$extends({
      name: "closure-observed-unbatchable",
      async observe(unit, proceed) {
        const completion = await proceed();
        units.push(`${unit.kind}:${unit.operation}:${completion.status}`);
      },
    });
    const unbatchable = overrideTransactionOperation(client.record.findMany(), {
      prepare: () => undefined,
      prepareBatch: () => Promise.resolve(undefined),
    });

    await expect(client.$transaction([unbatchable])).rejects.toMatchObject({
      name: TransactionError.name,
      message: expect.stringContaining("cannot be batched atomically"),
    });
    await flushObservations();
    expect(driver.batches).toEqual([]);
    expect(units).toContain("operation:findMany:failure");
  });

  test("keeps an already-applied observation settled when a later parse fails", async () => {
    const driver = new ArrayNativeDriver();
    const base = trackedClient(driver);
    const units: string[] = [];
    const client = base.$extends({
      name: "closure-observed-parse",
      async observe(unit, proceed) {
        const completion = await proceed();
        units.push(`${unit.kind}:${unit.operation}:${completion.status}`);
      },
    });
    const failingParse = overrideTransactionOperation(
      client.record.findMany(),
      {
        parseResult: () => {
          throw new Error("member parse failed");
        },
      }
    );

    await expect(
      client.$transaction([client.record.findMany(), failingParse])
    ).rejects.toThrow();
    await flushObservations();
    expect(
      units.filter((unit) => unit.startsWith("operation:")).sort()
    ).toEqual(["operation:findMany:failure", "operation:findMany:success"]);
  });

  test("refuses an intercepted native member with no atomic batch form", async () => {
    const driver = new ArrayNativeDriver();
    const base = trackedClient(driver);
    const client = base.$extends({
      name: "closure-intercepted-unbatchable",
      query: {
        record: {
          async findMany({ proceed }) {
            return await proceed();
          },
        },
      },
    });
    const unbatchable = overrideTransactionOperation(client.record.findMany(), {
      prepare: () => undefined,
      prepareBatch: () => Promise.resolve(undefined),
    });

    await expect(client.$transaction([unbatchable])).rejects.toMatchObject({
      name: TransactionError.name,
      message: expect.stringContaining("cannot be batched atomically"),
    });
    expect(driver.batches).toEqual([]);
  });

  test("closes an intercepted native array whose result window is too short", async () => {
    const driver = new ArrayNativeDriver();
    driver.dropLastResult = true;
    const base = trackedClient(driver);
    const client = base.$extends({
      name: "closure-intercepted-short-window",
      query: {
        record: {
          async findMany({ proceed }) {
            return await proceed();
          },
        },
      },
    });

    await expect(
      client.$transaction([client.record.findMany()])
    ).rejects.toMatchObject({
      message: expect.stringContaining("expected 1, one per statement"),
    });
    expect(driver.batches).toHaveLength(1);
  });
});
