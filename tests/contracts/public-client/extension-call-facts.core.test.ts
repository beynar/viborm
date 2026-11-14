/**
 * The facts a call shows any extension: `key(run)`, `codec(run)`,
 * `database(x)`, `settled(scope, fn)`, a direct read's run after its handler
 * returned, and `{ inner: true }`. None names the cache; each is read from
 * the call, the run or the scope it is handed.
 */
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  QueryError,
  UnsupportedOperationError,
  ValidationError,
} from "@errors";
import { stableStringify } from "@extensions/key";
import {
  accepts,
  arg,
  args,
  around,
  type Codec,
  call,
  codec,
  createClient,
  database,
  extension,
  key,
  methods,
  oneOf,
  type Run,
  reads,
  rule,
  s,
  settled,
  statement,
  target,
  unit,
  writes,
} from "@src/index";
import { JsonParameter } from "@src/sql/json-parameter";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { afterEach, describe, expect, test } from "vitest";

const item = s.model({
  id: s.string().id(),
  name: s.string(),
  tenant: s.string(),
});
/** A model of every family a driver's raw values decode into. */
const sample = s.model({
  id: s.string().id(),
  big: s.bigInt(),
  bytes: s.blob(),
  raw: s.blob(),
  n: s.number(),
  doc: s.json(),
  list: s.int().array(),
});
const schema = { item, sample };

/** Answers every read with the rows it holds, and counts what it sends. */
class CountingDriver extends SqlOnlyDriver {
  sent: string[] = [];
  rows: Record<string, unknown>[] = [{ id: "i1", name: "one", tenant: "a" }];

  constructor() {
    super(new PostgresAdapter(), "postgresql");
  }

  // Optional: the fixture's own `execute` declares no parameter.
  protected override async execute<T>(
    _client?: null,
    sql = ""
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.sent.push(sql);
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
}

const clients: { $disconnect(): Promise<void> }[] = [];

function base(findUniqueBatching?: true) {
  const driver = new CountingDriver();
  const client = createClient({ schema, driver, findUniqueBatching });
  clients.push(client);
  return { client, driver };
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

/** An extension that records `key(run)` for every read and runs it. */
function keyRecorder(keys: (string | undefined)[]) {
  return extension(
    "keys",
    around(
      () => (run) => {
        keys.push(key(run));
        return run();
      },
      target(reads)
    )
  );
}

describe("key(run)", () => {
  test("is equal for the same statement and arguments, and differs with either", async () => {
    const keys: (string | undefined)[] = [];
    const { client } = base();
    const db = client.$extends(keyRecorder(keys));
    await db.item.findMany({ where: { name: "one" } });
    await db.item.findMany({ where: { name: "one" } });
    await db.item.findMany({ where: { name: "two" } });
    await db.item.findFirst({ where: { name: "one" } });
    expect(keys[0]).toBeTypeOf("string");
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });

  test("an argument enters it through the statement a rule produces from it", async () => {
    const keys: (string | undefined)[] = [];
    const { client } = base();
    const db = client
      .$extends(
        extension(
          "tenancy",
          args({ tenant: oneOf("a", "b").default("a") }),
          rule({ item: { read: { where: { tenant: arg("tenant") } } } })
        )
      )
      .$extends(
        extension("noise", args({ region: oneOf("eu", "us").on(reads) }))
      )
      .$extends(keyRecorder(keys));
    await db.item.findMany({ tenant: "a" });
    await db.item.findMany({ tenant: "b" });
    // An argument no rule reads leaves the statement, and so the key, as is.
    await db.item.findMany({ tenant: "a", region: "eu" });
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });

  test("reading it prepares the call: what runs is that preparation, whatever its caller changes later", async () => {
    const keys: (string | undefined)[] = [];
    const { client, driver } = base();
    const where = { name: "one" };
    const db = client.$extends(
      extension(
        "late",
        around(
          () => async (run) => {
            keys.push(key(run));
            where.name = "changed";
            return run();
          },
          target(reads)
        )
      )
    );
    await db.item.findMany({ where });
    const fresh: (string | undefined)[] = [];
    await client.$extends(keyRecorder(fresh)).item.findMany({
      where: { name: "one" },
    });
    expect(keys[0]).toBe(fresh[0]);
    expect(driver.sent[0]).toBe(driver.sent[1]);
  });

  test("is undefined for a chain that rewrites statements, a volatile argument, a write and a raw statement", async () => {
    const keys: (string | undefined)[] = [];
    const { client } = base();
    const rewritten = client
      .$extends(
        extension(
          "rewrites",
          unit((u, next) => next(statement(u)), ["statement"], {
            rewrites: true,
          })
        )
      )
      .$extends(keyRecorder(keys));
    await rewritten.item.findMany();
    const judged = client
      .$extends(
        extension("judged", args({ caller: oneOf("x").on(reads).volatile() }))
      )
      .$extends(keyRecorder(keys));
    await judged.item.findMany({ caller: "x" });
    await judged.item.findMany();
    const everything = client.$extends(
      extension(
        "all",
        around(() => (run) => {
          keys.push(key(run));
          return run();
        })
      )
    );
    await everything.item.create({
      data: { id: "i2", name: "two", tenant: "a" },
    });
    await everything.$queryRaw`SELECT 1`;
    expect(keys.map((value) => value === undefined)).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  test("keys a JSON parameter by its text, never as the object that spells its fields", () => {
    const parameter = JsonParameter.from({ a: 1 });
    expect(stableStringify([parameter])).not.toBe(
      stableStringify([{ json: '{"a":1}' }])
    );
    expect(stableStringify([parameter])).toBe(
      stableStringify([JsonParameter.from({ a: 1 })])
    );
  });
});

describe("codec(run)", () => {
  /** A read's codec, run once: what the driver returned, stored. */
  function detaching(seen: (c: Codec<unknown>) => unknown) {
    return extension(
      "detach",
      around(
        () =>
          async <R>(run: Run<unknown, R>): Promise<R> => {
            const c = codec(run);
            const value = await c.run();
            seen(c);
            return value;
          },
        target(reads)
      )
    );
  }

  test("stores the driver's rows and restores the answer the decoder makes of them, fresh each time", async () => {
    const { client, driver } = base();
    driver.rows = [
      {
        id: "s1",
        big: 9_007_199_254_740_993n,
        bytes: new Uint8Array([0, 1, 255]),
        raw: new Uint8Array([7, 8]).buffer,
        n: -0,
        doc: { a: ["a", "x"], n: ["n", "5"], deep: [{ k: null }, 1.5, true] },
        list: [1, -2],
      },
    ];
    let stored: unknown;
    let restore: ((entry: unknown) => unknown) | undefined;
    const db = client.$extends(
      detaching((c) => {
        stored = JSON.parse(JSON.stringify(c.snapshot()));
        restore = c.materialize;
      })
    );
    const answer = await db.sample.findMany();
    const first = restore?.(stored);
    const second = restore?.(stored);
    expect(first).toEqual(answer);
    expect(second).toEqual(answer);
    expect(first).not.toBe(second);
    expect(Object.is((first as { n: number }[])[0]?.n, -0)).toBe(true);
    expect((first as { bytes: Uint8Array }[])[0]?.bytes).not.toBe(
      (second as { bytes: Uint8Array }[])[0]?.bytes
    );
  });

  test("writes each value JSON cannot carry as a tagged array, and every array tagged", async () => {
    const { client, driver } = base();
    const document = JSON.parse('{"__proto__": {"x": 1}, "k": "v"}');
    driver.rows = [
      {
        id: "i1",
        name: "one",
        tenant: "a",
        big: -12n,
        at: new Date(5),
        never: new Date(Number.NaN),
        bytes: new Uint8Array([104, 105]),
        raw: new Uint8Array([33]).buffer,
        nan: Number.NaN,
        up: Number.POSITIVE_INFINITY,
        down: Number.NEGATIVE_INFINITY,
        zero: -0,
        list: [1, "a", null, [false]],
        document,
        bare: Object.assign(Object.create(null), { k: 1 }),
        absent: undefined,
      },
    ];
    let stored: unknown;
    let restored: unknown;
    const db = client.$extends(
      detaching((c) => {
        stored = c.snapshot();
        restored = c.materialize(JSON.parse(JSON.stringify(stored)));
      })
    );
    const answer = await db.item.findMany();
    expect(JSON.stringify(stored)).toBe(
      JSON.stringify([
        {
          id: "i1",
          name: "one",
          tenant: "a",
          big: ["n", "-12"],
          at: ["d", 5],
          never: ["d", null],
          bytes: ["b", "aGk="],
          raw: ["B", "IQ=="],
          nan: ["f", "NaN"],
          up: ["f", "Infinity"],
          down: ["f", "-Infinity"],
          zero: ["f", "-0"],
          list: ["a", 1, "a", null, ["a", false]],
          document: JSON.parse('{"__proto__": {"x": 1}, "k": "v"}'),
          bare: { k: 1 },
        },
      ])
    );
    expect(
      Object.getPrototypeOf(
        Reflect.get(Reflect.get(stored as object, 0), "document")
      )
    ).toBe(Object.prototype);
    expect(restored).toEqual(answer);
  });

  test("cannot store a value of another kind, nor rows a run did not keep", async () => {
    const failures: unknown[] = [];
    const { client, driver } = base();
    const db = client.$extends(
      extension(
        "detach",
        around(
          () =>
            async <R>(run: Run<unknown, R>): Promise<R> => {
              const c = codec(run);
              try {
                c.snapshot();
              } catch (error) {
                failures.push(error);
              }
              const value = await c.run();
              try {
                c.snapshot();
              } catch (error) {
                failures.push(error);
              }
              return value;
            },
          target(reads)
        )
      )
    );
    const row = { id: "i1", name: "one", tenant: "a" };
    for (const extra of [new Map(), [1, undefined], new Array(2), () => 1]) {
      driver.rows = [{ ...row, extra }];
      await db.item.findMany();
    }
    expect(failures).toHaveLength(8);
    for (const failure of failures) expect(failure).toBeInstanceOf(TypeError);
  });

  test("refuses stored rows it never writes, and rows the decoder refuses", async () => {
    const { client } = base();
    let restore: ((entry: unknown) => unknown) | undefined;
    const db = client.$extends(
      detaching((c) => {
        restore = c.materialize;
      })
    );
    await db.item.findMany();
    const row = { id: "i1", name: "one", tenant: "a" };
    for (const entry of [
      {},
      [null],
      [[]],
      [new Map()],
      [{ ...row, extra: Number.NaN }],
      [{ ...row, extra: ["z", 1] }],
      [{ ...row, extra: ["d", "1"] }],
      [{ ...row, extra: ["d", 1, 2] }],
      [{ ...row, extra: ["f", "1"] }],
      [{ ...row, extra: ["n", "01"] }],
      [{ ...row, extra: ["n", 1] }],
      [{ ...row, extra: ["b", 1] }],
      [{ ...row, extra: ["a", undefined] }],
      [{ ...row, extra: () => 1 }],
      [{ ...row, extra: new Map() }],
    ])
      expect(() => restore?.(entry)).toThrow(TypeError);
    expect(() => restore?.([{ ...row, name: 1 }])).toThrow(QueryError);
    expect(restore?.([row])).toEqual([row]);
  });

  test("keeps the rows of each concurrent findUnique, which a shared read would not hold", async () => {
    const { client, driver } = base(true);
    const stored: unknown[] = [];
    const db = client.$extends(
      detaching((c) => {
        stored.push(c.snapshot());
      })
    );
    await Promise.all([
      db.item.findUnique({ where: { id: "i1" } }),
      db.item.findUnique({ where: { id: "i2" } }),
    ]);
    expect(stored).toHaveLength(2);
    expect(driver.sent).toHaveLength(2);
  });

  test("refuses a call that is not one read", async () => {
    const failures: unknown[] = [];
    const { client } = base();
    const db = client.$extends(
      extension(
        "detach",
        around(() => <R>(run: Run<unknown, R>): Promise<R> => {
          try {
            codec(run);
          } catch (error) {
            failures.push(error);
          }
          return run();
        })
      )
    );
    await db.item.create({ data: { id: "i2", name: "two", tenant: "a" } });
    await db.$queryRaw`SELECT 1`;
    expect(failures).toHaveLength(2);
    for (const failure of failures)
      expect(failure).toBeInstanceOf(UnsupportedOperationError);
  });
});

describe("database(x)", () => {
  test("is the dialect, SQL namespace and driver name a call, its run and a method's scope work against", async () => {
    const seen: unknown[] = [];
    const { client } = base();
    const db = client.$extends(
      extension(
        "where",
        around((c) => {
          seen.push(database(c));
          return (run) => {
            seen.push(database(run));
            return run();
          };
        }, target(reads)),
        methods((scope) => ({ $where: () => database(scope) }))
      )
    );
    await db.item.findMany();
    seen.push(db.$where());
    expect(seen).toEqual([
      {
        dialect: "postgresql",
        namespace: "public",
        driverName: "sql-only-postgresql",
      },
      {
        dialect: "postgresql",
        namespace: "public",
        driverName: "sql-only-postgresql",
      },
      {
        dialect: "postgresql",
        namespace: "public",
        driverName: "sql-only-postgresql",
      },
    ]);
    expect(() => database({})).toThrow(TypeError);
  });
});

describe("settled(scope, fn)", () => {
  function settling(log: string[], fail?: unknown) {
    return extension(
      "settle",
      methods((scope) => ({
        $after: (label: string) =>
          settled(scope, () => {
            log.push(label);
            if (fail !== undefined) throw fail;
          }),
      }))
    );
  }

  test("outside a transaction runs at once, and its promise is the function's own", async () => {
    const log: string[] = [];
    const { client } = base();
    await client.$extends(settling(log)).$after("now");
    expect(log).toEqual(["now"]);
    const typed = new ValidationError(
      { kind: "schema-builder", builder: "$bind", path: "x" },
      [{ path: "x", message: "refused" }]
    );
    await expect(
      client.$extends(settling([], typed)).$after("typed")
    ).rejects.toBe(typed);
    await expect(
      client.$extends(settling([], new Error("plain"))).$after("plain")
    ).rejects.toBeInstanceOf(QueryError);
  });

  test("inside a transaction runs after the outermost commit, never after a rollback", async () => {
    const log: string[] = [];
    const { client } = base();
    const db = client
      .$extends(settling(log))
      // A part that watches writes gives the chain its transaction collector.
      .$extends(
        extension(
          "watcher",
          call(() => undefined, target(writes))
        )
      );
    await db.$transaction(async (tx) => {
      await tx.$after("committed");
      await tx.$transaction(async (inner) => {
        await inner.$after("nested");
      });
      expect(log).toEqual([]);
    });
    expect(log).toEqual(["committed", "nested"]);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$after("rolled back");
        throw new Error("abort");
      })
    ).rejects.toThrow("abort");
    expect(log).toEqual(["committed", "nested"]);
  });
});

describe("a direct read's run after its handler returned", () => {
  test("runs the core alone, once", async () => {
    const later: (() => Promise<unknown>)[] = [];
    const outer: string[] = [];
    const { client, driver } = base();
    const db = client
      .$extends(
        extension(
          "outer",
          around(
            () => async (run) => {
              outer.push("outer");
              return run();
            },
            target(reads)
          )
        )
      )
      .$extends(
        extension(
          "answers",
          around(
            () => (run) => {
              later.push(() => run());
              return Promise.resolve([]);
            },
            // One operation: an answer in place of the core is typed by it.
            target("item", "findMany")
          )
        )
      );
    await expect(db.item.findMany()).resolves.toEqual([]);
    expect(driver.sent).toEqual([]);
    await expect(later[0]!()).resolves.toEqual([
      { id: "i1", name: "one", tenant: "a" },
    ]);
    expect(driver.sent).toHaveLength(1);
    expect(outer).toEqual(["outer"]);
    expect(() => later[0]!()).toThrow(QueryError);
  });

  test("a write's run after its handler returned is refused", async () => {
    let late: (() => Promise<unknown>) | undefined;
    const { client } = base();
    const db = client.$extends(
      extension(
        "late",
        around(
          () => async (run) => {
            late = () => run();
            return run();
          },
          target(writes)
        )
      )
    );
    await db.item.create({ data: { id: "i2", name: "two", tenant: "a" } });
    expect(() => late?.()).toThrow(QueryError);
  });
});

describe("around(fn, target, { inner: true })", () => {
  test("sits nearest the core whatever the chain's order", async () => {
    const order: string[] = [];
    const named = (name: string, inner: boolean) =>
      extension(
        name,
        around(
          () => async (run) => {
            order.push(`${name} in`);
            const value = await run();
            order.push(`${name} out`);
            return value;
          },
          target(reads),
          inner ? { inner: true } : undefined
        )
      );
    const { client } = base();
    await client
      .$extends(named("A", true))
      .$extends(named("B", false))
      .item.findMany();
    expect(order).toEqual(["B in", "A in", "A out", "B out"]);
  });
});

describe("accepts(schema)", () => {
  test("a validator's error of viborm's own passes as it is", async () => {
    const refusal = new UnsupportedOperationError("refused by its validator");
    const { client } = base();
    const db = client.$extends(
      extension(
        "checked",
        args({
          checked: accepts({
            "~standard": {
              version: 1,
              vendor: "test",
              validate: () => {
                throw refusal;
              },
            },
          }).on(reads),
        })
      )
    );
    await expect(db.item.findMany({ checked: 1 })).rejects.toBe(refusal);
  });
});

describe("settled and a handler's post-work", () => {
  test("a direct write is settled before its handler's post-work; in a transaction, after the outermost commit", async () => {
    const timeline: string[] = [];
    const { client } = base();
    const db = client.$extends(
      extension(
        "order",
        around((c) => {
          settled(c, () => {
            timeline.push("outcome");
          });
          return async (run) => {
            const value = await run();
            timeline.push("post-work");
            return value;
          };
        }, target(writes))
      )
    );
    await db.item.deleteMany();
    await db.item.create({ data: { id: "i9", name: "n", tenant: "a" } });
    await db.$transaction(async (tx) => {
      await tx.item.deleteMany();
      timeline.push("tx-body");
    });
    timeline.push("|");
    await db.$transaction([db.item.deleteMany()]);
    expect(timeline).toEqual([
      "outcome",
      "post-work",
      "outcome",
      "post-work",
      "post-work",
      "tx-body",
      "outcome",
      "|",
      // An array is a transaction: its commit comes after its members ran.
      "post-work",
      "outcome",
    ]);
  });
});
