import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { QueryError } from "@errors";
import {
  ATTR_DB_QUERY_PARAMETER_PREFIX,
  ATTR_DB_QUERY_TEXT,
  ATTR_VIBORM_CORRELATION_ID,
  SPAN_EXECUTE,
} from "@instrumentation/spans";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Sql } from "@sql";
import { createClient, defineExtension, s, sql } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import {
  captureLogs,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({ id: s.string().id(), name: s.string() });
const batchRow = s.model({
  id: s.int().id().increment(),
  code: s.string().unique(),
  label: s.string(),
});
const schema = { batchRow, record };

interface ProviderCall {
  readonly activeSpan: unknown;
  readonly activeSpanId: string | undefined;
  readonly params: readonly unknown[];
  readonly sql: string;
}

class StatementDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly providerCalls: ProviderCall[] = [];
  readonly transactionEvents: string[] = [];
  failAtProviderCall: number | undefined;
  beforeProviderResult:
    | ((callNumber: number, params: readonly unknown[]) => void | Promise<void>)
    | undefined;
  timeline: string[] | undefined;

  constructor(initialize = true) {
    super("sqlite", "official-statement-test");
    if (initialize) this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource.
  }

  protected async execute<T>(
    _client: object,
    statement: string,
    params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.timeline?.push("provider");
    this.providerCalls.push({
      activeSpan: activeSpanName(),
      activeSpanId: activeSpanId(),
      params,
      sql: statement,
    });
    const callNumber = this.providerCalls.length;
    await this.beforeProviderResult?.(callNumber, params);
    if (callNumber === this.failAtProviderCall) {
      throw new Error("fallback provider failed");
    }
    return {
      rows: [{ id: "record-1", name: "Ada" }] as T[],
      rowCount: 1,
    };
  }

  protected executeRaw<T>(
    client: object,
    statement: string,
    params: unknown[] = [],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute(client, statement, params, context);
  }

  protected async transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    this.transactionEvents.push("BEGIN");
    try {
      const value = await callback(client);
      this.transactionEvents.push("COMMIT");
      return value;
    } catch (error) {
      this.transactionEvents.push("ROLLBACK");
      throw error;
    }
  }
}

class FailingInitializationDriver extends StatementDriver {
  constructor() {
    super(false);
  }

  protected override async initClient(): Promise<object> {
    throw new Error("initialization failed");
  }
}

class NativeStatementDriver extends StatementDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  failBatchIndex: number | undefined;

  protected override async transaction<T>(): Promise<T> {
    throw new Error("Native fixture has no callback transaction");
  }

  protected override async executeBatch<T>(
    _client: object,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.providerCalls.push({
      activeSpan: activeSpanName(),
      activeSpanId: activeSpanId(),
      params: queries.map((query) => query.params ?? []),
      sql: queries.map((query) => query.sql).join("; "),
    });
    if (this.failBatchIndex !== undefined) {
      const context = queries[this.failBatchIndex]?.context;
      throw new QueryError("native member failed", {
        meta: {
          model: context?.model,
          operation: context?.operation,
          correlationId: context?.correlationId,
        },
      });
    }
    return queries.map(() => ({
      rows: [{ id: "record-native", name: "Native" }] as T[],
      rowCount: 1,
    }));
  }
}

class ThrowingRenderSql extends Sql {
  override toStatement(): string {
    throw new Error("render failed");
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function activeSpanName(): unknown {
  const span = trace.getActiveSpan();
  return span === undefined ? undefined : Reflect.get(span, "name");
}

function activeSpanId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().spanId;
}

function trackedClient(driver: StatementDriver) {
  const client = createClient({ schema, driver });
  clients.push(client);
  return client;
}

function createDeferredSignal(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve() {
      settle?.();
    },
  };
}

class OpaqueProviderParameter {
  value: string;

  constructor(value: string) {
    this.value = value;
  }
}

function createHostileParameter(value: string): {
  readonly parameter: OpaqueProviderParameter;
  readonly reads: () => number;
} {
  let reads = 0;
  const parameter = new Proxy(new OpaqueProviderParameter(value), {
    ownKeys(target) {
      reads += 1;
      return Reflect.ownKeys(target);
    },
  });
  return { parameter, reads: () => reads };
}

function mutateFirstParameter(params: readonly unknown[]): void {
  const parameter = params[0];
  if (typeof parameter === "object" && parameter !== null) {
    Reflect.set(parameter, "value", "provider-mutated");
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("Expected statement instrumentation to settle");
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("official statement instrumentation", () => {
  test("snapshots hostile parameters once only for an active disclosure channel", async () => {
    const recorder = withOtelRecorder();
    try {
      const inactiveExtensions = [
        undefined,
        instrumentation({}),
        instrumentation({ logging: { cache: true } }),
        instrumentation({
          tracing: {
            ignoreSpanTypes: [SPAN_EXECUTE],
            includeParams: true,
          },
        }),
      ];

      for (const extension of inactiveExtensions) {
        const driver = new StatementDriver();
        const hostile = createHostileParameter("inactive-secret");
        driver.beforeProviderResult = (_callNumber, params) => {
          mutateFirstParameter(params);
        };
        const base = trackedClient(driver);
        const client =
          extension === undefined ? base : base.$extends(extension);
        await client.$queryRaw(sql`SELECT ${hostile.parameter}`);
        expect(hostile.reads()).toBe(0);
        expect(hostile.parameter.value).toBe("provider-mutated");
        expect(driver.providerCalls[0]?.params[0]).toBe(hostile.parameter);
      }

      const diagnosticDriver = new StatementDriver();
      const diagnosticParameter = createHostileParameter("diagnostic-before");
      diagnosticDriver.failAtProviderCall = 1;
      diagnosticDriver.beforeProviderResult = (_callNumber, params) => {
        mutateFirstParameter(params);
      };
      const diagnosticFailure = await trackedClient(diagnosticDriver)
        .$extends(instrumentation({ diagnostics: { includeParams: true } }))
        .$queryRaw(sql`SELECT ${diagnosticParameter.parameter}`)
        .catch((error) => error);
      expect(diagnosticParameter.reads()).toBe(1);
      expect(diagnosticFailure).toMatchObject({
        meta: { params: [{ value: "diagnostic-before" }] },
      });

      const logs = captureLogs();
      const loggingDriver = new StatementDriver();
      const loggingParameter = createHostileParameter("logging-before");
      loggingDriver.beforeProviderResult = (_callNumber, params) => {
        mutateFirstParameter(params);
      };
      await trackedClient(loggingDriver)
        .$extends(
          instrumentation({
            logging: { includeParams: true, query: logs.callback },
          })
        )
        .$queryRaw(sql`SELECT ${loggingParameter.parameter}`);
      await waitFor(() => logs.events.length === 1);
      expect(loggingParameter.reads()).toBe(1);
      expect(logs.events[0]?.params).toEqual([{ value: "logging-before" }]);

      const tracingDriver = new StatementDriver();
      const tracingParameter = createHostileParameter("tracing-before");
      tracingDriver.beforeProviderResult = (_callNumber, params) => {
        mutateFirstParameter(params);
      };
      await trackedClient(tracingDriver)
        .$extends(instrumentation({ tracing: { includeParams: true } }))
        .$queryRaw(sql`SELECT ${tracingParameter.parameter}`);
      expect(tracingParameter.reads()).toBe(1);
      const executeSpans = recorder
        .spans()
        .filter(({ name }) => name === SPAN_EXECUTE);
      expect(executeSpans).toHaveLength(1);
      expect(
        executeSpans[0]?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]
      ).toBe('{"value":"tracing-before"}');

      const combinedLogs = captureLogs();
      const combinedDriver = new StatementDriver();
      const combinedParameter = createHostileParameter("combined-before");
      combinedDriver.failAtProviderCall = 1;
      combinedDriver.beforeProviderResult = (_callNumber, params) => {
        mutateFirstParameter(params);
      };
      const combinedFailure = await trackedClient(combinedDriver)
        .$extends(
          instrumentation({
            diagnostics: { includeParams: true },
            logging: {
              error: combinedLogs.callback,
              includeParams: true,
            },
            tracing: { includeParams: true },
          })
        )
        .$queryRaw(sql`SELECT ${combinedParameter.parameter}`)
        .catch((error) => error);
      await waitFor(() => combinedLogs.events.length === 1);

      const expectedCombinedParams = [{ value: "combined-before" }];
      const combinedCorrelation = combinedLogs.events[0]?.correlationId;
      expect(combinedParameter.reads()).toBe(1);
      expect(combinedFailure).toBeInstanceOf(QueryError);
      expect(combinedFailure).toMatchObject({
        meta: {
          correlationId: combinedCorrelation,
          params: expectedCombinedParams,
        },
      });
      expect(combinedLogs.events[0]).toMatchObject({
        correlationId: combinedCorrelation,
        params: expectedCombinedParams,
      });
      expect(combinedCorrelation).toEqual(expect.any(String));
      const combinedSpan = recorder
        .spans()
        .find(
          ({ attributes, name }) =>
            name === SPAN_EXECUTE &&
            attributes[ATTR_VIBORM_CORRELATION_ID] === combinedCorrelation
        );
      expect(
        combinedSpan?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]
      ).toBe('{"value":"combined-before"}');
    } finally {
      await recorder.dispose();
    }
  });

  test("isolates overlapping sibling statement telemetry on one driver", async () => {
    const recorder = withOtelRecorder();
    try {
      const firstGate = createDeferredSignal();
      const secondGate = createDeferredSignal();
      const firstStarted = createDeferredSignal();
      const secondStarted = createDeferredSignal();
      const driver = new StatementDriver();
      driver.failAtProviderCall = 2;
      driver.beforeProviderResult = (callNumber) => {
        if (callNumber === 1) {
          firstStarted.resolve();
          return firstGate.promise;
        }
        secondStarted.resolve();
        return secondGate.promise;
      };
      const firstLogs = captureLogs();
      const secondLogs = captureLogs();
      const base = trackedClient(driver);
      const first = base.$extends(
        instrumentation({
          logging: {
            includeSql: true,
            query: firstLogs.callback,
          },
          tracing: true,
        })
      );
      const second = base.$extends(
        instrumentation({
          logging: {
            error: secondLogs.callback,
            includeParams: true,
            includeSql: true,
          },
          tracing: { includeParams: true },
        })
      );
      const firstSecret = "first-sibling-secret";
      const secondSecret = "second-sibling-secret";

      const firstResult = first
        .$queryRaw(sql`SELECT ${firstSecret}`)
        .then((value) => value);
      await firstStarted.promise;
      const secondResult = second
        .$queryRaw(sql`SELECT ${secondSecret}`)
        .catch((error) => error);
      await secondStarted.promise;
      expect(driver.providerCalls.map(({ activeSpan }) => activeSpan)).toEqual([
        SPAN_EXECUTE,
        SPAN_EXECUTE,
      ]);
      firstGate.resolve();
      secondGate.resolve();

      await expect(firstResult).resolves.toEqual([
        { id: "record-1", name: "Ada" },
      ]);
      await expect(secondResult).resolves.toBeInstanceOf(QueryError);
      await waitFor(
        () => firstLogs.events.length === 1 && secondLogs.events.length === 1
      );

      const firstCorrelation = firstLogs.events[0]?.correlationId;
      const secondCorrelation = secondLogs.events[0]?.correlationId;
      expect(firstCorrelation).toEqual(expect.any(String));
      expect(secondCorrelation).toEqual(expect.any(String));
      expect(secondCorrelation).not.toBe(firstCorrelation);
      expect(firstLogs.events[0]).toMatchObject({
        level: "query",
        operation: "$queryRaw",
      });
      expect(firstLogs.events[0]?.params).toBeUndefined();
      expect(secondLogs.events[0]).toMatchObject({
        level: "error",
        operation: "$queryRaw",
        params: [secondSecret],
      });
      expect(JSON.stringify(firstLogs.events)).not.toContain(secondSecret);
      expect(JSON.stringify(secondLogs.events)).not.toContain(firstSecret);

      const firstSpan = recorder
        .spans()
        .find(
          ({ attributes, name }) =>
            name === SPAN_EXECUTE &&
            attributes[ATTR_VIBORM_CORRELATION_ID] === firstCorrelation
        );
      const secondSpan = recorder
        .spans()
        .find(
          ({ attributes, name }) =>
            name === SPAN_EXECUTE &&
            attributes[ATTR_VIBORM_CORRELATION_ID] === secondCorrelation
        );
      expect(firstSpan?.status.code).toBe(SpanStatusCode.OK);
      expect(
        firstSpan?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]
      ).toBeUndefined();
      expect(secondSpan?.status.code).toBe(SpanStatusCode.ERROR);
      expect(
        secondSpan?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]
      ).toBe(secondSecret);
      expect(secondSpan?.events.map(({ name }) => name)).toContain("exception");
      expect(driver.providerCalls[0]?.activeSpanId).toBe(
        firstSpan?.spanContext().spanId
      );
      expect(driver.providerCalls[1]?.activeSpanId).toBe(
        secondSpan?.spanContext().spanId
      );
      expect(driver.providerCalls[0]?.activeSpanId).not.toBe(
        driver.providerCalls[1]?.activeSpanId
      );
    } finally {
      await recorder.dispose();
    }
  });

  test("presents the exact transformed statement once", async () => {
    const recorder = withOtelRecorder();
    try {
      const officialLogs = captureLogs();
      const officialDriver = new StatementDriver();
      const official = trackedClient(officialDriver)
        .$extends(
          instrumentation({
            logging: {
              error: officialLogs.callback,
              includeParams: true,
              includeSql: true,
              query: officialLogs.callback,
            },
            tracing: { includeParams: true, includeSql: true },
          })
        )
        .$extends({
          name: "official-parity-transform",
          statement({ statement }) {
            return sql`${sql.raw("/* parity */ ")}${statement}`;
          },
        });
      await official.$queryRaw(sql`SELECT ${7}`);
      await waitFor(() => officialLogs.events.length === 1);

      expect(officialDriver.providerCalls).toHaveLength(1);
      expect(officialDriver.providerCalls[0]).toMatchObject({
        params: [7],
        sql: "/* parity */ SELECT ?",
      });
      expect(officialLogs.events[0]).toMatchObject({
        level: "query",
        model: "$raw",
        operation: "$queryRaw",
        params: [7],
        sql: "/* parity */ SELECT ?",
      });
      const executeSpans = recorder
        .spans()
        .filter(({ name }) => name === SPAN_EXECUTE);
      expect(executeSpans).toHaveLength(1);
      expect({
        params:
          executeSpans[0]?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`],
        sql: executeSpans[0]?.attributes[ATTR_DB_QUERY_TEXT],
      }).toEqual({
        params: "7",
        sql: "/* parity */ SELECT ?",
      });
    } finally {
      await recorder.dispose();
    }
  });

  test("enters observers before transform and starts the provider in the exact disclosed span", async () => {
    const recorder = withOtelRecorder();
    try {
      const logs = captureLogs();
      const timeline: string[] = [];
      const driver = new StatementDriver();
      driver.timeline = timeline;
      const hostile = createHostileParameter("private");
      const parameter = hostile.parameter;
      const client = trackedClient(driver)
        .$extends({
          name: "statement-before",
          observe(unit, proceed) {
            if (unit.kind !== "statement") return;
            timeline.push(`A.in:${String(activeSpanName())}`);
            return proceed().then(() => timeline.push("A.out"));
          },
        })
        .$extends(
          instrumentation({
            logging: {
              includeSql: true,
              query(event) {
                timeline.push("query-log");
                logs.callback(event, () => undefined);
              },
            },
            tracing: { includeParams: true },
          })
        )
        .$extends({
          name: "statement-after",
          observe(unit, proceed) {
            if (unit.kind !== "statement") return;
            timeline.push(`B.in:${String(activeSpanName())}`);
            return proceed().then(() => timeline.push("B.out"));
          },
        })
        .$extends({
          name: "statement-transform",
          statement({ statement }) {
            timeline.push(`transform:${String(activeSpanName())}`);
            return sql`${sql.raw("/* transformed */ ")}${statement}`;
          },
        });

      await client.$queryRaw(sql`SELECT ${parameter}`);
      await waitFor(() => timeline.includes("A.out"));

      const executeSpans = recorder
        .spans()
        .filter(({ name }) => name === SPAN_EXECUTE);
      expect(timeline.slice(0, 4)).toEqual([
        "A.in:viborm.operation",
        "B.in:viborm.operation",
        "transform:viborm.operation",
        "provider",
      ]);
      expect(timeline.indexOf("B.out")).toBeLessThan(
        timeline.indexOf("query-log")
      );
      expect(timeline.indexOf("query-log")).toBeLessThan(
        timeline.indexOf("A.out")
      );
      expect(driver.providerCalls).toHaveLength(1);
      expect(driver.providerCalls[0]).toMatchObject({
        activeSpan: SPAN_EXECUTE,
        sql: "/* transformed */ SELECT ?",
      });
      expect(driver.providerCalls[0]?.params[0]).toBe(parameter);
      expect(executeSpans).toHaveLength(1);
      expect(executeSpans[0]?.attributes[ATTR_DB_QUERY_TEXT]).toBeUndefined();
      expect(
        executeSpans[0]?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]
      ).toBeDefined();
      expect(logs.events).toHaveLength(1);
      expect(logs.events[0]).toMatchObject({
        level: "query",
        operation: "$queryRaw",
        sql: "/* transformed */ SELECT ?",
      });
      expect(logs.events[0]?.params).toBeUndefined();
      expect(hostile.reads()).toBe(1);
    } finally {
      await recorder.dispose();
    }
  });

  test("keeps verbatim raw observed and presented but outside statement transforms", async () => {
    const recorder = withOtelRecorder();
    try {
      const logs = captureLogs();
      const driver = new StatementDriver();
      let transforms = 0;
      let statementUnits = 0;
      const client = trackedClient(driver)
        .$extends(
          instrumentation({
            logging: {
              query: logs.callback,
              warning: logs.callback,
            },
            tracing: true,
          })
        )
        .$extends({
          name: "unsafe-observer",
          observe(unit, proceed) {
            if (unit.kind !== "statement") return;
            statementUnits += 1;
            return proceed();
          },
          statement({ statement }) {
            transforms += 1;
            return statement;
          },
        });

      await client.$queryRawUnsafe("SELECT 1");
      await client.$queryRawUnsafe("SELECT 2");
      await waitFor(() => logs.events.length === 2);

      expect(transforms).toBe(0);
      expect(statementUnits).toBe(2);
      expect(driver.providerCalls).toHaveLength(2);
      expect(
        recorder.spans().filter(({ name }) => name === SPAN_EXECUTE)
      ).toHaveLength(2);
      expect(logs.events.map(({ level }) => level).sort()).toEqual([
        "query",
        "query",
      ]);
    } finally {
      await recorder.dispose();
    }
  });

  test("keeps callback and fallback statements on one official presentation each", async () => {
    const recorder = withOtelRecorder();
    try {
      const logs = captureLogs();
      const driver = new StatementDriver();
      let statementUnits = 0;
      const client = trackedClient(driver)
        .$extends(
          instrumentation({
            logging: { query: logs.callback },
            tracing: true,
          })
        )
        .$extends({
          name: "transaction-statement-count",
          observe(unit, proceed) {
            if (unit.kind !== "statement") return;
            statementUnits += 1;
            return proceed();
          },
        });

      await client.$transaction((transaction) => transaction.record.findMany());
      await client.$transaction([
        client.record.findMany(),
        client.$queryRaw(sql`SELECT 2`),
      ]);
      await waitFor(() => logs.events.length === 3);

      expect(statementUnits).toBe(3);
      expect(driver.providerCalls).toHaveLength(3);
      expect(driver.transactionEvents).toEqual([
        "BEGIN",
        "COMMIT",
        "BEGIN",
        "COMMIT",
      ]);
      expect(
        recorder.spans().filter(({ name }) => name === SPAN_EXECUTE)
      ).toHaveLength(3);
      expect(logs.events).toHaveLength(3);
    } finally {
      await recorder.dispose();
    }
  });

  test("keeps N native statement units but one provider span and query log", async () => {
    const recorder = withOtelRecorder();
    try {
      const logs = captureLogs();
      const driver = new NativeStatementDriver();
      let statementUnits = 0;
      let transforms = 0;
      const client = trackedClient(driver)
        .$extends(
          instrumentation({
            logging: {
              includeSql: true,
              query: logs.callback,
            },
            tracing: { includeSql: true },
          })
        )
        .$extends({
          name: "native-statement-count",
          observe(unit, proceed) {
            if (unit.kind !== "statement") return;
            statementUnits += 1;
            return proceed();
          },
          statement({ statement }) {
            transforms += 1;
            return sql`${sql.raw(`/* ${transforms} */ `)}${statement}`;
          },
        });

      await client.$transaction([
        client.$queryRaw(sql`SELECT ${1}`),
        client.$queryRaw(sql`SELECT ${2}`),
      ]);
      await waitFor(() => logs.events.length === 1);

      expect(statementUnits).toBe(2);
      expect(transforms).toBe(2);
      expect(driver.providerCalls).toHaveLength(1);
      expect(driver.providerCalls[0]).toMatchObject({
        activeSpan: SPAN_EXECUTE,
        sql: "/* 1 */ SELECT ?; /* 2 */ SELECT ?",
      });
      const executeSpans = recorder
        .spans()
        .filter(({ name }) => name === SPAN_EXECUTE);
      expect(executeSpans).toHaveLength(1);
      expect(executeSpans[0]?.attributes[ATTR_DB_QUERY_TEXT]).toBe(
        "/* 1 */ SELECT ?; /* 2 */ SELECT ?"
      );
      expect(logs.events).toHaveLength(1);
      expect(logs.events[0]?.sql).toBe("/* 1 */ SELECT ?; /* 2 */ SELECT ?");
    } finally {
      await recorder.dispose();
    }
  });

  test("logs a direct multi-statement fallback failure once after normalization", async () => {
    const logs = captureLogs();
    const driver = new StatementDriver();
    driver.failAtProviderCall = 2;
    const client = trackedClient(driver).$extends(
      instrumentation({ logging: { error: logs.callback } })
    );

    await expect(
      client.batchRow.createMany({
        data: [
          { code: "generated", label: "first" },
          { id: 50, code: "explicit", label: "second" },
        ],
      })
    ).rejects.toBeInstanceOf(QueryError);
    await waitFor(() => logs.events.length > 0);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(driver.providerCalls).toHaveLength(2);
    expect(driver.transactionEvents).toEqual(["BEGIN", "ROLLBACK"]);
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      level: "error",
      model: "batchRow",
      operation: "createMany",
    });
  });

  test("attributes one native provider failure to its exact member and logs it once", async () => {
    const logs = captureLogs();
    const driver = new NativeStatementDriver();
    driver.failBatchIndex = 1;
    const client = trackedClient(driver)
      .$extends(
        instrumentation({
          logging: { error: logs.callback, includeSql: true },
        })
      )
      .$extends({
        name: "intercepted-native-error-dedup",
        async query({ proceed }) {
          return proceed();
        },
      });

    await expect(
      client.$transaction([
        client.record.findMany(),
        client.$queryRaw(sql`SELECT ${2}`),
      ])
    ).rejects.toBeInstanceOf(QueryError);
    await waitFor(() => logs.events.length > 0);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      level: "error",
      operation: "$queryRaw",
    });
    expect(logs.events[0]?.model).toBe("$raw");
    expect(logs.events[0]?.sql).toBe("SELECT ?");
  });

  test("skips execute presentation when transform, render, or acquisition fails", async () => {
    const logs = captureLogs();
    let completions = 0;
    const observeSettlement = defineExtension<typeof schema>()({
      name: "pre-gate-settlement",
      observe(unit, proceed) {
        if (unit.kind !== "statement") return;
        return proceed().then(() => {
          completions += 1;
        });
      },
    });
    const cases = [
      {
        client(driver: StatementDriver) {
          return trackedClient(driver)
            .$extends(observeSettlement)
            .$extends(
              instrumentation({
                logging: { query: logs.callback },
                tracing: true,
              })
            )
            .$extends({
              name: "throwing-transform",
              statement() {
                throw new Error("transform failed");
              },
            });
        },
        driver: new StatementDriver(),
      },
      {
        client(driver: StatementDriver) {
          return trackedClient(driver)
            .$extends(observeSettlement)
            .$extends(
              instrumentation({
                logging: { query: logs.callback },
                tracing: true,
              })
            )
            .$extends({
              name: "throwing-render",
              statement() {
                return new ThrowingRenderSql(["SELECT 1"], []);
              },
            });
        },
        driver: new StatementDriver(),
      },
      {
        client(driver: StatementDriver) {
          return trackedClient(driver)
            .$extends(observeSettlement)
            .$extends(
              instrumentation({
                logging: { query: logs.callback },
                tracing: true,
              })
            );
        },
        driver: new FailingInitializationDriver(),
      },
    ];

    for (let index = 0; index < cases.length; index += 1) {
      const testCase = cases[index]!;
      const recorder = withOtelRecorder();
      try {
        await expect(
          testCase.client(testCase.driver).record.findMany()
        ).rejects.toBeInstanceOf(Error);
        await waitFor(() => completions === index + 1);
        expect(testCase.driver.providerCalls).toHaveLength(0);
        expect(logs.events).toHaveLength(0);
        expect(
          recorder.spans().filter(({ name }) => name === SPAN_EXECUTE)
        ).toHaveLength(0);
      } finally {
        await recorder.dispose();
      }
    }
  });

  test("skips the shared native presentation when later materialization fails", async () => {
    const recorder = withOtelRecorder();
    try {
      const logs = captureLogs();
      const driver = new NativeStatementDriver();
      let transforms = 0;
      let completed = false;
      const client = trackedClient(driver)
        .$extends({
          name: "native-gate-settlement",
          observe(unit, proceed) {
            if (unit.kind !== "statement") return;
            return proceed().then(() => {
              completed = true;
            });
          },
        })
        .$extends(
          instrumentation({
            logging: { query: logs.callback },
            tracing: true,
          })
        )
        .$extends({
          name: "native-prepare-failure",
          statement({ statement }) {
            transforms += 1;
            if (transforms === 2) throw new Error("second transform failed");
            return statement;
          },
        });

      await expect(
        client.$transaction([
          client.$queryRaw(sql`SELECT 1`),
          client.$queryRaw(sql`SELECT 2`),
        ])
      ).rejects.toBeInstanceOf(Error);
      await waitFor(() => completed);

      expect(transforms).toBe(2);
      expect(driver.providerCalls).toHaveLength(0);
      expect(logs.events).toHaveLength(0);
      expect(
        recorder.spans().filter(({ name }) => name === SPAN_EXECUTE)
      ).toHaveLength(0);
    } finally {
      await recorder.dispose();
    }
  });
});
