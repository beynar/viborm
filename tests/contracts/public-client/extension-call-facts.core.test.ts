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
const schema = { item };

/** Answers every read with the rows it holds, and counts what it sends. */
class CountingDriver extends SqlOnlyDriver {
  sent: string[] = [];
  rows: Record<string, unknown>[] = [{ id: "i1", name: "one", tenant: "a" }];

  constructor() {
    super(new PostgresAdapter(), "postgresql");
  }

  protected override async execute<T>(
    _client: null,
    sql: string
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.sent.push(sql);
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
}

const clients: { $disconnect(): Promise<void> }[] = [];

function base() {
  const driver = new CountingDriver();
  const client = createClient({ schema, driver });
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
      () => (run: Run<unknown, unknown>) => {
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
          () => async (run: Run<unknown, unknown>) => {
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
        around(() => (run: Run<unknown, unknown>) => {
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
  test("detaches the core's answer and restores a fresh graph each time", async () => {
    const restored: unknown[] = [];
    const { client } = base();
    const db = client.$extends(
      extension(
        "detach",
        around(
          () => async (run: Run<unknown, unknown>) => {
            const { snapshot, materialize } = codec(run);
            const stored = JSON.parse(JSON.stringify(snapshot(await run())));
            const first = materialize(stored);
            restored.push(first, materialize(stored));
            return first;
          },
          target(reads)
        )
      )
    );
    const rows = await db.item.findMany();
    expect(rows).toEqual([{ id: "i1", name: "one", tenant: "a" }]);
    expect(restored[0]).toEqual(restored[1]);
    expect(restored[0]).not.toBe(restored[1]);
    expect(codec).toBeTypeOf("function");
  });

  test("refuses a call that is not one read", async () => {
    const failures: unknown[] = [];
    const { client } = base();
    const db = client.$extends(
      extension(
        "detach",
        around(() => (run: Run<unknown, unknown>) => {
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
  test("is the dialect and SQL namespace a call, its run and a method's scope work against", async () => {
    const seen: unknown[] = [];
    const { client } = base();
    const db = client.$extends(
      extension(
        "where",
        around((c) => {
          seen.push(database(c));
          return (run: Run<unknown, unknown>) => {
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
      { dialect: "postgresql", namespace: "public" },
      { dialect: "postgresql", namespace: "public" },
      { dialect: "postgresql", namespace: "public" },
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
            () => async (run: Run<unknown, unknown>) => {
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
            () => (run: Run<unknown, unknown>) => {
              later.push(() => run());
              return Promise.resolve([]);
            },
            target(reads)
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
          () => async (run: Run<unknown, unknown>) => {
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
          () => async (run: Run<unknown, unknown>) => {
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
