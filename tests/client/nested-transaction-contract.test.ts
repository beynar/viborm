import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers/driver";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { QueryResult } from "@drivers/types";
import { VibORMErrorCode } from "@errors";
import {
  isPendingOperation,
  type PendingOperation,
} from "@query-engine/pending-operation";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const record = s.model({ id: s.string().id() });
const schema = { record };

class RecordingTransactionDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly statements: string[] = [];

  constructor() {
    super("sqlite", "nested-client-contract");
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
    sql: string,
    _params?: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(sql);
    return { rows: [], rowCount: 0 };
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => this.statements.push("BEGIN"),
      callback: () => fn(client),
      commit: () => this.statements.push("COMMIT"),
      rollback: () => this.statements.push("ROLLBACK"),
    });
  }
}

function createContractClient(driver: RecordingTransactionDriver) {
  return createClient({ schema, driver });
}

function runTransaction<T>(
  client: object,
  input: unknown,
  options?: unknown
): Promise<T> {
  const args = options === undefined ? [input] : [input, options];
  return Reflect.apply(Reflect.get(client, "$transaction"), client, args);
}

function createFindMany(client: object): PendingOperation<unknown> {
  const model = Reflect.get(client, "record");
  const operation = Reflect.get(model, "findMany");
  const pending = Reflect.apply(operation, model, [{}]);
  if (!isPendingOperation(pending)) {
    throw new Error("expected a PendingOperation");
  }
  return pending;
}

describe("nested public transaction contract", () => {
  test("rejects root operations inside a callback transaction scope", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);
    const rootOperation = createFindMany(client);

    await runTransaction(client, async (tx: object) => {
      await expect(runTransaction(tx, [rootOperation])).rejects.toMatchObject({
        code: VibORMErrorCode.OPERATION_SCOPE_MISMATCH,
        message: expect.stringContaining("outside this transaction scope"),
      });
    });
  });

  test("rejects escaped callback operations in the root scope", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);
    let callbackOperation: PendingOperation<unknown> | undefined;

    await runTransaction(client, async (tx: object) => {
      callbackOperation = createFindMany(tx);
    });
    if (!callbackOperation)
      throw new Error("callback operation was not created");

    await expect(
      runTransaction(client, [callbackOperation])
    ).rejects.toMatchObject({
      code: VibORMErrorCode.OPERATION_SCOPE_MISMATCH,
      message: expect.stringContaining("outside this transaction scope"),
    });
  });

  test("accepts callback operations in a legitimate nested transaction", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);

    await expect(
      runTransaction(client, async (tx: object) => {
        const operation = createFindMany(tx);
        return runTransaction(tx, [operation]);
      })
    ).resolves.toEqual([[]]);
    expect(driver.statements.some((sql) => sql.startsWith("SAVEPOINT"))).toBe(
      true
    );
  });

  test("keeps different-client failures distinct from scope failures", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);
    const otherClient = createContractClient(driver);
    const foreignOperation = createFindMany(otherClient);

    await expect(
      runTransaction(client, [foreignOperation])
    ).rejects.toMatchObject({
      code: VibORMErrorCode.OPERATION_CLIENT_MISMATCH,
      message: expect.stringContaining("different client instance"),
    });
  });

  test("empty arrays return without creating a savepoint", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);

    await expect(
      runTransaction<unknown[]>(client, (tx: object) =>
        runTransaction<unknown[]>(tx, [])
      )
    ).resolves.toEqual([]);
    expect(driver.statements).toEqual(["BEGIN", "COMMIT"]);
  });

  test("removed options reject asynchronously before the empty fast path", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);

    await runTransaction(client, async (tx: object) => {
      const nested = runTransaction(tx, [], {});
      await expect(nested).rejects.toMatchObject({
        code: VibORMErrorCode.INVALID_TRANSACTION_INPUT,
      });
    });
    expect(driver.statements).toEqual(["BEGIN", "COMMIT"]);
  });

  test("invalid nested items reject through the Promise API", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);

    await runTransaction(client, async (tx: object) => {
      const nested = runTransaction(tx, [Promise.resolve("not pending")]);
      await expect(nested).rejects.toMatchObject({
        name: "InvalidTransactionInputError",
      });
    });
    expect(driver.statements).toEqual(["BEGIN", "COMMIT"]);
  });

  test("an early unawaited nested rejection prevents public outer commit", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);

    await expect(
      runTransaction(client, async (tx: object) => {
        const unobserved = runTransaction(tx, async () => {
          throw new Error("early public nested failure");
        });
        expect(unobserved).toBeDefined();
        await runTransaction(tx, async () => undefined);
      })
    ).rejects.toThrow("early public nested failure");
    expect(driver.statements.some((sql) => sql.startsWith("SAVEPOINT"))).toBe(
      true
    );
    expect(
      driver.statements.some((sql) => sql.startsWith("ROLLBACK TO SAVEPOINT"))
    ).toBe(true);
    expect(driver.statements.at(-1)).toBe("ROLLBACK");
    expect(driver.statements).not.toContain("COMMIT");
  });
});
