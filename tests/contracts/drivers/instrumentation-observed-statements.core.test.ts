/**
 * What the driver layer does DIFFERENTLY once something is observing.
 *
 * Every statement and lifecycle entry point in `DriverInstrumentationBase` has
 * two lanes: an unobserved one that dispatches immediately, and an observed one
 * that hands the provider call to a gate so the trusted observer decides when
 * the physical work starts and what is disclosed about it. The unobserved lane
 * is exercised everywhere; this file pins the observed one, and the four facts
 * that only it can get wrong:
 *
 *  - a statement refused BEFORE dispatch must not be logged as a query,
 *  - disclosure is per policy, not per convenience,
 *  - a batch statement's deferred transform runs inside its own observation,
 *  - the connection lifecycle stays exclusive while it is being observed.
 *
 * All of it runs on recording in-memory drivers and a real in-memory OTel
 * exporter; no provider is involved.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { Driver } from "@drivers/driver";
import { createExecutionContext } from "@drivers/execution-context";
import { runTransactionLifecycle } from "@drivers/shared";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/types";
import { appendResolvedExtension } from "@extensions/chain";
import { getOfficialInstrumentationChainCapability } from "@instrumentation/extension";
import {
  ATTR_DB_QUERY_PARAMETER_PREFIX,
  ATTR_DB_QUERY_TEXT,
  SPAN_CONNECT,
  SPAN_EXECUTE,
} from "@instrumentation/spans";
import { sql } from "@sql";
import {
  type InstrumentationConfig,
  instrumentation,
} from "@src/instrumentation/exports";
import {
  captureLogs,
  type OtelRecorder,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { afterEach, describe, expect, test } from "vitest";

interface FakeSession {
  readonly id: string;
}

/** A promise this test settles by hand, standing in for unfinished work. */
function held() {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  return { promise, settle: () => settle?.() };
}

/**
 * Build the trusted context an official-derived client supplies, optionally
 * with one ordinary extension beside the official one. `statement` proves a
 * deferred transform; `observe` reads the completion the observer is handed.
 */
function observedContext(
  config: InstrumentationConfig,
  values: QueryExecutionContext,
  companion?: object
): QueryExecutionContext {
  let chain = appendResolvedExtension(undefined, instrumentation(config), {});
  if (companion) chain = appendResolvedExtension(chain, companion, {});
  const capability = getOfficialInstrumentationChainCapability(chain);
  if (capability === undefined) {
    throw new Error("Official instrumentation capability was not registered");
  }
  return createExecutionContext(values, capability.context, undefined, chain);
}

interface ObservedOptions {
  readonly serialize?: boolean;
}

class ObservedDriver extends Driver<FakeSession, FakeSession> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();
  readonly statements: string[] = [];
  initCount = 0;
  closeCount = 0;
  initFailure: Error | undefined;
  closeGate: { promise: Promise<void>; settle: () => void } | undefined;
  protected override readonly serializeTransactions: boolean;

  constructor(options: ObservedOptions = {}) {
    super("postgresql", "observed");
    this.serializeTransactions = options.serialize === true;
  }

  protected initClient(): Promise<FakeSession> {
    this.initCount += 1;
    if (this.initFailure) return Promise.reject(this.initFailure);
    return Promise.resolve({ id: `session-${this.initCount}` });
  }

  protected async closeClient(): Promise<void> {
    this.closeCount += 1;
    await this.closeGate?.promise;
  }

  protected execute<T>(
    _client: FakeSession,
    statement: string
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected executeRaw<T>(
    _client: FakeSession,
    statement: string
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    client: FakeSession,
    fn: (tx: FakeSession) => Promise<T>
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => this.executeRaw(client, "BEGIN", undefined),
      callback: () => fn(client),
      commit: () => this.executeRaw(client, "COMMIT", undefined),
      rollback: () => this.executeRaw(client, "ROLLBACK", undefined),
    });
  }
}

/** The same driver with a real atomic batch call the base cannot decompose. */
class NativeBatchDriver extends ObservedDriver {
  override readonly supportsBatch = true;
  readonly submitted: string[][] = [];

  protected override executeBatch<T>(
    _client: FakeSession,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.submitted.push(queries.map((query) => query.sql));
    return Promise.resolve(
      queries.map(() => ({ rows: [], rowCount: 0 }) as QueryResult<T>)
    );
  }
}

const CONNECTION_CLOSING = /Database connection is closing/;

/** Let the observer's span finish; a span ends after the caller is resolved. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("Expected the observed span to be recorded");
}

/** One extension that appends a comment to every statement it is given. */
const taggingExtension = {
  name: "statement-tagger",
  statement: ({ statement }: { statement: unknown }) =>
    sql`${statement} /* tagged */`,
};

describe("observed statement disclosure", () => {
  test("logs one query event per observed statement, per the logging policy", async () => {
    const logs = captureLogs();
    const driver = new ObservedDriver();
    const context = observedContext(
      {
        logging: {
          error: logs.callback,
          includeParams: true,
          includeSql: true,
          query: logs.callback,
        },
      },
      { correlationId: "observed-1", model: "entry", operation: "findMany" }
    );

    await driver._execute(sql`SELECT ${7}`, context);

    expect(driver.statements).toEqual(["SELECT $1"]);
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      correlationId: "observed-1",
      level: "query",
      model: "entry",
      operation: "findMany",
      params: [7],
      sql: "SELECT $1",
    });
  });

  test("withholds SQL and parameters the logging policy does not disclose", async () => {
    const logs = captureLogs();
    const driver = new ObservedDriver();
    const context = observedContext(
      { logging: { query: logs.callback } },
      { model: "entry", operation: "findMany" }
    );

    await driver._execute(sql`SELECT ${"secret"}`, context);

    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]?.sql).toBeUndefined();
    expect(logs.events[0]?.params).toBeUndefined();
    expect(JSON.stringify(logs.events)).not.toContain("secret");
  });

  test("logs nothing for a statement refused before it reached the provider", async () => {
    const logs = captureLogs();
    const driver = new ObservedDriver();
    const context = observedContext(
      {
        logging: {
          error: logs.callback,
          includeParams: true,
          includeSql: true,
          query: logs.callback,
        },
      },
      { model: "$raw", operation: "$executeRaw" }
    );

    await expect(
      driver._executeRaw("SELECT $1", [new Date(Number.NaN)], context)
    ).rejects.toMatchObject({ code: "V4002" });
    // Nothing was dispatched, so there is no query to report and no provider
    // failure to attribute: an admission refusal is not a statement event.
    expect(driver.statements).toEqual([]);
    expect(logs.events).toEqual([]);
  });

  test("reports a provider failure as one error event", async () => {
    const logs = captureLogs();
    class FailingDriver extends ObservedDriver {
      protected override execute<T>(): Promise<QueryResult<T>> {
        return Promise.reject(new Error("relation does not exist"));
      }
    }
    const driver = new FailingDriver();
    const context = observedContext(
      { logging: { error: logs.callback, includeSql: true } },
      { model: "entry", operation: "findMany" }
    );

    await expect(driver._execute(sql`SELECT ${1}`, context)).rejects.toThrow();
    expect(logs.events).toHaveLength(1);
    expect(logs.events[0]).toMatchObject({
      level: "error",
      model: "entry",
      operation: "findMany",
      sql: "SELECT $1",
    });
  });

  test("emits no gate at all when nothing the official chain owns is enabled", async () => {
    const driver = new ObservedDriver();
    // `logging: {}` still declares the official observer, but no level handler
    // is installed and tracing is off: there is nothing for a gate to carry.
    const context = observedContext(
      { logging: { includeSql: true } },
      { model: "entry", operation: "findMany" }
    );

    await expect(
      driver._execute(sql`SELECT ${1}`, context)
    ).resolves.toMatchObject({ rowCount: 0 });
    expect(driver.statements).toEqual(["SELECT $1"]);
  });
});

describe("observed statement tracing", () => {
  let recorder: OtelRecorder | undefined;

  afterEach(async () => {
    await recorder?.dispose();
    recorder = undefined;
  });

  test("discloses SQL and parameters on the execute span exactly as configured", async () => {
    recorder = withOtelRecorder();
    const driver = new ObservedDriver();
    const context = observedContext(
      { tracing: { includeParams: true, includeSql: true } },
      { correlationId: "traced-1", model: "entry", operation: "findMany" }
    );

    await driver._execute(sql`SELECT ${42}`, context);
    const traced = recorder;
    await waitFor(() => traced.find(SPAN_EXECUTE) !== undefined);

    const span = traced.find(SPAN_EXECUTE);
    expect(span?.attributes[ATTR_DB_QUERY_TEXT]).toBe("SELECT $1");
    expect(span?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]).toBe("42");
  });

  test("keeps SQL and parameters off the span when tracing discloses neither", async () => {
    recorder = withOtelRecorder();
    const driver = new ObservedDriver();
    const context = observedContext(
      { tracing: true },
      { model: "entry", operation: "findMany" }
    );

    await driver._execute(sql`SELECT ${"secret"}`, context);
    const traced = recorder;
    await waitFor(() => traced.find(SPAN_EXECUTE) !== undefined);

    const span = traced.find(SPAN_EXECUTE);
    expect(span).toBeDefined();
    expect(span?.attributes[ATTR_DB_QUERY_TEXT]).toBeUndefined();
    expect(
      span?.attributes[`${ATTR_DB_QUERY_PARAMETER_PREFIX}.0`]
    ).toBeUndefined();
  });

  test("spans the observed connection lifecycle without losing the client", async () => {
    recorder = withOtelRecorder();
    const driver = new ObservedDriver();
    const context = observedContext(
      { tracing: true },
      { operation: "connect" }
    );

    await driver._connect(context);
    await driver._execute(sql`SELECT ${1}`, context);
    const traced = recorder;
    await waitFor(() => traced.find(SPAN_CONNECT) !== undefined);

    expect(driver.initCount).toBe(1);
    expect(traced.find(SPAN_CONNECT)).toBeDefined();
  });
});

describe("observed batch statements", () => {
  test("applies a deferred transform per statement of a native batch", async () => {
    const logs = captureLogs();
    const driver = new NativeBatchDriver();
    const context = observedContext(
      {
        logging: { includeSql: true, query: logs.callback },
      },
      { model: "entry", operation: "createMany" },
      taggingExtension
    );
    const first = driver._prepare(
      sql`INSERT INTO entry VALUES (${1})`,
      context
    );
    const second = driver._prepare(
      sql`INSERT INTO entry VALUES (${2})`,
      context
    );

    await driver._executeBatch([first, second], undefined, context);

    // `_prepare` handed the planner an untransformed statement; the transform
    // was deferred until each statement had its own observation.
    expect(first.sql).toBe("INSERT INTO entry VALUES ($1)");
    expect(driver.submitted).toEqual([
      [
        "INSERT INTO entry VALUES ($1) /* tagged */",
        "INSERT INTO entry VALUES ($1) /* tagged */",
      ],
    ]);
  });

  test("applies a deferred transform per statement of a sequential batch", async () => {
    const driver = new ObservedDriver();
    const context = observedContext(
      { logging: { includeSql: true, query: () => undefined } },
      { model: "entry", operation: "createMany" },
      taggingExtension
    );
    const first = driver._prepare(
      sql`INSERT INTO entry VALUES (${1})`,
      context
    );
    const second = driver._prepare(
      sql`INSERT INTO entry VALUES (${2})`,
      context
    );

    await driver._executeBatch([first, second], undefined, context);

    expect(driver.statements).toEqual([
      "BEGIN",
      "INSERT INTO entry VALUES ($1) /* tagged */",
      "INSERT INTO entry VALUES ($1) /* tagged */",
      "COMMIT",
    ]);
  });

  test("leaves a statement with no typed provenance exactly as submitted", async () => {
    const driver = new NativeBatchDriver();
    const context = observedContext(
      { logging: { includeSql: true, query: () => undefined } },
      { model: "entry", operation: "createMany" },
      taggingExtension
    );

    await driver._executeBatch(
      [{ sql: "INSERT INTO entry DEFAULT VALUES" }],
      undefined,
      context
    );

    expect(driver.submitted).toEqual([["INSERT INTO entry DEFAULT VALUES"]]);
  });
});

describe("observed connection exclusivity", () => {
  test.each([
    { label: "a pooled driver", serialize: false },
    { label: "a single-connection driver", serialize: true },
  ])("connects and disconnects once on $label", async ({ serialize }) => {
    const driver = new ObservedDriver({ serialize });
    const context = observedContext({ tracing: true }, {});

    await driver._connect(context);
    await driver._disconnect(context);
    await driver._connect(context);

    expect(driver.initCount).toBe(2);
    expect(driver.closeCount).toBe(1);
  });

  test("refuses a second disconnect and every statement while one is closing", async () => {
    const driver = new ObservedDriver();
    const gate = held();
    driver.closeGate = gate;
    await driver._connect();

    const closing = driver._disconnect();

    await expect(driver._disconnect()).rejects.toThrow(CONNECTION_CLOSING);
    await expect(driver._execute(sql`SELECT ${1}`)).rejects.toThrow(
      CONNECTION_CLOSING
    );
    gate.settle();
    await closing;
    expect(driver.closeCount).toBe(1);
  });

  test("disconnects cleanly after the connection attempt itself failed", async () => {
    const driver = new ObservedDriver();
    driver.initFailure = new Error("ECONNREFUSED");

    await expect(driver._connect()).rejects.toThrow();
    // The failed init promise is drained, not rethrown: there is no transport
    // to close, and a disconnect must not resurface the connect failure.
    await expect(driver._disconnect()).resolves.toBeUndefined();
    expect(driver.closeCount).toBe(0);
  });
});
