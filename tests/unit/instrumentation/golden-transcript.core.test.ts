/**
 * The instrumentation golden transcript.
 *
 * `docs/architecture/instrumentation-encapsulation-plan.md` moves every
 * presentation decision (span names, attributes, log events, disclosure per
 * channel) out of core and into the official extension without changing what
 * an installed extension presents. This file is the witness of "without
 * changing": it re-runs the setups of the named official instrumentation
 * contracts through a real `NodeTracerProvider` and records, per scenario,
 *
 *  - every finished span: name, kind, attributes, status, events, parent link;
 *  - every log event, in emission order, with its level;
 *  - the thrown error's JSON (under each `diagnostics` setting where the
 *    scenario varies it);
 *  - the units and completions an ordinary observer receives.
 *
 * The committed `__golden__/transcript.json` was written once from the source
 * the plan was measured at and is never regenerated while the plan runs: a
 * difference is a behaviour change the plan did not authorize.
 *
 * Normalization. Trace, span and parent ids become ordinals by first
 * appearance in export order (`external` for a parent the recorder never saw),
 * correlation ids (UUIDs) become ordinals by first appearance, and span
 * start/end times are dropped because OTel reads a high-resolution clock fake
 * timers do not govern. Only `Date` is faked, so log `timestamp`/`duration`,
 * error timestamps and completion `durationMs` are recorded exactly. Object
 * keys are sorted; `undefined` members are absent, as in JSON.
 *
 * The real-clock cell runs outside fake timers: it pins that a query log's
 * `duration` and `timestamp` are measured inside the operation, which the
 * frozen clock of the transcript cannot show.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { CacheDriver, type CacheEntry } from "@cache/driver";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { getExecutionTransactionPhases } from "@drivers/execution-context";
import type { TransactionOptionSupport } from "@drivers/shared/transaction-options";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import type { CommittedBatchNotification } from "@drivers/types";
import { QueryError } from "@errors";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { cache } from "@src/cache/exports";
import { createClient, defineExtension, s, sql } from "@src/index";
import {
  type InstrumentationConfig,
  instrumentation,
  type LogEvent,
} from "@src/instrumentation/exports";
import { createTestClock } from "@tests/fixtures/test-clock";
import { afterEach, describe, expect, test, vi } from "vitest";
import { captureLogs, withOtelRecorder } from "./_capture";

const GOLDEN_NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const record = s.model({ id: s.string().id(), name: s.string() });
const batchRow = s.model({
  id: s.int().id().increment(),
  code: s.string().unique(),
  label: s.string(),
});
const schema = { batchRow, record };

// ---------------------------------------------------------------------------
// Drivers: the named contracts' fixtures, reduced to what their setups use.
// ---------------------------------------------------------------------------

/** `official-statement-instrumentation.core` `StatementDriver`. */
class StatementDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  providerCalls = 0;
  failAtProviderCall: number | undefined;

  constructor() {
    super("sqlite", "official-statement-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    this.providerCalls += 1;
    if (this.providerCalls === this.failAtProviderCall) {
      throw new Error("fallback provider failed");
    }
    return { rows: [{ id: "record-1", name: "Ada" }] as T[], rowCount: 1 };
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected async transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return await callback(client);
  }
}

/** `official-statement-instrumentation.core` `NativeStatementDriver`. */
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

/** `official-instrumentation-extension.core` `OperationDriver`. */
class OperationDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readFailure: Error | undefined;

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
    const isRead = statement.trimStart().startsWith("SELECT");
    if (this.readFailure && isRead) {
      await Promise.resolve();
      throw this.readFailure;
    }
    const rows = isRead ? [{ id: "record-1", name: "Ada" }] : [];
    return { rows: rows as T[], rowCount: rows.length };
  }

  protected executeRaw<T>(
    client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    return this.execute(client, statement);
  }

  protected async transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return await callback(client);
  }
}

/** `official-driver-lifecycle-instrumentation.core` `OfficialLifecycleDriver`. */
class LifecycleDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  failBegin: Error | undefined;
  failCommit: Error | undefined;
  failConnect: Error | undefined;
  failDisconnect: Error | undefined;
  failTransactionClose: Error | undefined;

  constructor(name: string, initialized = true) {
    super("sqlite", name);
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
    if (this.failConnect) throw this.failConnect;
    return {};
  }

  protected async closeClient(): Promise<void> {
    if (this.failDisconnect) throw this.failDisconnect;
  }

  protected async execute<T>(
    _client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    const rows = statement.trimStart().startsWith("SELECT")
      ? [{ id: "record-1", name: "Ada" }]
      : [];
    return { rowCount: 1, rows: rows as T[] };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return { rowCount: 1, rows: [] };
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    return runTransactionLifecycle({
      begin: () => {
        if (this.failBegin) throw this.failBegin;
      },
      callback: () => callback(client),
      commit: () => {
        if (this.failCommit) throw this.failCommit;
      },
      rollback: () => undefined,
      close: () => {
        if (this.failTransactionClose) throw this.failTransactionClose;
      },
      phases: getExecutionTransactionPhases(context),
    });
  }
}

/** `official-driver-lifecycle-instrumentation.core` native variant. */
class NativeLifecycleDriver extends LifecycleDriver {
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
    await committed?.();
    return queries.map(() => ({ rowCount: 1, rows: [] }));
  }
}

/** `official-cache-instrumentation.core` `CacheInstrumentationDriver`. */
class CacheDatabaseDriver extends Driver<object, object> {
  readonly adapter = new SQLiteAdapter();
  rows = [{ id: "record-1", name: "Ada" }];
  failNextRead: unknown;

  constructor() {
    super("sqlite", "cache-instrumentation-test");
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
    if (statement.trimStart().startsWith("SELECT")) {
      if (this.failNextRead !== undefined) {
        const failure = this.failNextRead;
        this.failNextRead = undefined;
        throw failure;
      }
      return {
        rows: this.rows.map((row) => ({ ...row })) as T[],
        rowCount: this.rows.length,
      };
    }
    return {
      rows: statement.includes("RETURNING")
        ? ([{ id: "created", name: "Created" }] as T[])
        : [],
      rowCount: 1,
    };
  }

  protected executeRaw<T>(
    client: object,
    statement: string
  ): Promise<QueryResult<T>> {
    return this.execute(client, statement);
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return callback(client);
  }
}

/** `official-cache-instrumentation.core` `ObservableInstrumentationCache`. */
class GoldenCache extends CacheDriver {
  readonly entries = new Map<string, CacheEntry>();
  failNextSet: unknown;
  failNextDelete: unknown;

  constructor(clock: ReturnType<typeof createTestClock>) {
    super("observable-instrumentation-cache", clock);
  }

  protected async get<T>(key: string): Promise<CacheEntry<T> | null> {
    return (this.entries.get(key) as CacheEntry<T> | undefined) ?? null;
  }

  protected async set<T>(
    key: string,
    _storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    if (!key.endsWith(":reval") && this.failNextSet !== undefined) {
      const failure = this.failNextSet;
      this.failNextSet = undefined;
      throw failure;
    }
    this.entries.set(key, entry);
  }

  protected async delete(keys: string[]): Promise<void> {
    if (this.failNextDelete !== undefined) {
      const failure = this.failNextDelete;
      this.failNextDelete = undefined;
      throw failure;
    }
    for (const key of keys) this.entries.delete(key);
  }

  protected async clear(prefix: string): Promise<void> {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

interface ObservedUnit {
  readonly observer: string;
  readonly unit: Record<string, unknown>;
  completion?: Record<string, unknown>;
}

interface ScenarioScope {
  readonly logs: ReturnType<typeof captureLogs>;
  readonly errors: unknown[];
  /** An ordinary observer recording every unit it enters and its completion. */
  observer(
    name: string,
    after?: () => unknown
  ): ReturnType<typeof recordingObserver>;
  /** Record a rejection's error JSON; resolve to the value otherwise. */
  settle<T>(promise: PromiseLike<T>): Promise<T | undefined>;
  track<Client extends { $disconnect(): Promise<void> }>(
    client: Client
  ): Client;
}

function recordingObserver(
  observed: ObservedUnit[],
  name: string,
  after?: () => unknown
) {
  return defineExtension<typeof schema>()({
    name,
    observe(unit, proceed) {
      const entry: ObservedUnit = { observer: name, unit: { ...unit } };
      observed.push(entry);
      const completion = proceed();
      completion.then((summary) => {
        entry.completion = { ...summary };
      });
      return after === undefined ? completion : after();
    },
  });
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) {
    await client.$disconnect().catch(() => undefined);
  }
});

async function drain(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function createBackgroundQueue() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>): void {
      promises.push(promise);
    },
    async settle(): Promise<void> {
      while (promises.length > 0) await Promise.all(promises.splice(0));
      await Promise.resolve();
    },
  };
}

function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const json: unknown = JSON.parse(JSON.stringify(value));
    return plain({
      name: value.name,
      message: value.message,
      ...(typeof json === "object" && json !== null ? json : {}),
    });
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member: unknown = Reflect.get(value, key);
      if (member !== undefined) out[key] = plain(member);
    }
    return out;
  }
  return value;
}

const JSON_LINE_WIDTH = 80;

/**
 * `JSON.stringify(value, null, 2)` in the layout Biome's JSON formatter keeps,
 * so the committed golden is both Biome-clean and byte-equal to this output:
 * a non-empty object always breaks, and an array stays on one line when every
 * member does and the line fits.
 */
function formatJson(value: unknown, depth: number, prefix: string): string {
  const inline = formatJsonInline(value);
  if (
    inline !== undefined &&
    depth * 2 + prefix.length + inline.length + 1 <= JSON_LINE_WIDTH
  ) {
    return inline;
  }
  const indent = "  ".repeat(depth + 1);
  const closing = "  ".repeat(depth);
  if (Array.isArray(value)) {
    const members = value.map(
      (member) => `${indent}${formatJson(member, depth + 1, "")}`
    );
    return `[\n${members.join(",\n")}\n${closing}]`;
  }
  if (typeof value === "object" && value !== null) {
    const members = Object.entries(value).map(([key, member]) => {
      const label = `${JSON.stringify(key)}: `;
      return `${indent}${label}${formatJson(member, depth + 1, label)}`;
    });
    return `{\n${members.join(",\n")}\n${closing}}`;
  }
  return JSON.stringify(value);
}

function formatJsonInline(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const members = value.map(formatJsonInline);
    if (members.some((member) => member === undefined)) return undefined;
    return `[${members.join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length === 0 ? "{}" : undefined;
  }
  return JSON.stringify(value);
}

function normalizeSpans(spans: readonly ReadableSpan[]) {
  const spanIds = new Map<string, string>();
  const traceIds = new Map<string, string>();
  for (const span of spans) {
    spanIds.set(span.spanContext().spanId, `span-${spanIds.size + 1}`);
  }
  return spans.map((span) => {
    const traceId = span.spanContext().traceId;
    if (!traceIds.has(traceId)) {
      traceIds.set(traceId, `trace-${traceIds.size + 1}`);
    }
    const parentId = span.parentSpanContext?.spanId;
    return {
      id: spanIds.get(span.spanContext().spanId),
      trace: traceIds.get(traceId),
      parent:
        parentId === undefined ? null : (spanIds.get(parentId) ?? "external"),
      name: span.name,
      kind: span.kind,
      attributes: plain(span.attributes),
      status: plain(span.status),
      events: span.events.map((event) => ({
        name: event.name,
        attributes: plain(event.attributes ?? {}),
      })),
    };
  });
}

function normalizeCorrelation(value: unknown, ordinals: Map<string, string>) {
  if (typeof value === "string" && UUID.test(value)) {
    if (!ordinals.has(value)) {
      ordinals.set(value, `correlation-${ordinals.size + 1}`);
    }
    return ordinals.get(value);
  }
  if (Array.isArray(value)) {
    return value.map((member) => normalizeCorrelation(member, ordinals));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      out[key] = normalizeCorrelation(member, ordinals);
    }
    return out;
  }
  return value;
}

async function runScenario(
  run: (scope: ScenarioScope) => Promise<void>
): Promise<unknown> {
  const recorder = withOtelRecorder();
  const logs = captureLogs();
  const errors: unknown[] = [];
  const observed: ObservedUnit[] = [];
  const scope: ScenarioScope = {
    logs,
    errors,
    observer(name, after) {
      return recordingObserver(observed, name, after);
    },
    async settle(promise) {
      try {
        return await promise;
      } catch (error) {
        errors.push(error);
        return undefined;
      }
    },
    track(client) {
      clients.push(client);
      return client;
    },
  };
  try {
    await run(scope);
    await drain();
    const transcript = {
      spans: normalizeSpans(recorder.spans()),
      logs: logs.events.map((event: LogEvent) => plain(event)),
      errors: errors.map(plain),
      observed: observed.map((entry) => plain(entry)),
    };
    return normalizeCorrelation(transcript, new Map());
  } finally {
    for (const client of clients.splice(0)) {
      await client.$disconnect().catch(() => undefined);
    }
    await recorder.dispose();
  }
}

function logAll(logs: ReturnType<typeof captureLogs>) {
  return {
    cache: logs.callback,
    error: logs.callback,
    query: logs.callback,
    warning: logs.callback,
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Disclosure {
  readonly includeParams?: true;
  readonly includeSql?: true;
}

const DISCLOSURES: readonly Disclosure[] = [
  {},
  { includeSql: true },
  { includeParams: true },
  { includeParams: true, includeSql: true },
];

function disclosureConfig(
  channel: "diagnostics" | "logging" | "tracing",
  disclosure: Disclosure,
  logs: ReturnType<typeof captureLogs>
): InstrumentationConfig {
  if (channel === "tracing") return { tracing: { ...disclosure } };
  if (channel === "logging") {
    return {
      logging: { ...disclosure, error: logs.callback, query: logs.callback },
    };
  }
  return { diagnostics: { ...disclosure } };
}

const SCENARIOS: ReadonlyArray<
  readonly [string, (scope: ScenarioScope) => Promise<void>]
> = [
  [
    "statement/single",
    async ({ logs, observer, settle, track }) => {
      const client = track(
        createClient({ schema, driver: new StatementDriver() })
      )
        .$extends(instrumentation({ logging: logAll(logs), tracing: true }))
        .$extends(observer("ordinary"));
      await settle(client.$queryRaw(sql`SELECT ${7}`));
      await settle(client.record.findMany());
    },
  ],
  ...(["without", "with"] as const).map(
    (mode) =>
      [
        `statement/failure-${mode}-diagnostics`,
        async ({ logs, observer, settle, track }: ScenarioScope) => {
          const driver = new StatementDriver();
          driver.failAtProviderCall = 1;
          const client = track(createClient({ schema, driver }))
            .$extends(
              instrumentation({
                logging: logAll(logs),
                tracing: true,
                ...(mode === "with"
                  ? { diagnostics: { includeParams: true, includeSql: true } }
                  : {}),
              })
            )
            .$extends(observer("ordinary"));
          await settle(client.$queryRaw(sql`SELECT ${"failing"}`));
        },
      ] as const
  ),
  [
    "statement/native-batch",
    async ({ logs, observer, settle, track }) => {
      let transforms = 0;
      const client = track(
        createClient({ schema, driver: new NativeStatementDriver() })
      )
        .$extends(
          instrumentation({
            logging: { includeSql: true, query: logs.callback },
            tracing: { includeSql: true },
          })
        )
        .$extends(observer("ordinary"))
        .$extends({
          name: "native-statement-transform",
          statement({ statement }) {
            transforms += 1;
            return sql`${sql.raw(`/* ${transforms} */ `)}${statement}`;
          },
        });
      await settle(
        client.$transaction([
          client.$queryRaw(sql`SELECT ${1}`),
          client.$queryRaw(sql`SELECT ${2}`),
        ])
      );
    },
  ],
  [
    "statement/dedup-fallback",
    async ({ logs, observer, settle, track }) => {
      const driver = new StatementDriver();
      driver.failAtProviderCall = 2;
      const client = track(createClient({ schema, driver }))
        .$extends(instrumentation({ logging: { error: logs.callback } }))
        .$extends(observer("ordinary"));
      await settle(
        client.batchRow.createMany({
          data: [
            { code: "generated", label: "first" },
            { id: 50, code: "explicit", label: "second" },
          ],
        })
      );
    },
  ],
  [
    "statement/dedup-native",
    async ({ logs, observer, settle, track }) => {
      const driver = new NativeStatementDriver();
      driver.failBatchIndex = 1;
      const client = track(createClient({ schema, driver }))
        .$extends(
          instrumentation({
            logging: { error: logs.callback, includeSql: true },
          })
        )
        .$extends(observer("ordinary"))
        .$extends({
          name: "intercepted-native-error-dedup",
          async query({ proceed }) {
            return proceed();
          },
        });
      await settle(
        client.$transaction([
          client.record.findMany(),
          client.$queryRaw(sql`SELECT ${2}`),
        ])
      );
    },
  ],
  [
    "statement/dedup-successor-traced",
    async ({ logs, observer, settle, track }) => {
      const driver = new NativeStatementDriver();
      driver.failBatchIndex = 1;
      const client = track(createClient({ schema, driver }))
        .$extends(
          instrumentation({
            logging: { error: logs.callback, query: logs.callback },
            tracing: true,
          })
        )
        .$extends(observer("ordinary"))
        .$extends({
          name: "successor-error-dedup",
          async query({ proceed }) {
            return proceed();
          },
        });
      await settle(
        client.$transaction([
          client.record.findMany(),
          client.$queryRaw(sql`SELECT ${2}`),
        ])
      );
    },
  ],
  [
    "lifecycle/spans-and-parents",
    async ({ observer, settle, track }) => {
      const driver = new LifecycleDriver("official-lifecycle", false);
      const client = track(
        createClient({ schema, driver })
          .$extends(observer("before"))
          .$extends(instrumentation({ tracing: true }))
          .$extends(observer("after"))
      );
      await settle(client.$connect());
      await settle(
        client.$transaction(async (tx) => {
          await tx.record.findMany();
          await tx.$transaction(async (nested) => {
            await nested.record.findMany();
          });
        })
      );
      await settle(client.$disconnect());
    },
  ],
  [
    "lifecycle/queued-savepoints",
    async ({ observer, settle, track }) => {
      const driver = new LifecycleDriver("queued-savepoints");
      const client = track(
        createClient({ schema, driver })
          .$extends(observer("before"))
          .$extends(instrumentation({ tracing: true }))
          .$extends(observer("after"))
      );
      let releaseFirst: (() => void) | undefined;
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstStarted: (() => void) | undefined;
      const firstEntered = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      await settle(
        client.$transaction(async (tx) => {
          const first = tx.$transaction(async () => {
            firstStarted?.();
            await firstReleased;
          });
          const second = tx.$transaction(async () => undefined);
          await firstEntered;
          releaseFirst?.();
          await Promise.all([first, second]);
        })
      );
    },
  ],
  [
    "lifecycle/commit-certainty",
    async ({ observer, settle, track }) => {
      const cases: ReadonlyArray<
        readonly [string, (driver: LifecycleDriver) => void, Error?]
      > = [
        [
          "begin-failure",
          (driver) => {
            driver.failBegin = new Error("begin failed");
          },
        ],
        ["body-failure", () => undefined, new Error("body failed")],
        [
          "commit-failure",
          (driver) => {
            driver.failCommit = new Error("commit failed");
          },
        ],
        [
          "cleanup-failure",
          (driver) => {
            driver.failTransactionClose = new Error("cleanup failed");
          },
        ],
      ];
      for (const [name, configure, bodyFailure] of cases) {
        const driver = new LifecycleDriver(name);
        configure(driver);
        const client = track(
          createClient({ schema, driver })
            .$extends(instrumentation({ tracing: true }))
            .$extends(observer(`capture-${name}`))
        );
        await settle(
          client.$transaction(async () => {
            if (bodyFailure) throw bodyFailure;
          })
        );
      }
    },
  ],
  [
    "lifecycle/fallback-and-native",
    async ({ observer, settle, track }) => {
      const fallback = track(
        createClient({
          schema,
          driver: new LifecycleDriver("fallback-lifecycle"),
        })
          .$extends(instrumentation({ tracing: true }))
          .$extends(observer("fallback"))
      );
      await settle(
        fallback.$transaction([
          fallback.$executeRawUnsafe("UPDATE record SET name = 'fallback'"),
        ])
      );
      const native = track(
        createClient({
          schema,
          driver: new NativeLifecycleDriver("native-lifecycle"),
        })
          .$extends(instrumentation({ tracing: true }))
          .$extends(observer("native"))
      );
      await settle(
        native.$transaction([
          native.$executeRawUnsafe("UPDATE record SET name = 'native'"),
        ])
      );
    },
  ],
  [
    "lifecycle/connection-failures",
    async ({ observer, settle, track }) => {
      const connectDriver = new LifecycleDriver("connect-failure", false);
      connectDriver.failConnect = Object.assign(
        new Error("connect failed at private-host"),
        { code: "ECONNREFUSED", status: 503 }
      );
      const connecting = track(
        createClient({ schema, driver: connectDriver })
          .$extends(instrumentation({ tracing: true }))
          .$extends(observer("connect"))
      );
      await settle(connecting.$connect());

      const disconnectDriver = new LifecycleDriver("disconnect-failure");
      disconnectDriver.failDisconnect = Object.assign(
        new Error("disconnect failed at private-endpoint"),
        { code: "ECONNRESET", status: 502 }
      );
      const disconnecting = track(
        createClient({ schema, driver: disconnectDriver })
          .$extends(instrumentation({ tracing: true }))
          .$extends(observer("disconnect"))
      );
      await settle(disconnecting.$disconnect());
      disconnectDriver.failDisconnect = undefined;
      await settle(disconnecting.$connect());
      await settle(disconnecting.$disconnect());
      await settle(disconnecting.$connect());
    },
  ],
  [
    "operation/span",
    async ({ observer, settle, track }) => {
      const client = track(
        createClient({ schema, driver: new OperationDriver() })
      )
        .$extends(observer("before"))
        .$extends(instrumentation({ tracing: true }))
        .$extends(observer("after"));
      await settle(client.$queryRaw<{ id: string }>(sql`SELECT 1`));
      await settle(client.record.findMany());
    },
  ],
  [
    "operation/failed-read",
    async ({ logs, observer, settle, track }) => {
      const driver = new OperationDriver();
      driver.readFailure = new Error("provider read failed");
      const client = track(createClient({ schema, driver }))
        .$extends(observer("before"))
        .$extends(
          instrumentation({
            logging: { error: logs.callback },
            tracing: true,
          })
        )
        .$extends(observer("after"));
      await settle(client.record.findMany());
    },
  ],
  [
    "operation/error-log",
    async ({ logs, observer, settle, track }) => {
      const client = track(
        createClient({ schema, driver: new OperationDriver() })
      )
        .$extends(observer("before"))
        .$extends(instrumentation({ logging: { error: logs.callback } }))
        .$extends(observer("after"));
      await settle(client.record.findMany({ take: "invalid" as never }));
    },
  ],
  [
    "cache/cold-fresh-bypass-set-failure",
    async ({ logs, observer, settle, track }) => {
      const cacheDriver = new GoldenCache(createTestClock());
      const background = createBackgroundQueue();
      const client = track(
        createClient({ schema, driver: new CacheDatabaseDriver() })
          .$extends(
            cache({
              driver: cacheDriver,
              version: "official-parity",
              waitUntil: background.waitUntil,
            })
          )
          .$extends(
            instrumentation({
              logging: { cache: logs.callback },
              tracing: true,
            })
          )
          .$extends(observer("ordinary"))
      );
      await settle(
        client
          .$withCache({ key: "records", ttl: 10, swr: 100 })
          .record.findMany()
      );
      await background.settle();
      await settle(
        client
          .$withCache({ key: "records", ttl: 10, swr: 100 })
          .record.findMany()
      );
      await settle(
        client
          .$withCache({ key: "records", ttl: 10, swr: 100, bypass: true })
          .record.findMany()
      );
      await background.settle();
      cacheDriver.failNextSet = new Error("cache set refused");
      await settle(
        client
          .$withCache({ key: "set-failure", ttl: 10, swr: 100 })
          .record.findMany()
      );
      await background.settle();
    },
  ],
  [
    "cache/invalidation-children",
    async ({ observer, settle, track }) => {
      const client = track(
        createClient({ schema, driver: new CacheDatabaseDriver() })
          .$extends(
            cache({
              driver: new GoldenCache(createTestClock()),
              version: "invalidate",
            })
          )
          .$extends(
            observer("cache-observer-before", () => {
              throw new Error("contained observer failure");
            })
          )
          .$extends(instrumentation({ tracing: true }))
          .$extends(
            observer("cache-observer-after", () =>
              Promise.reject(new Error("contained observer rejection"))
            )
          )
      );
      await settle(client.$invalidate("record:*", "one"));
      await settle(
        client.record.create({
          data: { id: "created", name: "Created" },
          cache: { invalidate: ["one"] },
        })
      );
    },
  ],
  [
    "cache/swr-revalidation",
    async ({ logs, observer, settle, track }) => {
      const clock = createTestClock();
      const cacheDriver = new GoldenCache(clock);
      const databaseDriver = new CacheDatabaseDriver();
      const background = createBackgroundQueue();
      const client = track(
        createClient({ schema, driver: databaseDriver })
          .$extends(
            cache({
              driver: cacheDriver,
              version: "swr-instrumentation",
              waitUntil: background.waitUntil,
            })
          )
          .$extends(
            instrumentation({
              logging: { cache: logs.callback },
              tracing: true,
            })
          )
          .$extends(observer("ordinary"))
      );
      const cached = client.$withCache({ ttl: 10, swr: 100 });
      await settle(cached.record.findMany());
      await background.settle();
      clock.advance(11);
      databaseDriver.rows = [{ id: "record-1", name: "Grace" }];
      await settle(cached.record.findMany());
      await background.settle();
      await drain();
      clock.advance(11);
      databaseDriver.failNextRead = new Error("worker refused");
      cacheDriver.failNextDelete = new Error("cleanup refused");
      await settle(cached.record.findMany());
      await background.settle();
    },
  ],
  ...(["tracing", "logging", "diagnostics"] as const).flatMap((channel) =>
    DISCLOSURES.map(
      (disclosure) =>
        [
          `disclosure/${channel}/${disclosure.includeSql === true ? "sql" : "no-sql"}+${disclosure.includeParams === true ? "params" : "no-params"}`,
          async ({ logs, settle, track }: ScenarioScope) => {
            const config = disclosureConfig(channel, disclosure, logs);
            const succeeding = track(
              createClient({ schema, driver: new StatementDriver() })
            ).$extends(instrumentation(config));
            await settle(succeeding.$queryRaw(sql`SELECT ${"secret-value"}`));
            const failingDriver = new StatementDriver();
            failingDriver.failAtProviderCall = 1;
            const failing = track(
              createClient({ schema, driver: failingDriver })
            ).$extends(instrumentation(config));
            await settle(failing.$queryRaw(sql`SELECT ${"secret-value"}`));
          },
        ] as const
    )
  ),
];

describe("instrumentation golden transcript", () => {
  test("presents every named scenario exactly as the committed transcript", async () => {
    vi.useFakeTimers({ now: GOLDEN_NOW, toFake: ["Date"] });
    const transcript: Record<string, unknown> = {};
    for (const [name, run] of SCENARIOS) {
      transcript[name] = await runScenario(run);
    }
    await expect(`${formatJson(transcript, 0, "")}\n`).toMatchFileSnapshot(
      "./__golden__/transcript.json"
    );
  });

  test("measures a query log inside its operation on the real clock", async () => {
    const logs = captureLogs();
    const completions: number[] = [];
    const client = createClient({ schema, driver: new StatementDriver() })
      .$extends(instrumentation({ logging: { query: logs.callback } }))
      .$extends({
        name: "real-clock-operation",
        observe(unit, proceed) {
          if (unit.kind !== "operation") return;
          return proceed().then(({ durationMs }) => {
            completions.push(durationMs);
          });
        },
      });
    clients.push(client);

    await client.$queryRaw(sql`SELECT ${1}`);
    const resolvedAt = Date.now();
    await drain();

    expect(logs.events).toHaveLength(1);
    expect(completions).toHaveLength(1);
    const [event] = logs.events;
    expect(event?.duration).toEqual(expect.any(Number));
    expect(event?.duration).toBeLessThanOrEqual(completions[0] ?? -1);
    expect(event?.timestamp.getTime()).toBeLessThanOrEqual(resolvedAt);
  });
});
