import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers/driver";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { QueryResult } from "@drivers/types";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

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

class ScopeSchedulingDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly events: string[] = [];
  readonly queryFailure = new Error("provider query failed");
  readonly releaseFailure = new Error("savepoint release failed");
  failingQuery: string | undefined;
  failReleaseAfterRollback = false;
  private hasRolledBackSavepoint = false;

  constructor() {
    super("sqlite", "scope-scheduling-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // The fixture owns no provider resource.
  }

  protected execute<T>(
    client: object,
    statement: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.executeRaw(client, statement, params);
  }

  protected async executeRaw<T>(
    _client: object,
    statement: string,
    _params?: unknown[]
  ): Promise<QueryResult<T>> {
    this.events.push(statement);
    if (statement.startsWith("ROLLBACK TO SAVEPOINT")) {
      this.hasRolledBackSavepoint = true;
    }
    if (
      statement.startsWith("RELEASE SAVEPOINT") &&
      this.hasRolledBackSavepoint &&
      this.failReleaseAfterRollback
    ) {
      throw this.releaseFailure;
    }
    if (statement === this.failingQuery) throw this.queryFailure;
    return { rows: [], rowCount: 1 };
  }

  protected transaction<T>(
    client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => this.events.push("BEGIN"),
      callback: () => fn(client),
      commit: () => this.events.push("COMMIT"),
      rollback: () => this.events.push("ROLLBACK"),
    });
  }
}

describe("transaction-bound scope scheduling", () => {
  test("a pre-activation sibling waits for nested rollback before reaching the provider", async () => {
    const driver = new ScopeSchedulingDriver();
    const nestedStarted = createDeferred();
    const releaseNested = createDeferred();
    const nestedFailure = new Error("nested callback failed");

    await driver.withTransaction(async (outerTx) => {
      const nested = outerTx.withTransaction(async (nestedTx) => {
        await nestedTx._executeRaw("NESTED_WRITE");
        nestedStarted.resolve();
        await releaseNested.promise;
        throw nestedFailure;
      });
      const sibling = outerTx._executeRaw("SIBLING_WRITE");

      await nestedStarted.promise;
      await Promise.resolve();
      await Promise.resolve();
      const siblingReachedProvider = driver.events.includes("SIBLING_WRITE");
      releaseNested.resolve();

      await expect(nested).rejects.toBe(nestedFailure);
      await expect(sibling).resolves.toMatchObject({ rowCount: 1 });
      expect(siblingReachedProvider).toBe(false);
      await outerTx._executeRaw("OUTER_WRITE");
    });

    expect(driver.events.map(eventKind)).toEqual([
      "BEGIN",
      "SAVEPOINT",
      "NESTED_WRITE",
      "ROLLBACK_TO_SAVEPOINT",
      "RELEASE_SAVEPOINT",
      "SIBLING_WRITE",
      "OUTER_WRITE",
      "COMMIT",
    ]);
  });

  test("an unawaited direct _transaction drains before outer commit", async () => {
    const driver = new ScopeSchedulingDriver();
    const directStarted = createDeferred();
    const releaseDirect = createDeferred();
    const outerTransaction = driver.withTransaction(async (outerTx) => {
      const directTransaction = outerTx._transaction(async () => {
        driver.events.push("DIRECT_START");
        directStarted.resolve();
        await releaseDirect.promise;
        driver.events.push("DIRECT_END");
      });
      expect(directTransaction).toBeDefined();
      await directStarted.promise;
    });

    await directStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(driver.events).not.toContain("COMMIT");
    releaseDirect.resolve();
    await outerTransaction;

    expect(driver.events.map(eventKind)).toEqual([
      "BEGIN",
      "SAVEPOINT",
      "DIRECT_START",
      "DIRECT_END",
      "RELEASE_SAVEPOINT",
      "COMMIT",
    ]);
  });

  test("captured parent-scope calls reject before provider work without poisoning the parent", async () => {
    const driver = new ScopeSchedulingDriver();
    let capturedNestedCallbackCalled = false;

    await driver.withTransaction(async (outerTx) => {
      await outerTx.withTransaction(async (nestedTx) => {
        await expect(
          outerTx._execute(sql`CAPTURED_TYPED`)
        ).rejects.toMatchObject({ name: "TransactionError" });
        await expect(outerTx._executeRaw("CAPTURED_RAW")).rejects.toMatchObject(
          { name: "TransactionError" }
        );
        await expect(
          outerTx._executeBatch([{ sql: "CAPTURED_BATCH" }])
        ).rejects.toMatchObject({ name: "TransactionError" });
        await expect(
          outerTx.withTransaction(async () => {
            capturedNestedCallbackCalled = true;
          })
        ).rejects.toMatchObject({ name: "TransactionError" });
        await expect(outerTx._executeBatch([])).resolves.toEqual([]);
        await expect(
          Reflect.apply(outerTx._executeBatch, outerTx, [[], { timeout: 1 }])
        ).rejects.toMatchObject({ code: "V5005" });
        await nestedTx._executeRaw("CHILD_WRITE");
      });
      await outerTx._executeRaw("AFTER_NESTED");
    });

    expect(capturedNestedCallbackCalled).toBe(false);
    expect(driver.events).not.toEqual(
      expect.arrayContaining([
        "CAPTURED_TYPED",
        "CAPTURED_RAW",
        "CAPTURED_BATCH",
      ])
    );
    expect(driver.events.map(eventKind)).toEqual([
      "BEGIN",
      "SAVEPOINT",
      "CHILD_WRITE",
      "RELEASE_SAVEPOINT",
      "AFTER_NESTED",
      "COMMIT",
    ]);
  });

  test("a queued provider failure poisons the scope before the next item runs", async () => {
    const driver = new ScopeSchedulingDriver();
    driver.failingQuery = "FAIL";

    await expect(
      driver.withTransaction(async (tx) => {
        const first = tx._executeRaw("FAIL");
        const second = tx._executeRaw("SECOND");
        await expect(first).rejects.toMatchObject({ name: "QueryError" });
        await expect(second).rejects.toMatchObject({ name: "QueryError" });
      })
    ).rejects.toMatchObject({ name: "QueryError" });

    expect(driver.events).toEqual(["BEGIN", "FAIL", "ROLLBACK"]);
  });

  test("savepoint cleanup poison is classified before a queued sibling runs", async () => {
    const driver = new ScopeSchedulingDriver();
    driver.failReleaseAfterRollback = true;
    const callbackFailure = new Error("nested callback failed");

    await expect(
      driver.withTransaction(async (tx) => {
        const nested = tx.withTransaction(async () => {
          throw callbackFailure;
        });
        const sibling = tx._executeRaw("SIBLING");
        const nestedError = await nested.catch((error) => error);
        const siblingError = await sibling.catch((error) => error);

        expect(nestedError).toBeInstanceOf(AggregateError);
        expect(siblingError).toBe(nestedError);
      })
    ).rejects.toBeInstanceOf(AggregateError);

    expect(driver.events.map(eventKind)).toEqual([
      "BEGIN",
      "SAVEPOINT",
      "ROLLBACK_TO_SAVEPOINT",
      "RELEASE_SAVEPOINT",
      "ROLLBACK",
    ]);
  });

});

function eventKind(event: string): string {
  if (event.startsWith("ROLLBACK TO SAVEPOINT")) {
    return "ROLLBACK_TO_SAVEPOINT";
  }
  if (event.startsWith("RELEASE SAVEPOINT")) return "RELEASE_SAVEPOINT";
  if (event.startsWith("SAVEPOINT")) return "SAVEPOINT";
  return event;
}
