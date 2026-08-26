import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import type { CommittedBatchNotification } from "@drivers/types";
import { ClientInitializationError, isVibORMError } from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import { ATTR_DB_OPERATION_NAME, SPAN_OPERATION } from "@instrumentation/spans";
import { trace } from "@opentelemetry/api";
import { createClient, s, sql } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import {
  captureLogs,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, test, vi } from "vitest";

const record = s.model({ id: s.string().id(), name: s.string() });
const schema = { record };

class OperationDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly events: string[] = [];
  timeline: string[] | undefined;

  constructor() {
    super("sqlite", "official-instrumentation-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource.
  }

  protected async execute<T>(
    _client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    this.events.push("provider");
    this.timeline?.push("provider");
    const rows = statement.trimStart().startsWith("SELECT")
      ? [{ id: "record-1", name: "Ada" }]
      : [];
    return { rows: rows as T[], rowCount: rows.length };
  }

  protected executeRaw<T>(
    client: object,
    statement: string,
    _params?: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute(client, statement);
  }

  protected async transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    this.events.push("BEGIN");
    this.timeline?.push("BEGIN");
    try {
      const result = await callback(client);
      this.events.push("COMMIT");
      this.timeline?.push("COMMIT");
      return result;
    } catch (failure) {
      this.events.push("ROLLBACK");
      this.timeline?.push("ROLLBACK");
      throw failure;
    }
  }
}

class NativeOperationDriver extends OperationDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async transaction<T>(): Promise<T> {
    throw new Error("Native test driver has no callback transactions");
  }

  protected override async executeBatch<T>(
    _client: object,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.events.push("batch-provider");
    this.timeline?.push("provider");
    await committed?.();
    return queries.map((query) => ({
      rows: query.sql.trimStart().startsWith("SELECT")
        ? ([{ id: "record-native", name: "Native" }] as T[])
        : [],
      rowCount: 1,
    }));
  }
}

class EmptyReadOperationDriver extends OperationDriver {
  protected override async execute<T>(
    _client: object,
    _statement: string
  ): Promise<QueryResult<T>> {
    this.events.push("provider");
    return { rows: [], rowCount: 0 };
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function baseClient(driver: OperationDriver = new OperationDriver()) {
  const client = createClient({ schema, driver });
  clients.push(client);
  return { client, driver };
}

function applyUnsafe<Client extends object>(
  client: Client,
  extension: unknown
): Client {
  const extend = Reflect.get(client, "$extends");
  if (typeof extend !== "function") throw new Error("Expected $extends");
  return Reflect.apply(extend, client, [extension]);
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("Expected instrumentation work did not settle");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("official instrumentation extension construction", () => {
  test("snapshots hostile config once and keeps one fixed private capability", () => {
    const reads = { diagnostics: 0, includeSql: 0, logging: 0, tracing: 0 };
    const tracing = {
      get includeSql(): true {
        reads.includeSql += 1;
        return true;
      },
    };
    const config = {
      get diagnostics(): undefined {
        reads.diagnostics += 1;
        return undefined;
      },
      get logging(): undefined {
        reads.logging += 1;
        return undefined;
      },
      get tracing(): typeof tracing {
        reads.tracing += 1;
        return tracing;
      },
    };

    const extension = instrumentation(config);

    expect(extension.name).toBe("viborm.instrumentation");
    expect(Object.isFrozen(extension)).toBe(true);
    expect(Reflect.ownKeys(extension)).toEqual(["name", "observe"]);
    expect(reads).toEqual({
      diagnostics: 1,
      includeSql: 1,
      logging: 1,
      tracing: 1,
    });
  });

  test("refuses a cloned, renamed, or structurally forged instance", () => {
    const { client: base } = baseClient();
    const official = instrumentation({ logging: { error: true } });
    const derived = base.$extends(official);
    const cloned = { ...official };
    const renamedClone = { ...official, name: "renamed-official" };

    expect(() => applyUnsafe(derived, cloned)).toThrow(
      ClientInitializationError
    );
    expect(() => applyUnsafe(derived, renamedClone)).toThrow(
      ClientInitializationError
    );
    expect(() => applyUnsafe(base, renamedClone)).toThrow(
      ClientInitializationError
    );
    expect(() =>
      applyUnsafe(base, {
        name: "viborm.instrumentation",
        observe() {
          return undefined;
        },
      })
    ).toThrow(ClientInitializationError);
  });

  test("does not read or activate a hostile removed core config key", async () => {
    const reads: string[] = [];
    const config = { schema, driver: new OperationDriver() };
    Object.defineProperty(config, "instrumentation", {
      enumerable: true,
      get() {
        reads.push("instrumentation");
        throw new Error("removed config must not be read");
      },
    });

    const base = createClient(config);
    clients.push(base);
    await expect(base.record.findMany()).resolves.toEqual([
      { id: "record-1", name: "Ada" },
    ]);
    expect(reads).toEqual([]);
  });

  test("keeps diagnostics-only capability without a lifecycle handler or array friend", () => {
    const diagnostics = instrumentation({
      diagnostics: { includeSql: true },
    });
    const chain = appendResolvedExtension(undefined, diagnostics, schema);
    expect(chain.observe).toHaveLength(0);
    expect(getOfficialInstrumentationChainCapability(chain)).toBeDefined();

    const { client: base } = baseClient();
    const client = base.$extends(diagnostics);
    const operation = client.record.findMany();
    expect(readTestTransactionOperation(operation)?.hasObservation()).toBe(
      false
    );
  });
});

describe("official logical operation presentation", () => {
  test("preserves exact observer order and the first async OTel active span", async () => {
    const recorder = withOtelRecorder();
    try {
      const timeline: string[] = [];
      let resolveOuter: (() => void) | undefined;
      const outerCompleted = new Promise<void>((resolve) => {
        resolveOuter = resolve;
      });
      const { client: base, driver } = baseClient();
      const client = base
        .$extends({
          name: "before-instrumentation",
          observe(unit, proceed) {
            if (unit.kind !== "operation") return;
            timeline.push(`A.in:${trace.getActiveSpan() !== undefined}`);
            return proceed().then(() => {
              timeline.push(
                `A.out:${recorder.find(SPAN_OPERATION) !== undefined}`
              );
              resolveOuter?.();
            });
          },
        })
        .$extends(instrumentation({ tracing: true }))
        .$extends({
          name: "after-instrumentation",
          observe(unit, proceed) {
            if (unit.kind !== "operation") return;
            timeline.push(`B.in:${trace.getActiveSpan() !== undefined}`);
            return proceed().then(() => {
              timeline.push(
                `B.out:${recorder.find(SPAN_OPERATION) !== undefined}`
              );
            });
          },
        });
      driver.events.length = 0;

      await expect(
        client.$queryRaw<{ id: string }>(sql`SELECT 1`)
      ).resolves.toEqual([{ id: "record-1", name: "Ada" }]);
      await outerCompleted;

      expect(timeline).toEqual([
        "A.in:false",
        "B.in:true",
        "B.out:false",
        "A.out:true",
      ]);
      expect(driver.events).toEqual(["provider"]);
      expect(
        recorder.spans().filter(({ name }) => name === SPAN_OPERATION)
      ).toHaveLength(1);
    } finally {
      await recorder.dispose();
    }
  });

  test("keeps child failure primary and presents one selected error log", async () => {
    const officialLogs = captureLogs();
    const timeline: string[] = [];
    const { client: officialBase } = baseClient();
    const officialClient = officialBase
      .$extends({
        name: "outer-error-observer",
        observe(unit, proceed) {
          if (unit.kind !== "operation") return;
          timeline.push("A.in");
          return proceed().then(() => timeline.push("A.out"));
        },
      })
      .$extends(
        instrumentation({
          logging: {
            error(event) {
              timeline.push("I.out");
              officialLogs.callback(event, () => undefined);
            },
          },
        })
      )
      .$extends({
        name: "inner-error-observer",
        observe(unit, proceed) {
          if (unit.kind !== "operation") return;
          timeline.push("B.in");
          return proceed().then(() => timeline.push("B.out"));
        },
      });
    const officialFailure = await officialClient.record
      .findMany({ take: "invalid" as never })
      .catch((failure) => failure);
    await waitFor(() => timeline.includes("A.out"));

    expect(timeline).toEqual(["A.in", "B.in", "B.out", "I.out", "A.out"]);
    expect(officialLogs.events).toHaveLength(1);
    expect(isVibORMError(officialFailure)).toBe(true);
    expect(officialLogs.events[0]).toMatchObject({
      level: "error",
      model: "record",
      operation: "findMany",
    });
    expect(officialLogs.events[0]?.error?.name).toBe("ValidationError");
  });

  test("keeps OrThrow display spans and base-operation error logs", async () => {
    const recorder = withOtelRecorder();
    try {
      const officialLogs = captureLogs();
      const officialBase = createClient({
        schema,
        driver: new EmptyReadOperationDriver(),
      });
      clients.push(officialBase);
      const official = officialBase.$extends(
        instrumentation({
          logging: { error: officialLogs.callback },
          tracing: true,
        })
      );
      const officialFailure = await official.record
        .findUniqueOrThrow({ where: { id: "missing" } })
        .catch((failure) => failure);
      await waitFor(
        () =>
          officialLogs.events.length === 1 &&
          recorder.spans().filter(({ name }) => name === SPAN_OPERATION)
            .length === 1
      );

      expect(isVibORMError(officialFailure)).toBe(true);
      expect(officialLogs.events[0]?.operation).toBe("findUnique");
      expect(
        recorder
          .spans()
          .filter(({ name }) => name === SPAN_OPERATION)
          .map((span) => span.attributes[ATTR_DB_OPERATION_NAME])
      ).toEqual(["findUniqueOrThrow"]);
    } finally {
      await recorder.dispose();
    }
  });

  test("isolates official contexts across sibling clients sharing one driver", async () => {
    const firstLogs = captureLogs();
    const secondLogs = captureLogs();
    const { client: base } = baseClient();
    const first = base.$extends(
      instrumentation({ logging: { error: firstLogs.callback } })
    );
    const second = base.$extends(
      instrumentation({ logging: { error: secondLogs.callback } })
    );

    await first.record
      .findMany({ take: "first" as never })
      .catch(() => undefined);
    expect(firstLogs.events).toHaveLength(1);
    expect(secondLogs.events).toHaveLength(0);

    await second.record
      .findMany({ take: "second" as never })
      .catch(() => undefined);
    expect(firstLogs.events).toHaveLength(1);
    expect(secondLogs.events).toHaveLength(1);
  });

  test("keeps one operation span for cached reads and each array member", async () => {
    const recorder = withOtelRecorder();
    try {
      const cache = new MemoryCache();
      const cachedDriver = new OperationDriver();
      const cachedBase = createClient({
        schema,
        driver: cachedDriver,
      }).$extends(cacheExtension({ driver: cache }));
      clients.push(cachedBase);
      const cached = cachedBase.$extends(instrumentation({ tracing: true }));
      await cached.$withCache({ key: "records" }).record.findMany();

      const fallbackDriver = new OperationDriver();
      const fallbackBase = createClient({ schema, driver: fallbackDriver });
      clients.push(fallbackBase);
      const fallback = fallbackBase.$extends(
        instrumentation({ tracing: true })
      );
      await fallback.$transaction([
        fallback.record.findMany(),
        fallback.$queryRaw<{ id: string }>(sql`SELECT 1`),
      ]);

      const nativeDriver = new NativeOperationDriver();
      const nativeBase = createClient({ schema, driver: nativeDriver });
      clients.push(nativeBase);
      const native = nativeBase.$extends(instrumentation({ tracing: true }));
      await native.$transaction([
        native.record.findMany(),
        native.$queryRaw<{ id: string }>(sql`SELECT 3`),
      ]);

      await waitFor(
        () =>
          recorder.spans().filter(({ name }) => name === SPAN_OPERATION)
            .length === 5
      );

      expect(
        recorder.spans().filter(({ name }) => name === SPAN_OPERATION)
      ).toHaveLength(5);
      expect(fallbackDriver.events).toContain("BEGIN");
      expect(fallbackDriver.events).toContain("COMMIT");
      expect(nativeDriver.events).toContain("batch-provider");
    } finally {
      await recorder.dispose();
    }
  });
});

describe("official array observation readiness", () => {
  test("enters every intercepted native member before admission and pays async prewarm once", async () => {
    const recorder = withOtelRecorder();
    try {
      const timeline: string[] = [];
      const { client: base, driver } = baseClient(new NativeOperationDriver());
      driver.timeline = timeline;
      const official = instrumentation({ tracing: true });
      const client = base.$extends(official).$extends({
        name: "native-readiness",
        request({ operation }) {
          timeline.push(`request:${operation}`);
          return {};
        },
        async query({ operation, proceed }) {
          timeline.push(`query:${operation}`);
          return proceed();
        },
        observe(unit, proceed) {
          if (unit.kind !== "operation") return;
          timeline.push(
            `observer:${unit.operation}:${trace.getActiveSpan() !== undefined}`
          );
          return proceed();
        },
      });
      const first = client.record.findMany();
      const second = client.record.findMany();

      const firstExecution = client.$transaction([first, second]);
      expect(timeline).toEqual([]);
      await firstExecution;

      expect(timeline.slice(0, 2)).toEqual([
        "observer:findMany:true",
        "observer:findMany:true",
      ]);
      expect(timeline.indexOf("request:findMany")).toBeGreaterThan(1);
      expect(timeline.indexOf("query:findMany")).toBeGreaterThan(1);
      expect(timeline.indexOf("provider")).toBeGreaterThan(1);
      expect(timeline.indexOf("query:findMany")).toBeLessThan(
        timeline.indexOf("provider")
      );

      const warmedStart = timeline.length;
      const warmed = client.$transaction([client.record.findMany()]);
      expect(timeline[warmedStart]).toBe("observer:findMany:true");
      await warmed;
    } finally {
      await recorder.dispose();
    }
  });

  test("enters every observe-only native member before provider admission", async () => {
    const recorder = withOtelRecorder();
    try {
      const timeline: string[] = [];
      const { client: base, driver } = baseClient(new NativeOperationDriver());
      driver.timeline = timeline;
      const client = base
        .$extends(instrumentation({ tracing: true }))
        .$extends({
          name: "legacy-native-readiness",
          observe(unit, proceed) {
            if (unit.kind !== "operation") return;
            timeline.push(
              `observer:${unit.operation}:${trace.getActiveSpan() !== undefined}`
            );
            return proceed();
          },
        });
      const first = client.record.findMany();
      const second = client.record.findMany();

      await client.$transaction([first, second]);

      expect(timeline.slice(0, 2)).toEqual([
        "observer:findMany:true",
        "observer:findMany:true",
      ]);
      expect(timeline.indexOf("provider")).toBeGreaterThan(1);
    } finally {
      await recorder.dispose();
    }
  });

  test("enters intercepted fallback members before request and query admission", async () => {
    const recorder = withOtelRecorder();
    try {
      const timeline: string[] = [];
      const { client: base, driver } = baseClient();
      driver.timeline = timeline;
      const client = base
        .$extends(instrumentation({ tracing: true }))
        .$extends({
          name: "fallback-readiness",
          request({ operation }) {
            timeline.push(`request:${operation}`);
            return {};
          },
          async query({ operation, proceed }) {
            timeline.push(`query:${operation}`);
            return proceed();
          },
          observe(unit, proceed) {
            if (unit.kind !== "operation") return;
            timeline.push(
              `observer:${unit.operation}:${trace.getActiveSpan() !== undefined}`
            );
            return proceed();
          },
        });
      const first = client.record.findMany();
      const second = client.record.findMany();

      await client.$transaction([first, second]);

      expect(timeline.slice(0, 2)).toEqual([
        "observer:findMany:true",
        "observer:findMany:true",
      ]);
      expect(timeline.indexOf("request:findMany")).toBeGreaterThan(1);
      expect(timeline.indexOf("query:findMany")).toBeGreaterThan(1);
      expect(timeline.indexOf("BEGIN")).toBeGreaterThan(1);
      expect(timeline.indexOf("provider")).toBeGreaterThan(1);
      expect(timeline.indexOf("query:findMany")).toBeLessThan(
        timeline.indexOf("BEGIN")
      );
      expect(timeline.indexOf("BEGIN")).toBeLessThan(
        timeline.indexOf("provider")
      );
    } finally {
      await recorder.dispose();
    }
  });
});
