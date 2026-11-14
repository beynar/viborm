/**
 * Adversarial review of the last pass of the extension host (2026-11-15,
 * `573d6cf92..41e987fa1`), the half that is not transactions: one admission
 * memo per extension and schema (`shared(key, make)`, `perSchema`), each part
 * joining the chain itself, two `unit` or `methods` parts in one extension,
 * the freezes removed, and the error surface of `extension()`.
 *
 * Runs on SQLite (in memory, or one file shared by two clients).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import {
  accepts,
  arg,
  args,
  call,
  defaults,
  extension,
  methods,
  rule,
  sql,
  statement,
  text,
  unit,
} from "@src/index";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

const NAMES_TENANT = /tenant/;
const NAMES_TWICE_MODEL = /twice-model/;
const NAMES_TWICE = /twice/;
const BOTH_REWRITES = /\/\* first \*\/ \/\* second \*\/$/;
const NAMES_FACTORY = /broken-factory/;
const NAMES_BAD = /bad/;

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
  createMany(args: object): Promise<unknown>;
  [method: string]: unknown;
}
interface Loose {
  [model: string]: unknown;
  post: Delegate;
  user: Delegate;
  $extends(definition: unknown): Loose;
  $as(actor: object): Loose;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

const memory = async (schema: object): Promise<Loose> => {
  const client = createClient({
    schema: schema as never,
    dataDir: ":memory:",
  }) as never as Loose;
  opened.push(client);
  await syncLiveSchema(client as never);
  return client;
};

const titles = async (delegate: Delegate, args: object = {}) =>
  (await delegate.findMany({ ...args, select: { id: true } }))
    .map((row) => String(row.id))
    .sort();

/** Two schemas with the same model names over different tables. */
function twoSchemas() {
  const make = (suffix: string) => {
    const user = s
      .model({
        id: s.string().id(),
        org: s.string(),
        posts: s.toMany(() => post),
      })
      .map(`user_${suffix}`);
    const post = s
      .model({
        id: s.string().id(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      })
      .map(`post_${suffix}`);
    return { user, post };
  };
  return { a: make("a"), b: make("b") };
}

/**
 * One SQLite file holding both schemas' tables, the orgs swapped between
 * them, and a client of each schema over it.
 */
async function sharedFile(a: object, b: object) {
  const file = join(mkdtempSync(join(tmpdir(), "viborm-memo-")), "db.sqlite");
  const clientA = createClient({
    schema: a as never,
    dataDir: file,
  }) as never as Loose & {
    $executeRawUnsafe(query: string): Promise<number>;
  };
  const clientB = createClient({
    schema: b as never,
    dataDir: file,
  }) as never as Loose;
  opened.push(clientA, clientB);
  for (const suffix of ["a", "b"]) {
    await clientA.$executeRawUnsafe(
      `CREATE TABLE user_${suffix} (id TEXT PRIMARY KEY, org TEXT NOT NULL)`
    );
    await clientA.$executeRawUnsafe(
      `CREATE TABLE post_${suffix} (id TEXT PRIMARY KEY, "authorId" TEXT NOT NULL)`
    );
  }
  await clientA.user.createMany({
    data: [
      { id: "u1", org: "x" },
      { id: "u2", org: "y" },
    ],
  });
  await clientB.user.createMany({
    data: [
      { id: "u1", org: "y" },
      { id: "u2", org: "x" },
    ],
  });
  for (const client of [clientA, clientB])
    await client.post.createMany({
      data: [
        { id: "p1", authorId: "u1" },
        { id: "p2", authorId: "u2" },
      ],
    });
  return { file, clientA, clientB };
}

describe("B. one memo per extension and schema", () => {
  // A predicate compiled for one schema's model objects, read by a client of
  // another schema with the same model names, would read the other tables.
  test("one permissions value over two schemas with the same model names reads each client's own tables", async () => {
    const { a, b } = twoSchemas();
    const { clientA, clientB } = await sharedFile(a, b);
    const policy = permissions({
      actor: v.object({ org: v.string() }),
      models: {
        user: { read: { org: { actor: "org" } } },
        post: { read: { author: "read" } },
      },
    } as never);
    const governedA = clientA.$extends(policy).$as({ org: "x" });
    const governedB = clientB.$extends(policy).$as({ org: "x" });
    expect(await titles(governedA.post)).toEqual(["p1"]);
    expect(await titles(governedB.post)).toEqual(["p2"]);
    // And in the other order of first use, on fresh views.
    expect(
      await titles(clientB.$extends(policy).$as({ org: "x" }).post)
    ).toEqual(["p2"]);
    expect(
      await titles(clientA.$extends(policy).$as({ org: "x" }).post)
    ).toEqual(["p1"]);
  });

  test("one rule value over two schemas with the same model names filters each client's own tables", async () => {
    const { a, b } = twoSchemas();
    const { clientA, clientB } = await sharedFile(a, b);
    const only = extension(
      "org-x",
      rule({ post: { read: { where: { author: { org: "x" } } } } } as never)
    );
    expect(await titles(clientA.$extends(only).post)).toEqual(["p1"]);
    expect(await titles(clientB.$extends(only).post)).toEqual(["p2"]);
  });

  test("a schema object whose model is swapped after first use is read again by the next client", async () => {
    const { a, b } = twoSchemas();
    const schema: Record<string, unknown> = { ...a };
    const { file } = await sharedFile(a, b);
    const policy = permissions({
      actor: v.object({ org: v.string() }),
      models: {
        user: { read: { org: { actor: "org" } } },
        post: { read: { author: "read" } },
      },
    } as never);
    const first = createClient({
      schema: schema as never,
      dataDir: file,
    }) as never as Loose;
    opened.push(first);
    expect(await titles(first.$extends(policy).$as({ org: "x" }).post)).toEqual(
      ["p1"]
    );
    // Both models swapped for those of the other tables.
    schema.user = b.user;
    schema.post = b.post;
    const second = createClient({
      schema: schema as never,
      dataDir: file,
    }) as never as Loose;
    opened.push(second);
    expect(
      await titles(second.$extends(policy).$as({ org: "x" }).post)
    ).toEqual(["p2"]);
  });

  test("a rule reading an argument is refused on every chain that does not declare it, whatever was applied first", async () => {
    const post = s.model({ id: s.string().id(), tenant: s.string() });
    const base = await memory({ post });
    const tenancy = extension("tenancy", args({ tenant: accepts(v.string()) }));
    const scoped = extension(
      "scoped",
      rule({ post: { read: { where: { tenant: arg("tenant") } } } } as never)
    );
    expect(() => base.$extends(tenancy).$extends(scoped)).not.toThrow();
    expect(() => base.$extends(scoped)).toThrow(NAMES_TENANT);
    const other = await memory({ post });
    expect(() => other.$extends(scoped)).toThrow(NAMES_TENANT);
  });

  test("the same chain built in two orders answers the same", async () => {
    const post = s.model({
      id: s.string().id(),
      title: s.string(),
      deleted: s.boolean(),
    });
    const base = await memory({ post });
    await base.post.createMany({
      data: [
        { id: "a", title: "keep", deleted: false },
        { id: "b", title: "keep", deleted: true },
        { id: "c", title: "drop", deleted: false },
      ],
    });
    const kept = extension(
      "kept",
      rule({ post: { read: { where: { deleted: false } } } } as never)
    );
    const titled = extension(
      "titled",
      rule({ post: { read: { where: { title: "keep" } } } } as never)
    );
    expect(await titles(base.$extends(kept).$extends(titled).post)).toEqual([
      "a",
    ]);
    expect(await titles(base.$extends(titled).$extends(kept).post)).toEqual([
      "a",
    ]);
    expect(await titles(base.$extends(kept).post)).toEqual(["a", "c"]);
    expect(await titles(base.$extends(titled).post)).toEqual(["a", "b"]);
  });
});

describe("C. two unit parts, two methods parts in one extension", () => {
  test("two methods parts both add their methods, the second sees the first's", async () => {
    const post = s.model({ id: s.string().id() });
    const base = await memory({ post });
    const db = base.$extends(
      extension(
        "two-methods",
        methods(() => ({ $one: () => 1 })),
        methods((scope) => ({
          // The types do not show the first part's methods on this scope.
          $two: () => 2 + (scope as never as { $one(): number }).$one(),
        }))
      )
    ) as never as { $one(): number; $two(): number };
    expect([db.$one(), db.$two()]).toEqual([1, 3]);
  });

  test("a method name given by two methods parts of one extension is refused at $extends", async () => {
    const post = s.model({ id: s.string().id() });
    const base = await memory({ post });
    expect(() =>
      base.$extends(
        extension(
          "twice",
          methods(() => ({ $x: () => "first" })),
          // The types refuse it already; the runtime must too.
          methods((() => ({ $x: () => "second" })) as never)
        )
      )
    ).toThrow(NAMES_TWICE);
  });

  test("a model method given by two methods parts of one extension is refused at $extends", async () => {
    const post = s.model({ id: s.string().id() });
    const base = await memory({ post });
    expect(() =>
      base.$extends(
        extension(
          "twice-model",
          methods(() => ({ post: { tag: () => "first" } })),
          methods(() => ({ post: { tag: () => "second" } }))
        )
      )
    ).toThrow(NAMES_TWICE_MODEL);
  });

  test("two unit parts both run, in the order written; two rewrites compose in that order", async () => {
    const post = s.model({ id: s.string().id() });
    const base = await memory({ post });
    const seen: string[] = [];
    const db = base.$extends(
      extension(
        "two-units",
        unit((u, next) => next(sql`${statement(u)} /* first */`), undefined, {
          rewrites: true,
        }),
        unit((u, next) => next(sql`${statement(u)} /* second */`), undefined, {
          rewrites: true,
        }),
        unit(async (u, next) => {
          if (u.kind === "statement") seen.push(`a:${text(u)}`);
          return next();
        }),
        unit(async (u, next) => {
          if (u.kind === "statement") seen.push("b");
          return next();
        })
      )
    );
    await db.post.findMany();
    expect(seen.length).toBe(2);
    expect(seen[0]).toMatch(BOTH_REWRITES);
    expect(seen[1]).toBe("b");
  });
});

describe("D. what an author can mutate after $extends", () => {
  test("the extension value and c.args stay frozen", async () => {
    const post = s.model({ id: s.string().id(), title: s.string() });
    const base = await memory({ post });
    let assigned: unknown;
    const value = extension(
      "frozen",
      call((c) => {
        try {
          (c.args as Record<string, unknown>).where = { id: "x" };
          assigned = "assigned";
        } catch (error) {
          assigned = (error as Error).constructor.name;
        }
      })
    );
    expect(Object.isFrozen(value)).toBe(true);
    await base.$extends(value).post.findMany();
    expect(assigned).toBe("TypeError");
  });

  // A handler is handed the schema the extension is applied to. Removing a
  // model from it, or swapping one, changes it for every client of that
  // schema object, and for every extension memo keyed by it.
  test("a call handler cannot change the schema every client of it shares", async () => {
    const post = s.model({ id: s.string().id(), title: s.string() });
    const secret = s.model({ id: s.string().id() });
    const schema = { post, secret };
    const base = await memory(schema);
    const db = base.$extends(
      extension(
        "vandal",
        call((c) => {
          try {
            Reflect.deleteProperty(c.schema, "secret");
          } catch {
            // A frozen schema refuses: what this test wants.
          }
        })
      )
    );
    await db.post.findMany();
    expect(Object.keys(schema)).toEqual(["post", "secret"]);
  });

  test("entries given to rule and mutated after $extends change nothing, on this client or the next", async () => {
    const post = s.model({ id: s.string().id(), title: s.string() });
    const schema = { post };
    const base = await memory(schema);
    await base.post.createMany({
      data: [
        { id: "a", title: "a" },
        { id: "b", title: "b" },
      ],
    });
    const where = { title: "a" };
    const value = extension(
      "by-title",
      rule({ post: { read: { where } } } as never)
    );
    const first = base.$extends(value);
    expect(await titles(first.post)).toEqual(["a"]);
    let mutated = "mutated";
    try {
      where.title = "b";
    } catch (error) {
      mutated = (error as Error).constructor.name;
    }
    const second = (await memory(schema)).$extends(value);
    await (second.post as Delegate).createMany({
      data: [
        { id: "a", title: "a" },
        { id: "b", title: "b" },
      ],
    });
    const third = createClient({
      schema: { post },
      dataDir: ":memory:",
    }) as never as Loose;
    opened.push(third);
    await syncLiveSchema(third as never);
    await third.post.createMany({
      data: [
        { id: "a", title: "a" },
        { id: "b", title: "b" },
      ],
    });
    const answers = {
      mutated,
      sameClient: await titles(first.post),
      sameSchema: await titles(second.post),
      otherSchema: await titles(third.$extends(value).post),
    };
    // Whatever the mutation does, every client of the value must answer alike.
    expect({ ...answers, mutated: undefined }).toEqual({
      mutated: undefined,
      sameClient: answers.sameClient,
      sameSchema: answers.sameClient,
      otherSchema: answers.sameClient,
    });
  });

  test("a defaults map mutated after $extends changes nothing, on this client or the next", async () => {
    const post = s.model({ id: s.string().id(), title: s.string() });
    const schema = { post };
    const base = await memory(schema);
    const create = { title: "default" };
    const value = extension("titled", defaults({ post: { create } } as never));
    const first = base.$extends(value);
    await first.post.create({ data: { id: "a" } });
    try {
      create.title = "changed";
    } catch {
      // A frozen map refuses.
    }
    await first.post.create({ data: { id: "b" } });
    const other = (await memory(schema)).$extends(value);
    await other.post.create({ data: { id: "c" } });
    const rows = [
      ...(await base.post.findMany({ select: { id: true, title: true } })),
      ...(await other.post.findMany({ select: { id: true, title: true } })),
    ];
    expect(new Set(rows.map((row) => row.title)).size).toBe(1);
  });

  test("an args declaration mutated after $extends changes nothing", async () => {
    const post = s.model({ id: s.string().id(), tenant: s.string() });
    const schema = { post };
    const base = await memory(schema);
    await base.post.createMany({
      data: [
        { id: "a", tenant: "t1" },
        { id: "b", tenant: "t2" },
      ],
    });
    const declared: Record<string, unknown> = { tenant: accepts(v.string()) };
    const value = extension(
      "tenancy",
      args(declared as never),
      rule({ post: { read: { where: { tenant: arg("tenant") } } } } as never)
    );
    const db = base.$extends(value);
    expect(await titles(db.post, { tenant: "t1" })).toEqual(["a"]);
    try {
      declared.tenant = accepts(v.literal("t2"));
    } catch {
      // A frozen declaration refuses.
    }
    const answers = [
      await titles(db.post, { tenant: "t1" }).catch(
        (e: Error) => e.constructor.name
      ),
      await titles((await memory(schema)).$extends(value).post, {
        tenant: "t1",
      }).catch((e: Error) => e.constructor.name),
    ];
    expect(answers).toEqual([["a"], ["a"]]);
  });

  test("the scope a methods factory receives cannot be changed for the next view", async () => {
    const post = s.model({ id: s.string().id() });
    const base = await memory({ post });
    await base.post.create({ data: { id: "a" } });
    const db = base.$extends(
      extension(
        "scope-vandal",
        methods((scope) => {
          try {
            (scope as Record<string, unknown>).post = {
              findMany: async () => [{ id: "forged" }],
            };
          } catch {
            // A frozen scope refuses.
          }
          return {
            $count: async () =>
              (await (scope as never as Loose).post.findMany()).length,
          };
        })
      )
    ) as never as Loose & { $count(): Promise<number> };
    await db.$count();
    expect(await titles(db.post)).toEqual(["a"]);
  });
});

describe("E. the error surface", () => {
  test("a methods factory that throws names its extension", async () => {
    const post = s.model({ id: s.string().id() });
    const base = await memory({ post });
    let caught: unknown;
    try {
      base.$extends(
        extension(
          "broken-factory",
          methods(() => {
            throw new Error("boom");
          })
        )
      );
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error)?.message)).toMatch(NAMES_FACTORY);
  });

  test("extension() refuses a value that is not a part, and an uncalled builder", () => {
    expect(() => extension("bad", {} as never)).toThrow(NAMES_BAD);
    expect(() => extension("bad", call as never)).toThrow(NAMES_BAD);
  });

  test("one part in two extensions of one chain runs once in each", async () => {
    const post = s.model({ id: s.string().id() });
    const base = await memory({ post });
    let calls = 0;
    const counted = call(() => {
      calls += 1;
    });
    await base
      .$extends(extension("one", counted))
      .$extends(extension("two", counted))
      .post.findMany();
    expect(calls).toBe(2);
  });

  test("one part named twice in one extension is refused or runs twice, never silently once", async () => {
    const post = s.model({ id: s.string().id() });
    const base = await memory({ post });
    let calls = 0;
    const counted = call(() => {
      calls += 1;
    });
    let refused = false;
    try {
      await base.$extends(extension("twice", counted, counted)).post.findMany();
    } catch {
      refused = true;
    }
    expect(refused || calls === 2).toBe(true);
  });
});
