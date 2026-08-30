import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { getExecutionTransactionPhases } from "@drivers/execution-context";
import type { TransactionOptionSupport } from "@drivers/shared/transaction-options";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { CommittedBatchNotification } from "@drivers/types";
import { isVibORMError } from "@errors";
import {
  ATTR_DB_DRIVER,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_CONNECT,
  SPAN_DISCONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_TRANSACTION,
} from "@instrumentation/spans";
import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { createClient, defineExtension, s } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { withOtelRecorder } from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({ id: s.string().id(), name: s.string() });
const schema = { record };

interface LifecycleSummary {
  readonly commitCertainty?: "committed" | "may-have-committed";
  readonly status: "failure" | "success";
}

interface CapturedLifecycle {
  readonly completion: Promise<LifecycleSummary>;
  readonly kind: "connection" | "savepoint" | "transaction";
  readonly operation: string | undefined;
  summary?: LifecycleSummary;
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

function activeSpanName(): string {
  const span = trace.getActiveSpan();
  return span === undefined ? "none" : String(Reflect.get(span, "name"));
}

class OfficialLifecycleDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly timeline: string[] = [];
  protected override readonly serializeTransactions: boolean;
  closeBarrier: Promise<void> | undefined;
  closeCount = 0;
  failBegin: Error | undefined;
  failCommit: Error | undefined;
  failConnect: Error | undefined;
  failDisconnect: Error | undefined;
  failRelease: Error | undefined;
  failTransactionClose: Error | undefined;
  onCloseStart: (() => void) | undefined;

  constructor(name: string, initialized = true, serializeTransactions = true) {
    super("sqlite", name);
    this.serializeTransactions = serializeTransactions;
    if (initialized) this.client = {};
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "serializable-only",
      isolationLevelReason: "the fixture is serializable",
      maxWait: "queue",
      timeout: true,
    };
  }

  protected async initClient(): Promise<object> {
    this.timeline.push(`provider:connect:${activeSpanName()}`);
    if (this.failConnect) throw this.failConnect;
    return {};
  }

  protected async closeClient(): Promise<void> {
    this.timeline.push(`provider:disconnect:${activeSpanName()}`);
    this.closeCount += 1;
    this.onCloseStart?.();
    if (this.closeBarrier) await this.closeBarrier;
    if (this.failDisconnect) throw this.failDisconnect;
  }

  protected async execute<T>(
    _client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    this.timeline.push(`provider:statement:${activeSpanName()}`);
    const rows = statement.trimStart().startsWith("SELECT")
      ? [{ id: "record-1", name: "Ada" }]
      : [];
    return { rowCount: 1, rows: rows as T[] };
  }

  protected async executeRaw<T>(
    _client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    this.timeline.push(`provider:${statement}:${activeSpanName()}`);
    if (statement.startsWith("RELEASE") && this.failRelease) {
      const failure = this.failRelease;
      this.failRelease = undefined;
      throw failure;
    }
    return { rowCount: 1, rows: [] };
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    const phases = getExecutionTransactionPhases(context);
    return runTransactionLifecycle({
      begin: () => {
        this.timeline.push(`provider:BEGIN:${activeSpanName()}`);
        if (this.failBegin) throw this.failBegin;
      },
      callback: () => callback(client),
      commit: () => {
        this.timeline.push(`provider:COMMIT:${activeSpanName()}`);
        if (this.failCommit) throw this.failCommit;
      },
      rollback: () => {
        this.timeline.push(`provider:ROLLBACK:${activeSpanName()}`);
      },
      close: () => {
        this.timeline.push(`provider:CLOSE:${activeSpanName()}`);
        if (this.failTransactionClose) throw this.failTransactionClose;
      },
      phases,
    });
  }
}

class OfficialNativeLifecycleDriver extends OfficialLifecycleDriver {
  override readonly supportsBatch = true;
  override readonly supportsTransactions = false;

  protected override async transaction<T>(): Promise<T> {
    throw new Error("Native lifecycle fixture has no callback transaction");
  }

  protected override async executeBatch<T>(
    _client: object,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.timeline.push(`provider:native:${activeSpanName()}`);
    await committed?.();
    return queries.map(() => ({ rowCount: 1, rows: [] }));
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function track<Client extends { $disconnect(): Promise<void> }>(
  client: Client
): Client {
  clients.push(client);
  return client;
}

function lifecycleObserver(
  label: string,
  timeline: string[],
  captures: CapturedLifecycle[]
) {
  return defineExtension<typeof schema>()({
    name: `official-lifecycle-${label}`,
    observe(unit, proceed) {
      if (
        unit.kind !== "connection" &&
        unit.kind !== "savepoint" &&
        unit.kind !== "transaction"
      ) {
        return;
      }
      timeline.push(`${label}:${unit.kind}:in:${activeSpanName()}`);
      const completion = proceed();
      const capture: CapturedLifecycle = {
        completion,
        kind: unit.kind,
        operation: unit.operation,
      };
      captures.push(capture);
      completion.then((summary) => {
        capture.summary = summary;
        timeline.push(
          `${label}:${unit.kind}:out:${summary.status}:${summary.commitCertainty ?? "none"}`
        );
      });
    },
  });
}

async function settle(captures: readonly CapturedLifecycle[]): Promise<void> {
  await Promise.all(captures.map(({ completion }) => completion));
}

function driverSpans(spans: readonly ReadableSpan[], driverName: string) {
  return spans.filter(
    ({ attributes }) => attributes[ATTR_DB_DRIVER] === driverName
  );
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.$disconnect().catch(() => undefined);
  }
});

describe("official driver lifecycle instrumentation", () => {
  test("starts lifecycle spans at dispatch and preserves active parent links", async () => {
    const recorder = withOtelRecorder();
    try {
      const officialDriver = new OfficialLifecycleDriver(
        "official-lifecycle",
        false
      );
      const before: CapturedLifecycle[] = [];
      const after: CapturedLifecycle[] = [];
      const official = track(
        createClient({ schema, driver: officialDriver })
          .$extends(lifecycleObserver("A", officialDriver.timeline, before))
          .$extends(instrumentation({ tracing: true }))
          .$extends(lifecycleObserver("B", officialDriver.timeline, after))
      );

      await official.$connect();
      await official.$transaction(async (tx) => {
        await tx.record.findMany();
        await tx.$transaction(async (nested) => {
          await nested.record.findMany();
        });
      });
      await official.$disconnect();
      await settle([...before, ...after]);

      const officialSpans = driverSpans(recorder.spans(), "official-lifecycle");
      expect(
        officialSpans.filter(({ name }) => name === SPAN_CONNECT)
      ).toHaveLength(1);
      expect(
        officialSpans.filter(({ name }) => name === SPAN_DISCONNECT)
      ).toHaveLength(1);
      const transactionSpans = officialSpans.filter(
        ({ name }) => name === SPAN_TRANSACTION
      );
      expect(transactionSpans).toHaveLength(2);

      const outerTransaction = transactionSpans.find(
        ({ parentSpanContext }) => parentSpanContext === undefined
      );
      if (!outerTransaction) throw new Error("Missing outer transaction span");
      const savepoint = transactionSpans.find(
        ({ parentSpanContext }) =>
          parentSpanContext?.spanId === outerTransaction.spanContext().spanId
      );
      if (!savepoint) throw new Error("Missing nested savepoint span");
      const operationSpans = officialSpans.filter(
        ({ name }) => name === SPAN_OPERATION
      );
      expect(
        operationSpans.some(
          ({ parentSpanContext }) =>
            parentSpanContext?.spanId === outerTransaction.spanContext().spanId
        )
      ).toBe(true);
      expect(
        operationSpans.some(
          ({ parentSpanContext }) =>
            parentSpanContext?.spanId === savepoint.spanContext().spanId
        )
      ).toBe(true);
      for (const operation of operationSpans) {
        expect(
          officialSpans.some(
            ({ name, parentSpanContext }) =>
              name === SPAN_EXECUTE &&
              parentSpanContext?.spanId === operation.spanContext().spanId
          )
        ).toBe(true);
      }
      expect(officialDriver.timeline).toContain(
        `provider:connect:${SPAN_CONNECT}`
      );
      expect(officialDriver.timeline).toContain(
        `provider:BEGIN:${SPAN_TRANSACTION}`
      );
      expect(
        officialDriver.timeline.some((event) =>
          event.startsWith("provider:SAVEPOINT")
        )
      ).toBe(true);
      expect(officialDriver.timeline).toContain(
        `provider:disconnect:${SPAN_DISCONNECT}`
      );
      expect(officialDriver.timeline[0]).toBe("A:connection:in:none");
      expect(officialDriver.timeline[1]).toBe("B:connection:in:none");
    } finally {
      await recorder.dispose();
    }
  });

  test("keeps queued savepoint observation outside serialized provider spans", async () => {
    const recorder = withOtelRecorder();
    try {
      const driver = new OfficialLifecycleDriver("queued-savepoints");
      const before: CapturedLifecycle[] = [];
      const after: CapturedLifecycle[] = [];
      const client = track(
        createClient({ schema, driver })
          .$extends(lifecycleObserver("A", driver.timeline, before))
          .$extends(instrumentation({ tracing: true }))
          .$extends(lifecycleObserver("B", driver.timeline, after))
      );
      const firstStarted = createDeferred<void>();
      const releaseFirst = createDeferred<void>();

      await client.$transaction(async (tx) => {
        const first = tx.$transaction(async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
        });
        const second = tx.$transaction(async () => undefined);
        await firstStarted.promise;

        expect(
          driver.timeline.filter((event) => event.startsWith("B:savepoint:in"))
        ).toHaveLength(2);
        expect(
          driver.timeline.filter((event) =>
            event.startsWith("provider:SAVEPOINT")
          )
        ).toHaveLength(1);
        releaseFirst.resolve();
        await Promise.all([first, second]);
      });
      await settle([...before, ...after]);

      expect(
        after
          .filter(({ kind }) => kind === "savepoint")
          .every(
            ({ summary }) =>
              summary?.status === "success" &&
              summary.commitCertainty === undefined
          )
      ).toBe(true);
      expect(
        driverSpans(recorder.spans(), "queued-savepoints").filter(
          ({ name }) => name === SPAN_TRANSACTION
        )
      ).toHaveLength(3);
      expect(
        driver.timeline.filter((event) =>
          event.startsWith("provider:SAVEPOINT")
        )
      ).toHaveLength(2);
      expect(
        driver.timeline
          .filter((event) => event.startsWith("provider:SAVEPOINT"))
          .every((event) => event.endsWith(SPAN_TRANSACTION))
      ).toBe(true);
    } finally {
      await recorder.dispose();
    }
  });

  test("reports exact commit certainty without changing failing span status", async () => {
    const recorder = withOtelRecorder();
    try {
      const cases: Array<{
        readonly bodyFailure?: Error;
        readonly configure: (driver: OfficialLifecycleDriver) => void;
        readonly expected: LifecycleSummary["commitCertainty"];
        readonly name: string;
      }> = [
        {
          name: "begin-failure",
          expected: undefined,
          configure(driver: OfficialLifecycleDriver) {
            driver.failBegin = new Error("begin failed");
          },
        },
        {
          name: "body-failure",
          expected: undefined,
          configure(_driver: OfficialLifecycleDriver) {
            // The callback supplies this failure below.
          },
          bodyFailure: new Error("body failed"),
        },
        {
          name: "commit-failure",
          expected: "may-have-committed" as const,
          configure(driver: OfficialLifecycleDriver) {
            driver.failCommit = new Error("commit failed");
          },
        },
        {
          name: "cleanup-failure",
          expected: "committed" as const,
          configure(driver: OfficialLifecycleDriver) {
            driver.failTransactionClose = new Error("cleanup failed");
          },
        },
      ];

      for (const lifecycleCase of cases) {
        const driver = new OfficialLifecycleDriver(lifecycleCase.name);
        lifecycleCase.configure(driver);
        const captures: CapturedLifecycle[] = [];
        const client = track(
          createClient({ schema, driver })
            .$extends(instrumentation({ tracing: true }))
            .$extends(lifecycleObserver("capture", driver.timeline, captures))
        );
        await expect(
          client.$transaction(async () => {
            if (lifecycleCase.bodyFailure) throw lifecycleCase.bodyFailure;
          })
        ).rejects.toBeInstanceOf(Error);
        await settle(captures);

        const transaction = captures.find(({ kind }) => kind === "transaction");
        expect(transaction?.summary).toMatchObject({ status: "failure" });
        expect(transaction?.summary?.commitCertainty).toBe(
          lifecycleCase.expected
        );
        const span = driverSpans(recorder.spans(), lifecycleCase.name).find(
          ({ name }) => name === SPAN_TRANSACTION
        );
        expect(span?.status.code).toBe(2);
        expect(span?.events.some(({ name }) => name === "exception")).toBe(
          true
        );
      }
    } finally {
      await recorder.dispose();
    }
  });

  test("settles a predispatch maxWait failure without a fictional span", async () => {
    const recorder = withOtelRecorder();
    try {
      const driver = new OfficialLifecycleDriver("max-wait-lifecycle");
      const captures: CapturedLifecycle[] = [];
      const client = track(
        createClient({ schema, driver })
          .$extends(instrumentation({ tracing: true }))
          .$extends(lifecycleObserver("capture", driver.timeline, captures))
      );
      const firstStarted = createDeferred<void>();
      const releaseFirst = createDeferred<void>();
      const first = client.$transaction(async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
      });
      const waiting = client.$transaction(async () => undefined, {
        maxWait: 5,
      });
      await firstStarted.promise;

      await expect(waiting).rejects.toBeInstanceOf(Error);
      releaseFirst.resolve();
      await first;
      await settle(captures);

      const transactions = captures.filter(
        ({ kind }) => kind === "transaction"
      );
      expect(transactions).toHaveLength(2);
      expect(transactions[1]?.summary).toMatchObject({ status: "failure" });
      expect(transactions[1]?.summary?.commitCertainty).toBeUndefined();
      expect(
        driverSpans(recorder.spans(), "max-wait-lifecycle").filter(
          ({ name }) => name === SPAN_TRANSACTION
        )
      ).toHaveLength(1);
    } finally {
      await recorder.dispose();
    }
  });

  test("emits one fallback transaction and no native transaction", async () => {
    const recorder = withOtelRecorder();
    try {
      const fallbackDriver = new OfficialLifecycleDriver("fallback-lifecycle");
      const fallback = track(
        createClient({ schema, driver: fallbackDriver }).$extends(
          instrumentation({ tracing: true })
        )
      );
      await fallback.$transaction([
        fallback.$executeRawUnsafe("UPDATE record SET name = 'fallback'"),
      ]);

      const nativeDriver = new OfficialNativeLifecycleDriver(
        "native-lifecycle"
      );
      const native = track(
        createClient({ schema, driver: nativeDriver }).$extends(
          instrumentation({ tracing: true })
        )
      );
      await native.$transaction([
        native.$executeRawUnsafe("UPDATE record SET name = 'native'"),
      ]);

      expect(
        driverSpans(recorder.spans(), "fallback-lifecycle").filter(
          ({ name }) => name === SPAN_TRANSACTION
        )
      ).toHaveLength(1);
      expect(
        driverSpans(recorder.spans(), "native-lifecycle").filter(
          ({ name }) => name === SPAN_TRANSACTION
        )
      ).toHaveLength(0);
    } finally {
      await recorder.dispose();
    }
  });

  test("isolates official lifecycle spans on a shared driver and skips inactive names", async () => {
    const recorder = withOtelRecorder();
    try {
      const driver = new OfficialLifecycleDriver("shared-lifecycle");
      const base = track(createClient({ schema, driver }));
      const ordinary = track(
        base.$extends({
          name: "ordinary-only-lifecycle",
          observe(_unit, proceed) {
            proceed();
          },
        })
      );
      const official = track(base.$extends(instrumentation({ tracing: true })));
      const ignored = track(
        base.$extends(
          instrumentation({
            tracing: {
              ignoreSpanTypes: [
                SPAN_CONNECT,
                SPAN_DISCONNECT,
                SPAN_TRANSACTION,
              ],
            },
          })
        )
      );

      await base.$transaction(async () => undefined);
      await ordinary.$transaction(async () => undefined);
      await official.$transaction(async () => undefined);
      await ignored.$transaction(async () => undefined);

      expect(
        driverSpans(recorder.spans(), "shared-lifecycle").filter(
          ({ name }) => name === SPAN_TRANSACTION
        )
      ).toHaveLength(1);
    } finally {
      await recorder.dispose();
    }
  });

  test("keeps connection failures inside exact official spans and resets disconnect", async () => {
    const recorder = withOtelRecorder();
    try {
      const connectDriver = new OfficialLifecycleDriver(
        "connect-failure",
        false
      );
      connectDriver.failConnect = Object.assign(
        new Error("connect failed at private-host"),
        { code: "ECONNREFUSED", status: 503 }
      );
      const connecting = track(
        createClient({ schema, driver: connectDriver }).$extends(
          instrumentation({ tracing: true })
        )
      );
      const connectFailure = await connecting
        .$connect()
        .catch((error) => error);
      expect(connectFailure).toMatchObject({
        name: "ConnectionError",
        message: "Database connection failed",
        meta: {
          driver: "connect-failure",
          model: "$connection",
          operation: "$connect",
          correlationId: expect.any(String),
          providerCode: "ECONNREFUSED",
          providerStatus: 503,
        },
        originalCause: { message: "Underlying error details redacted" },
      });
      expect(JSON.stringify(connectFailure)).not.toContain("private-host");

      const disconnectDriver = new OfficialLifecycleDriver(
        "disconnect-failure"
      );
      disconnectDriver.failDisconnect = Object.assign(
        new Error("disconnect failed at private-endpoint"),
        { code: "ECONNRESET", status: 502 }
      );
      const disconnecting = track(
        createClient({ schema, driver: disconnectDriver }).$extends(
          instrumentation({ tracing: true })
        )
      );
      const disconnectFailure = await disconnecting
        .$disconnect()
        .catch((error) => error);
      expect(disconnectFailure).toMatchObject({
        name: "ConnectionError",
        message: "Database disconnection failed",
        meta: {
          driver: "disconnect-failure",
          model: "$connection",
          operation: "$disconnect",
          correlationId: expect.any(String),
          providerCode: "ECONNRESET",
          providerStatus: 502,
        },
        originalCause: { message: "Underlying error details redacted" },
      });
      expect(JSON.stringify(disconnectFailure)).not.toContain(
        "private-endpoint"
      );
      disconnectDriver.failDisconnect = undefined;
      await expect(disconnecting.$connect()).rejects.toMatchObject({
        code: "V1003",
      });
      await disconnecting.$disconnect();
      await expect(disconnecting.$connect()).resolves.toBeUndefined();

      const connectSpan = driverSpans(recorder.spans(), "connect-failure").find(
        ({ name }) => name === SPAN_CONNECT
      );
      const disconnectSpan = driverSpans(
        recorder.spans(),
        "disconnect-failure"
      ).find(({ name }) => name === SPAN_DISCONNECT);
      expect(connectSpan?.status.code).toBe(2);
      expect(disconnectSpan?.status.code).toBe(2);
    } finally {
      await recorder.dispose();
    }
  });

  test("rejects an overlapping disconnect with its own context and closes once", async () => {
    const recorder = withOtelRecorder();
    try {
      const closeStarted = createDeferred<void>();
      const releaseClose = createDeferred<void>();
      const driver = new OfficialLifecycleDriver(
        "overlapping-disconnect",
        true,
        false
      );
      const captures: CapturedLifecycle[] = [];
      driver.closeBarrier = releaseClose.promise;
      driver.onCloseStart = () => closeStarted.resolve();
      const client = track(
        createClient({ schema, driver })
          .$extends(instrumentation({ tracing: true }))
          .$extends(lifecycleObserver("overlap", driver.timeline, captures))
      );

      const originating = client.$disconnect();
      await closeStarted.promise;
      const overlapFailure = await client.$disconnect().catch((error) => error);
      releaseClose.resolve();
      await originating;
      await settle(captures);

      if (!isVibORMError(overlapFailure)) {
        throw new Error("expected an overlapping disconnect VibORMError");
      }
      expect(overlapFailure).toMatchObject({
        name: "ConnectionError",
        code: "V1003",
        meta: {
          driver: "overlapping-disconnect",
          model: "$connection",
          operation: "$disconnect",
          correlationId: expect.any(String),
        },
      });
      const disconnectSpans = driverSpans(
        recorder.spans(),
        "overlapping-disconnect"
      ).filter(({ name }) => name === SPAN_DISCONNECT);
      expect(disconnectSpans).toHaveLength(1);
      expect(overlapFailure.meta.correlationId).not.toBe(
        disconnectSpans[0]?.attributes[ATTR_VIBORM_CORRELATION_ID]
      );
      expect(captures.map(({ summary }) => summary?.status).sort()).toEqual([
        "failure",
        "success",
      ]);
      expect(driver.closeCount).toBe(1);
    } finally {
      await recorder.dispose();
    }
  });

  test("rejects a provider-reentrant disconnect with its own context and closes once", async () => {
    const recorder = withOtelRecorder();
    try {
      const driver = new OfficialLifecycleDriver(
        "reentrant-disconnect",
        true,
        false
      );
      const captures: CapturedLifecycle[] = [];
      const client = track(
        createClient({ schema, driver })
          .$extends(instrumentation({ tracing: true }))
          .$extends(lifecycleObserver("reentrant", driver.timeline, captures))
      );
      let reentrant: Promise<unknown> | undefined;
      driver.onCloseStart = () => {
        reentrant = client.$disconnect().catch((error) => error);
      };

      await client.$disconnect();
      if (reentrant === undefined) {
        throw new Error("expected a reentrant disconnect attempt");
      }
      const reentrantFailure = await reentrant;
      await settle(captures);
      if (!isVibORMError(reentrantFailure)) {
        throw new Error("expected a reentrant disconnect VibORMError");
      }
      expect(reentrantFailure).toMatchObject({
        name: "ConnectionError",
        code: "V1003",
        meta: {
          driver: "reentrant-disconnect",
          model: "$connection",
          operation: "$disconnect",
          correlationId: expect.any(String),
        },
      });
      const disconnectSpans = driverSpans(
        recorder.spans(),
        "reentrant-disconnect"
      ).filter(({ name }) => name === SPAN_DISCONNECT);
      expect(disconnectSpans).toHaveLength(1);
      expect(reentrantFailure.meta.correlationId).not.toBe(
        disconnectSpans[0]?.attributes[ATTR_VIBORM_CORRELATION_ID]
      );
      expect(captures.map(({ summary }) => summary?.status).sort()).toEqual([
        "failure",
        "success",
      ]);
      expect(driver.closeCount).toBe(1);
    } finally {
      await recorder.dispose();
    }
  });
});
