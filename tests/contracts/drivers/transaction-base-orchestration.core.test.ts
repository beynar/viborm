/**
 * `DriverTransactionBase` is the one place every driver's transaction and
 * atomic-batch semantics are decided, and the decisions it owns are the ones a
 * provider cannot be asked to prove: WHERE an isolation level is emitted, WHICH
 * layer arms the `timeout` race, WHAT a `maxWait` bound actually bounds, and
 * whether a batch inside an open transaction re-opens one.
 *
 * These contracts are driven through recording in-memory drivers rather than a
 * database on purpose: each one is a statement-ordering or option-routing fact
 * that a real provider would only confirm indirectly, and the provider suites
 * already own the round trip.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { Driver } from "@drivers/driver";
import { readPreparedStatement } from "@drivers/prepared-statement-provenance";
import {
  runTransactionLifecycle,
  type TransactionOptionSupport,
} from "@drivers/shared";
import type {
  BatchQuery,
  CommittedBatchNotification,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/types";
import { sql } from "@sql";
import { createOfficialTestExecutionContext } from "@tests/unit/instrumentation/_official-context";
import { describe, expect, test } from "vitest";

interface FakeSession {
  readonly id: string;
}

interface RecordedStatement {
  readonly kind: "execute" | "executeRaw";
  readonly sql: string;
}

/** A promise this test settles by hand, standing in for unfinished work. */
function held<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle: (value: T) => settle?.(value) };
}

const POST_BEGIN_SUPPORT: TransactionOptionSupport = {
  isolationLevel: "post-begin",
  timeout: true,
  maxWait: "unsupported",
  maxWaitReason: "this recording driver owns no transaction-slot wait",
};

const NAMED_MAX_WAIT = /waited longer than maxWait \(1ms\)/;
const UNORDERED_SEGMENTS = /cannot acknowledge ordered committed segments/;

const QUEUE_MAX_WAIT_SUPPORT: TransactionOptionSupport = {
  isolationLevel: "unsupported",
  isolationLevelReason: "this recording driver opens no configurable session",
  timeout: true,
  maxWait: "queue",
};

interface RecordingOptions {
  readonly serialize?: boolean;
  readonly supportsBatch?: boolean;
  readonly supportsOrderedCommittedSegments?: boolean;
  readonly supportsTransactions?: boolean;
  readonly support?: TransactionOptionSupport;
}

/**
 * One driver that records every statement its base class dispatches, and runs
 * a real BEGIN/COMMIT/ROLLBACK lifecycle over an in-memory session so statement
 * ORDER — which is what these contracts are about — is observable.
 */
class RecordingDriver extends Driver<FakeSession, FakeSession> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();
  readonly statements: RecordedStatement[] = [];
  readonly batches: BatchQuery[][] = [];
  override readonly supportsTransactions: boolean;
  override readonly supportsBatch: boolean;
  override readonly supportsOrderedCommittedSegments: boolean;
  protected override readonly serializeTransactions: boolean;
  private readonly support: TransactionOptionSupport | undefined;

  constructor(options: RecordingOptions = {}) {
    super("postgresql", "recording");
    this.supportsTransactions = options.supportsTransactions !== false;
    this.supportsBatch = options.supportsBatch === true;
    this.supportsOrderedCommittedSegments =
      options.supportsOrderedCommittedSegments === true;
    this.serializeTransactions = options.serialize === true;
    this.support = options.support;
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    return this.support ?? super.transactionOptionSupport();
  }

  protected initClient(): Promise<FakeSession> {
    return Promise.resolve({ id: "session" });
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    _client: FakeSession,
    statement: string
  ): Promise<QueryResult<T>> {
    this.statements.push({ kind: "execute", sql: statement });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected executeRaw<T>(
    _client: FakeSession,
    statement: string
  ): Promise<QueryResult<T>> {
    this.statements.push({ kind: "executeRaw", sql: statement });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    client: FakeSession,
    fn: (tx: FakeSession) => Promise<T>
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => this.executeRaw(client, "BEGIN"),
      callback: () => fn(client),
      commit: () => this.executeRaw(client, "COMMIT"),
      rollback: () => this.executeRaw(client, "ROLLBACK"),
    });
  }

  protected override async executeBatch<T>(
    client: FakeSession,
    queries: BatchQuery[],
    context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.batches.push([...queries]);
    if (!this.supportsBatch) {
      return super.executeBatch<T>(client, queries, context, committed);
    }
    await committed?.();
    return queries.map(() => ({ rows: [], rowCount: 0 }) as QueryResult<T>);
  }

  sqlOf(): string[] {
    return this.statements.map((entry) => entry.sql);
  }
}

describe("isolation level placement", () => {
  test("emits a post-begin level as the first statement inside the transaction", async () => {
    const driver = new RecordingDriver({ support: POST_BEGIN_SUPPORT });

    await driver.withTransaction(
      async (txDriver) => {
        await txDriver._executeRaw("SELECT body");
      },
      { isolationLevel: "RepeatableRead" }
    );

    expect(driver.sqlOf()).toEqual([
      "BEGIN",
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      "SELECT body",
      "COMMIT",
    ]);
  });

  test("emits nothing when no level was asked for", async () => {
    const driver = new RecordingDriver({ support: POST_BEGIN_SUPPORT });

    await driver._transaction(async (tx) => tx.id);

    expect(driver.sqlOf()).toEqual(["BEGIN", "COMMIT"]);
  });
});

describe("transaction timeout ownership", () => {
  test("_transaction races its own callback and rolls the transaction back", async () => {
    const driver = new RecordingDriver({ support: POST_BEGIN_SUPPORT });
    const body = held<string>();

    await expect(
      driver._transaction(() => body.promise, { timeout: 1 })
    ).rejects.toMatchObject({ code: "V5002", name: "TransactionError" });
    expect(driver.sqlOf()).toEqual(["BEGIN", "ROLLBACK"]);
    body.settle("abandoned");
  });

  test("withTransaction consumes timeout itself and forwards every other option", async () => {
    const driver = new RecordingDriver({ support: POST_BEGIN_SUPPORT });
    const body = held<string>();

    await expect(
      driver.withTransaction(() => body.promise, {
        isolationLevel: "Serializable",
        timeout: 1,
      })
    ).rejects.toMatchObject({ code: "V5002", name: "TransactionError" });
    // The isolation level survived the timeout being stripped, and the level
    // still landed inside the transaction it configures.
    expect(driver.sqlOf()).toEqual([
      "BEGIN",
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      "ROLLBACK",
    ]);
    body.settle("abandoned");
  });

  test("withTransaction keeps a body that finishes inside its bound", async () => {
    const driver = new RecordingDriver({ support: POST_BEGIN_SUPPORT });

    await expect(
      driver.withTransaction(
        async (txDriver) => {
          await txDriver._executeRaw("SELECT inside");
          return "committed";
        },
        { timeout: 5000 }
      )
    ).resolves.toBe("committed");
    expect(driver.sqlOf()).toEqual(["BEGIN", "SELECT inside", "COMMIT"]);
  });

  test("withTransaction refuses before BEGIN on a driver without callback transactions", async () => {
    const driver = new RecordingDriver({
      supportsBatch: true,
      supportsTransactions: false,
    });

    await expect(
      driver.withTransaction(() => Promise.resolve("unreachable"))
    ).rejects.toMatchObject({
      name: "TransactionError",
      meta: expect.objectContaining({ method: "$transaction(callback)" }),
    });
    expect(driver.sqlOf()).toEqual([]);
  });
});

describe("queue-bounded maxWait", () => {
  test("rejects a transaction that never started and never invokes its body", async () => {
    const driver = new RecordingDriver({
      serialize: true,
      support: QUEUE_MAX_WAIT_SUPPORT,
    });
    const occupied = held<string>();
    let secondBodyRan = false;

    const holder = driver._transaction(() => occupied.promise);
    const bounded = driver._transaction(
      () => {
        secondBodyRan = true;
        return Promise.resolve("started");
      },
      { maxWait: 1 }
    );

    await expect(bounded).rejects.toMatchObject({
      code: "V5002",
      name: "TransactionError",
    });
    await expect(bounded).rejects.toThrow(NAMED_MAX_WAIT);
    expect(secondBodyRan).toBe(false);
    occupied.settle("released");
    await expect(holder).resolves.toBe("released");
    // Exactly one transaction was opened: the bounded-out one never reached
    // BEGIN, so there was nothing to roll back.
    expect(driver.sqlOf()).toEqual(["BEGIN", "COMMIT"]);
  });

  test("honors a bound the queue meets", async () => {
    const driver = new RecordingDriver({
      serialize: true,
      support: QUEUE_MAX_WAIT_SUPPORT,
    });

    await expect(
      driver._transaction(() => Promise.resolve("started"), { maxWait: 5000 })
    ).resolves.toBe("started");
    expect(driver.sqlOf()).toEqual(["BEGIN", "COMMIT"]);
  });
});

describe("batch execution inside an open transaction", () => {
  test("runs on the open transaction instead of opening a second one", async () => {
    const driver = new RecordingDriver();

    const results = await driver.withTransaction((txDriver) =>
      txDriver._executeBatch([{ sql: "INSERT one" }, { sql: "INSERT two" }])
    );

    expect(results).toEqual([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    expect(driver.sqlOf()).toEqual([
      "BEGIN",
      "INSERT one",
      "INSERT two",
      "COMMIT",
    ]);
  });

  test("attributes a statement failure to its index and rolls the transaction back", async () => {
    class FailingDriver extends RecordingDriver {
      protected override execute<T>(
        client: FakeSession,
        statement: string
      ): Promise<QueryResult<T>> {
        if (statement === "INSERT two") {
          return Promise.reject(new Error("duplicate key value"));
        }
        return super.execute<T>(client, statement);
      }
    }
    const driver = new FailingDriver();

    await expect(
      driver.withTransaction((txDriver) =>
        txDriver._executeBatch([{ sql: "INSERT one" }, { sql: "INSERT two" }])
      )
    ).rejects.toMatchObject({
      meta: expect.objectContaining({ statementIndex: 1 }),
    });
    expect(driver.sqlOf()).toEqual(["BEGIN", "INSERT one", "ROLLBACK"]);
  });
});

describe("native batch commit acknowledgement", () => {
  test("refuses an ordered committed notification a driver cannot honor", async () => {
    const driver = new RecordingDriver({ supportsBatch: true });
    let acknowledged = 0;
    const notify: CommittedBatchNotification = () => {
      acknowledged += 1;
      return Promise.resolve();
    };

    await expect(
      driver._executeBatch(
        [{ sql: "INSERT one" }],
        undefined,
        undefined,
        notify
      )
    ).rejects.toThrow(UNORDERED_SEGMENTS);
    expect(acknowledged).toBe(0);
    // The refusal lands before any statement is prepared for dispatch.
    expect(driver.batches).toEqual([]);
  });

  test("forwards the notification to a driver that declares the capability", async () => {
    const driver = new RecordingDriver({
      supportsBatch: true,
      supportsOrderedCommittedSegments: true,
    });
    let acknowledged = 0;
    const notify: CommittedBatchNotification = () => {
      acknowledged += 1;
      return Promise.resolve();
    };

    await expect(
      driver._executeBatch(
        [{ sql: "INSERT one" }, { sql: "INSERT two" }],
        undefined,
        undefined,
        notify
      )
    ).resolves.toHaveLength(2);
    expect(acknowledged).toBe(1);
    expect(driver.batches).toHaveLength(1);
  });
});

describe("_prepare provenance under trusted observers", () => {
  test("detaches the statement and keeps its typed provenance for later transforms", () => {
    const driver = new RecordingDriver();
    const context = createOfficialTestExecutionContext(
      { logging: { query: () => undefined } },
      { model: "entry", operation: "createMany" }
    );
    const statement = sql`INSERT INTO entry VALUES (${"a"}, ${2})`;

    const prepared = driver._prepare(statement, context);
    const provenance = readPreparedStatement(prepared);

    expect(prepared.sql).toBe("INSERT INTO entry VALUES ($1, $2)");
    expect(prepared.params).toEqual(["a", 2]);
    expect(prepared.params).not.toBe(statement.values);
    expect(provenance).toBeDefined();
    expect(provenance).not.toBe(statement);
    expect(provenance?.values).toEqual(["a", 2]);
    expect(provenance?.strings).toEqual([...statement.strings]);
  });

  test("carries no provenance when nothing is observing", () => {
    const driver = new RecordingDriver();
    const statement = sql`SELECT ${1}`;

    const prepared = driver._prepare(statement, { operation: "findMany" });

    expect(prepared.sql).toBe("SELECT $1");
    expect(readPreparedStatement(prepared)).toBeUndefined();
  });
});
