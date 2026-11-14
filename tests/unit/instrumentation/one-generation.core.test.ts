/**
 * One generation of unit handlers, through the public vocabulary.
 *
 * The span order holds without `prewarm` under three rules, each pinned
 * here: a unit's child starts only when `next()` is called; the host waits
 * for the handler's promise; `$transaction([...])` waits until every member's
 * operation unit reached its child before it prepares any member. Then: the
 * core contains nothing a handler does (D5), a unit starts at its physical
 * boundary (one `statement` unit per send), the unit words read what the
 * producer holds, an extension emits units of its own (`work`, `note`,
 * `notes`), and `disclosure` carries the error policy.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { trace } from "@opentelemetry/api";
import {
  around,
  correlation,
  createClient,
  disclosure,
  driver,
  extension,
  failure,
  methods,
  note,
  notes,
  origin,
  parameters,
  run,
  s,
  sql,
  statement,
  statements,
  table,
  text,
  type UnitContext,
  type UnitOutcome,
  unit,
  work,
} from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import type { TracingSpan } from "@src/instrumentation/types";
import { afterEach, describe, expect, test } from "vitest";
import { type OtelRecorder, withOtelRecorder } from "./_capture";
import { StatementDriver } from "./_fake-driver";

const record = s
  .model({ id: s.string().id(), name: s.string() })
  .map("records");
const schema = { record };

/** One provider call for a whole array: a native batch. */
class NativeDriver extends StatementDriver {
  override readonly supportsBatch = true;
  override readonly supportsTransactions = false;
  readonly sent: string[] = [];

  protected override async executeBatch<T>(
    _client: object,
    queries: { sql: string }[]
  ) {
    this.sent.push(`batch:${queries.length}`);
    return queries.map(() => ({
      rows: [{ id: "record-1", name: "Ada" }] as T[],
      rowCount: 1,
    }));
  }
}

/** Records every SQL text the provider is handed, in order. */
class RecordingDriver extends StatementDriver {
  readonly sent: string[] = [];

  protected override async execute<T>(_client?: object, sqlText?: string) {
    this.sent.push(sqlText ?? "");
    return { rows: [{ id: "record-1", name: "Ada" }] as T[], rowCount: 1 };
  }

  protected override executeRaw<T>(client?: object, sqlText?: string) {
    return this.execute<T>(client, sqlText);
  }
}

let recorder: OtelRecorder | undefined;
afterEach(async () => {
  await recorder?.dispose();
  recorder = undefined;
});

const parentOf = (name: string) => {
  const span = recorder?.find(name);
  return span?.parentSpanContext?.spanId;
};
const idOf = (name: string) => recorder?.find(name)?.spanContext().spanId;

describe("span order without prewarm", () => {
  test("cold: the child waits for OTel, runs in the operation span, and the execute span is its child", async () => {
    recorder = withOtelRecorder();
    const active: (string | undefined)[] = [];
    const client = createClient({ schema, driver: new StatementDriver() })
      .$extends(instrumentation({ tracing: true }))
      .$extends(
        extension(
          "inner",
          unit(
            (_unit, next) => {
              active.push(trace.getActiveSpan()?.spanContext().spanId);
              return next();
            },
            ["operation"]
          )
        )
      );

    await client.record.findMany();

    expect(idOf("viborm.operation")).toBeDefined();
    expect(active).toEqual([idOf("viborm.operation")]);
    expect(parentOf("viborm.execute")).toBe(idOf("viborm.operation"));
  });

  test("warm: a second call nests the same way", async () => {
    recorder = withOtelRecorder();
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(instrumentation({ tracing: true }));
    await client.record.findMany();
    const traced = recorder;
    await traced.dispose();
    recorder = withOtelRecorder();

    await client.record.findMany();

    expect(parentOf("viborm.execute")).toBe(idOf("viborm.operation"));
  });

  test("an array waits until every member's unit reached its child before the provider", async () => {
    recorder = withOtelRecorder();
    const nativeDriver = new NativeDriver();
    const events = nativeDriver.sent;
    const client = createClient({ schema, driver: nativeDriver })
      .$extends(instrumentation({ tracing: true }))
      .$extends(
        extension(
          "members",
          unit(
            async (unitSeen, next) => {
              // A handler that waits before its child, as a cold tracer does.
              await new Promise((resolve) => setTimeout(resolve, 5));
              events.push(`enter:${unitSeen.model}`);
              return next();
            },
            ["operation"]
          )
        )
      );

    await client.$transaction([
      client.record.findMany(),
      client.record.findMany(),
    ]);

    // Each member's unit reaches its child before the batch is sent.
    expect(events).toEqual(["enter:record", "enter:record", "batch:2"]);
    const operations = (recorder?.spans() ?? []).filter(
      (span) => span.name === "viborm.operation"
    );
    expect(operations).toHaveLength(2);
  });

  test("a Workers-like tracer nests execute under operation", async () => {
    const storage = new AsyncLocalStorage<string>();
    const spans: { name: string; parent: string | undefined }[] = [];
    let next = 0;
    const tracer = {
      startActiveSpan<T>(name: string, fn: (span: TracingSpan) => T): T {
        const id = `${name}#${(next += 1)}`;
        spans.push({ name: id, parent: storage.getStore() });
        return storage.run(id, () =>
          fn({ setAttribute: () => undefined, end: () => undefined })
        );
      },
    };
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(instrumentation({ tracing: { tracer } }));

    await client.record.findMany();

    const operation = spans.find((span) =>
      span.name.startsWith("viborm.operation")
    );
    const execute = spans.find((span) =>
      span.name.startsWith("viborm.execute")
    );
    expect(execute?.parent).toBe(operation?.name);
  });
});

describe("the core contains nothing a handler does", () => {
  const withUnit = (
    handler: (u: UnitContext, next: () => Promise<UnitOutcome>) => unknown,
    providerDriver = new StatementDriver()
  ) =>
    createClient({ schema, driver: providerDriver }).$extends(
      extension("probe", unit(handler, ["operation"]))
    );

  test("what a handler throws fails the call", async () => {
    const thrown = new Error("handler refused");
    await expect(
      withUnit(async (_u, next) => {
        await next();
        throw thrown;
      }).record.findMany()
    ).rejects.toBe(thrown);
  });

  test("a handler that settles without next() fails the call", async () => {
    const providerDriver = new StatementDriver();
    await expect(
      withUnit(() => undefined, providerDriver).record.findMany()
    ).rejects.toMatchObject({
      name: "QueryError",
      message: expect.stringContaining("without calling next()"),
    });
    expect(providerDriver.providerCalls).toBe(0);
  });

  test("next() twice fails the call and runs the child once", async () => {
    const providerDriver = new StatementDriver();
    await expect(
      withUnit(async (_u, next) => {
        await next();
        await next().catch(() => undefined);
      }, providerDriver).record.findMany()
    ).rejects.toMatchObject({
      message: expect.stringContaining("more than once"),
    });
    expect(providerDriver.providerCalls).toBe(1);
  });

  test("the child's failure is authoritative", async () => {
    const providerDriver = new StatementDriver();
    providerDriver.failAtProviderCall = 1;
    const failed = await withUnit(async (_u, next) => {
      await next();
      throw new Error("handler failed after the child");
    }, providerDriver)
      .record.findMany()
      .catch((error: unknown) => error);
    expect(failed).not.toMatchObject({
      message: "handler failed after the child",
    });
  });

  test("the instrumentation contains its own failures", async () => {
    const providerDriver = new StatementDriver();
    const tracer = {
      startActiveSpan(): never {
        throw new Error("tracer refused");
      },
    };
    const client = createClient({ schema, driver: providerDriver }).$extends(
      instrumentation({
        tracing: { tracer },
        logging: {
          query: () => {
            throw new Error("logger refused");
          },
        },
      })
    );

    await expect(client.record.findMany()).resolves.toHaveLength(1);
    expect(providerDriver.providerCalls).toBe(1);
  });
});

describe("units at their physical boundary", () => {
  const recorded = (sink: string[]) =>
    extension(
      "statements",
      unit(
        (u, next) => {
          sink.push(
            `${text(u)}|${JSON.stringify(parameters(u))}|${statements(u)?.length ?? 0}`
          );
          return next();
        },
        ["statement"]
      )
    );

  test("a rewritten statement is one unit, around the provider call, with the text sent", async () => {
    const sent: string[] = [];
    const providerDriver = new RecordingDriver();
    const client = createClient({ schema, driver: providerDriver })
      .$extends(
        extension(
          "rewrite",
          unit(
            (u, next) => {
              const before = statement(u);
              return next(before && sql`${before} /* rewritten */`);
            },
            ["statement"],
            { rewrites: true }
          )
        )
      )
      .$extends(recorded(sent));

    await client.$queryRaw(sql`SELECT ${7}`);

    expect(providerDriver.sent).toEqual(["SELECT ? /* rewritten */"]);
    expect(sent).toEqual(["SELECT ? /* rewritten */|[7]|0"]);
  });

  test("rewriting units run in chain order; a throw or a missing next() refuses the statement", async () => {
    const providerDriver = new RecordingDriver();
    const tag = (name: string) =>
      extension(
        name,
        unit(
          (u, next) => {
            const before = statement(u);
            return next(before && sql`${before} /* ${sql.raw(name)} */`);
          },
          ["statement"],
          { rewrites: true }
        )
      );
    const client = createClient({ schema, driver: providerDriver })
      .$extends(tag("first"))
      .$extends(tag("second"));
    await client.$queryRaw(sql`SELECT ${1}`);
    expect(providerDriver.sent).toEqual(["SELECT ? /* first */ /* second */"]);

    const refusing = (
      handler: (u: UnitContext, next: () => Promise<UnitOutcome>) => unknown
    ) =>
      createClient({ schema, driver: new RecordingDriver() })
        .$extends(
          extension(
            "refusing",
            unit(handler, ["statement"], { rewrites: true })
          )
        )
        .$queryRaw(sql`SELECT ${1}`);
    const refused = new Error("refused");
    await expect(
      refusing(() => {
        throw refused;
      })
    ).rejects.toBe(refused);
    // Thrown after its next() settled, too: the rewriting unit is a unit.
    await expect(
      refusing(async (_u: UnitContext, next: () => Promise<UnitOutcome>) => {
        await next();
        throw refused;
      })
    ).rejects.toBe(refused);
    await expect(refusing(() => undefined)).rejects.toMatchObject({
      message: expect.stringContaining("without calling next()"),
    });
  });

  test("a rewriting unit's late next(sql) is honoured, and next() resolves with the statement's real end", async () => {
    const providerDriver = new RecordingDriver();
    const ends: string[] = [];
    const client = createClient({ schema, driver: providerDriver }).$extends(
      extension(
        "late",
        unit(
          async (u, next) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            const before = statement(u);
            const end = await next(before && sql`${before} /* late */`);
            ends.push(end.status);
          },
          ["statement"],
          { rewrites: true }
        )
      )
    );
    await client.$queryRaw(sql`SELECT ${1}`);
    expect(providerDriver.sent).toEqual(["SELECT ? /* late */"]);

    const failing = new StatementDriver();
    failing.failAtProviderCall = 1;
    await createClient({ schema, driver: failing })
      .$extends(
        extension(
          "ends",
          unit(
            async (_u, next) => {
              ends.push((await next()).status);
            },
            ["statement"],
            { rewrites: true }
          )
        )
      )
      .$queryRaw(sql`SELECT ${1}`)
      .catch(() => undefined);
    expect(ends).toEqual(["success", "failure"]);
  });

  test("a verbatim unsafe raw query is never rewritten, but its unit reads its text", async () => {
    const sent: string[] = [];
    const providerDriver = new RecordingDriver();
    const client = createClient({ schema, driver: providerDriver })
      .$extends(
        extension(
          "rewrite",
          unit((_u, next) => next(sql`SELECT 0`), ["statement"], {
            rewrites: true,
          })
        )
      )
      .$extends(recorded(sent));

    await client.$queryRawUnsafe("SELECT 42");

    expect(providerDriver.sent).toEqual(["SELECT 42"]);
    expect(sent).toEqual(["SELECT 42|[]|0"]);
  });

  test("a native batch is one statement unit, its members read on demand", async () => {
    const sent: string[] = [];
    const client = createClient({
      schema,
      driver: new NativeDriver(),
    }).$extends(recorded(sent));

    await client.$transaction([
      client.$queryRaw(sql`SELECT ${1}`),
      client.$queryRaw(sql`SELECT ${2}`),
    ]);

    expect(sent).toEqual(["SELECT ?; SELECT ?|[[1],[2]]|2"]);
  });

  test("a fallback array sends, and observes, one statement at a time", async () => {
    const sent: string[] = [];
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(recorded(sent));

    await client.$transaction([
      client.$queryRaw(sql`SELECT ${1}`),
      client.$queryRaw(sql`SELECT ${2}`),
    ]);

    expect(sent).toEqual(["SELECT ?|[1]|0", "SELECT ?|[2]|0"]);
  });
});

describe("the unit words", () => {
  test("read the driver, table, correlation and failure of each unit", async () => {
    const providerDriver = new StatementDriver();
    providerDriver.failAtProviderCall = 1;
    const seen: Record<string, unknown>[] = [];
    const client = createClient({ schema, driver: providerDriver }).$extends(
      extension(
        "words",
        unit(async (u, next) => {
          const end = await next();
          const failed = failure(u);
          seen.push({
            kind: u.kind,
            status: end.status,
            driver: driver(u)?.driverName,
            table: table(u),
            correlation: correlation(u),
            origin: failed === undefined ? undefined : origin(failed),
          });
        })
      )
    );

    await client.record.findMany().catch(() => undefined);

    const [statementUnit, operationUnit] = seen;
    expect(statementUnit).toMatchObject({
      kind: "statement",
      status: "failure",
      driver: "official-statement-test",
    });
    expect(operationUnit).toMatchObject({
      kind: "operation",
      status: "failure",
      driver: "official-statement-test",
      table: "records",
    });
    expect(operationUnit?.correlation).toEqual(expect.any(String));
    expect(statementUnit?.correlation).toBe(operationUnit?.correlation);
    // One failure: the operation's error descends from the statement's.
    expect(operationUnit?.origin).toBe(statementUnit?.origin);
  });

  test("run(u, sql) opens the transaction and runs before its body", async () => {
    const providerDriver = new RecordingDriver();
    const client = createClient({ schema, driver: providerDriver }).$extends(
      extension(
        "opening",
        unit(
          async (u, next) => {
            await run(u, sql`SET LOCAL role = ${"reader"}`);
            return next();
          },
          ["transaction"]
        )
      )
    );

    await client.$transaction(async (tx) => {
      await tx.$queryRaw(sql`SELECT ${1}`);
    });

    expect(providerDriver.sent).toEqual(["SET LOCAL role = ?", "SELECT ?"]);
  });
});

describe("an extension's own units", () => {
  test("work emits a unit under the chain's handlers; note and notes carry facts", async () => {
    const seen: string[] = [];
    const client = createClient({ schema, driver: new StatementDriver() })
      .$extends(
        extension(
          "reader",
          unit(async (u, next) => {
            await next();
            if (u.kind === "probe" || u.kind === "operation")
              seen.push(`${u.kind}:${JSON.stringify(notes(u))}`);
          })
        )
      )
      .$extends(
        extension(
          "emitter",
          around(() => async (call) => {
            await work(
              call,
              { kind: "probe", operation: "look", note: { first: 1 } },
              async (own) => {
                note(own, { second: 2 });
              }
            );
            note(call, { onOperation: true });
            return call();
          })
        )
      );

    await client.record.findMany();

    expect(seen).toEqual([
      'probe:[{"first":1},{"second":2}]',
      'operation:[{"onOperation":true}]',
    ]);
  });
});

describe("a method's own units", () => {
  test("work on a method's scope emits a unit of its own execution, correlated by itself", async () => {
    const seen: string[] = [];
    const correlations: (string | undefined)[] = [];
    const client = createClient({ schema, driver: new StatementDriver() })
      .$extends(
        extension(
          "reader",
          unit(async (u, next) => {
            await next();
            seen.push(`${u.kind}:${u.operation}`);
            correlations.push(correlation(u));
          })
        )
      )
      .$extends(
        extension(
          "maintenance",
          methods((scope) => ({
            $sweep: () =>
              work(scope, { kind: "sweep", operation: "all" }, async (own) =>
                work(own, { kind: "sweep", operation: "one" }, async () => 1)
              ),
          }))
        )
      );

    await expect(client.$sweep()).resolves.toBe(1);
    await client.$sweep();
    expect(seen).toEqual(["sweep:one", "sweep:all", "sweep:one", "sweep:all"]);
    // One execution per call: its units share a correlation, the next has its own.
    expect(correlations[0]).toEqual(expect.any(String));
    expect(correlations[1]).toBe(correlations[0]);
    expect(correlations[2]).not.toBe(correlations[0]);
  });

  test("work on a method's scope runs alone where no unit part listens", async () => {
    const client = createClient({
      schema,
      driver: new StatementDriver(),
    }).$extends(
      extension(
        "maintenance",
        methods((scope) => ({
          $sweep: () =>
            work(scope, { kind: "sweep", operation: "all" }, async () => 2),
        }))
      )
    );

    await expect(client.$sweep()).resolves.toBe(2);
  });
});

describe("disclosure", () => {
  const failingClient = () => {
    const providerDriver = new StatementDriver();
    providerDriver.failAtProviderCall = 1;
    return createClient({ schema, driver: providerDriver });
  };
  const failingQuery = async (client: {
    $queryRaw: (query: ReturnType<typeof sql>) => PromiseLike<unknown>;
  }) => {
    const error = await Promise.resolve(
      client.$queryRaw(sql`SELECT ${"secret"}`)
    ).catch((caught: unknown) => caught);
    return JSON.stringify(error);
  };

  test("an error carries the SQL only where the chain discloses it", async () => {
    expect(await failingQuery(failingClient())).not.toContain("SELECT");
    expect(
      await failingQuery(
        failingClient().$extends(extension("d", disclosure({ sql: true })))
      )
    ).toContain("SELECT");
    expect(
      await failingQuery(
        failingClient().$extends(
          instrumentation({ diagnostics: { includeSql: true } })
        )
      )
    ).toContain("SELECT");
  });
});
