/**
 * Adversarial review of the last pass of the extension host (2026-11-15,
 * `573d6cf92..41e987fa1`): every `$transaction` through `transact`, parts
 * that join the chain themselves, one admission memo per extension and
 * schema, freezes removed.
 *
 * Each test states what a user sees: what commits, what rolls back, when and
 * how often `settled` is told, what a process sees of a rejection. One suite
 * for both databases: in-memory SQLite runs it in the client layer, PGlite
 * among the local providers (a Wasm Postgres weighs on the layer's memory
 * ceiling by its import alone).
 */

import { s } from "@schema";
import {
  around,
  call,
  defaults,
  extension,
  methods,
  rule,
  settled,
  sql,
  target,
  watch,
  writes,
} from "@src/index";
import { on } from "@src/on";
import { afterEach, describe, expect, test } from "vitest";

const post = s.model({ id: s.string().id(), title: s.string() });
const link = s.model({ id: s.string().id(), parentId: s.string() });
export const schema = { post, link };

const SETTLED_FAILED =
  /^rejected:QueryError:Extension "recorder" settled\(\) failed \(committed\)/;
const FOREIGN_KEY_REJECTED = /^rejected:ForeignKeyError:/;
const REJECTED = /^rejected:/;

export type DriverName = "sqlite" | "pglite";

/**
 * The suite on one database: `create` opens a client of `schema` over it,
 * its tables made again by each test.
 */
export function transactionsReview(
  database: DriverName,
  create: () => unknown
): void {
  const DRIVERS = [database] as const;

  type Row = Record<string, unknown>;
  interface Delegate {
    findMany(args?: object): Promise<Row[]>;
    create(args: object): Promise<Row>;
  }
  interface Loose {
    post: Delegate;
    link: Delegate;
    $record(id: string, fail?: boolean): Promise<void>;
    $extends(definition: unknown): Loose;
    $executeRaw(query: unknown): Promise<number>;
    $executeRawUnsafe(query: string): Promise<number>;
    $queryRawUnsafe(query: string): Promise<Row[]>;
    $transaction(
      body: ((tx: Loose) => Promise<unknown>) | readonly unknown[],
      options?: object
    ): Promise<unknown>;
    $disconnect(): Promise<void>;
  }

  const opened: Loose[] = [];
  afterEach(async () => {
    for (const client of opened.splice(0)) await client.$disconnect();
  });

  /** A client over fresh tables; `link.parentId` is checked at COMMIT. */
  async function open(driver: DriverName): Promise<Loose> {
    const client = create() as never as Loose;
    opened.push(client);
    const deferred =
      driver === "sqlite"
        ? "REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED"
        : "REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED";
    if (driver === "sqlite")
      await client.$executeRawUnsafe("PRAGMA foreign_keys = ON");
    else
      await client.$executeRawUnsafe(
        "DROP TABLE IF EXISTS link, parent, post CASCADE"
      );
    await client.$executeRawUnsafe(
      "CREATE TABLE post (id TEXT PRIMARY KEY, title TEXT NOT NULL)"
    );
    await client.$executeRawUnsafe("CREATE TABLE parent (id TEXT PRIMARY KEY)");
    await client.$executeRawUnsafe(
      `CREATE TABLE link (id TEXT PRIMARY KEY, "parentId" TEXT NOT NULL ${deferred})`
    );
    return client;
  }

  const ids = async (client: Loose): Promise<string[]> =>
    (await client.post.findMany({})).map((row) => String(row.id)).sort();

  const outcomeOf = (promise: Promise<unknown>): Promise<string> =>
    promise.then(
      () => "resolved",
      (error: unknown) =>
        `rejected:${(error as Error)?.constructor?.name}:${(error as Error)?.message}`
    );

  /** An extension that tells `events` each `settled` of a write, raw or model, and a method that writes then registers one. */
  function recorder(events: string[], failOn?: string) {
    return extension(
      "recorder",
      call((c) => {
        settled(c, ({ certainty }) => {
          const id = String(
            (c.args as { data?: { id?: unknown } }).data?.id ?? "?"
          );
          events.push(`settled:${id}:${certainty}`);
          if (id === failOn) throw new Error(`settled for ${id} fails`);
        });
      }, target(writes)),
      around((c) => {
        if (c.kind !== "raw") return;
        settled(c, ({ certainty }) => {
          events.push(`settled:raw:${certainty}`);
        });
      }),
      methods((scope) => ({
        async $record(id: string, fail?: boolean) {
          await (scope as never as Loose).post.create({
            data: { id, title: "m" },
          });
          if (fail) throw new Error("the method fails after its write");
          await settled(scope, ({ certainty }) => {
            events.push(`settled:method:${id}:${certainty}`);
          });
        },
      }))
    );
  }

  /** Chains whose own effect on a transaction is tested: none of them hears writes. */
  const PLAIN_CHAINS = {
    none: (client: Loose) => client,
    call: (client: Loose) =>
      client.$extends(
        extension(
          "plain-call",
          call(() => undefined)
        )
      ),
    rule: (client: Loose) =>
      client.$extends(
        extension(
          "plain-rule",
          rule({ post: { read: { where: { title: { not: "hidden" } } } } })
        )
      ),
    defaults: (client: Loose) =>
      client.$extends(
        extension(
          "plain-defaults",
          defaults({ post: { orderBy: { id: "asc" } } })
        )
      ),
  } as const;

  /** Chains that hear writes, each beside the recorder. */
  const HEARING_CHAINS = {
    recorder: (client: Loose) => client,
    around: (client: Loose) =>
      client.$extends(
        extension(
          "timing",
          around(() => (run) => run())
        )
      ),
    on: (client: Loose) =>
      client.$extends(on({ post: { create: () => undefined } } as never)),
  } as const;

  describe.each(DRIVERS)("%s: an unawaited savepoint that fails", (driver) => {
    // 573d6cf92 and main: the driver keeps the rejection of a nested
    // `$transaction` nobody observes to itself and fails the outer one. Since
    // 317fc9bfb `transact` chains `.then(end(), …)` on it: the chained promise
    // rejects with no handler, and Node reports an unhandled rejection. Under
    // Node's default (`--unhandled-rejections=throw`) the process exits.
    test("raises no unhandled rejection on an unextended client", async () => {
      const unhandled: unknown[] = [];
      const listen = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", listen);
      try {
        const client = await open(driver);
        const outcome = await outcomeOf(
          client.$transaction(async (tx) => {
            await tx.post.create({ data: { id: "outer", title: "a" } });
            tx.$transaction(async (inner) => {
              await inner.post.create({ data: { id: "inner", title: "b" } });
              throw new Error("inner fails");
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(outcome).toBe("rejected:Error:inner fails");
        expect(await ids(client)).toEqual([]);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", listen);
      }
    });

    test.each(
      Object.keys(HEARING_CHAINS)
    )("fails the outer transaction and tells nothing, beside %s", async (name) => {
      const events: string[] = [];
      const listen = () => undefined;
      process.on("unhandledRejection", listen);
      try {
        const base = await open(driver);
        const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
          base.$extends(recorder(events))
        );
        const outcome = await outcomeOf(
          db.$transaction(async (tx) => {
            await tx.post.create({ data: { id: "outer", title: "a" } });
            tx.$transaction(async (inner) => {
              await inner.post.create({ data: { id: "inner", title: "b" } });
              throw new Error("inner fails");
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(outcome).toBe("rejected:Error:inner fails");
        expect(await ids(base)).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        process.off("unhandledRejection", listen);
      }
    });
  });

  describe.each(
    DRIVERS
  )("%s: what commits and what settled is told", (driver) => {
    const chains = Object.keys(HEARING_CHAINS);

    test.each(
      chains
    )("success: each write told once, after the body, beside %s", async (name) => {
      const events: string[] = [];
      const base = await open(driver);
      const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
        base.$extends(recorder(events))
      );
      await db.$transaction(async (tx) => {
        await tx.post.create({ data: { id: "a", title: "a" } });
        await tx.$executeRaw(
          sql`INSERT INTO post (id, title) VALUES (${"b"}, ${"b"})`
        );
        await tx.$record("c");
        events.push("body-end");
      });
      expect(await ids(base)).toEqual(["a", "b", "c"]);
      expect(events).toEqual([
        "body-end",
        "settled:a:committed",
        "settled:raw:committed",
        "settled:c:committed",
        "settled:method:c:committed",
      ]);
    });

    test.each(
      chains
    )("a failure between two statements: nothing commits, nothing told, beside %s", async (name) => {
      const events: string[] = [];
      const base = await open(driver);
      const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
        base.$extends(recorder(events))
      );
      const outcome = await outcomeOf(
        db.$transaction(async (tx) => {
          await tx.post.create({ data: { id: "a", title: "a" } });
          await tx.$record("m");
          throw new Error("between");
        })
      );
      expect(outcome).toBe("rejected:Error:between");
      expect(await ids(base)).toEqual([]);
      expect(events).toEqual([]);
    });

    test.each(
      chains
    )("a caught savepoint failure: its writes are neither committed nor told, beside %s", async (name) => {
      const events: string[] = [];
      const base = await open(driver);
      const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
        base.$extends(recorder(events))
      );
      await db.$transaction(async (tx) => {
        await tx.post.create({ data: { id: "outer", title: "a" } });
        await tx
          .$transaction(async (inner) => {
            await inner.post.create({ data: { id: "inner", title: "b" } });
            await inner.$record("inner-m");
            await inner.$executeRaw(
              sql`INSERT INTO post (id, title) VALUES (${"inner-raw"}, ${"r"})`
            );
            throw new Error("inner fails");
          })
          .catch(() => undefined);
        await tx
          .$transaction(async (inner) => {
            await inner.post.create({ data: { id: "kept", title: "k" } });
          })
          .catch(() => undefined);
      });
      expect(await ids(base)).toEqual(["kept", "outer"]);
      expect(events).toEqual([
        "settled:outer:committed",
        "settled:kept:committed",
      ]);
    });

    test.each(
      chains
    )("a method that fails after its write, caught: the write commits and is told by its call, beside %s", async (name) => {
      const events: string[] = [];
      const base = await open(driver);
      const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
        base.$extends(recorder(events))
      );
      await db.$transaction(async (tx) => {
        await tx.$record("m", true).catch(() => undefined);
      });
      expect(await ids(base)).toEqual(["m"]);
      expect(events).toEqual(["settled:m:committed"]);
    });

    test.each(
      chains
    )("a settled listener that throws: committed, every listener told, the transaction rejects, beside %s", async (name) => {
      const events: string[] = [];
      const base = await open(driver);
      const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
        base.$extends(recorder(events, "a"))
      );
      const outcome = await outcomeOf(
        db.$transaction(async (tx) => {
          await tx.post.create({ data: { id: "a", title: "a" } });
          await tx.post.create({ data: { id: "b", title: "b" } });
        })
      );
      expect(outcome).toMatch(SETTLED_FAILED);
      expect(await ids(base)).toEqual(["a", "b"]);
      expect(events).toEqual(["settled:a:committed", "settled:b:committed"]);
    });

    // COMMIT was sent and failed: the documented certainty is
    // "may-have-committed" (main, 573d6cf92 and the head agree), told once.
    test.each(
      chains
    )("a commit that fails (deferred foreign key): nothing commits, each write told once as may-have-committed, beside %s", async (name) => {
      const events: string[] = [];
      const base = await open(driver);
      const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
        base.$extends(recorder(events))
      );
      const outcome = await outcomeOf(
        db.$transaction(async (tx) => {
          await tx.post.create({ data: { id: "a", title: "a" } });
          await tx.link.create({ data: { id: "l", parentId: "missing" } });
        })
      );
      expect(outcome).toMatch(FOREIGN_KEY_REJECTED);
      expect(await ids(base)).toEqual([]);
      expect(events).toEqual([
        "settled:a:may-have-committed",
        "settled:l:may-have-committed",
      ]);
    });

    test.each(
      chains
    )("an around that throws after run(): the call fails, an uncaught failure rolls back, beside %s", async (name) => {
      const events: string[] = [];
      const base = await open(driver);
      const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
        base.$extends(recorder(events))
      ).$extends(
        extension(
          "late-refusal",
          around(
            () => async (run) => {
              await run();
              throw new Error("after run");
            },
            target("post", "create")
          )
        )
      );
      const outcome = await outcomeOf(
        db.$transaction(async (tx) => {
          await tx.post.create({ data: { id: "a", title: "a" } });
        })
      );
      expect(outcome).toBe("rejected:Error:after run");
      expect(await ids(base)).toEqual([]);
      expect(events).toEqual([]);
    });

    test.each(
      chains
    )("a watch that throws: the call fails, an uncaught failure rolls back, beside %s", async (name) => {
      const events: string[] = [];
      const base = await open(driver);
      const db = HEARING_CHAINS[name as keyof typeof HEARING_CHAINS](
        base.$extends(recorder(events))
      ).$extends(
        extension(
          "bad-watch",
          call((c) => {
            watch(c, {
              wants: () => true,
              rows() {
                throw new Error("watch fails");
              },
            });
          }, target(writes))
        )
      );
      const outcome = await outcomeOf(
        db.$transaction(async (tx) => {
          await tx.post.create({ data: { id: "a", title: "a" } });
        })
      );
      expect(outcome).toMatch(REJECTED);
      expect(await ids(base)).toEqual([]);
      expect(events).toEqual([]);
    });

    test("two transactions at once on one client: each told only of its own commit", async () => {
      const events: string[] = [];
      const base = await open(driver);
      const db = base.$extends(recorder(events));
      const outcomes = await Promise.all(
        ["x", "y", "z"].map((id) =>
          outcomeOf(
            db.$transaction(async (tx) => {
              await tx.post.create({ data: { id, title: id } });
              await new Promise((resolve) => setTimeout(resolve, 3));
              if (id === "y") throw new Error("y fails");
            })
          )
        )
      );
      expect(outcomes).toEqual([
        "resolved",
        "rejected:Error:y fails",
        "resolved",
      ]);
      expect(await ids(base)).toEqual(["x", "z"]);
      expect([...events].sort()).toEqual([
        "settled:x:committed",
        "settled:z:committed",
      ]);
    });

    test("an array with a raw statement: told after its commit; a failing member commits and tells nothing", async () => {
      const events: string[] = [];
      const base = await open(driver);
      const db = base.$extends(recorder(events));
      await db.$transaction([
        db.post.create({ data: { id: "a", title: "a" } }),
        db.$executeRaw(
          sql`INSERT INTO post (id, title) VALUES (${"b"}, ${"b"})`
        ),
      ]);
      expect(events).toEqual(["settled:a:committed", "settled:raw:committed"]);
      events.length = 0;
      const outcome = await outcomeOf(
        db.$transaction([
          db.post.create({ data: { id: "c", title: "c" } }),
          db.$executeRawUnsafe("INSERT INTO nowhere VALUES (1)"),
        ])
      );
      expect(outcome).toMatch(REJECTED);
      expect(await ids(base)).toEqual(["a", "b"]);
      expect(events).toEqual([]);
    });

    test("an array inside a callback: told after the outermost commit, dropped with its rollback", async () => {
      const events: string[] = [];
      const base = await open(driver);
      const db = base.$extends(recorder(events));
      await db.$transaction(async (tx) => {
        await tx.$transaction([
          tx.post.create({ data: { id: "a", title: "a" } }),
          tx.$executeRaw(
            sql`INSERT INTO post (id, title) VALUES (${"b"}, ${"b"})`
          ),
        ]);
        events.push("body-end");
      });
      expect(events).toEqual([
        "body-end",
        "settled:a:committed",
        "settled:raw:committed",
      ]);
      events.length = 0;
      await outcomeOf(
        db.$transaction(async (tx) => {
          await tx.$transaction([
            tx.post.create({ data: { id: "c", title: "c" } }),
          ]);
          throw new Error("outer fails");
        })
      );
      expect(await ids(base)).toEqual(["a", "b"]);
      expect(events).toEqual([]);
    });
  });

  describe.each(
    DRIVERS
  )("%s: a chain that hears no write runs its transactions as before", (driver) => {
    test.each(
      Object.keys(PLAIN_CHAINS)
    )("%s: same outcomes, errors and rows as an unextended client", async (name) => {
      const run = async (chain: keyof typeof PLAIN_CHAINS) => {
        const base = await open(driver);
        const db = PLAIN_CHAINS[chain](base);
        const out: string[] = [];
        out.push(
          await outcomeOf(
            db.$transaction(async (tx) => {
              await tx.post.create({ data: { id: "a", title: "a" } });
              throw new Error("between");
            })
          )
        );
        out.push(
          await outcomeOf(
            db.$transaction(async (tx) => {
              await tx.post.create({ data: { id: "b", title: "b" } });
              await tx
                .$transaction(async (inner) => {
                  await inner.post.create({ data: { id: "c", title: "c" } });
                  throw new Error("inner");
                })
                .catch(() => undefined);
            })
          )
        );
        out.push(
          await outcomeOf(
            db.$transaction(async (tx) => {
              await tx.link.create({ data: { id: "l", parentId: "missing" } });
            })
          )
        );
        out.push(
          await outcomeOf(
            db.$transaction(async (tx) => {
              await tx.post.create({ data: { id: "b", title: "duplicate" } });
            })
          )
        );
        out.push(
          await outcomeOf(
            db.$transaction(async () => undefined, { isolationLevel: "Bogus" })
          )
        );
        out.push(await ids(base).then((list) => list.join(",")));
        return out;
      };
      expect(await run(name as keyof typeof PLAIN_CHAINS)).toEqual(
        await run("none")
      );
    });

    test.each(
      Object.keys(PLAIN_CHAINS)
    )("%s: the transaction resolves after as many microtasks as an unextended client", async (name) => {
      const ticksOf = async (chain: keyof typeof PLAIN_CHAINS) => {
        const db = PLAIN_CHAINS[chain](await open(driver));
        let ticks = 0;
        let counting = true;
        const spin = () => {
          if (!counting) return;
          ticks += 1;
          queueMicrotask(spin);
        };
        await db.$transaction(async () => {
          queueMicrotask(spin);
        });
        counting = false;
        return ticks;
      };
      expect(await ticksOf(name as keyof typeof PLAIN_CHAINS)).toBe(
        await ticksOf("none")
      );
    });
  });

  if (database === "pglite")
    test("the isolation level reaches the transaction through every chain", async () => {
      for (const name of Object.keys(PLAIN_CHAINS)) {
        const db = PLAIN_CHAINS[name as keyof typeof PLAIN_CHAINS](
          await open("pglite")
        );
        const level = await db.$transaction(
          async (tx) => tx.$queryRawUnsafe("SHOW transaction_isolation"),
          { isolationLevel: "Serializable" }
        );
        expect([name, level]).toEqual([
          name,
          [{ transaction_isolation: "serializable" }],
        ]);
      }
    });
}
