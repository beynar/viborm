import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { executeNativeBatch } from "@client/array-transaction-native-batch";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
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

class AtomicBatchDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly batches: BatchQuery[][] = [];

  constructor() {
    super("sqlite", "atomic-batch-contract");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // This fixture owns no provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("AtomicBatchDriver accepts only batch execution.");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("AtomicBatchDriver accepts only batch execution.");
  }

  protected async transaction<T>(): Promise<T> {
    throw new Error("AtomicBatchDriver has no callback transaction.");
  }

  protected async executeBatch<T>(
    _client: object,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries);
    return queries.map(() => ({ rows: [], rowCount: 1 }));
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function batchClient() {
  const driver = new AtomicBatchDriver();
  const client = createClient({ schema, driver });
  clients.push(client);
  return { client, driver };
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("unintercepted array transaction batch contracts", () => {
  test("executes a multi-statement operation as one atomic native batch", async () => {
    const { client, driver } = batchClient();
    const mixedShapeCreate = client.record.createMany({
      data: [
        { code: "generated", label: "first" },
        { id: 40, code: "explicit", label: "second" },
      ],
    });

    await expect(client.$transaction([mixedShapeCreate])).resolves.toEqual([
      { count: 2 },
    ]);
    expect(driver.batches).toHaveLength(1);
    expect(driver.batches[0]).toHaveLength(2);
  });

  test("refuses an operation with no atomic batch representation", async () => {
    const { client, driver } = batchClient();
    const unbatchable = overrideTransactionOperation(client.record.findMany(), {
      prepare: () => undefined,
      prepareBatch: () => Promise.resolve(undefined),
    });

    await expect(
      // @ts-expect-error - the array overload names only the operation classes
      // the client itself produces; this shell registers the same internal
      // transaction-operation owner, so the seam admits what the type cannot name.
      client.$transaction([unbatchable])
    ).rejects.toMatchObject({
      name: TransactionError.name,
      message: expect.stringContaining("cannot be batched atomically"),
    });
    expect(driver.batches).toEqual([]);
  });

  test("contains a hostile array snapshot failure before provider work", async () => {
    const { client, driver } = batchClient();
    const snapshotFailure = new Error("private array length failure");
    const hostile = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") throw snapshotFailure;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      Reflect.apply(client.$transaction, client, [hostile])
    ).rejects.toBe(snapshotFailure);
    expect(driver.batches).toEqual([]);
  });

  test("refuses a non-integer array length before provider work", async () => {
    const { client, driver } = batchClient();
    const hostile = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") return -1;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      Reflect.apply(client.$transaction, client, [hostile])
    ).rejects.toBeInstanceOf(InvalidTransactionInputError);
    expect(driver.batches).toEqual([]);
  });
});

describe("coverage low value", () => {
  test("an empty native batch returns without provider dispatch", async () => {
    const driver = new AtomicBatchDriver();
    const context: QueryExecutionContext = {};

    await expect(
      executeNativeBatch(driver, [], [], undefined, context)
    ).resolves.toEqual([]);
    expect(driver.batches).toEqual([]);
  });
});
