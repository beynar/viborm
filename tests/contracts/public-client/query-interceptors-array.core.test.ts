import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { readPreparedStatement } from "@drivers/prepared-statement-provenance";
import type { CommittedBatchNotification } from "@drivers/types";
import {
  CacheConfigurationError,
  InvalidTransactionInputError,
  NestedWriteAssertionError,
  NotFoundError,
  QueryError,
  ValidationError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import { raw, sql } from "@sql";
import {
  overrideTransactionOperation,
  readTestTransactionOperation,
  type TestTransactionOperationView,
} from "@tests/fixtures/transaction-operation";
import { afterEach, describe, expect, test, vi } from "vitest";

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
const batchRow = s.model({
  id: s.int().id().increment(),
  code: s.string().unique(),
  label: s.string(),
});
const schema = { batchRow, note, record };

const FORMER_TRANSACTION_PROGRAM_MEMBERS = [
  "reserveWith",
  "executeWith",
  "prepare",
  "prepareBatch",
  "parseResult",
  "observeBatchPhase",
  "canBatch",
  "isBatchOperation",
  "execute",
  "getClientId",
  "getScopeId",
  "getModel",
  "getOperation",
  "getExecutionContext",
];

class ArrayFallbackDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly events: string[] = [];
  private transactionDepth = 0;
  failNext: Error | undefined;

  constructor() {
    super("sqlite", "array-fallback-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to close.
  }

  protected async execute<T>(
    _client: object,
    statement: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.events.push(statement);
    const failure = this.failNext;
    this.failNext = undefined;
    if (failure) throw failure;
    const rows = statement.trimStart().startsWith("SELECT")
      ? [{ id: "row", name: "value" }]
      : [];
    return { rows: rows as T[], rowCount: 1 };
  }

  protected executeRaw<T>(
    client: object,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute(client, statement, params, context);
  }

  protected async transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    const nested = this.transactionDepth > 0;
    this.events.push(nested ? "SAVEPOINT" : "BEGIN");
    this.transactionDepth += 1;
    try {
      const result = await callback(client);
      this.events.push(nested ? "RELEASE" : "COMMIT");
      return result;
    } catch (error) {
      this.events.push(nested ? "ROLLBACK TO" : "ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

class ArrayNativeDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  override readonly supportsOrderedCommittedSegments = true;
  readonly events: string[] = [];
  timeline: string[] | undefined;
  submittedQueries: BatchQuery[] | undefined;
  assertionIndex: number | undefined;
  failProvider: Error | undefined;
  malformedResults = false;

  constructor() {
    super("sqlite", "array-native-test");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to close.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("ArrayNativeDriver executes only native batches");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("ArrayNativeDriver executes only native batches");
  }

  protected async transaction<T>(): Promise<T> {
    throw new Error("ArrayNativeDriver has no callback transactions");
  }

  protected async executeBatch<T>(
    _client: object,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.events.push("provider");
    this.timeline?.push("provider");
    this.submittedQueries = queries;
    if (this.failProvider) throw this.failProvider;
    if (this.assertionIndex !== undefined) {
      throw new NestedWriteAssertionError("native assertion failed", {
        meta: { statementIndex: this.assertionIndex },
      });
    }
    await committed?.();
    const results = queries.map((query, index) => ({
      rows: query.sql.trimStart().startsWith("SELECT")
        ? ([
            {
              id: `row-${index}`,
              name: `value-${index}`,
            },
          ] as T[])
        : [],
      rowCount: index + 1,
    }));
    return this.malformedResults ? results.slice(0, -1) : results;
  }
}

class ArrayInvalidationCache extends MemoryCache {
  private readonly onClear: (prefix: string) => void | Promise<void>;

  constructor(onClear: (prefix: string) => void | Promise<void>) {
    super();
    this.onClear = onClear;
  }

  protected override async clear(prefix: string): Promise<void> {
    await this.onClear(prefix);
    await super.clear(prefix);
  }
}

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function fallbackClient() {
  const driver = new ArrayFallbackDriver();
  const client = createClient({ schema, driver });
  clients.push(client);
  return { client, driver };
}

function nativeClient() {
  const driver = new ArrayNativeDriver();
  const client = createClient({ schema, driver });
  clients.push(client);
  return { client, driver };
}

function applyUnsafeExtension<Client extends object>(
  client: Client,
  definition: unknown
): Client {
  const extend = Reflect.get(client, "$extends");
  if (typeof extend !== "function") throw new Error("Expected $extends");
  return Reflect.apply(extend, client, [definition]);
}

function runUnsafeArrayTransaction(
  client: object,
  candidates: readonly unknown[]
): Promise<unknown> {
  const transaction = Reflect.get(client, "$transaction");
  if (typeof transaction !== "function") {
    throw new Error("Expected $transaction");
  }
  return Reflect.apply(transaction, client, [candidates]);
}

function requireTransactionOperation(
  operation: unknown
): TestTransactionOperationView {
  const capability = readTestTransactionOperation(operation);
  if (capability === undefined) throw new Error("Expected pending operation");
  return capability;
}

function collectFailures(failure: unknown): unknown[] {
  const failures = [failure];
  if (failure instanceof AggregateError) {
    for (const nested of failure.errors) {
      failures.push(...collectFailures(nested));
    }
  }
  return failures;
}

async function captureFailure(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the array transaction to fail");
}

function providerStatements(events: readonly string[]): string[] {
  return events.filter(
    (event) =>
      !(
        event.startsWith("BEGIN") ||
        event.startsWith("COMMIT") ||
        event.startsWith("ROLLBACK") ||
        event.startsWith("SAVEPOINT") ||
        event.startsWith("RELEASE")
      )
  );
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("array query admission", () => {
  test("creates no rejecting observation mirror when observe is absent", async () => {
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "no-observer-rejection",
      query: {
        record: {
          async findMany({ proceed }) {
            await proceed();
            throw new Error("query post-work failed");
          },
        },
      },
    });

    await expect(
      client.$transaction([client.record.findMany()])
    ).rejects.toThrow();
    expect(providerStatements(driver.events)).toHaveLength(1);
  });

  test("starts every chain before releasing any provider effect", async () => {
    let releaseSecond = (): void => undefined;
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let calls = 0;
    let markHandlersStarted = (): void => undefined;
    const handlersStarted = new Promise<void>((resolve) => {
      markHandlersStarted = resolve;
    });
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "parallel-admission",
      query: {
        record: {
          async findMany({ mode, proceed }) {
            expect(mode).toBe("array");
            calls += 1;
            if (calls === 2) markHandlersStarted();
            if (calls === 2) await secondReady;
            return proceed();
          },
        },
      },
    });

    const result = client.$transaction([
      client.record.findMany(),
      client.record.findMany(),
    ]);
    await handlersStarted;

    expect(calls).toBe(2);
    expect(driver.events).toEqual([]);
    releaseSecond();
    await expect(result).resolves.toHaveLength(2);
    expect(driver.events[0]).toBe("BEGIN");
  });

  test("prepares every member before running any handler or provider effect", async () => {
    let handlerCalls = 0;
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "prepare-first",
      async query({ proceed }) {
        handlerCalls += 1;
        return proceed();
      },
    });
    const invalid = Reflect.apply(client.record.findMany, client.record, [
      { take: "invalid" },
    ]);

    await expect(
      client.$transaction([client.record.findMany(), invalid])
    ).rejects.toBeInstanceOf(ValidationError);
    expect(handlerCalls).toBe(0);
    expect(driver.events).toEqual([]);
  });

  test("admits every request-only write before fallback transaction effects", async () => {
    let requestCalls = 0;
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "request-only-admission",
      request: {
        record: {
          deleteMany() {
            requestCalls += 1;
            if (requestCalls === 2) {
              throw new Error("second request refused");
            }
            return {};
          },
        },
      },
    });
    const first = client.record.deleteMany({ where: { id: "first" } });
    const second = client.record.deleteMany({ where: { id: "second" } });

    expect(readTestTransactionOperation(first)?.requiresInterception()).toBe(
      false
    );
    expect(
      readTestTransactionOperation(
        client.$executeRawUnsafe("SELECT 1")
      )?.requiresInterception()
    ).toBe(false);
    await expect(client.$transaction([first, second])).rejects.toMatchObject({
      name: "QueryError",
      meta: expect.objectContaining({
        model: "record",
        operation: "deleteMany",
      }),
    });
    expect(requestCalls).toBe(2);
    expect(driver.events).toEqual([]);
  });

  test("keeps request preparation inside an operation observer lifecycle", () => {
    const { client: base } = fallbackClient();
    const client = base
      .$extends({
        name: "observed-request",
        request: {
          record: {
            findMany() {
              return {};
            },
          },
        },
      })
      .$extends({
        name: "request-observer",
        observe: () => undefined,
      });

    expect(
      readTestTransactionOperation(
        client.record.findMany()
      )?.requiresInterception()
    ).toBe(true);
  });

  test("requires proceed for array reads, mutations, and every raw family", async () => {
    const { client: base, driver } = fallbackClient();
    const readClient = base.$extends({
      name: "read-no-proceed",
      query: {
        record: {
          async findMany() {
            return [];
          },
        },
      },
    });
    await expect(
      readClient.$transaction([readClient.record.findMany()])
    ).rejects.toBeInstanceOf(QueryError);

    const mandatory = applyUnsafeExtension(base, {
      name: "mandatory-no-proceed",
      async query({ kind }: { kind: string }) {
        return kind === "model" ? { count: 99 } : [];
      },
    });
    const operations = [
      mandatory.record.deleteMany(),
      mandatory.$queryRaw(sql`SELECT 1`),
      mandatory.$executeRaw(sql`DELETE FROM record`),
      mandatory.$queryRawUnsafe("SELECT 1"),
      mandatory.$executeRawUnsafe("DELETE FROM record"),
    ];
    for (const operation of operations) {
      await expect(mandatory.$transaction([operation])).rejects.toBeInstanceOf(
        QueryError
      );
    }
    expect(driver.events).toEqual([]);
  });

  test.each([
    [
      "caught double",
      ({ proceed }: { proceed(): Promise<unknown> }) => {
        const first = proceed();
        try {
          proceed();
        } catch {
          // The handler cannot neutralize the protocol failure.
        }
        return first;
      },
    ],
    [
      "proceed then throw",
      async ({ proceed }: { proceed(): Promise<unknown> }) => {
        proceed();
        throw new Error("post-admission failure");
      },
    ],
  ])("aborts %s before provider release", async (_name, handler) => {
    const { client: base, driver } = fallbackClient();
    const client = applyUnsafeExtension(base, {
      name: "hostile-continuation",
      query: { record: { findMany: handler } },
    });

    await expect(
      client.$transaction([client.record.findMany()])
    ).rejects.toBeInstanceOf(QueryError);
    expect(driver.events).toEqual([]);
  });

  test("retains a final handler failure after caught double-proceed and child rejection", async () => {
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "admission-evidence",
      query: {
        record: {
          async findMany({ proceed }) {
            const child = proceed();
            try {
              proceed();
            } catch {
              // The handler cannot neutralize the protocol failure.
            }
            try {
              await child;
            } catch {
              // Admission closure rejects the suspended child before dispatch.
            }
            throw new Error("distinct final handler failure");
          },
        },
      },
    });

    const failure = await captureFailure(
      client.$transaction([client.record.findMany()])
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(failure.cause);
    expect(failure.cause).toMatchObject({
      message: expect.stringContaining("called proceed more than once"),
    });
    expect(failure.errors[1]).toBeInstanceOf(QueryError);
    expect(failure.errors[1]).toMatchObject({
      message: expect.stringContaining(
        'Extension "admission-evidence" query handler for record.findMany failed.'
      ),
    });
    expect(driver.events).toEqual([]);
  });

  test("uses the exact child result and error after a handler returns a fabricated value", async () => {
    const { client: base, driver } = fallbackClient();
    const client = applyUnsafeExtension(base, {
      name: "fabricated-return",
      query: {
        record: {
          async findMany({ proceed }: { proceed(): Promise<unknown> }) {
            proceed();
            return [{ id: "fabricated" }];
          },
        },
      },
    });

    const [rows] = await client.$transaction([client.record.findMany()]);
    expect(rows[0]?.id).toBe("row");

    driver.failNext = new Error("authoritative child failure");
    const failure = await captureFailure(
      client.$transaction([client.record.findMany()])
    );
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure).toMatchObject({ originalCause: expect.any(Error) });
  });

  test("closes a detached late proceed without releasing the provider", async () => {
    let detached: (() => Promise<unknown>) | undefined;
    const { client: base, driver } = fallbackClient();
    const client = applyUnsafeExtension(base, {
      name: "detached-proceed",
      query: {
        record: {
          async findMany({ proceed }: { proceed(): Promise<unknown> }) {
            detached = proceed;
            return [];
          },
        },
      },
    });

    await expect(
      client.$transaction([client.record.findMany()])
    ).rejects.toBeInstanceOf(QueryError);
    expect(detached).toBeDefined();
    expect(detached).toThrowError(QueryError);
    expect(driver.events).toEqual([]);
  });
});

describe("fallback array query execution", () => {
  test("waits for member post-work before the next SQL and rolls back on failure", async () => {
    let calls = 0;
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "sequential-post-work",
      query: {
        record: {
          async findMany({ proceed }) {
            calls += 1;
            const result = await proceed();
            if (calls === 2) throw new Error("first member post-work failed");
            return result;
          },
        },
      },
    });

    await expect(
      client.$transaction([client.record.findMany(), client.record.findMany()])
    ).rejects.toBeInstanceOf(QueryError);
    expect(providerStatements(driver.events)).toHaveLength(1);
    expect(driver.events.at(-1)).toBe("ROLLBACK");
  });

  test("keeps the first core child primary before first and later post-work", async () => {
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "later-fallback-post-work",
      query: {
        record: {
          async findMany({ proceed }) {
            try {
              return await proceed();
            } catch {
              throw new Error("first admitted member post-work failed");
            }
          },
        },
        note: {
          async findMany({ proceed }) {
            try {
              return await proceed();
            } catch {
              throw new Error("later admitted member post-work failed");
            }
          },
        },
      },
    });
    driver.failNext = new Error("first core failed");

    const failure = await captureFailure(
      client.$transaction([client.record.findMany(), client.note.findMany()])
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toHaveLength(3);
    expect(failure.errors[0]).toBe(failure.cause);
    expect(failure.cause).toBeInstanceOf(QueryError);
    expect(failure.errors[1]).toBeInstanceOf(QueryError);
    expect(failure.errors[1]).toMatchObject({
      message: expect.stringContaining(
        'Extension "later-fallback-post-work" query handler for record.findMany failed.'
      ),
    });
    expect(failure.errors[2]).toBeInstanceOf(QueryError);
    expect(failure.errors[2]).toMatchObject({
      message: expect.stringContaining(
        'Extension "later-fallback-post-work" query handler for note.findMany failed.'
      ),
    });
    expect(providerStatements(driver.events)).toHaveLength(1);
    expect(driver.events.at(-1)).toBe("ROLLBACK");
  });

  test("promotes a released savepoint and discards a rolled-back one", async () => {
    const outcomes: string[] = [];
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "nested-array-outcomes",
      query: {
        record: {
          async deleteMany({ input, onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) => outcomes.push(certainty));
            const result = await proceed();
            const where = Reflect.get(input, "where");
            if (where === null || typeof where !== "object") {
              throw new Error("Expected a where clause");
            }
            const id = Reflect.get(where, "id");
            if (id === null || typeof id !== "object") {
              throw new Error("Expected an id clause");
            }
            if (Reflect.get(id, "equals") === "rollback") {
              throw new Error("rollback nested array");
            }
            return result;
          },
        },
      },
    });

    await client.$transaction(async (tx) => {
      await tx.$transaction([tx.record.deleteMany({ where: { id: "kept" } })]);
      expect(outcomes).toEqual([]);
      await tx
        .$transaction([tx.record.deleteMany({ where: { id: "rollback" } })])
        .catch(() => undefined);
      expect(outcomes).toEqual([]);
    });

    expect(outcomes).toEqual(["committed"]);
    expect(driver.events.some((event) => event.startsWith("SAVEPOINT "))).toBe(
      true
    );
    expect(
      driver.events.some((event) => event.startsWith("RELEASE SAVEPOINT "))
    ).toBe(true);
    expect(
      driver.events.some((event) => event.startsWith("ROLLBACK TO SAVEPOINT "))
    ).toBe(true);
    expect(driver.events.at(-1)).toBe("COMMIT");
  });
});

describe("raw write-outcome classification", () => {
  test("keeps raw classification, outcomes, and context behind private state", async () => {
    const observations: string[] = [];
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "private-raw-state",
      async query({ kind, onWriteOutcome, proceed }) {
        observations.push(kind);
        onWriteOutcome(({ certainty }) => observations.push(certainty));
        return proceed();
      },
    });
    const operation = client.$executeRawUnsafe(
      "UPDATE record SET name = ?",
      "private"
    );
    const authenticContext = requireTransactionOperation(operation).context;
    const invariantNames = [
      "engine",
      "execution",
      "context",
      "method",
      "captured",
      "parse",
      "resolved",
      "observationCommitCertainty",
    ];
    expect(Reflect.ownKeys(operation)).not.toEqual(
      expect.arrayContaining(invariantNames)
    );
    expect(Object.isFrozen(operation)).toBe(true);
    const prototype = Reflect.getPrototypeOf(operation);
    if (prototype === null) throw new Error("Expected raw operation prototype");
    expect(Object.isFrozen(prototype)).toBe(true);
    const originalThen = Reflect.get(prototype, "then");
    expect(typeof originalThen).toBe("function");
    expect(Reflect.defineProperty(prototype, "then", { value: vi.fn() })).toBe(
      false
    );
    expect(Reflect.get(prototype, "then")).toBe(originalThen);
    for (const name of [
      "resolve",
      "run",
      "runResolved",
      "getPromise",
      "observeLogicalOperation",
      "withObservationNotifications",
    ]) {
      const helper = Reflect.get(operation, name);
      expect(helper).toBeUndefined();
      expect(() => {
        if (typeof helper !== "function") {
          throw new TypeError("Private helper is not callable");
        }
        Reflect.apply(helper, operation, []);
      }).toThrow(TypeError);
    }
    for (const name of invariantNames) {
      expect(
        Reflect.defineProperty(operation, name, {
          value: "forged",
        })
      ).toBe(false);
    }

    await expect(client.$transaction([operation])).resolves.toEqual([1]);
    expect(requireTransactionOperation(operation).context).toBe(
      authenticContext
    );
    expect(observations).toEqual(["executeRawUnsafe", "committed"]);
    expect(providerStatements(driver.events)).toEqual([
      "UPDATE record SET name = ?",
    ]);
  });

  test("publishes only execute families in direct and fallback modes", async () => {
    const outcomes: string[] = [];
    const { client: base } = fallbackClient();
    const client = base.$extends({
      name: "fallback-raw-outcomes",
      async query({ kind, onWriteOutcome, proceed }) {
        if (kind !== "model") {
          onWriteOutcome(({ certainty }) =>
            outcomes.push(`${kind}:${certainty}`)
          );
        }
        return proceed();
      },
    });

    await client.$queryRaw(sql`SELECT 1`);
    await client.$queryRawUnsafe("SELECT 1");
    expect(outcomes).toEqual([]);
    await client.$executeRaw(sql`DELETE FROM record`);
    await client.$executeRawUnsafe("DELETE FROM record");
    expect(outcomes).toEqual([
      "executeRaw:committed",
      "executeRawUnsafe:committed",
    ]);

    outcomes.splice(0);
    await client.$transaction([
      client.$queryRaw(sql`SELECT 1`),
      client.$executeRaw(sql`DELETE FROM record`),
      client.$queryRawUnsafe("SELECT 1"),
      client.$executeRawUnsafe("DELETE FROM record"),
    ]);
    expect(outcomes).toEqual([
      "executeRaw:committed",
      "executeRawUnsafe:committed",
    ]);
  });

  test("publishes only execute families for native success and dispatch failure", async () => {
    const committed: string[] = [];
    const { client: successBase } = nativeClient();
    const success = successBase.$extends({
      name: "native-raw-outcomes",
      async query({ kind, onWriteOutcome, proceed }) {
        if (kind !== "model") {
          onWriteOutcome(({ certainty }) =>
            committed.push(`${kind}:${certainty}`)
          );
        }
        return proceed();
      },
    });
    await success.$transaction([
      success.$queryRaw(sql`SELECT 1`),
      success.$executeRaw(sql`DELETE FROM record`),
      success.$queryRawUnsafe("SELECT 1"),
      success.$executeRawUnsafe("DELETE FROM record"),
    ]);
    expect(committed).toEqual([
      "executeRaw:committed",
      "executeRawUnsafe:committed",
    ]);

    const readOutcomes: string[] = [];
    const { client: readBase, driver: readDriver } = nativeClient();
    readDriver.failProvider = new Error("read dispatch failed");
    const read = readBase.$extends({
      name: "native-raw-read-failure",
      async query({ kind, onWriteOutcome, proceed }) {
        onWriteOutcome(({ certainty }) =>
          readOutcomes.push(`${kind}:${certainty}`)
        );
        return proceed();
      },
    });
    await captureFailure(read.$transaction([read.$queryRaw(sql`SELECT 1`)]));
    expect(readOutcomes).toEqual([]);

    const writeOutcomes: string[] = [];
    const { client: writeBase, driver: writeDriver } = nativeClient();
    writeDriver.failProvider = new Error("write dispatch failed");
    const write = writeBase.$extends({
      name: "native-raw-write-failure",
      async query({ kind, onWriteOutcome, proceed }) {
        onWriteOutcome(({ certainty }) =>
          writeOutcomes.push(`${kind}:${certainty}`)
        );
        return proceed();
      },
    });
    await captureFailure(
      write.$transaction([write.$executeRaw(sql`DELETE FROM record`)])
    );
    expect(writeOutcomes).toEqual(["executeRaw:may-have-committed"]);
  });
});

describe("native array query execution", () => {
  test("orders provider, committed outcomes, parsing, and handler post-work", async () => {
    const timeline: string[] = [];
    const { client: base, driver } = nativeClient();
    driver.timeline = timeline;
    const client = base.$extends({
      name: "native-order",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(() => timeline.push("outcome"));
            const result = await proceed();
            timeline.push("post-work");
            return result;
          },
        },
      },
    });
    const operation = client.record.deleteMany();
    const parse = vi.fn((raw: QueryResult<unknown>) => {
      timeline.push("parse");
      return { count: raw.rowCount };
    });
    const parsing = overrideTransactionOperation(operation, {
      parseResult: parse,
    });

    await runUnsafeArrayTransaction(client, [parsing]);

    expect(parse).toHaveBeenCalledOnce();
    expect(timeline).toEqual(["provider", "outcome", "parse", "post-work"]);
  });

  test("attempts every cache invalidation before listeners and keeps commit failure primary", async () => {
    const timeline: string[] = [];
    let invalidation = 0;
    const cache = new ArrayInvalidationCache(() => {
      invalidation += 1;
      timeline.push(`cache:${invalidation}`);
      throw new Error(`cache ${invalidation} failed`);
    });
    const { client: unextended } = nativeClient();
    const base = unextended.$extends(cacheExtension({ driver: cache }));
    const client = base.$extends({
      name: "exhaustive-native-cache",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(() => timeline.push("listener:deleteMany"));
            return proceed();
          },
          async updateMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(() => timeline.push("listener:updateMany"));
            return proceed();
          },
        },
      },
    });

    const failure = await captureFailure(
      client.$transaction([
        client.record.deleteMany({ cache: { autoInvalidate: true } }),
        client.record.updateMany({
          data: { name: "updated" },
          cache: { autoInvalidate: true },
        }),
      ])
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.cause).toBeInstanceOf(CacheConfigurationError);
    const cacheFailures = collectFailures(failure).filter(
      (candidate) => candidate instanceof CacheConfigurationError
    );
    expect(cacheFailures).toHaveLength(2);
    for (const cacheFailure of cacheFailures) {
      expect(cacheFailure).toMatchObject({
        meta: expect.objectContaining({ commitCertainty: "committed" }),
      });
    }
    expect(timeline).toEqual([
      "cache:1",
      "cache:2",
      "listener:deleteMany",
      "listener:updateMany",
    ]);
  });

  test("keeps child post-work primary over cache and listener commit failures", async () => {
    const timeline: string[] = [];
    const cache = new ArrayInvalidationCache(() => {
      timeline.push("cache");
      throw new Error("cache failed");
    });
    const { client: unextended } = nativeClient();
    const base = unextended.$extends(cacheExtension({ driver: cache }));
    const client = base.$extends({
      name: "native-child-primary",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(() => {
              timeline.push("listener");
              throw new Error("listener failed");
            });
            await proceed();
            throw new Error("child post-work failed");
          },
        },
      },
    });

    const failure = await captureFailure(
      client.$transaction([
        client.record.deleteMany({ cache: { autoInvalidate: true } }),
      ])
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.cause).toMatchObject({
      message:
        'Extension "native-child-primary" query handler for record.deleteMany failed.',
      meta: expect.objectContaining({ commitCertainty: "committed" }),
    });
    const failures = collectFailures(failure);
    expect(
      failures.some((candidate) => candidate instanceof CacheConfigurationError)
    ).toBe(true);
    expect(
      failures.some(
        (candidate) =>
          candidate instanceof QueryError &&
          candidate.message.includes("write-outcome listener failed")
      )
    ).toBe(true);
    expect(timeline).toEqual(["cache", "listener"]);
  });

  test("keeps the native child primary across ordered post-work and commit failures", async () => {
    const timeline: string[] = [];
    const cache = new ArrayInvalidationCache(() => {
      timeline.push("cache");
      throw new Error("cache failed");
    });
    const { client: unextended } = nativeClient();
    const base = unextended.$extends(cacheExtension({ driver: cache }));
    const client = base.$extends({
      name: "native-child-graph",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(() => {
              timeline.push("listener");
              throw new Error("listener failed");
            });
            try {
              return await proceed();
            } catch {
              throw new Error("first member post-work failed");
            }
          },
          async findMany({ proceed }) {
            await proceed();
            throw new Error("later member post-work failed");
          },
        },
      },
    });
    const firstSource = client.record.deleteMany({
      cache: { autoInvalidate: true },
    });
    const first = overrideTransactionOperation(firstSource, {
      parseResult: () => {
        throw new QueryError("first native child failed");
      },
    });

    const failure = await captureFailure(
      runUnsafeArrayTransaction(client, [first, client.record.findMany()])
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toHaveLength(5);
    expect(failure.errors[0]).toBe(failure.cause);
    expect(failure.errors[0]).toMatchObject({
      message: "first native child failed",
      meta: expect.objectContaining({ commitCertainty: "committed" }),
    });
    expect(failure.errors[1]).toMatchObject({
      message:
        'Extension "native-child-graph" query handler for record.deleteMany failed.',
    });
    expect(failure.errors[2]).toMatchObject({
      message:
        'Extension "native-child-graph" query handler for record.findMany failed.',
    });
    expect(failure.errors[3]).toBeInstanceOf(CacheConfigurationError);
    expect(failure.errors[4]).toMatchObject({
      message: expect.stringContaining("write-outcome listener failed"),
    });
    expect(timeline).toEqual(["cache", "listener"]);
  });

  test("labels post-commit handler and cardinality failures without extra parsing", async () => {
    const { client: base, driver } = nativeClient();
    const client = base.$extends({
      name: "native-post-failure",
      query: {
        record: {
          async findMany({ proceed }) {
            const result = await proceed();
            throw new Error(`post-work after ${result.length} rows`);
          },
        },
      },
    });
    const postFailure = await captureFailure(
      client.$transaction([client.record.findMany()])
    );
    expect(postFailure).toMatchObject({
      meta: expect.objectContaining({ commitCertainty: "committed" }),
    });

    driver.malformedResults = true;
    const operation = client.record.findMany();
    const original = requireTransactionOperation(operation);
    const parse = vi.fn((raw: QueryResult<unknown>) =>
      original.parseResult(raw)
    );
    const parsing = overrideTransactionOperation(operation, {
      parseResult: parse,
    });
    const cardinalityFailure = await captureFailure(
      runUnsafeArrayTransaction(client, [parsing])
    );
    expect(parse).not.toHaveBeenCalled();
    const primary =
      cardinalityFailure instanceof AggregateError
        ? cardinalityFailure.cause
        : cardinalityFailure;
    expect(primary).toMatchObject({
      meta: expect.objectContaining({ commitCertainty: "committed" }),
    });
  });

  test("does every late preparation before one native submission", async () => {
    let handlerCalls = 0;
    const { client: base, driver } = nativeClient();
    const client = base.$extends({
      name: "late-native-preparation",
      async query({ proceed }) {
        handlerCalls += 1;
        return proceed();
      },
    });
    const first = client.record.findMany();
    const second = overrideTransactionOperation(client.record.findMany(), {
      prepare: () => {
        throw new Error("late preparation failed");
      },
    });

    const failure = await captureFailure(
      runUnsafeArrayTransaction(client, [first, second])
    );
    expect(failure).toBeInstanceOf(QueryError);
    if (!(failure instanceof QueryError)) throw failure;
    expect(failure.originalCause).toBeInstanceOf(Error);
    expect(failure.originalCause?.message).toBe(
      "Underlying error details redacted"
    );
    expect(handlerCalls).toBe(2);
    expect(driver.events).toEqual([]);
  });

  test("publishes may-have-committed and attempts cache plus every listener on provider failure", async () => {
    const timeline: string[] = [];
    const cache = new ArrayInvalidationCache(() => {
      timeline.push("cache");
      throw new Error("cache invalidation failed");
    });
    const { client: unextended, driver } = nativeClient();
    const base = unextended.$extends(cacheExtension({ driver: cache }));
    driver.failProvider = new Error("provider acknowledgement lost");
    const client = base
      .$extends({
        name: "first-listener",
        query: {
          record: {
            async deleteMany({ onWriteOutcome, proceed }) {
              onWriteOutcome(({ certainty }) => {
                timeline.push(`first:${certainty}`);
                throw new Error("first listener failed");
              });
              return proceed();
            },
          },
        },
      })
      .$extends({
        name: "second-listener",
        query: {
          record: {
            async deleteMany({ onWriteOutcome, proceed }) {
              onWriteOutcome(({ certainty }) =>
                timeline.push(`second:${certainty}`)
              );
              return proceed();
            },
          },
        },
      });

    const failure = await captureFailure(
      client.$transaction([
        client.record.deleteMany({ cache: { autoInvalidate: true } }),
      ])
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.cause).toBeInstanceOf(QueryError);
    expect(failure.errors[0]).toBe(failure.cause);
    expect(failure.cause).toMatchObject({
      meta: expect.objectContaining({
        commitCertainty: "may-have-committed",
      }),
    });
    expect(timeline).toEqual([
      "cache",
      "first:may-have-committed",
      "second:may-have-committed",
    ]);
  });

  test("preserves single, multi-statement, guard, and raw result windows", async () => {
    const { client: base, driver } = nativeClient();
    const client = base.$extends({
      name: "mixed-results",
      async query({ proceed }) {
        return proceed();
      },
    });
    const createMany = client.batchRow.createMany({
      data: [
        { code: "generated", label: "first" },
        { id: 50, code: "explicit", label: "second" },
      ],
    });

    const [rows, created, rawRows] = await client.$transaction([
      client.record.findMany(),
      createMany,
      client.$queryRaw<{ id: string }>(sql`SELECT 1 AS id`),
    ]);

    expect(rows[0]?.id).toBe("row-0");
    expect(created).toEqual({ count: 5 });
    expect(rawRows[0]?.id).toBe("row-3");

    const guarded = client.batchRow.createMany({
      data: [
        { code: "guard-generated", label: "first" },
        { id: 51, code: "guard-explicit", label: "second" },
      ],
    });
    const guardedCapability = requireTransactionOperation(guarded);
    const prepared = await guardedCapability.prepareBatch();
    if (!prepared || prepared.queries.length !== 2) {
      throw new Error("mixed-shape createMany did not compile two statements");
    }
    const guardedOperation = overrideTransactionOperation(guarded, {
      prepareBatch: async () => ({
        ...prepared,
        guards: [
          {
            queryIndex: 1,
            premise: "exists",
            probe: sql`SELECT 1`,
            failure: {
              kind: "notFound",
              message: "middle guard",
              raceable: false,
            },
            model: "batchRow",
            operation: "createMany",
          },
        ],
      }),
    });
    driver.assertionIndex = 2;
    const failure = await captureFailure(
      runUnsafeArrayTransaction(client, [
        client.record.findMany(),
        guardedOperation,
        client.$queryRaw(sql`SELECT 1`),
      ])
    );
    const primary = failure instanceof AggregateError ? failure.cause : failure;
    expect(primary).toBeInstanceOf(NotFoundError);
    expect(primary).toMatchObject({
      code: VibORMErrorCode.RECORD_NOT_FOUND,
      meta: {
        commitCertainty: "may-have-committed",
        model: "batchRow",
        operation: "createMany",
      },
    });
  });
});

describe("array ownership and zero-handler path", () => {
  test("refuses forged array members without inspecting or starting them", async () => {
    const { client, driver } = fallbackClient();
    const reads: PropertyKey[] = [];
    const effect = vi.fn();
    const guessedSymbol = Symbol.for("viborm.transactionOperation");
    const symbolForgery = Object.defineProperty({}, guessedSymbol, {
      get() {
        reads.push(guessedSymbol);
        effect();
        return true;
      },
    });
    const protocolForgery = {};
    for (const name of [
      "clientId",
      "scopeId",
      "model",
      "operation",
      "reserveWith",
      "executeWith",
      "prepare",
      "prepareBatch",
      "parseResult",
      "observeBatchPhase",
      "requiresInterception",
      "prepareAdmission",
      "stagePackageWriteOutcomes",
      "startInterception",
      "executeCore",
      "isWrite",
      "hasObservation",
      "observe",
    ]) {
      Object.defineProperty(protocolForgery, name, {
        get() {
          reads.push(name);
          effect();
          return name.endsWith("Id") ? Symbol(name) : vi.fn();
        },
      });
    }
    const proxyForgery = new Proxy(protocolForgery, {
      get(_target, key) {
        reads.push(key);
        effect();
        throw new Error(`Unexpected forged-member read: ${String(key)}`);
      },
      getOwnPropertyDescriptor(_target, key) {
        reads.push(key);
        effect();
        throw new Error(`Unexpected forged descriptor read: ${String(key)}`);
      },
      getPrototypeOf() {
        reads.push("getPrototypeOf");
        effect();
        throw new Error("Unexpected forged prototype read");
      },
      has(_target, key) {
        reads.push(key);
        effect();
        throw new Error(`Unexpected forged membership read: ${String(key)}`);
      },
      ownKeys() {
        reads.push("ownKeys");
        effect();
        throw new Error("Unexpected forged key scan");
      },
    });

    for (const forgery of [symbolForgery, protocolForgery, proxyForgery]) {
      await expect(
        runUnsafeArrayTransaction(client, [forgery])
      ).rejects.toMatchObject({ name: "InvalidTransactionInputError" });
      expect(reads).toEqual([]);
      expect(effect).not.toHaveBeenCalled();
      expect(driver.events).toEqual([]);
    }
  });

  test("uses the entry snapshot after the caller replaces a member", async () => {
    const { client } = fallbackClient();
    const { client: foreign } = fallbackClient();
    const candidates: unknown[] = [client.record.findMany()];

    const execution = runUnsafeArrayTransaction(client, candidates);
    candidates[0] = foreign.record.findMany();

    await expect(execution).resolves.toEqual([[{ id: "row", name: "value" }]]);
  });

  test("uses the entry snapshot when a batch observer replaces a member", async () => {
    const { client: base } = fallbackClient();
    const { client: foreign } = fallbackClient();
    let candidates: unknown[] = [];
    const client = base.$extends({
      name: "snapshot-observer-mutation",
      observe(unit, proceed) {
        if (unit.kind === "batch") {
          candidates[0] = foreign.record.findMany();
        }
        proceed();
      },
    });
    candidates = [client.record.findMany()];

    await expect(
      runUnsafeArrayTransaction(client, candidates)
    ).resolves.toEqual([[{ id: "row", name: "value" }]]);
  });

  test("keeps captured authority immutable from public program properties", async () => {
    const { client } = fallbackClient();
    const modelOperation = client.record.findMany();
    const rawOperation = client.$executeRawUnsafe(
      "UPDATE record SET name = ?",
      "captured"
    );
    for (const operation of [modelOperation, rawOperation]) {
      expect(Object.isFrozen(operation)).toBe(true);
      for (const name of FORMER_TRANSACTION_PROGRAM_MEMBERS) {
        expect(
          Reflect.defineProperty(operation, name, {
            value: vi.fn(),
          })
        ).toBe(false);
      }
    }

    await expect(
      client.$transaction([modelOperation, rawOperation])
    ).resolves.toEqual([[{ id: "row", name: "value" }], 1]);
  });

  test("keeps foreign operation identity private and immutable", async () => {
    const { client: target, driver: targetDriver } = fallbackClient();
    const { client: foreignModel } = fallbackClient();
    const { client: foreignRaw } = fallbackClient();
    const cases = [
      {
        client: foreignModel,
        operation: foreignModel.record.findMany(),
        expected: [[{ id: "row", name: "value" }]],
      },
      {
        client: foreignRaw,
        operation: foreignRaw.$executeRawUnsafe(
          "UPDATE record SET name = ?",
          "foreign"
        ),
        expected: [1],
      },
    ];

    for (const candidate of cases) {
      const shadowKeys = [
        "context",
        "engine",
        "clientId",
        "scopeId",
        "_clientId",
        "_scopeId",
        ...FORMER_TRANSACTION_PROGRAM_MEMBERS,
      ];
      for (const key of shadowKeys) {
        expect(
          Reflect.defineProperty(candidate.operation, key, {
            value: target,
          })
        ).toBe(false);
      }

      await expect(
        target.$transaction([candidate.operation])
      ).rejects.toMatchObject({ name: "PendingOperationError" });
      expect(targetDriver.events).toEqual([]);

      const authenticResult: unknown = await candidate.client.$transaction([
        candidate.operation,
      ]);
      expect(authenticResult).toEqual(candidate.expected);
    }
  });

  test("keeps handler controls inactive without publishing a friend member", async () => {
    const { client: base } = fallbackClient();
    const baseOperation = base.record.findMany();
    const baseRaw = base.$queryRaw(sql`SELECT 1`);
    const client = base.$extends({ name: "empty-query", query: {} });
    const operation = client.record.findMany();
    const rawOperation = client.$queryRaw(sql`SELECT 1`);
    expect(Reflect.has(operation, "prepareArrayAdmission")).toBe(false);
    expect(Reflect.has(operation, "startArrayInterception")).toBe(false);
    expect(Reflect.has(operation, "executeArrayCore")).toBe(false);
    expect(Reflect.has(operation, "isArrayWrite")).toBe(false);
    expect(
      Reflect.get(operation, Symbol.for("viborm.arrayTransactionOperation"))
    ).toBeUndefined();
    expect(
      readTestTransactionOperation(baseOperation)?.requiresInterception()
    ).toBe(false);
    expect(readTestTransactionOperation(baseRaw)?.requiresInterception()).toBe(
      false
    );
    expect(
      readTestTransactionOperation(operation)?.requiresInterception()
    ).toBe(false);
    expect(
      readTestTransactionOperation(rawOperation)?.requiresInterception()
    ).toBe(false);
    expect(readTestTransactionOperation(baseOperation)?.hasObservation()).toBe(
      false
    );
    expect(readTestTransactionOperation(baseRaw)?.hasObservation()).toBe(false);
    expect(readTestTransactionOperation(operation)?.hasObservation()).toBe(
      false
    );
    expect(readTestTransactionOperation(rawOperation)?.hasObservation()).toBe(
      false
    );
    await client.$transaction([operation]);

    const intercepted = base.$extends({
      name: "registered-friend",
      async query({ proceed }) {
        return proceed();
      },
    });
    const interceptedOperation = intercepted.record.findMany();
    const interceptedRaw = intercepted.$queryRaw(sql`SELECT 1`);
    expect(
      readTestTransactionOperation(interceptedOperation)?.requiresInterception()
    ).toBe(true);
    expect(
      readTestTransactionOperation(interceptedRaw)?.requiresInterception()
    ).toBe(true);
    const exact = base.$extends({
      name: "exact-query-registration",
      query: {
        record: {
          async findMany({ proceed }) {
            return proceed();
          },
        },
      },
    });
    expect(
      readTestTransactionOperation(
        exact.record.findMany()
      )?.requiresInterception()
    ).toBe(true);
    expect(
      readTestTransactionOperation(
        exact.note.findMany()
      )?.requiresInterception()
    ).toBe(false);
    expect(
      readTestTransactionOperation(
        exact.$queryRaw(sql`SELECT 1`)
      )?.requiresInterception()
    ).toBe(false);
    const reflectedSymbols = [
      operation,
      rawOperation,
      interceptedOperation,
      interceptedRaw,
    ].flatMap((candidate) => {
      const prototype = Reflect.getPrototypeOf(candidate);
      return [
        ...Object.getOwnPropertySymbols(candidate),
        ...(prototype ? Object.getOwnPropertySymbols(prototype) : []),
      ];
    });
    expect(reflectedSymbols.map((symbol) => symbol.description)).not.toContain(
      "viborm.arrayTransactionOperation"
    );
    expect(reflectedSymbols.map((symbol) => symbol.description)).not.toContain(
      "viborm.transactionOperationOwner"
    );
  });

  test("makes a genuine member prototype immutable", () => {
    const { client, driver } = fallbackClient();
    const operation = client.record.findMany();
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Reflect.setPrototypeOf(operation, {})).toBe(false);
    expect(driver.events).toEqual([]);
  });

  test("cannot mint model or raw authority through reflected constructors", () => {
    const { client, driver } = fallbackClient();
    const operations = [
      client.record.findMany(),
      client.$queryRaw(sql`SELECT 1`),
    ];

    for (const operation of operations) {
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Reflect.setPrototypeOf(operation, {})).toBe(false);
      const reflectedConstructor = Reflect.get(operation, "constructor");
      if (typeof reflectedConstructor !== "function") {
        throw new Error("Expected an operation constructor");
      }
      expect(() => Reflect.construct(reflectedConstructor, [])).toThrow(
        InvalidTransactionInputError
      );
    }
    expect(driver.events).toEqual([]);
  });

  test("refuses duplicate, awaited, foreign-client, and foreign-scope members", async () => {
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "ownership",
      async query({ proceed }) {
        return proceed();
      },
    });

    const duplicate = client.record.findMany();
    await expect(client.$transaction([duplicate, duplicate])).rejects.toThrow();

    const awaited = client.record.findMany();
    await awaited;
    driver.events.splice(0);
    await expect(client.$transaction([awaited])).rejects.toThrow();

    const { client: foreignBase } = fallbackClient();
    const foreign = foreignBase.$extends({
      name: "foreign",
      async query({ proceed }) {
        return proceed();
      },
    });
    await expect(
      client.$transaction([foreign.record.findMany()])
    ).rejects.toThrow();

    await client.$transaction(async (tx) => {
      await expect(
        tx.$transaction([client.record.findMany()])
      ).rejects.toThrow();
    });
    expect(providerStatements(driver.events)).toEqual([]);
  });
});

describe("public array lifecycle observers", () => {
  test("wraps ownership refusal in the outer batch lifecycle", async () => {
    const completions: Array<{
      readonly certainty: string | undefined;
      readonly status: string;
    }> = [];
    const { client: base, driver } = fallbackClient();
    const { client: foreign } = fallbackClient();
    const client = base.$extends({
      name: "ownership-observer",
      observe(unit, proceed) {
        if (unit.kind !== "batch") return;
        proceed().then((completion) => {
          completions.push({
            certainty: completion.commitCertainty,
            status: completion.status,
          });
        });
      },
    });

    await expect(
      client.$transaction([foreign.record.findMany()])
    ).rejects.toThrow();
    await Promise.resolve();
    expect(providerStatements(driver.events)).toEqual([]);
    expect(completions).toEqual([{ certainty: undefined, status: "failure" }]);
  });

  test("reports a hostile snapshot read through the outer batch lifecycle", async () => {
    const failure = new Error("hostile candidate copy");
    const completions: string[] = [];
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "snapshot-failure-observer",
      observe(unit, proceed) {
        if (unit.kind !== "batch") return;
        proceed().then((completion) => {
          completions.push(completion.status);
        });
      },
    });
    let lengthReads = 0;
    let memberReads = 0;
    const candidates = new Proxy<unknown[]>([client.record.findMany()], {
      get(target, key, receiver) {
        if (key === "length") lengthReads += 1;
        if (key === "0") {
          memberReads += 1;
          throw failure;
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const caught = await runUnsafeArrayTransaction(client, candidates).catch(
      (error) => error
    );
    await Promise.resolve();
    expect({ caught, lengthReads, memberReads }).toEqual({
      caught: failure,
      lengthReads: 1,
      memberReads: 1,
    });
    expect(providerStatements(driver.events)).toEqual([]);
    expect(completions).toEqual(["failure"]);
  });

  test("rejects a hostile non-number length after one observed read", async () => {
    const completions: string[] = [];
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "snapshot-length-failure-observer",
      observe(unit, proceed) {
        if (unit.kind !== "batch") return;
        proceed().then((completion) => {
          completions.push(completion.status);
        });
      },
    });
    let lengthReads = 0;
    let memberReads = 0;
    const candidates = new Proxy<unknown[]>([client.record.findMany()], {
      get(target, key, receiver) {
        if (key === "length") {
          lengthReads += 1;
          return "1";
        }
        if (key === "0") memberReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    const caught = await runUnsafeArrayTransaction(client, candidates).catch(
      (error) => error
    );
    await Promise.resolve();
    expect({ caught, lengthReads, memberReads }).toEqual({
      caught: expect.any(InvalidTransactionInputError),
      lengthReads: 1,
      memberReads: 0,
    });
    expect(providerStatements(driver.events)).toEqual([]);
    expect(completions).toEqual(["failure"]);
  });

  test("contains a rejected private operation-observer application", async () => {
    const operationCompletions: string[] = [];
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "rejected-operation-observer",
      query: {
        record: {
          async findMany({ proceed }) {
            await proceed();
            throw new Error("query post-work failed");
          },
        },
      },
      observe(unit, proceed) {
        if (unit.kind !== "operation") return;
        proceed().then((completion) => {
          operationCompletions.push(completion.status);
        });
      },
    });

    await expect(
      client.$transaction([client.record.findMany()])
    ).rejects.toThrow();
    await Promise.resolve();
    expect(providerStatements(driver.events)).toHaveLength(1);
    expect(operationCompletions).toEqual(["failure"]);
  });

  test("starts fallback statement observers before transforms and contains transform failure", async () => {
    const timeline: string[] = [];
    const { client: base, driver } = fallbackClient();
    let statementUnits = 0;
    let transformCalls = 0;
    const client = base.$extends({
      name: "fallback-statement-order",
      statement({ statement }) {
        transformCalls += 1;
        timeline.push(`transform:${transformCalls}`);
        if (transformCalls === 2) {
          throw new Error("fallback transform failed");
        }
        return statement;
      },
      observe(unit, proceed) {
        if (unit.kind !== "statement") return;
        statementUnits += 1;
        const statementUnit = statementUnits;
        timeline.push(`statement:in:${statementUnit}`);
        proceed().then((completion) => {
          timeline.push(`statement:out:${statementUnit}:${completion.status}`);
        });
      },
    });
    const context = requireTransactionOperation(
      client.record.findMany()
    ).context;
    const first = driver._prepare(sql`SELECT 1`, context);
    const second = driver._prepare(sql`SELECT 2`, context);
    expect(transformCalls).toBe(0);

    await expect(
      driver._executeBatch([first, second], undefined, context)
    ).rejects.toBeInstanceOf(QueryError);
    await Promise.resolve();
    expect(driver.events[0]).toBe("BEGIN");
    expect(providerStatements(driver.events)).toHaveLength(1);
    expect(driver.events.at(-1)).toBe("ROLLBACK");
    expect(timeline.indexOf("statement:in:1")).toBeLessThan(
      timeline.indexOf("transform:1")
    );
    expect(timeline.indexOf("statement:in:2")).toBeLessThan(
      timeline.indexOf("transform:2")
    );
    expect(timeline).toEqual(
      expect.arrayContaining([
        "statement:in:1",
        "transform:1",
        "statement:out:1:success",
        "statement:in:2",
        "transform:2",
        "statement:out:2:failure",
      ])
    );
  });

  test("orders native statement onions before transforms and submits nothing on failure", async () => {
    const timeline: string[] = [];
    const { client: base, driver } = nativeClient();
    const client = base.$extends({
      name: "native-statement-order",
      statement({ operation, statement }) {
        timeline.push(`transform:${operation}`);
        if (operation === "count") throw new Error("native transform failed");
        return statement;
      },
      observe(unit, proceed) {
        if (unit.kind !== "statement") return;
        timeline.push(`statement:in:${unit.operation}`);
        proceed().then((completion) => {
          timeline.push(`statement:out:${unit.operation}:${completion.status}`);
        });
      },
    });
    const first = client.record.findMany();
    const second = client.record.count();
    expect(timeline).toEqual([]);

    await expect(client.$transaction([first, second])).rejects.toBeInstanceOf(
      QueryError
    );
    await Promise.resolve();
    expect(driver.events).toEqual([]);
    expect(timeline.slice(0, 4)).toEqual([
      "statement:in:findMany",
      "transform:findMany",
      "statement:in:count",
      "transform:count",
    ]);
    expect(timeline.slice(4)).toEqual([
      "statement:out:count:failure",
      "statement:out:findMany:failure",
    ]);
  });

  test("keeps prepared Sql provenance private from copied and hostile batch queries", async () => {
    const statementCompletions: string[] = [];
    let transformCalls = 0;
    const { client: base, driver } = nativeClient();
    const basePrepared = driver._prepare(
      sql`SELECT 0`,
      requireTransactionOperation(base.record.findMany()).context
    );
    expect(readPreparedStatement(basePrepared)).toBeUndefined();
    const client = base.$extends({
      name: "private-statement-provenance",
      statement({ statement }) {
        transformCalls += 1;
        return sql`${raw("/* transformed */ ")}${statement}`;
      },
      observe(unit, proceed) {
        if (unit.kind !== "statement") return;
        proceed().then((completion) => {
          statementCompletions.push(completion.status);
        });
      },
    });
    const context = requireTransactionOperation(
      client.record.findMany()
    ).context;
    const prepared = driver._prepare(sql`SELECT ${1} AS value`, context);

    expect(transformCalls).toBe(0);
    expect(Reflect.ownKeys(prepared)).toEqual(["sql", "params"]);
    expect(readPreparedStatement(prepared)).toBeDefined();
    const copied: BatchQuery = {
      sql: prepared.sql,
      params: [...(prepared.params ?? [])],
      context,
    };
    expect(readPreparedStatement(copied)).toBeUndefined();
    await driver._executeBatch([copied], undefined, context);
    expect(transformCalls).toBe(0);
    expect(driver.submittedQueries?.[0]?.sql).not.toContain("transformed");

    await driver._executeBatch([prepared], undefined, context);
    expect(transformCalls).toBe(1);
    expect(driver.submittedQueries?.[0]?.sql).toContain("transformed");

    const providerCalls = driver.events.length;
    const hostile = new Proxy<BatchQuery>(
      { sql: "SELECT 1", params: [], context },
      {
        get(target, key, receiver) {
          if (typeof key === "symbol") {
            throw new Error("hostile metadata read");
          }
          return Reflect.get(target, key, receiver);
        },
      }
    );
    await expect(
      driver._executeBatch([hostile], undefined, context)
    ).rejects.toThrow();
    await Promise.resolve();
    expect(driver.events).toHaveLength(providerCalls);
    expect(transformCalls).toBe(1);
    expect(statementCompletions).toEqual(["success", "success", "failure"]);
  });

  test("uses the legacy fallback path with one batch, member, and physical-statement unit", async () => {
    const units: Array<{
      readonly kind: string;
      readonly model?: string;
      readonly operation?: string;
    }> = [];
    const completions: Array<{
      readonly kind: string;
      readonly operation: string | undefined;
      readonly certainty: string | undefined;
      readonly status: string;
    }> = [];
    const { client: base, driver } = fallbackClient();
    const client = base.$extends({
      name: "fallback-observer",
      observe(unit, proceed) {
        units.push(unit);
        proceed().then((completion) => {
          completions.push({
            kind: unit.kind,
            operation: unit.operation,
            certainty: completion.commitCertainty,
            status: completion.status,
          });
        });
      },
    });
    const read = client.record.findMany();
    const write = client.$executeRawUnsafe(
      "UPDATE record SET name = ?",
      "fallback"
    );

    expect(readTestTransactionOperation(read)?.requiresInterception()).toBe(
      false
    );
    expect(readTestTransactionOperation(write)?.requiresInterception()).toBe(
      false
    );
    const result = await client.$transaction([read, write]);
    await Promise.resolve();

    expect(result[0]).toEqual([{ id: "row", name: "value" }]);
    expect(result[1]).toBe(1);
    expect(units.filter((unit) => unit.kind === "batch")).toHaveLength(1);
    expect(units.filter((unit) => unit.kind === "operation")).toHaveLength(2);
    expect(units.filter((unit) => unit.kind === "statement")).toHaveLength(2);
    expect(providerStatements(driver.events)).toHaveLength(2);
    expect(completions).toContainEqual({
      kind: "batch",
      operation: "$transaction([...])",
      certainty: "committed",
      status: "success",
    });
    expect(
      completions
        .filter((completion) => completion.kind === "operation")
        .every((completion) => completion.certainty === undefined)
    ).toBe(true);
  });

  test("keeps observe-only native admission private and reports exact commit facts", async () => {
    const units: string[] = [];
    const completions: Array<{
      readonly unit: string;
      readonly certainty: string | undefined;
      readonly status: string;
    }> = [];
    const { client: base, driver } = nativeClient();
    const client = base.$extends({
      name: "native-observer",
      observe(unit, proceed) {
        const key = `${unit.kind}:${unit.operation ?? "none"}`;
        units.push(key);
        proceed().then((completion) => {
          completions.push({
            unit: key,
            certainty: completion.commitCertainty,
            status: completion.status,
          });
        });
      },
    });
    const write = client.$executeRawUnsafe(
      "UPDATE record SET name = ?",
      "native"
    );
    const read = client.record.findMany();

    expect(readTestTransactionOperation(write)?.requiresInterception()).toBe(
      false
    );
    expect(readTestTransactionOperation(read)?.requiresInterception()).toBe(
      false
    );
    expect(readTestTransactionOperation(write)?.hasObservation()).toBe(true);
    expect(readTestTransactionOperation(read)?.hasObservation()).toBe(true);
    const reflected = [write, read].flatMap((operation) => {
      const prototype = Reflect.getPrototypeOf(operation);
      return [
        ...Reflect.ownKeys(operation),
        ...(prototype ? Reflect.ownKeys(prototype) : []),
      ];
    });
    expect(reflected).not.toContain("observeArrayLifecycle");
    expect(reflected).not.toContain("observationToken");
    const result = await client.$transaction([write, read]);
    await Promise.resolve();

    expect(result[0]).toBe(1);
    expect(result[1]).toEqual([{ id: "row-1", name: "value-1" }]);
    expect(driver.events).toEqual(["provider"]);
    expect(units.filter((unit) => unit.startsWith("batch:"))).toHaveLength(1);
    expect(units.filter((unit) => unit.startsWith("operation:"))).toHaveLength(
      2
    );
    expect(units.filter((unit) => unit.startsWith("statement:"))).toHaveLength(
      2
    );
    expect(
      completions
        .filter(
          (completion) =>
            completion.unit.startsWith("batch:") ||
            completion.unit.startsWith("operation:")
        )
        .every((completion) => completion.certainty === "committed")
    ).toBe(true);

    completions.splice(0);
    const parseFailure = new Error("native parse failed");
    const parsing = overrideTransactionOperation(client.record.findMany(), {
      parseResult: () => {
        throw parseFailure;
      },
    });
    const parsingFailure = await captureFailure(
      runUnsafeArrayTransaction(client, [parsing])
    );
    expect(parsingFailure).toBeInstanceOf(QueryError);
    await Promise.resolve();
    expect(completions).toEqual(
      expect.arrayContaining([
        {
          unit: "operation:findMany",
          certainty: "committed",
          status: "failure",
        },
        {
          unit: "batch:$transaction([...])",
          certainty: "committed",
          status: "failure",
        },
      ])
    );

    completions.splice(0);
    driver.failProvider = new Error("native dispatch failed");
    const failedWrite = client.$executeRawUnsafe(
      "UPDATE record SET name = 'x'"
    );
    await expect(client.$transaction([failedWrite])).rejects.toThrow();
    await Promise.resolve();
    expect(completions).toContainEqual({
      unit: "batch:$transaction([...])",
      certainty: "may-have-committed",
      status: "failure",
    });
    expect(completions).toContainEqual({
      unit: "operation:$executeRawUnsafe",
      certainty: "may-have-committed",
      status: "failure",
    });
  });

  test("reports committed after native query post-work fails", async () => {
    const completions: Array<{
      readonly kind: string;
      readonly certainty: string | undefined;
      readonly status: string;
    }> = [];
    const { client: base } = nativeClient();
    const client = base.$extends({
      name: "post-work-observer",
      query: {
        record: {
          async findMany({ proceed }) {
            await proceed();
            throw new Error("post-work failed");
          },
        },
      },
      observe(unit, proceed) {
        if (unit.kind !== "operation" && unit.kind !== "batch") return;
        proceed().then((completion) => {
          completions.push({
            kind: unit.kind,
            certainty: completion.commitCertainty,
            status: completion.status,
          });
        });
      },
    });

    await expect(
      client.$transaction([client.record.findMany()])
    ).rejects.toThrow();
    await Promise.resolve();
    expect(completions).toEqual(
      expect.arrayContaining([
        { kind: "operation", certainty: "committed", status: "failure" },
        { kind: "batch", certainty: "committed", status: "failure" },
      ])
    );
  });

  test("contains hostile observers without duplicating fallback effects", async () => {
    const never = new Promise<never>(() => undefined);
    const { client: base, driver } = fallbackClient();
    let doubleProceedStayedIdempotent = true;
    const client = base
      .$extends({
        name: "array-no-proceed",
        observe() {
          return { fabricated: true };
        },
      })
      .$extends({
        name: "array-double-proceed",
        observe(_unit, proceed) {
          const firstCompletion = proceed();
          doubleProceedStayedIdempotent &&= firstCompletion === proceed();
          return "fabricated";
        },
      })
      .$extends({
        name: "array-throw",
        observe(_unit, proceed) {
          proceed();
          throw new Error("observer failed");
        },
      })
      .$extends({
        name: "array-never",
        observe(_unit, proceed) {
          proceed();
          return never;
        },
      });

    await expect(
      client.$transaction([
        client.record.findMany(),
        client.$queryRawUnsafe("SELECT 1"),
      ])
    ).resolves.toHaveLength(2);
    expect(providerStatements(driver.events)).toHaveLength(2);
    expect(doubleProceedStayedIdempotent).toBe(true);
  });

  test("does not claim a durable commit for a nested savepoint batch", async () => {
    const certainties: Array<string | undefined> = [];
    const { client: base } = fallbackClient();
    const client = base.$extends({
      name: "nested-observer",
      observe(unit, proceed) {
        if (unit.kind !== "batch") return;
        proceed().then((completion) => {
          certainties.push(completion.commitCertainty);
        });
      },
    });

    await client.$transaction((tx) =>
      tx.$transaction([tx.$executeRawUnsafe("UPDATE record SET name = 'x'")])
    );
    await Promise.resolve();
    expect(certainties).toEqual([undefined]);
  });
});
