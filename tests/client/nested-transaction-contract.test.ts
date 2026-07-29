import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers/driver";
import { createClient as createPGliteClient } from "@drivers/pglite";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { QueryResult } from "@drivers/types";
import { TransactionError, VibORMErrorCode } from "@errors";
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

  /**
   * REWRITTEN for decision D-2 (W5-U3). The old pin asserted `{}` was rejected
   * on the nested form. What must survive is that a nested refusal still
   * arrives *through the Promise API* (never as a synchronous throw that would
   * escape the callback's own error handling) and still lands before the empty
   * fast path, without disturbing the outer transaction.
   */
  test("a nested refusal rejects asynchronously before the empty fast path", async () => {
    const driver = new RecordingTransactionDriver();
    const client = createContractClient(driver);

    await runTransaction(client, async (tx: object) => {
      // A nested $transaction is a SAVEPOINT: its isolation level is fixed by
      // the outer transaction, so asking is a typed refusal.
      const refused = runTransaction(tx, [], {
        isolationLevel: "Serializable",
      });
      await expect(refused).rejects.toMatchObject({ code: "V8003" });

      const malformed = runTransaction(tx, [], { timeout: 5 });
      await expect(malformed).rejects.toMatchObject({
        code: VibORMErrorCode.INVALID_TRANSACTION_INPUT,
      });

      // Asking for nothing still takes the empty fast path.
      await expect(runTransaction(tx, [], {})).resolves.toEqual([]);
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

describe("single-connection root client during a callback transaction", () => {
  /**
   * Witness for the refusal in `assertBaseOperationAllowedDuringTransaction`:
   * on a single-connection driver, a ROOT-client operation issued inside a
   * callback transaction must be refused with a typed TransactionError — not
   * silently join (and roll back with) a transaction it was never handed.
   * Discovered missing during the T3 ALS spike: under an ambient driver store
   * the refusal disappeared and the whole estate stayed green.
   */
  test("refuses a root-client operation while the connection is transaction-bound", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = await createPGliteClient({ schema, client: new PGlite() });
    try {
      // No push: the create is refused before any SQL reaches the database.
      const failure = await client
        .$transaction(async (_tx) => {
          // Deliberately `client`, not `_tx` — the misuse under test.
          await client.record.create({ data: { id: "escapee" } });
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(failure).toBeInstanceOf(TransactionError);
      const refusal = failure as TransactionError;
      expect(refusal.message).toMatch(/cannot use the originating client/);
      expect(refusal.meta).toMatchObject({
        driver: "pglite",
        method: "$transaction(callback)",
      });
    } finally {
      await client.$disconnect();
    }
  });
});
