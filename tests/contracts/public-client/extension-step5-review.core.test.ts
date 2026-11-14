/**
 * Adversarial review of step 5 (the public vocabulary): each test states one
 * sentence of the contract (`extension-contract-spec.md`, sections 3 to 7 and
 * 11 to 13) and checks it through the public builders on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import {
  ForbiddenError,
  QueryError,
  ValidationError,
  VibORMError,
} from "@errors";
import { s } from "@schema";
import {
  again,
  arg,
  args,
  around,
  call,
  extension,
  methods,
  oneOf,
  provided,
  rule,
  settled,
  target,
  when,
  writes,
} from "@src/index";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
  owner: s
    .toOne(() => user)
    .fields("ownerId")
    .references("id"),
});
const schema = { user, post };

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  findFirst(args?: object): Promise<Row | null>;
  create(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
  [method: string]: unknown;
}
// The chains below are applied whatever their declared state: only their
// behaviour is read.
interface Loose {
  user: Delegate;
  post: Delegate;
  $extends(value: unknown): Loose;
  $transaction<T>(
    run: ((tx: Loose) => Promise<T>) | readonly unknown[]
  ): Promise<T>;
  $as(actor: unknown): Loose;
  $disconnect(): Promise<void>;
  [method: string]: unknown;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function seeded(): Promise<Loose> {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  await base.user.create({ data: { id: "u1", name: "Ann" } });
  await base.user.create({ data: { id: "u2", name: "Bob" } });
  await base.post.create({ data: { id: "p1", title: "one", ownerId: "u1" } });
  return base;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("call: two moments", () => {
  test("every first moment runs, in chain order, before validation; then the second moments nest, first applied outermost", async () => {
    const log: string[] = [];
    const logging = (name: string) =>
      extension(
        name,
        around((c) => {
          log.push(`${name}:1:${c.operation}`);
          return async (run) => {
            log.push(`${name}:2:in`);
            const value = await run();
            log.push(`${name}:2:out`);
            return value;
          };
        })
      );
    const client = (await seeded())
      .$extends(logging("a"))
      .$extends(logging("b"));
    await client.post.findMany({});
    expect(log).toEqual([
      "a:1:findMany",
      "b:1:findMany",
      "a:2:in",
      "b:2:in",
      "b:2:out",
      "a:2:out",
    ]);
    log.length = 0;
    const error = await rejection(client.post.findMany({ take: "many" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(log).toEqual(["a:1:findMany", "b:1:findMany"]);
  });

  test("c.args is read-only and holds the shape keys; c.set refuses shape keys and argument names", async () => {
    let seen: Readonly<Record<string, unknown>> | undefined;
    const reader = extension(
      "reader",
      call((c) => {
        seen = c.args;
      })
    );
    const client = (await seeded()).$extends(reader);
    await client.post.findMany({ select: { id: true }, take: 1 });
    expect(seen).toEqual({ select: { id: true }, take: 1 });
    expect(Object.isFrozen(seen)).toBe(true);

    const shape = (await seeded()).$extends(
      extension(
        "shape",
        call((c) => c.set({ select: { id: true } }))
      )
    );
    expect(await rejection(shape.post.findMany({}))).toBeInstanceOf(QueryError);

    // Another extension's argument name is refused too.
    const named = (await seeded())
      .$extends(extension("declares", args({ tenant: oneOf("a", "b") })))
      .$extends(
        extension(
          "patcher",
          call((c) => c.set({ tenant: "a" }))
        )
      );
    expect(await rejection(named.post.findMany({}))).toBeInstanceOf(QueryError);
  });

  test("c.values shows the declaring extension's arguments and no other's", async () => {
    const seen: Record<string, unknown> = {};
    const client = (await seeded())
      .$extends(
        extension(
          "first",
          args({ alpha: oneOf("x", "y") }),
          call((c) => {
            seen.first = { ...c.values };
          })
        )
      )
      .$extends(
        extension(
          "second",
          args({ beta: oneOf("x", "y") }),
          call((c) => {
            seen.second = { ...c.values };
          })
        )
      );
    await client.post.findMany({ alpha: "x", beta: "y" });
    expect(seen).toEqual({ first: { alpha: "x" }, second: { beta: "y" } });
  });

  test("a first moment that returns a promise is an error", async () => {
    const client = (await seeded()).$extends(
      extension("async", around((async () => undefined) as never))
    );
    expect(await rejection(client.post.findMany({}))).toBeInstanceOf(
      QueryError
    );
  });
});

describe("call: run()", () => {
  const twice = extension(
    "twice",
    around(() => async (run) => {
      await run();
      return run();
    })
  );
  const skips = extension(
    "skips",
    around(() => async () => [])
  );

  test("run() at most once", async () => {
    const client = (await seeded()).$extends(twice);
    expect(await rejection(client.post.findMany({}))).toBeInstanceOf(
      QueryError
    );
  });

  test("a read outside an array may return without run(); a write, a raw statement and an array member may not", async () => {
    const client = (await seeded()).$extends(skips);
    expect(await client.post.findMany({})).toEqual([]);
    expect(
      await rejection(
        client.post.create({ data: { id: "p2", title: "t", ownerId: "u1" } })
      )
    ).toBeInstanceOf(QueryError);
    expect(
      await rejection(
        (client.$queryRawUnsafe as (sql: string) => Promise<unknown>)(
          "SELECT 1"
        )
      )
    ).toBeInstanceOf(QueryError);
    expect(
      await rejection(client.$transaction([client.post.findMany({})]))
    ).toBeInstanceOf(QueryError);
  });

  test("the child's failure is the call's, whatever the handler throws after it (no aggregate error)", async () => {
    const client = (await seeded()).$extends(
      extension(
        "rethrows",
        around(() => async (run) => {
          try {
            return await run();
          } catch {
            throw new Error("handler's own");
          }
        })
      )
    );
    const error = await rejection(
      client.post.create({ data: { id: "p1", title: "dup", ownerId: "u1" } })
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error).toBeInstanceOf(VibORMError);
  });

  test("again(run) is false inside a transaction", async () => {
    const answers: boolean[] = [];
    const client = (await seeded()).$extends(
      extension(
        "retry",
        around(() => async (run) => {
          try {
            return await run();
          } catch (error) {
            answers.push(again(run));
            throw error;
          }
        })
      )
    );
    await rejection(
      client.$transaction((tx) =>
        tx.post.create({ data: { id: "p1", title: "dup", ownerId: "u1" } })
      )
    );
    await rejection(
      client.post.create({ data: { id: "p1", title: "dup", ownerId: "u1" } })
    );
    expect(answers).toEqual([false, true]);
  });
});

describe("call: settled", () => {
  test("awaited before a direct write resolves; after the outermost commit in a transaction; never after a rollback", async () => {
    const log: string[] = [];
    const client = (await seeded()).$extends(
      extension(
        "durable",
        around((c) => {
          settled(c, async (outcome) => {
            await Promise.resolve();
            log.push(`settled:${c.operation}:${outcome.certainty}`);
          });
          return (run) => run();
        }, target(writes))
      )
    );
    await client.post.create({ data: { id: "p2", title: "t", ownerId: "u1" } });
    log.push("resolved");
    await client.$transaction(async (tx) => {
      await tx.post.create({ data: { id: "p3", title: "t", ownerId: "u1" } });
      log.push("inside");
    });
    log.push("committed");
    await rejection(
      client.$transaction(async (tx) => {
        await tx.post.create({ data: { id: "p4", title: "t", ownerId: "u1" } });
        throw new Error("roll back");
      })
    );
    expect(log).toEqual([
      "settled:create:committed",
      "resolved",
      "inside",
      "settled:create:committed",
      "committed",
    ]);
  });

  test("a throw from settled rejects the call as a QueryError; a VibORMError passes as it is", async () => {
    const failing = (error: Error) =>
      extension(
        "fails",
        call((c) => {
          settled(c, () => {
            throw error;
          });
        }, target(writes))
      );
    const plain = (await seeded()).$extends(failing(new Error("boom")));
    expect(
      await rejection(
        plain.post.create({ data: { id: "p2", title: "t", ownerId: "u1" } })
      )
    ).toBeInstanceOf(QueryError);
    const own = new ForbiddenError("post", "create");
    const viborm = (await seeded()).$extends(failing(own));
    expect(
      await rejection(
        viborm.post.create({ data: { id: "p3", title: "t", ownerId: "u1" } })
      )
    ).toBe(own);
  });

  test("two settled functions run in chain order and the first fault rejects the call", async () => {
    const failing = (name: string) =>
      extension(
        name,
        call((c) => {
          settled(c, () => {
            throw new Error(name);
          });
        }, target(writes))
      );
    const client = (await seeded())
      .$extends(failing("first"))
      .$extends(failing("second"));
    const error = await rejection(
      client.post.create({ data: { id: "p2", title: "t", ownerId: "u1" } })
    );
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error).toBeInstanceOf(QueryError);
  });

  test("settled registered by a call without a writes target is refused, never silently dropped", async () => {
    let ran = false;
    const client = (await seeded()).$extends(
      extension(
        "untargeted",
        call((c) => {
          settled(c, () => {
            ran = true;
          });
        })
      )
    );
    const outcome = await client.post
      .create({ data: { id: "p2", title: "t", ownerId: "u1" } })
      .then(
        () => "resolved",
        (error: unknown) => error
      );
    // Either the side effect runs, or the registration is refused: a hook
    // that silently never runs is the defect.
    expect(ran || outcome !== "resolved").toBe(true);
  });

  test("settled in a call targeting one write by name is not silently dropped", async () => {
    let ran = false;
    const client = (await seeded()).$extends(
      extension(
        "named",
        call(
          (c) => {
            settled(c, () => {
              ran = true;
            });
          },
          target("post", "create")
        )
      )
    );
    const outcome = await client.post
      .create({ data: { id: "p2", title: "t", ownerId: "u1" } })
      .then(
        () => "resolved",
        (error: unknown) => error
      );
    expect(ran || outcome !== "resolved").toBe(true);
  });
});

describe("rule: arguments", () => {
  test("D7: a rule naming an argument no extension declares is refused at $extends", async () => {
    const base = await seeded();
    expect(
      thrown(() =>
        base.$extends(
          extension(
            "undeclared",
            rule({
              post: { read: { where: { ownerId: arg("nobody") } } },
            } as never)
          )
        )
      )
    ).toBeInstanceOf(VibORMError);
  });

  test("D7: a held arg written away from the rule is refused at $extends", async () => {
    const base = await seeded();
    const held = arg("ghost");
    const shared = { ownerId: held };
    expect(
      thrown(() =>
        base.$extends(
          extension(
            "held",
            rule({ post: { read: { where: shared } } } as never)
          )
        )
      )
    ).toBeInstanceOf(VibORMError);
  });

  test("an absent non-required argument drops the filter that names it; a required one refuses the call", async () => {
    const base = await seeded();
    await base.post.create({ data: { id: "p2", title: "two", ownerId: "u2" } });
    const owned = base.$extends(
      extension(
        "owned",
        args({ owner: v.string() }),
        rule({ post: { read: { where: { ownerId: arg("owner") } } } } as never)
      )
    );
    expect(await owned.post.findMany({})).toHaveLength(2);
    expect(await owned.post.findMany({ owner: "u1" })).toHaveLength(1);
    const required = base.$extends(
      extension(
        "required",
        args({ owner: oneOf("u1", "u2").required() }),
        rule({ post: { read: { where: { ownerId: arg("owner") } } } } as never)
      )
    );
    expect(await rejection(required.post.findMany({}))).toBeInstanceOf(
      VibORMError
    );
  });

  test("when: a failed test leaves no filter; provided: a failed test is false", async () => {
    const base = await seeded();
    await base.post.create({ data: { id: "p2", title: "two", ownerId: "u2" } });
    const gated = (word: typeof when | typeof provided, name: string) =>
      base.$extends(
        extension(
          name,
          args({ view: oneOf("mine", "all") }),
          rule({
            post: {
              read: {
                where: (word as typeof when)(arg("view"), "mine", {
                  ownerId: "u1",
                }),
              },
            },
          } as never)
        )
      );
    const withWhen = gated(when, "when");
    expect(await withWhen.post.findMany({ view: "mine" })).toHaveLength(1);
    expect(await withWhen.post.findMany({ view: "all" })).toHaveLength(2);
    const withProvided = gated(provided, "provided");
    expect(await withProvided.post.findMany({ view: "mine" })).toHaveLength(1);
    expect(await withProvided.post.findMany({ view: "all" })).toHaveLength(0);
  });

  test("a mode argument keeps the placement its declaration gives (.on)", async () => {
    const base = await seeded();
    const moded = base.$extends(
      extension(
        "moded",
        args({ view: oneOf("mine", "all").default("all").on(["findMany"]) }),
        rule({
          post: {
            read: { where: when(arg("view"), "mine", { ownerId: "u1" }) },
          },
        } as never)
      )
    );
    expect(await moded.post.findMany({ view: "mine" })).toHaveLength(1);
    // `.on(["findMany"])`: a findFirst does not accept the argument.
    expect(
      await rejection(moded.post.findFirst({ view: "mine" }))
    ).toBeInstanceOf(VibORMError);
  });
});

describe("permissions: an action a model does not grant", () => {
  const policy = () =>
    permissions({
      actor: v.object({ userId: v.string() }),
      models: { post: { read: true }, user: { read: true } },
    } as never);

  test("update and delete on a model listed with only read are refused, before validation", async () => {
    const base = await seeded();
    const db = base.$extends(policy()).$as({ userId: "u1" });
    expect(await db.post.findMany({})).toHaveLength(1);
    expect(
      await rejection(
        db.post.update({ where: { id: "p1" }, data: { title: "x" } })
      )
    ).toBeInstanceOf(ForbiddenError);
    expect(
      await rejection(db.post.delete({ where: { id: "p1" } }))
    ).toBeInstanceOf(ForbiddenError);
    expect(
      await rejection(
        (db.post.updateMany as (a: object) => Promise<unknown>)({
          where: {},
          data: { title: "x" },
        })
      )
    ).toBeInstanceOf(ForbiddenError);
    expect(
      await rejection(
        (db.post.deleteMany as (a: object) => Promise<unknown>)({ where: {} })
      )
    ).toBeInstanceOf(ForbiddenError);
    // A malformed call on a refused action is still a ForbiddenError (D3).
    expect(
      await rejection(db.post.update({ where: { id: 1 }, data: { nope: 1 } }))
    ).toBeInstanceOf(ForbiddenError);
    expect(await base.post.findMany({})).toEqual([
      { id: "p1", title: "one", ownerId: "u1" },
    ]);
  });

  test("an upsert and a nested write through a read-only relation are refused", async () => {
    const base = await seeded();
    const db = base
      .$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: { post: { read: true }, user: { read: true, update: true } },
        } as never)
      )
      .$as({ userId: "u1" });
    expect(
      await rejection(
        (db.post.upsert as (a: object) => Promise<unknown>)({
          where: { id: "p1" },
          create: { id: "p1", title: "x", ownerId: "u1" },
          update: { title: "x" },
        })
      )
    ).toBeInstanceOf(ForbiddenError);
    // A nested write through the relation either is refused or takes no row.
    await db.user
      .update({
        where: { id: "u1" },
        data: { posts: { updateMany: { where: {}, data: { title: "x" } } } },
      })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(ForbiddenError);
      });
    await db.user
      .update({ where: { id: "u1" }, data: { posts: { deleteMany: {} } } })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(ForbiddenError);
      });
    expect(await base.post.findMany({})).toEqual([
      { id: "p1", title: "one", ownerId: "u1" },
    ]);
  });
});

describe("extension and methods", () => {
  test("a duplicate extension name in one chain is refused", async () => {
    const base = await seeded();
    const one = extension(
      "same",
      call(() => undefined)
    );
    expect(thrown(() => base.$extends(one).$extends(one))).toBeInstanceOf(
      VibORMError
    );
  });

  test("a client method must start with $; collisions with the core, a model and an earlier extension are refused", async () => {
    const base = await seeded();
    const named = (name: string, key: string) =>
      extension(
        name,
        methods(() => ({ [key]: () => 1 }) as never)
      );
    expect(thrown(() => base.$extends(named("bare", "hello")))).toBeInstanceOf(
      VibORMError
    );
    expect(
      thrown(() => base.$extends(named("core", "$transaction")))
    ).toBeInstanceOf(VibORMError);
    const first = base.$extends(named("one", "$hello"));
    expect(thrown(() => first.$extends(named("two", "$hello")))).toBeInstanceOf(
      VibORMError
    );
    expect(
      thrown(() =>
        base.$extends(
          extension(
            "then",
            methods(() => ({ post: { then: () => 1 } }) as never)
          )
        )
      )
    ).toBeInstanceOf(VibORMError);
  });

  test("a model method is called with this equal to its delegate", async () => {
    const base = await seeded();
    const client = base.$extends(
      extension(
        "count-own",
        methods(
          () =>
            ({
              post: {
                titles(this: Delegate) {
                  return this.findMany({ select: { title: true } });
                },
              },
            }) as never
        )
      )
    );
    const titles = (client.post.titles as () => Promise<Row[]>)();
    expect(await titles).toEqual([{ title: "one" }]);
  });
});
