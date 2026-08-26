import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { Driver } from "@drivers";
import { getExecutionTransactionPhases } from "@drivers/execution-context";
import { runTransactionLifecycle } from "@drivers/shared/transactions";
import { QueryError, ValidationError } from "@errors";
import { s } from "@schema";
import { Sql, sql } from "@sql";
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
const schema = { note, record };

class QueryIntegrationDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly events: string[] = [];
  readonly submissions: Array<{ sql: string; params: unknown[] }> = [];
  lastTransactionHadPhases = false;
  outcomeEvents: string[] | undefined;
  private nextFailure: Error | undefined;
  private nextCommitFailure: Error | undefined;
  private nextCloseFailure: Error | undefined;
  private selectRows: unknown[] | undefined;

  constructor() {
    super("sqlite", "query-interceptor-test");
    this.client = {};
  }

  failNext(error: Error): void {
    this.nextFailure = error;
  }

  failNextCommit(error: Error): void {
    this.nextCommitFailure = error;
  }

  failNextTransactionClose(error: Error): void {
    this.nextCloseFailure = error;
  }

  respondToSelectsWith(rows: unknown[]): void {
    this.selectRows = rows;
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to close.
  }

  protected async execute<T>(
    _client: object,
    sql: string,
    params: unknown[] | undefined,
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.events.push(sql);
    this.submissions.push({ sql, params: params ? [...params] : [] });
    this.outcomeEvents?.push("provider");
    const failure = this.nextFailure;
    this.nextFailure = undefined;
    if (failure) throw failure;
    const rows = sql.trimStart().startsWith("SELECT")
      ? (this.selectRows ?? [])
      : [];
    return { rows: rows as T[], rowCount: 1 };
  }

  protected executeRaw<T>(
    client: object,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute(client, sql, params, context);
  }

  protected transaction<T>(
    client: object,
    fn: (transaction: object) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    const phases = getExecutionTransactionPhases(context);
    this.lastTransactionHadPhases = phases !== undefined;
    return runTransactionLifecycle({
      begin: () => this.events.push("BEGIN"),
      callback: () => fn(client),
      commit: () => {
        this.events.push("COMMIT");
        const failure = this.nextCommitFailure;
        this.nextCommitFailure = undefined;
        if (failure) throw failure;
      },
      rollback: () => this.events.push("ROLLBACK"),
      phases,
      close: () => {
        const failure = this.nextCloseFailure;
        this.nextCloseFailure = undefined;
        if (failure) throw failure;
      },
    });
  }
}

class PhaseBlindTransactionDriver extends QueryIntegrationDriver {
  protected override async transaction<T>(
    client: object,
    fn: (transaction: object) => Promise<T>,
    _context?: QueryExecutionContext
  ): Promise<T> {
    this.events.push("BEGIN");
    try {
      const result = await fn(client);
      this.events.push("COMMIT");
      return result;
    } catch (error) {
      this.events.push("ROLLBACK");
      throw error;
    }
  }
}

class QueryInvalidationCache extends MemoryCache {
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

function integrationClient(options?: {
  readonly driver?: QueryIntegrationDriver;
}) {
  const driver = options?.driver ?? new QueryIntegrationDriver();
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

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("public query-interceptor integration", () => {
  test("preserves the zero-query-handler argument and promise path", async () => {
    const args = { where: { name: "Ada" } };
    const { client: base, driver } = integrationClient();
    const client = base.$extends({
      name: "methods-only",
      client: () => ({ $ready: () => true }),
    });
    const operation = client.record.findMany(args);

    expect(operation.getArgs()).toBe(args);
    await Promise.all([Promise.resolve(operation), Promise.resolve(operation)]);
    expect(driver.submissions).toHaveLength(1);
  });

  test("keeps empty query maps off the callback transaction machinery", async () => {
    const { client: base, driver } = integrationClient();
    const client = base
      .$extends({ name: "empty-query", query: {} })
      .$extends({ name: "empty-model-query", query: { record: {} } });

    await expect(client.$transaction(async () => "ok")).resolves.toBe("ok");
    expect(driver.lastTransactionHadPhases).toBe(false);
  });

  test("stays lazy, validates first, snapshots input, and runs once in application order", async () => {
    const order: string[] = [];
    const callerWhere = { name: "Ada" };
    const { client: base, driver } = integrationClient();
    const client = base
      .$extends({
        name: "A",
        query: {
          record: {
            async findMany({ input, mode, proceed }) {
              order.push(`A-in:${mode}`);
              expect(Object.isFrozen(input)).toBe(true);
              expect(Object.isFrozen(input.where)).toBe(true);
              expect(input.where).not.toBe(callerWhere);
              const rows = await proceed();
              order.push("A-out");
              return rows;
            },
          },
        },
      })
      .$extends({
        name: "B",
        async query({ proceed }) {
          order.push("B-in");
          const result = await proceed();
          order.push("B-out");
          return result;
        },
      })
      .$extends({
        name: "C",
        query: {
          record: {
            async findMany({ proceed }) {
              order.push("C-in");
              const rows = await proceed();
              order.push("C-out");
              return rows;
            },
          },
        },
      });

    const operation = client.record.findMany({ where: callerWhere });
    expect(order).toEqual([]);
    expect(driver.events).toEqual([]);

    await Promise.all([operation.then(() => undefined), operation.finally()]);
    expect(order).toEqual([
      "A-in:direct",
      "B-in",
      "C-in",
      "C-out",
      "B-out",
      "A-out",
    ]);
    expect(driver.events).toHaveLength(1);
    expect(callerWhere).toEqual({ name: "Ada" });

    const handlerCalls = order.length;
    const invalid = Reflect.apply(client.record.findMany, client.record, [
      { take: "invalid" },
    ]);
    await expect(invalid).rejects.toBeInstanceOf(ValidationError);
    expect(order).toHaveLength(handlerCalls);
  });

  test("permits direct and callback reads to short-circuit after preparation", async () => {
    const modes: string[] = [];
    const { client: base, driver } = integrationClient();
    const client = applyUnsafeExtension(base, {
      name: "read-policy",
      query: {
        record: {
          async findMany({
            mode,
          }: {
            readonly mode: "direct" | "transaction" | "array";
          }) {
            modes.push(mode);
            return [{ id: mode, name: "short" }];
          },
        },
      },
    });

    await expect(client.record.findMany()).resolves.toEqual([
      { id: "direct", name: "short" },
    ]);
    await expect(
      client.$transaction(async (tx) => tx.record.findMany())
    ).resolves.toEqual([{ id: "transaction", name: "short" }]);
    expect(modes).toEqual(["direct", "transaction"]);
    expect(driver.events.filter((event) => event.startsWith("SELECT"))).toEqual(
      []
    );
  });

  test("requires proceed for mutations and raw operations after raw validation", async () => {
    let rawHandlerCalls = 0;
    const { client: base, driver } = integrationClient();
    const client = applyUnsafeExtension(base, {
      name: "mandatory-proceed",
      async query({ kind }: { kind: string }) {
        if (kind !== "model") rawHandlerCalls += 1;
        return kind === "model" ? { count: 99 } : [];
      },
    });

    await expect(
      client.record.deleteMany({ where: { id: "record-1" } })
    ).rejects.toBeInstanceOf(QueryError);
    await expect(client.$queryRawUnsafe("SELECT 1")).rejects.toBeInstanceOf(
      QueryError
    );
    expect(driver.events).toEqual([]);

    const rawMethod: CallableFunction = client.$queryRaw;
    const invalidRaw = Reflect.apply(rawMethod, client, [{}]);
    await expect(invalidRaw).rejects.toBeInstanceOf(QueryError);
    expect(rawHandlerCalls).toBe(1);
  });

  test("detaches every mutable safe-raw inspection surface from provider input", async () => {
    const nestedDate = new Date("2026-08-25T12:00:00.000Z");
    const nestedBytes = new Uint8Array([1, 2, 3]);
    const parameter = {
      label: "provider",
      nested: [{ date: nestedDate, bytes: nestedBytes }],
    };
    const directDate = new Date("2026-08-25T13:00:00.000Z");
    const directBytes = new Uint8Array([4, 5, 6]);
    const fragment = sql`SELECT ${parameter}, ${directDate}, ${directBytes}`;
    const { client: base, driver } = integrationClient();
    const client = base.$extends({
      name: "raw-inspection-isolation",
      async query({ kind, input, proceed }) {
        if (kind !== "queryRaw") return proceed();
        const inspectionQuery = Reflect.get(input, "query");
        expect(inspectionQuery).toBeInstanceOf(Sql);
        if (!(inspectionQuery instanceof Sql)) throw new Error("Expected Sql");
        expect(inspectionQuery).not.toBe(fragment);
        expect(Object.isFrozen(inspectionQuery)).toBe(true);
        expect(Object.isFrozen(inspectionQuery.strings)).toBe(true);
        expect(Object.isFrozen(inspectionQuery.values)).toBe(true);

        Reflect.set(inspectionQuery.strings, 0, "SELECT 'hijacked'");
        Reflect.set(inspectionQuery.values, 0, "hijacked");
        const inspectedParameter = inspectionQuery.values[0];
        if (
          inspectedParameter === null ||
          typeof inspectedParameter !== "object"
        ) {
          throw new Error("Expected detached raw parameter");
        }
        Reflect.set(inspectedParameter, "label", "hijacked");
        const inspectedNested = Reflect.get(inspectedParameter, "nested");
        if (!Array.isArray(inspectedNested)) {
          throw new Error("Expected detached nested parameter array");
        }
        const inspectedMember = inspectedNested[0];
        if (inspectedMember && typeof inspectedMember === "object") {
          const date = Reflect.get(inspectedMember, "date");
          if (date instanceof Date) date.setTime(0);
          const bytes = Reflect.get(inspectedMember, "bytes");
          if (bytes instanceof Uint8Array) bytes[0] = 99;
        }
        Reflect.set(inspectedNested, 0, "hijacked");
        const date = inspectionQuery.values[1];
        if (date instanceof Date) date.setTime(0);
        const bytes = inspectionQuery.values[2];
        if (bytes instanceof Uint8Array) bytes[0] = 99;
        return proceed();
      },
    });

    await client.$queryRaw(fragment);

    expect(driver.submissions).toHaveLength(1);
    expect(driver.submissions[0]).toEqual({
      sql: "SELECT ?, ?, ?",
      params: [parameter, directDate, directBytes],
    });
    expect(parameter).toEqual({
      label: "provider",
      nested: [{ date: nestedDate, bytes: nestedBytes }],
    });
    expect(nestedDate.toISOString()).toBe("2026-08-25T12:00:00.000Z");
    expect([...nestedBytes]).toEqual([1, 2, 3]);
    expect(directDate.toISOString()).toBe("2026-08-25T13:00:00.000Z");
    expect([...directBytes]).toEqual([4, 5, 6]);
  });

  test("discloses accessors, callables, and hostile prototypes opaquely", async () => {
    let getterReads = 0;
    const accessorParameter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "caller-secret";
      },
    });
    const callableParameter = vi.fn(() => "caller-authority");
    class CallerPrototype {
      readonly exposed = "caller-prototype";
    }
    const prototypeParameter = new CallerPrototype();
    const fragment = sql`SELECT ${accessorParameter}, ${callableParameter}, ${prototypeParameter}`;
    const { client: base, driver } = integrationClient();
    const client = base.$extends({
      name: "raw-opaque-disclosure",
      async query({ kind, input, proceed }) {
        if (kind !== "queryRaw") return proceed();
        const inspectionQuery = Reflect.get(input, "query");
        if (!(inspectionQuery instanceof Sql)) throw new Error("Expected Sql");
        const [accessor, callable, prototype] = inspectionQuery.values;
        if (
          accessor === null ||
          typeof accessor !== "object" ||
          callable === null ||
          typeof callable !== "object" ||
          prototype === null ||
          typeof prototype !== "object"
        ) {
          throw new Error("Expected opaque inspection values");
        }
        expect(getterReads).toBe(0);
        expect(Object.getPrototypeOf(accessor)).toBeNull();
        expect(Reflect.get(accessor, "secret")).not.toBe("caller-secret");
        expect(typeof callable).not.toBe("function");
        expect(Object.getPrototypeOf(callable)).toBeNull();
        expect(Object.getPrototypeOf(prototype)).toBeNull();
        expect(Reflect.get(prototype, "exposed")).toBeUndefined();
        return proceed();
      },
    });

    await client.$queryRaw(fragment);

    expect(getterReads).toBe(0);
    expect(callableParameter).not.toHaveBeenCalled();
    expect(driver.submissions[0]?.params).toEqual([
      accessorParameter,
      callableParameter,
      prototypeParameter,
    ]);
  });

  test("inspects the operation-owned payload without re-reading caller accessors", async () => {
    let callerReads = 0;
    const args = Object.defineProperty({}, "where", {
      enumerable: true,
      get: () => {
        callerReads += 1;
        return { name: "Ada" };
      },
    });
    const { client: base } = integrationClient();
    const client = base.$extends({
      name: "canonical-model-input",
      query: {
        record: {
          async findMany({ input, proceed }) {
            expect(callerReads).toBe(1);
            expect(input.where).toEqual({ name: { equals: "Ada" } });
            return proceed();
          },
        },
      },
    });

    await Reflect.apply(client.record.findMany, client.record, [args]);
    expect(callerReads).toBe(1);
  });

  test("detaches model Sql operands before query inspection", async () => {
    const operand = sql`${"Ada"}`;
    const { client: base, driver } = integrationClient();
    const client = base.$extends({
      name: "model-sql-inspection-isolation",
      query: {
        record: {
          async findMany({ input, proceed }) {
            const where = Reflect.get(input, "where");
            if (where === null || typeof where !== "object") {
              throw new Error("Expected detached where input");
            }
            const name = Reflect.get(where, "name");
            if (name === null || typeof name !== "object") {
              throw new Error("Expected detached name filter");
            }
            const inspectedOperand = Reflect.get(name, "equals");
            expect(inspectedOperand).toBeInstanceOf(Sql);
            expect(inspectedOperand).not.toBe(operand);
            if (inspectedOperand instanceof Sql) {
              Reflect.set(inspectedOperand.strings, 0, "'hijacked'");
              Reflect.set(inspectedOperand.values, 0, "hijacked");
            }
            return proceed();
          },
        },
      },
    });

    await client.record.findMany({ where: { name: { equals: operand } } });

    expect(driver.submissions).toHaveLength(1);
    expect(driver.submissions[0]?.params).toEqual(["Ada"]);
  });

  test("runs query outside cache invalidation and publishes direct outcomes in order", async () => {
    const events: string[] = [];
    const cache = new QueryInvalidationCache(() => {
      events.push("cache");
    });
    const { client: unextended, driver } = integrationClient();
    const base = unextended.$extends(cacheExtension({ driver: cache }));
    driver.outcomeEvents = events;
    const client = base
      .$extends({
        name: "A",
        query: {
          record: {
            async deleteMany({ onWriteOutcome, proceed }) {
              events.push("A-in");
              onWriteOutcome(({ certainty }) => events.push(`A:${certainty}`));
              const result = await proceed();
              events.push("A-out");
              return result;
            },
          },
        },
      })
      .$extends({
        name: "B",
        async query({ kind, onWriteOutcome, proceed }) {
          if (kind === "model") {
            onWriteOutcome(({ certainty }) => events.push(`B:${certainty}`));
          }
          return proceed();
        },
      });

    await expect(
      client.record.deleteMany({
        where: { id: "record-1" },
        cache: { autoInvalidate: true },
      })
    ).resolves.toEqual({ count: 1 });
    expect(events).toEqual([
      "A-in",
      "provider",
      "cache",
      "A:committed",
      "B:committed",
      "A-out",
    ]);
  });

  test("keeps provider failure primary when may-have-committed listeners fail", async () => {
    const providerFailure = new Error("provider lost acknowledgement");
    const certainties: string[] = [];
    const { client: base, driver } = integrationClient();
    driver.failNext(providerFailure);
    const client = base.$extends({
      name: "outcome-failure",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) => {
              certainties.push(certainty);
              throw new Error("listener failed");
            });
            return proceed();
          },
        },
      },
    });

    const failure = await client.record.deleteMany().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.cause).toBeInstanceOf(QueryError);
    expect(failure.errors[0]).toBe(failure.cause);
    expect(failure.errors[0]).toMatchObject({
      originalCause: expect.any(Error),
    });
    expect(failure.errors[1]).toBeInstanceOf(QueryError);
    expect(failure.errors[1]).toMatchObject({
      meta: expect.objectContaining({
        commitCertainty: "may-have-committed",
      }),
    });
    expect(certainties).toEqual(["may-have-committed"]);
  });

  test("labels direct write post-work as committed but not reads or rolled-back callbacks", async () => {
    const postWorkFailure = new Error("post-work failed");
    const { client: base } = integrationClient();
    const client = base.$extends({
      name: "post-work-certainty",
      query: {
        record: {
          async deleteMany({ proceed }) {
            await proceed();
            throw postWorkFailure;
          },
          async findMany({ proceed }) {
            await proceed();
            throw postWorkFailure;
          },
        },
      },
    });

    const directWrite = await client.record.deleteMany().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(directWrite).toBeInstanceOf(QueryError);
    expect(directWrite).toMatchObject({
      meta: expect.objectContaining({ commitCertainty: "committed" }),
      originalCause: expect.any(Error),
    });

    const directRead = await client.record.findMany().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(directRead).toBeInstanceOf(QueryError);
    expect(directRead).not.toMatchObject({
      meta: expect.objectContaining({ commitCertainty: expect.any(String) }),
    });

    const callbackWrite = await client
      .$transaction(async (tx) => tx.record.deleteMany())
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(callbackWrite).toBeInstanceOf(QueryError);
    expect(callbackWrite).not.toMatchObject({
      meta: expect.objectContaining({ commitCertainty: expect.any(String) }),
    });
  });

  test("retains undefined cache and listener failures from one commit callback", async () => {
    const cache = new QueryInvalidationCache(() => Promise.reject(undefined));
    const { client: unextended } = integrationClient();
    const base = unextended.$extends(cacheExtension({ driver: cache }));
    const client = base.$extends({
      name: "undefined-failure",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(() => Promise.reject(undefined));
            return proceed();
          },
        },
      },
    });

    const failure = await client.record
      .deleteMany({ cache: { autoInvalidate: true } })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors[0]).toBeInstanceOf(Error);
    expect(failure.errors[1]).toBeInstanceOf(QueryError);
    expect(failure.errors[1]).toMatchObject({
      originalCause: expect.any(Error),
    });
  });

  test("promotes nested savepoint outcomes and discards rolled-back outcomes", async () => {
    const outcomes: string[] = [];
    const { client: base, driver } = integrationClient();
    const client = base.$extends({
      name: "transaction-outcomes",
      query: {
        record: {
          async deleteMany({ mode, onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) =>
              outcomes.push(`${mode}:${certainty}`)
            );
            return proceed();
          },
        },
      },
    });

    await client.$transaction(async (tx) => {
      await tx.$transaction(async (nested) => {
        await nested.record.deleteMany({ where: { id: "kept" } });
      });
      expect(outcomes).toEqual([]);

      await tx
        .$transaction(async (nested) => {
          await nested.record.deleteMany({ where: { id: "discarded" } });
          throw new Error("rollback nested");
        })
        .catch(() => undefined);
      expect(outcomes).toEqual([]);
    });

    expect(outcomes).toEqual(["transaction:committed"]);
    expect(driver.events.at(-1)).toBe("COMMIT");
  });

  test("attempts every callback listener after commit in registration order", async () => {
    const calls: string[] = [];
    const { client: base, driver } = integrationClient();
    const client = base
      .$extends({
        name: "first",
        query: {
          record: {
            async deleteMany({ onWriteOutcome, proceed }) {
              onWriteOutcome(() => {
                calls.push("first");
                throw new Error("first failed");
              });
              return proceed();
            },
          },
        },
      })
      .$extends({
        name: "second",
        query: {
          record: {
            async deleteMany({ onWriteOutcome, proceed }) {
              onWriteOutcome(() => {
                calls.push("second");
                throw new Error("second failed");
              });
              return proceed();
            },
          },
        },
      });

    const failure = await client
      .$transaction(async (tx) => tx.record.deleteMany())
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(driver.events.at(-1)).toBe("COMMIT");
    expect(calls).toEqual(["first", "second"]);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({ commitCertainty: "committed" }),
      }),
      expect.objectContaining({
        meta: expect.objectContaining({ commitCertainty: "committed" }),
      }),
    ]);
  });

  test("contains a hostile Error proxy at the committed write-outcome boundary", async () => {
    const hostileFailure = new Proxy(
      new Error("private write-outcome failure"),
      {
        getPrototypeOf() {
          throw new Error("hostile write-outcome prototype read");
        },
      }
    );
    const { client: base, driver } = integrationClient();
    const client = base.$extends({
      name: "hostile-write-outcome-error",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(() => {
              throw hostileFailure;
            });
            return proceed();
          },
        },
      },
    });

    const failure = await client.record.deleteMany().then(
      () => undefined,
      (error: unknown) => error
    );

    expect(driver.submissions).toHaveLength(1);
    expect(failure).toBeInstanceOf(QueryError);
    if (!(failure instanceof QueryError)) throw failure;
    expect(failure.message).toContain(
      'Extension "hostile-write-outcome-error" write-outcome listener failed'
    );
    expect(failure.meta).toMatchObject({
      method: "onWriteOutcome",
      commitCertainty: "committed",
    });
    expect(failure.originalCause).toBeInstanceOf(Error);
    expect(failure.originalCause).not.toBe(hostileFailure);
  });

  test("discards outcomes when a tracked operation fails before the commit boundary", async () => {
    const certainties: string[] = [];
    let operationFailure: unknown;
    const { client: base, driver } = integrationClient();
    driver.failNext(new Error("tracked operation failed"));
    const client = base.$extends({
      name: "tracked-precommit-failure",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) => certainties.push(certainty));
            return proceed();
          },
        },
      },
    });

    await expect(
      client.$transaction(async (tx) => {
        tx.record.deleteMany().catch((error: unknown) => {
          operationFailure = error;
        });
        return "callback completed";
      })
    ).rejects.toBeInstanceOf(QueryError);

    expect(operationFailure).toBeInstanceOf(QueryError);
    expect(certainties).toEqual([]);
    expect(driver.events.at(-1)).toBe("ROLLBACK");
    expect(driver.events).not.toContain("COMMIT");
  });

  test("publishes may-have-committed after callback body success and commit failure", async () => {
    const commitFailure = new Error("commit acknowledgement lost");
    const certainties: string[] = [];
    const { client: base, driver } = integrationClient();
    driver.failNextCommit(commitFailure);
    const client = base.$extends({
      name: "commit-ambiguity",
      query: {
        record: {
          async deleteMany({ onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) => {
              certainties.push(certainty);
              throw new Error("outcome listener failed");
            });
            return proceed();
          },
        },
      },
    });

    const failure = await client
      .$transaction(async (tx) => tx.record.deleteMany())
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.cause).toBeInstanceOf(QueryError);
    expect(failure.errors[0]).toBe(failure.cause);
    expect(failure.errors[0]).toMatchObject({
      originalCause: expect.any(Error),
    });
    expect(failure.errors[1]).toBeInstanceOf(QueryError);
    expect(failure.errors[1]).toMatchObject({
      meta: expect.objectContaining({
        commitCertainty: "may-have-committed",
      }),
    });
    expect(certainties).toEqual(["may-have-committed"]);
  });

  test("reports commit ambiguity for a direct composed write transaction", async () => {
    const commitFailure = new Error("direct commit acknowledgement lost");
    const certainties: string[] = [];
    const { client: base, driver } = integrationClient();
    driver.respondToSelectsWith([{ id: "record-direct-ambiguous" }]);
    driver.failNextCommit(commitFailure);
    const client = base.$extends({
      name: "direct-composed-ambiguity",
      query: {
        record: {
          async create({ onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) => certainties.push(certainty));
            return proceed();
          },
        },
      },
    });

    const failure = await client.record
      .create({
        data: {
          id: "record-direct-ambiguous",
          name: "root",
          notes: { create: { id: "note-direct-ambiguous", body: "note" } },
        },
        select: { id: true },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(driver.events).toContain("BEGIN");
    expect(driver.events).toContain("COMMIT");
    expect(driver.events).toContain("ROLLBACK");
    expect(certainties).toEqual(["may-have-committed"]);
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure).toMatchObject({
      meta: expect.objectContaining({
        commitCertainty: "may-have-committed",
      }),
      originalCause: expect.any(Error),
    });
  });

  test("reports committed certainty when direct transaction cleanup fails after commit", async () => {
    const closeFailure = new Error("direct transaction close failed");
    const certainties: string[] = [];
    const { client: base, driver } = integrationClient();
    driver.respondToSelectsWith([{ id: "record-direct-committed" }]);
    driver.failNextTransactionClose(closeFailure);
    const client = base.$extends({
      name: "direct-composed-committed",
      query: {
        record: {
          async create({ onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) => certainties.push(certainty));
            return proceed();
          },
        },
      },
    });

    const failure = await client.record
      .create({
        data: {
          id: "record-direct-committed",
          name: "root",
          notes: { create: { id: "note-direct-committed", body: "note" } },
        },
        select: { id: true },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(driver.events).toContain("BEGIN");
    expect(driver.events.at(-1)).toBe("COMMIT");
    expect(certainties).toEqual(["committed"]);
    expect(failure).toBeInstanceOf(QueryError);
    expect(failure).toMatchObject({
      meta: expect.objectContaining({ commitCertainty: "committed" }),
      originalCause: expect.any(Error),
    });
  });

  test("publishes committed after a custom transaction fulfills without private phases", async () => {
    const certainties: string[] = [];
    const driver = new PhaseBlindTransactionDriver();
    driver.respondToSelectsWith([{ id: "record-phase-blind" }]);
    const { client: base } = integrationClient({ driver });
    const client = base.$extends({
      name: "phase-blind-commit",
      query: {
        record: {
          async create({ onWriteOutcome, proceed }) {
            onWriteOutcome(({ certainty }) => certainties.push(certainty));
            return proceed();
          },
        },
      },
    });

    await client.record.create({
      data: {
        id: "record-phase-blind",
        name: "root",
        notes: { create: { id: "note-phase-blind", body: "note" } },
      },
      select: { id: true },
    });

    expect(driver.events).toContain("COMMIT");
    expect(driver.lastTransactionHadPhases).toBe(false);
    expect(certainties).toEqual(["committed"]);
  });
});

describe("public protected operation and statement observers", () => {
  test("starts the operation observer before requestless lazy preparation fails", async () => {
    const timeline: string[] = [];
    const { client: base, driver } = integrationClient();
    const client = base.$extends({
      name: "preparation-observer",
      observe(unit, proceed) {
        if (unit.kind !== "operation") return;
        timeline.push("operation:in");
        proceed().then((completion) => {
          timeline.push(`operation:out:${completion.status}`);
        });
      },
    });

    // @ts-expect-error runtime guard covers invalid empty unique selector
    const operation = client.record.findUnique({ where: {} });
    expect(timeline).toEqual([]);

    await expect(operation).rejects.toBeInstanceOf(ValidationError);
    await Promise.resolve();
    expect(driver.submissions).toEqual([]);
    expect(timeline).toEqual(["operation:in", "operation:out:failure"]);
  });

  test("spans request through query post-work and observes the transformed statement", async () => {
    const timeline: string[] = [];
    const observedUnitKeys: PropertyKey[][] = [];
    let allUnitsFrozen = true;
    let allCompletionsFrozen = true;
    const { client: base, driver } = integrationClient();
    driver.outcomeEvents = timeline;
    const client = base.$extends({
      name: "ordered-observer",
      request: {
        record: {
          findMany() {
            timeline.push("request");
            return { take: 1 };
          },
        },
      },
      query: {
        record: {
          async findMany({ proceed }) {
            timeline.push("query:in");
            const result = await proceed();
            timeline.push("query:out");
            return result;
          },
        },
      },
      statement({ statement }) {
        timeline.push("transform");
        return statement;
      },
      observe(unit, proceed) {
        if (unit.kind !== "operation" && unit.kind !== "statement") return;
        allUnitsFrozen &&= Object.isFrozen(unit);
        observedUnitKeys.push(Reflect.ownKeys(unit));
        timeline.push(`${unit.kind}:in`);
        proceed().then((completion) => {
          allCompletionsFrozen &&= Object.isFrozen(completion);
          timeline.push(
            `${unit.kind}:out:${completion.status}:${completion.commitCertainty ?? "none"}`
          );
        });
      },
    });

    const operation = client.record.findMany({ where: { name: "Ada" } });
    expect(timeline).toEqual([]);
    await operation;
    await Promise.resolve();

    expect(allUnitsFrozen).toBe(true);
    expect(allCompletionsFrozen).toBe(true);
    expect(observedUnitKeys).toEqual([
      ["kind", "operation", "model"],
      ["kind", "operation", "model"],
    ]);
    expect(timeline).toEqual([
      "operation:in",
      "request",
      "query:in",
      "statement:in",
      "transform",
      "provider",
      "statement:out:success:none",
      "query:out",
      "operation:out:success:none",
    ]);
  });

  test("reports a synchronous transform failure through the statement observer", async () => {
    const timeline: string[] = [];
    const { client: base, driver } = integrationClient();
    const client = base.$extends({
      name: "failing-statement",
      statement() {
        timeline.push("transform");
        throw new Error("transform failed");
      },
      observe(unit, proceed) {
        if (unit.kind !== "statement") return;
        timeline.push("statement:in");
        proceed().then((completion) => {
          timeline.push(`statement:out:${completion.status}`);
        });
      },
    });

    await expect(client.record.findMany()).rejects.toBeInstanceOf(QueryError);
    await Promise.resolve();
    expect(driver.submissions).toEqual([]);
    expect(timeline).toEqual([
      "statement:in",
      "transform",
      "statement:out:failure",
    ]);
  });

  test("observes safe and unsafe raw statements without exposing their payload", async () => {
    const units: Array<{
      readonly kind: string;
      readonly model?: string;
      readonly operation?: string;
    }> = [];
    const completions: Array<{
      readonly operation: string | undefined;
      readonly certainty: string | undefined;
    }> = [];
    let transforms = 0;
    const { client: base } = integrationClient();
    const client = base.$extends({
      name: "raw-observer",
      statement({ statement }) {
        transforms += 1;
        return statement;
      },
      observe(unit, proceed) {
        if (unit.kind !== "operation" && unit.kind !== "statement") return;
        units.push(unit);
        proceed().then((completion) => {
          completions.push({
            operation: unit.operation,
            certainty: completion.commitCertainty,
          });
        });
      },
    });

    await client.$queryRaw(sql`SELECT ${1} AS value`);
    await client.$executeRawUnsafe("UPDATE record SET name = ?", "Ada");
    await Promise.resolve();

    expect(transforms).toBe(1);
    expect(
      units
        .filter((unit) => unit.kind === "statement")
        .map((unit) => Reflect.ownKeys(unit))
    ).toEqual([
      ["kind", "operation"],
      ["kind", "operation"],
    ]);
    expect(units.every((unit) => !("sql" in unit || "params" in unit))).toBe(
      true
    );
    expect(
      units
        .filter((unit) => unit.kind === "operation")
        .map((unit) => [unit.model, unit.operation])
    ).toEqual([
      [undefined, "$queryRaw"],
      [undefined, "$executeRawUnsafe"],
    ]);
    expect(completions).toContainEqual({
      operation: "$queryRaw",
      certainty: undefined,
    });
    expect(completions).toContainEqual({
      operation: "$executeRawUnsafe",
      certainty: "committed",
    });
  });

  test("keeps OrThrow caller spelling and publishes only sanitized failure metadata", async () => {
    let operationName: string | undefined;
    let observedFailure:
      | {
          readonly error?: Readonly<{
            readonly name: string;
            readonly message: string;
            readonly code?: string;
          }>;
          readonly status: string;
        }
      | undefined;
    const { client: base } = integrationClient();
    const client = base.$extends({
      name: "or-throw-observer",
      observe(unit, proceed) {
        if (unit.kind !== "operation") return;
        operationName = unit.operation;
        proceed().then((completion) => {
          observedFailure = completion;
        });
      },
    });

    await expect(
      client.record.findFirstOrThrow({ where: { name: "missing" } })
    ).rejects.toThrow();
    await Promise.resolve();
    expect(operationName).toBe("findFirstOrThrow");
    expect(observedFailure?.status).toBe("failure");
    expect(Object.isFrozen(observedFailure?.error)).toBe(true);
    expect("cause" in (observedFailure?.error ?? {})).toBe(false);
    expect("stack" in (observedFailure?.error ?? {})).toBe(false);
    expect("result" in (observedFailure ?? {})).toBe(false);
  });

  test("contains hostile observers and keeps callback writes pre-commit", async () => {
    const { client: base, driver } = integrationClient();
    const never = new Promise<never>(() => undefined);
    const callbackCertainties: Array<string | undefined> = [];
    let doubleProceedStayedIdempotent = true;
    const client = base
      .$extends({
        name: "completion-recorder",
        observe(unit, proceed) {
          const completion = proceed();
          if (unit.kind === "operation") {
            completion.then((summary) => {
              if (unit.operation === "$executeRawUnsafe") {
                callbackCertainties.push(summary.commitCertainty);
              }
            });
          }
        },
      })
      .$extends({
        name: "no-proceed",
        observe() {
          return { fabricated: true };
        },
      })
      .$extends({
        name: "double-proceed",
        observe(_unit, proceed) {
          const firstCompletion = proceed();
          doubleProceedStayedIdempotent &&= firstCompletion === proceed();
          return "fabricated";
        },
      })
      .$extends({
        name: "throwing-observer",
        observe(_unit, proceed) {
          proceed();
          throw new Error("observer failed");
        },
      })
      .$extends({
        name: "never-settling-observer",
        observe(_unit, proceed) {
          proceed();
          return never;
        },
      });

    await expect(client.record.findMany()).resolves.toEqual([]);
    const beforeTransaction = driver.submissions.length;
    await expect(
      client.$transaction((tx) =>
        tx.$executeRawUnsafe("UPDATE record SET name = ?", "Grace")
      )
    ).resolves.toBe(1);
    await Promise.resolve();
    expect(driver.submissions).toHaveLength(beforeTransaction + 1);
    expect(callbackCertainties).toEqual([undefined]);
    expect(doubleProceedStayedIdempotent).toBe(true);
  });
});
