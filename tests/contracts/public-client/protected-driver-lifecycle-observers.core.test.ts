import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { getExecutionTransactionPhases } from "@drivers/execution-context";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { CommittedBatchNotification } from "@drivers/types";
import { createClient, s } from "@src/index";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({
  id: s.string().id(),
  name: s.string(),
  notes: s.toMany(() => note),
});
const note = s.model({
  id: s.string().id(),
  body: s.string(),
  recordId: s.string(),
  record: s
    .toOne(() => record)
    .fields("recordId")
    .references("id"),
});
const schema = { note, record };

function transactionContext(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability.context;
}

type Completion = Readonly<{
  status: "success" | "failure";
  commitCertainty?: "committed" | "may-have-committed";
}>;

interface ObservedLifecycle {
  readonly kind: string;
  readonly operation: string | undefined;
  readonly completion: Promise<Completion>;
  summary?: Completion;
}

function createDeferred<Value>() {
  let resolveValue: ((value: Value | PromiseLike<Value>) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve(value: Value): void {
      if (resolveValue === undefined)
        throw new Error("Deferred is unavailable");
      resolveValue(value);
    },
  };
}

class LifecycleDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly timeline: string[] = [];
  sawTransactionPhases = false;
  failBegin: Error | undefined;
  failCommit: Error | undefined;
  failConnect: Error | undefined;
  failDisconnect: Error | undefined;
  failRelease: Error | undefined;
  failTransactionClose: Error | undefined;
  private selectRows: unknown[] | undefined;

  constructor(initialized = true) {
    super("sqlite", "protected-lifecycle-test");
    if (initialized) this.client = {};
  }

  respondToSelectsWith(rows: unknown[]): void {
    this.selectRows = rows;
  }

  protected async initClient(): Promise<object> {
    this.timeline.push("provider:connect");
    if (this.failConnect) throw this.failConnect;
    return {};
  }

  protected async closeClient(): Promise<void> {
    this.timeline.push("provider:disconnect");
    if (this.failDisconnect) throw this.failDisconnect;
  }

  protected async execute<T>(
    _client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    this.timeline.push(`provider:${statement}`);
    const rows = statement.trimStart().startsWith("SELECT")
      ? (this.selectRows ?? [])
      : [];
    return { rows: rows as T[], rowCount: 1 };
  }

  protected async executeRaw<T>(
    _client: object,
    statement: string,
    _params?: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.timeline.push(`provider:${statement}`);
    if (statement.startsWith("RELEASE") && this.failRelease) {
      const failure = this.failRelease;
      this.failRelease = undefined;
      throw failure;
    }
    return { rows: [], rowCount: 1 };
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    const phases = getExecutionTransactionPhases(context);
    this.sawTransactionPhases = phases !== undefined;
    return runTransactionLifecycle({
      begin: () => {
        this.timeline.push("provider:BEGIN");
        if (this.failBegin) throw this.failBegin;
      },
      callback: () => callback(client),
      commit: () => {
        this.timeline.push("provider:COMMIT");
        if (this.failCommit) throw this.failCommit;
      },
      rollback: () => this.timeline.push("provider:ROLLBACK"),
      close: () => {
        this.timeline.push("provider:CLOSE");
        if (this.failTransactionClose) throw this.failTransactionClose;
      },
      phases,
    });
  }
}

class PhaseBlindLifecycleDriver extends LifecycleDriver {
  protected override async transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    this.timeline.push("provider:BEGIN");
    try {
      const result = await callback(client);
      this.timeline.push("provider:COMMIT");
      this.timeline.push("provider:CLOSE");
      return result;
    } catch (error) {
      this.timeline.push("provider:ROLLBACK");
      throw error;
    }
  }
}

class NativeLifecycleDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsBatch = true;
  override readonly supportsTransactions = false;
  readonly timeline: string[] = [];

  constructor() {
    super("sqlite", "protected-native-lifecycle-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // The public disconnect path owns connection observation.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("NativeLifecycleDriver executes only batches");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("NativeLifecycleDriver executes only batches");
  }

  protected async transaction<T>(): Promise<T> {
    throw new Error("NativeLifecycleDriver has no transactions");
  }

  protected async executeBatch<T>(
    _client: object,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.timeline.push("provider:native-batch");
    await committed?.();
    return queries.map(() => ({ rows: [], rowCount: 1 }));
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function observedClient(driver: LifecycleDriver | NativeLifecycleDriver) {
  const observed: ObservedLifecycle[] = [];
  const client = createClient({ schema, driver }).$extends({
    name: "driver-lifecycle-observer",
    observe(unit, proceed) {
      if (
        unit.kind !== "transaction" &&
        unit.kind !== "savepoint" &&
        unit.kind !== "connection"
      ) {
        return;
      }
      driver.timeline.push(`observer:${unit.kind}:in:${unit.operation}`);
      const completion = proceed();
      const observation: ObservedLifecycle = {
        kind: unit.kind,
        operation: unit.operation,
        completion,
      };
      observed.push(observation);
      completion.then((summary) => {
        observation.summary = summary;
        driver.timeline.push(
          `observer:${unit.kind}:out:${summary.status}:${summary.commitCertainty ?? "none"}`
        );
      });
    },
  });
  clients.push(client);
  return { client, observed };
}

function byKind(
  observed: readonly ObservedLifecycle[],
  kind: ObservedLifecycle["kind"]
): ObservedLifecycle[] {
  return observed.filter((observation) => observation.kind === kind);
}

async function settleObservations(
  observed: readonly ObservedLifecycle[]
): Promise<void> {
  await Promise.all(observed.map((observation) => observation.completion));
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("public protected driver lifecycle observers", () => {
  test("wraps callback transaction acquisition through post-commit cleanup once", async () => {
    const driver = new LifecycleDriver(false);
    const { client, observed } = observedClient(driver);

    await expect(
      client.$transaction(async () => {
        driver.timeline.push("application:body");
        return "result" as const;
      })
    ).resolves.toBe("result");
    await settleObservations(observed);

    const transactions = byKind(observed, "transaction");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      operation: "$transaction(callback)",
      summary: { status: "success", commitCertainty: "committed" },
    });
    expect(driver.timeline).toEqual([
      "observer:transaction:in:$transaction(callback)",
      "provider:connect",
      "provider:BEGIN",
      "application:body",
      "provider:COMMIT",
      "provider:CLOSE",
      "observer:transaction:out:success:committed",
    ]);
  });

  test("observes a direct composed write's one internal transaction", async () => {
    const driver = new LifecycleDriver();
    driver.respondToSelectsWith([{ id: "record-direct" }]);
    const { client, observed } = observedClient(driver);

    await client.record.create({
      data: {
        id: "record-direct",
        name: "direct",
        notes: { create: { id: "note-direct", body: "nested" } },
      },
      select: { id: true },
    });
    await settleObservations(observed);

    const transactions = byKind(observed, "transaction");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      operation: "create",
      summary: { status: "success", commitCertainty: "committed" },
    });
    expect(
      driver.timeline.filter((event) => event === "provider:BEGIN")
    ).toHaveLength(1);
    expect(
      driver.timeline.filter((event) => event === "provider:COMMIT")
    ).toHaveLength(1);
  });

  test("treats fulfilled custom transaction drivers as the committed boundary", async () => {
    const driver = new PhaseBlindLifecycleDriver();
    const { client, observed } = observedClient(driver);

    await client.$transaction(async () => "custom-driver-result");
    await settleObservations(observed);

    expect(driver.sawTransactionPhases).toBe(false);
    expect(byKind(observed, "transaction")[0]?.summary).toMatchObject({
      status: "success",
      commitCertainty: "committed",
    });
  });

  test("observes nested callbacks and fallback arrays as savepoints without durable certainty", async () => {
    const driver = new LifecycleDriver();
    const { client, observed } = observedClient(driver);

    await client.$transaction(async (tx) => {
      await tx.$transaction(async () => "nested");
      await tx.$transaction([
        tx.$executeRawUnsafe("UPDATE record SET name = 'nested'"),
      ]);
    });
    await settleObservations(observed);

    expect(byKind(observed, "transaction")).toHaveLength(1);
    const savepoints = byKind(observed, "savepoint");
    expect(savepoints).toHaveLength(2);
    expect(savepoints.map((unit) => unit.operation)).toEqual([
      "$transaction(callback)",
      "$transaction([...])",
    ]);
    expect(
      savepoints.every(
        (unit) =>
          unit.summary?.status === "success" &&
          unit.summary.commitCertainty === undefined
      )
    ).toBe(true);
    expect(
      driver.timeline.filter((event) => event.startsWith("provider:SAVEPOINT"))
    ).toHaveLength(2);
    expect(
      driver.timeline.filter((event) => event.startsWith("provider:RELEASE"))
    ).toHaveLength(2);
  });

  test("observes queued savepoint wait while provider savepoints stay serialized", async () => {
    const driver = new LifecycleDriver();
    const { client, observed } = observedClient(driver);
    const firstBodyStarted = createDeferred<void>();
    const releaseFirstBody = createDeferred<void>();

    await client.$transaction(async (tx) => {
      const first = tx.$transaction(async () => {
        driver.timeline.push("application:first-savepoint");
        firstBodyStarted.resolve();
        await releaseFirstBody.promise;
      });
      const second = tx.$transaction(async () => {
        driver.timeline.push("application:second-savepoint");
      });

      await firstBodyStarted.promise;
      expect(
        driver.timeline.filter((event) =>
          event.startsWith("observer:savepoint:in")
        )
      ).toHaveLength(2);
      expect(
        driver.timeline.filter((event) =>
          event.startsWith("provider:SAVEPOINT")
        )
      ).toHaveLength(1);

      releaseFirstBody.resolve();
      await Promise.all([first, second]);
    });
    await settleObservations(observed);

    const savepoints = byKind(observed, "savepoint");
    expect(savepoints).toHaveLength(2);
    expect(
      savepoints.every(
        (observation) =>
          observation.summary?.status === "success" &&
          observation.summary.commitCertainty === undefined
      )
    ).toBe(true);
    const releases = driver.timeline
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.startsWith("provider:RELEASE"));
    const completions = driver.timeline
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.startsWith("observer:savepoint:out"));
    expect(releases).toHaveLength(2);
    expect(completions).toHaveLength(2);
    expect(releases[0]?.index).toBeLessThan(completions[0]?.index ?? -1);
    expect(releases[1]?.index).toBeLessThan(completions[1]?.index ?? -1);
  });

  test("emits one transaction for a fallback array and none for a native array", async () => {
    const fallbackDriver = new LifecycleDriver();
    const fallback = observedClient(fallbackDriver);
    await fallback.client.$transaction([
      fallback.client.$executeRawUnsafe("UPDATE record SET name = 'fallback'"),
    ]);
    await settleObservations(fallback.observed);

    expect(byKind(fallback.observed, "transaction")).toHaveLength(1);
    expect(byKind(fallback.observed, "savepoint")).toHaveLength(0);
    expect(fallback.observed[0]).toMatchObject({
      operation: "$transaction([...])",
      summary: { status: "success", commitCertainty: "committed" },
    });

    const nativeDriver = new NativeLifecycleDriver();
    const native = observedClient(nativeDriver);
    await native.client.$transaction([
      native.client.$executeRawUnsafe("UPDATE record SET name = 'native'"),
    ]);
    await settleObservations(native.observed);

    expect(byKind(native.observed, "transaction")).toHaveLength(0);
    expect(byKind(native.observed, "savepoint")).toHaveLength(0);
    expect(nativeDriver.timeline).toEqual(["provider:native-batch"]);
  });

  test("reports exact root certainty for body, commit-ack, and cleanup failures", async () => {
    const cases = [
      {
        expected: undefined,
        configure(driver: LifecycleDriver) {
          driver.failBegin = new Error("begin failed");
        },
      },
      {
        expected: undefined,
        configure(_driver: LifecycleDriver) {
          // The callback owns this failure before ready-to-commit.
        },
        bodyFailure: new Error("body failed"),
      },
      {
        expected: "may-have-committed" as const,
        configure(driver: LifecycleDriver) {
          driver.failCommit = new Error("commit acknowledgement failed");
        },
      },
      {
        expected: "committed" as const,
        configure(driver: LifecycleDriver) {
          driver.failTransactionClose = new Error("post-commit close failed");
        },
      },
    ];

    for (const lifecycleCase of cases) {
      const driver = new LifecycleDriver();
      lifecycleCase.configure(driver);
      const { client, observed } = observedClient(driver);
      const transaction = client.$transaction(async () => {
        if (lifecycleCase.bodyFailure) throw lifecycleCase.bodyFailure;
        return "ok";
      });
      await expect(transaction).rejects.toThrow();
      await settleObservations(observed);
      expect(byKind(observed, "transaction")).toHaveLength(1);
      expect(byKind(observed, "transaction")[0]?.summary).toMatchObject({
        status: "failure",
      });
      expect(byKind(observed, "transaction")[0]?.summary?.commitCertainty).toBe(
        lifecycleCase.expected
      );
    }
  });

  test("keeps savepoint release failure pre-durable and completes after rollback cleanup", async () => {
    const driver = new LifecycleDriver();
    const { client, observed } = observedClient(driver);
    driver.failRelease = new Error("release failed");

    await expect(
      client.$transaction((tx) => tx.$transaction(async () => "nested"))
    ).rejects.toThrow();
    await settleObservations(observed);

    const savepoint = byKind(observed, "savepoint")[0];
    expect(savepoint?.summary).toMatchObject({ status: "failure" });
    expect(savepoint?.summary?.commitCertainty).toBeUndefined();
    const completionIndex = driver.timeline.findIndex((event) =>
      event.startsWith("observer:savepoint:out:failure")
    );
    expect(
      driver.timeline.findIndex((event) =>
        event.startsWith("provider:ROLLBACK TO SAVEPOINT")
      )
    ).toBeLessThan(completionIndex);
  });

  test("wraps public connect and disconnect with exact private-safe identity", async () => {
    const driver = new LifecycleDriver(false);
    const { client, observed } = observedClient(driver);

    await client.$connect();
    await client.$disconnect();
    await settleObservations(observed);

    const connections = byKind(observed, "connection");
    expect(connections).toHaveLength(2);
    expect(
      connections.map(({ operation, summary }) => ({ operation, summary }))
    ).toEqual([
      {
        operation: "$connect",
        summary: expect.objectContaining({ status: "success" }),
      },
      {
        operation: "$disconnect",
        summary: expect.objectContaining({ status: "success" }),
      },
    ]);
    expect(driver.timeline).toEqual([
      "observer:connection:in:$connect",
      "provider:connect",
      "observer:connection:out:success:none",
      "observer:connection:in:$disconnect",
      "provider:disconnect",
      "observer:connection:out:success:none",
    ]);
    expect(
      connections.every(
        (observation) => observation.summary?.commitCertainty === undefined
      )
    ).toBe(true);
  });

  test("reports connect and disconnect failures without commit certainty", async () => {
    const connectDriver = new LifecycleDriver(false);
    connectDriver.failConnect = new Error("connect failed");
    const connecting = observedClient(connectDriver);
    await expect(connecting.client.$connect()).rejects.toThrow();
    await settleObservations(connecting.observed);
    expect(byKind(connecting.observed, "connection")[0]?.summary).toMatchObject(
      { status: "failure" }
    );
    expect(
      byKind(connecting.observed, "connection")[0]?.summary?.commitCertainty
    ).toBeUndefined();

    const disconnectDriver = new LifecycleDriver();
    disconnectDriver.failDisconnect = new Error("disconnect failed");
    const disconnecting = observedClient(disconnectDriver);
    await expect(disconnecting.client.$disconnect()).rejects.toThrow();
    await settleObservations(disconnecting.observed);
    expect(
      byKind(disconnecting.observed, "connection")[0]?.summary
    ).toMatchObject({ status: "failure" });
    expect(
      byKind(disconnecting.observed, "connection")[0]?.summary?.commitCertainty
    ).toBeUndefined();
  });

  test("contains hostile lifecycle observers without changing commit or result", async () => {
    const driver = new LifecycleDriver();
    let doubleProceedWasStable = true;
    const never = new Promise<never>(() => undefined);
    const base = createClient({ schema, driver });
    const client = base
      .$extends({
        name: "lifecycle-no-proceed",
        observe() {
          return { fabricated: true };
        },
      })
      .$extends({
        name: "lifecycle-double-proceed",
        observe(_unit, proceed) {
          const completion = proceed();
          doubleProceedWasStable &&= completion === proceed();
          return "fabricated";
        },
      })
      .$extends({
        name: "lifecycle-throw",
        observe(_unit, proceed) {
          proceed();
          throw new Error("observer failed");
        },
      })
      .$extends({
        name: "lifecycle-never",
        observe(_unit, proceed) {
          proceed();
          return never;
        },
      });
    clients.push(client);

    await expect(
      client.$transaction(async () => "authoritative")
    ).resolves.toBe("authoritative");
    expect(driver.timeline).toContain("provider:COMMIT");
    expect(doubleProceedWasStable).toBe(true);
  });

  test("keeps observer-free and copied external contexts outside private lifecycle provenance", async () => {
    const driver = new LifecycleDriver();
    const base = createClient({ schema, driver });
    clients.push(base);

    const noObserver = base.$extends({
      name: "methods-only",
      client: () => ({ $ready: () => true }),
    });
    await noObserver.$transaction(async () => "base");
    expect(driver.sawTransactionPhases).toBe(false);

    const { client, observed } = observedClient(driver);
    const trusted = transactionContext(client.record.findMany());
    const copiedContext = { ...trusted };
    await driver._transaction(async () => "copied", undefined, copiedContext);
    await settleObservations(observed);
    expect(observed).toEqual([]);
  });
});
