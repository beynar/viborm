/**
 * viborm/ordering with the rest of VibORM, on in-memory SQLite (interactive
 * and batch-only): write hooks receive stored keys, soft delete and
 * permissions, nested creates under generated parent ids, recursive reads,
 * adoption on an existing table, respacing in one statement. From the
 * adversarial reviews of PR #127.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { NotFoundError } from "@errors";
import { s } from "@schema";
import { Sql } from "@sql";
import { on } from "@src/on";
import { isKey, ordering, orderingKey } from "@src/ordering";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

class BatchOnlySQLite3Driver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries)
        results.push(await this.execute<T>(tx, query.sql, query.params ?? []));
      return results;
    });
  }
}

const board = s.model({
  id: s.int().id().increment(),
  name: s.string(),
  items: s.toMany(() => item),
});

const item = s.model({
  id: s.int().id().increment(),
  boardId: s.int().nullable(),
  day: s.dateTime().nullable(),
  rank: s.string().schema(orderingKey),
  title: s.string(),
  board: s
    .toOne(() => board)
    .fields("boardId")
    .references("id"),
});

const schema = { board, item };

async function open(batchOnly = false) {
  const client = createClient({
    schema,
    driver: batchOnly
      ? new BatchOnlySQLite3Driver({ dataDir: ":memory:" })
      : createInMemorySQLite3Driver(),
  });
  await syncLiveSchema(client);
  return client;
}

const titles = (rows: readonly { title: string }[]) => rows.map((r) => r.title);

describe("ordering review: ordering", () => {
  test("on() hook receives the created row's real key (not an Sql object)", async () => {
    const client = await open();
    const seen: unknown[] = [];
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      (client as any).$extends(
        on({
          item: {
            create: (rows: unknown[]) => {
              seen.push(...rows);
            },
          },
        } as any)
      )
    ) as any;
    await db.item.create({ data: { title: "a", boardId: null } });
    const stored = await db.item.findMany();
    expect(typeof (seen[0] as any).rank).toBe("string");
    expect((seen[0] as any).rank).toBe(stored[0].rank);
  });

  test("on() hook receives a moved row's stored key (not its expression)", async () => {
    const client = await open();
    const seen: unknown[] = [];
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      (client as any).$extends(
        on({
          item: {
            update: (rows: unknown[]) => {
              seen.push(...rows);
            },
          },
        } as any)
      )
    ) as any;
    for (const title of ["a", "b"]) await db.item.create({ data: { title } });
    await db.item.move({ where: { id: 1 }, after: { id: 2 } });
    const stored = await db.item.findUnique({ where: { id: 1 } });
    expect(seen).toHaveLength(1);
    expect((seen[0] as any).rank).toBe(stored.rank);
  });

  test("on() hook after ordering keys step", async () => {
    const client = await open();
    const seen: unknown[] = [];
    const db = (
      ordering({ item: { key: "rank", within: ["boardId"] } })(
        client as any
      ) as any
    ).$extends(
      on({
        item: {
          create: (rows: unknown[]) => {
            seen.push(...rows);
          },
        },
      } as any)
    );
    await db.item.create({ data: { title: "a", boardId: null } });
    const stored = await db.item.findMany();
    expect(typeof (seen[0] as any).rank).toBe("string");
    expect((seen[0] as any).rank).toBe(stored[0].rank);
  });

  test("create result carries the key as a string", async () => {
    const client = await open();
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      client as any
    ) as any;
    const created = await db.item.create({ data: { title: "a" } });
    expect(isKey(created.rank)).toBe(true);
  });

  test("createMany keeps array order when the list field is a DateTime", async () => {
    const client = await open();
    const db = ordering({ item: { key: "rank", within: ["day"] } })(
      client as any
    ) as any;
    const day = "2026-10-31T00:00:00.000Z";
    const data = Array.from({ length: 12 }, (_, i) => ({
      title: `t${String(i).padStart(2, "0")}`,
      day: new Date(day),
    }));
    await db.item.createMany({ data });
    const rows = await db.item.findMany();
    expect(titles(rows)).toEqual(data.map((d) => d.title));
  });

  test("array transaction of creates keeps order", async () => {
    const client = await open();
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      client as any
    ) as any;
    await db.$transaction([
      db.item.create({ data: { title: "a" } }),
      db.item.create({ data: { title: "b" } }),
      db.item.createMany({ data: [{ title: "c" }, { title: "d" }] }),
    ]);
    expect(titles(await db.item.findMany())).toEqual(["a", "b", "c", "d"]);
  });

  test.each([
    false,
    true,
  ])("nested creates under a produced parent id keep order (batchOnly=%s)", async (batchOnly) => {
    const client = await open(batchOnly);
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      client as any
    ) as any;
    const b0 = await db.board.create({ data: { name: "x" } });
    await db.item.create({ data: { title: "pre", boardId: b0.id } });
    const made = await db.board.create({
      data: {
        name: "b",
        items: {
          create: [{ title: "p" }, { title: "q" }, { title: "r" }],
          createMany: { data: [{ title: "s" }, { title: "t" }] },
        },
      },
      include: { items: true },
    });
    expect(titles(made.items)).toEqual(["p", "q", "r", "s", "t"]);
    expect(made.items.every((r: any) => isKey(r.rank))).toBe(true);
    const again = await db.board.findUnique({
      where: { id: made.id },
      include: { items: true },
    });
    expect(titles(again.items)).toEqual(["p", "q", "r", "s", "t"]);
  });

  test("rekey with a where narrower than the list respaces the whole list", async () => {
    const client = await open();
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      client as any
    ) as any;
    for (const t of ["a", "b", "c", "d", "e", "f"])
      await db.item.create({ data: { title: t } });
    await db.item.rekey({ where: { title: { in: ["e", "f"] } } });
    // e, f were last; a narrowed rekey moves them to the front.
    expect(titles(await db.item.findMany())).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  test("distinct without orderBy", async () => {
    const client = await open();
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      client as any
    ) as any;
    const b = await db.board.create({ data: { name: "x" } });
    for (const t of ["a", "b"])
      await db.item.create({ data: { title: t, boardId: b.id } });
    for (const t of ["c", "d"]) await db.item.create({ data: { title: t } });
    const rows = await db.item.findMany({ distinct: ["boardId"] });
    expect(rows).toHaveLength(2);
    const back = await db.item.findMany({ take: -2 });
    expect(titles(back)).toHaveLength(2);
    const cursor = await db.item.findMany({ cursor: { id: 2 }, take: 2 });
    expect(cursor).toHaveLength(2);
  });

  test("move with a NULL list after an anchor in a NULL list", async () => {
    const client = await open();
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      client as any
    ) as any;
    for (const t of ["a", "b", "c"])
      await db.item.create({ data: { title: t } });
    await db.item.move({ where: { id: 1 }, after: { id: 2 } });
    expect(titles(await db.item.findMany())).toEqual(["b", "a", "c"]);
    await db.item.move({ where: { id: 3 }, before: { id: 2 } });
    expect(titles(await db.item.findMany())).toEqual(["c", "b", "a"]);
  });

  test("move with an anchor given by a non-identity unique", async () => {
    const client = await open();
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      client as any
    ) as any;
    for (const t of ["a", "b", "c"])
      await db.item.create({ data: { title: t } });
    // anchor same row but spelled with a different value type
    await expect(
      db.item.move({ where: { id: 1 }, after: { id: 1, title: "a" } })
    ).rejects.toThrow();
  });
});

const task = s.model({
  id: s.int().id().increment(),
  status: s.string().default("todo"),
  rank: s.string().schema(orderingKey),
  title: s.string(),
  deletedAt: s.dateTime().nullable(),
});

describe("ordering review: ordering 2", () => {
  const openTask = async () => {
    const client = createClient({
      schema: { task },
      driver: createInMemorySQLite3Driver(),
    });
    await syncLiveSchema(client);
    return client as any;
  };

  test("a list field left to its default is appended to the right list", async () => {
    const client = await openTask();
    const db = ordering({ task: { key: "rank", within: ["status"] } })(
      client
    ) as any;
    for (const title of ["a", "b", "c"])
      await db.task.create({ data: { title } });
    const rows = await db.task.findMany();
    expect(titles(rows)).toEqual(["a", "b", "c"]);
    expect(new Set(rows.map((r: any) => r.rank)).size).toBe(3);
  });

  test("rekey under soft delete respaces hidden rows too", async () => {
    const client = await openTask();
    const tombs = softDelete({ models: { task: { deletedAt: "deletedAt" } } });
    const order = ordering({ task: { key: "rank" } });
    const db = order.methods(order.keys(tombs.rows(client)) as any) as any;
    const restorable = tombs.methods(db as any) as any;
    for (const title of ["a", "b", "c", "d", "e", "f"])
      await db.task.create({ data: { title } });
    await db.task.deleteMany({ where: { title: { in: ["a", "b", "c"] } } });
    await db.task.rekey();
    await restorable.task.restoreMany({
      where: { title: { in: ["a", "b", "c"] } },
    });
    expect(titles(await db.task.findMany())).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  test("move's respace keeps the rows it cannot see in place", async () => {
    const client = await openTask();
    const tombs = softDelete({ models: { task: { deletedAt: "deletedAt" } } });
    const order = ordering({ task: { key: "rank" } });
    const db = order.methods(order.keys(tombs.rows(client)) as any) as any;
    const restorable = tombs.methods(db as any) as any;
    // a b c with c, d, e, f tied at "15": order by id among equals.
    for (const title of ["a", "b"]) await db.task.create({ data: { title } });
    for (const title of ["c", "d", "e"])
      await db.task.create({ data: { title, rank: "15" } });
    await db.task.delete({ where: { id: 3 } }); // c hidden, keeps "15"
    await db.task.move({ where: { id: 1 }, after: { id: 4 } }); // between tied d, e: respace
    await restorable.task.restore({ where: { id: 3 } });
    // Intended: b, c, d, a, e (c was before d)
    expect(titles(await db.task.findMany())).toEqual(["b", "c", "d", "a", "e"]);
  });
});

const legacy = s.model({
  id: s.int().id().increment(),
  rank: s.string(),
  title: s.string(),
});

describe("ordering review: ordering adoption", () => {
  test.each([
    "x",
    "",
    "1",
    "0",
  ])("adoption with constant %j, creates before rekey keep order", async (constant) => {
    const client = createClient({
      schema: { legacy },
      driver: createInMemorySQLite3Driver(),
    }) as any;
    await syncLiveSchema(client);
    await client.legacy.create({ data: { title: "old", rank: constant } });
    const db = ordering({ legacy: { key: "rank" } })(client) as any;
    for (const title of ["a", "b", "c", "d", "e"])
      await db.legacy.create({ data: { title } });
    const rows = await db.legacy.findMany({ where: { title: { not: "old" } } });
    expect(titles(rows)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

const node = s.model({
  id: s.int().id().increment(),
  parentId: s.int().nullable(),
  rank: s.string().schema(orderingKey),
  title: s.string(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => node).name("tree"),
});

describe("ordering review: ordering recursive", () => {
  test("recursive children read in key order at every level", async () => {
    const client = createClient({
      schema: { node },
      driver: createInMemorySQLite3Driver(),
    }) as any;
    await syncLiveSchema(client);
    const db = ordering({ node: { key: "rank", within: ["parentId"] } })(
      client
    ) as any;
    const root = await db.node.create({ data: { title: "root" } });
    // children created z..a so id order differs from key order after moves
    for (const title of ["c1", "c2", "c3"])
      await db.node.create({ data: { title, parentId: root.id } });
    const c1 = await db.node.findFirst({ where: { title: "c1" } });
    for (const title of ["g1", "g2", "g3"])
      await db.node.create({ data: { title, parentId: c1.id } });
    await db.node.move({ where: { id: c1.id }, last: true });
    const g1 = await db.node.findFirst({ where: { title: "g1" } });
    await db.node.move({ where: { id: g1.id }, last: true });
    const tree = await db.node.findUnique({
      where: { id: root.id },
      select: {
        title: true,
        children: { recurse: { depth: 3 }, select: { title: true } },
      },
    });
    expect(tree.children.map((c: any) => c.title)).toEqual(["c2", "c3", "c1"]);
    expect(tree.children[2].children.map((c: any) => c.title)).toEqual([
      "g2",
      "g3",
      "g1",
    ]);
  });
});

const card2 = s.model({
  id: s.int().id().increment(),
  owner: s.string(),
  rank: s.string().schema(orderingKey),
  title: s.string(),
});

describe("ordering review: ordering + permissions", () => {
  test.each([
    false,
    true,
  ])("judged creates are appended in order (batchOnly=%s)", async (batchOnly) => {
    const client = createClient({
      schema: { card2 },
      driver: batchOnly
        ? new BatchOnlySQLite3Driver({ dataDir: ":memory:" })
        : createInMemorySQLite3Driver(),
    }) as any;
    await syncLiveSchema(client);
    const order = ordering({ card2: { key: "rank", within: ["owner"] } });
    const governed = order.methods(
      (order.keys(client) as any).$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: {
            card2: {
              read: { owner: { actor: "userId" } },
              update: { owner: { actor: "userId" } },
              create: { owner: { actor: "userId" } },
            },
          },
        } as any)
      )
    ) as any;
    const db = governed.$as({ userId: "u1" });
    for (const title of ["a", "b", "c"])
      await db.card2.create({ data: { title, owner: "u1" } });
    await db.card2.createMany({
      data: [
        { title: "d", owner: "u1" },
        { title: "e", owner: "u1" },
      ],
    });
    await expect(
      db.card2.create({ data: { title: "x", owner: "u2" } })
    ).rejects.toThrow();
    const rows = await db.card2.findMany();
    expect(rows.map((r: any) => r.title)).toEqual(["a", "b", "c", "d", "e"]);
    await db.card2.move({ where: { id: 1 }, last: true });
    expect((await db.card2.findMany()).map((r: any) => r.title)).toEqual([
      "b",
      "c",
      "d",
      "e",
      "a",
    ]);
  });
});

describe("ordering review: createMany key growth", () => {
  test.each([
    false,
    true,
  ])("integers stay linear in rows (batchOnly=%s)", async (batchOnly) => {
    const client = await open(batchOnly);
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      client as any
    ) as any;
    const n = 3000;
    await db.item.createMany({
      data: Array.from({ length: n }, (_, i) => ({ title: `t${i}` })),
    });
    const rows = await db.item.findMany({
      select: { rank: true, title: true },
    });
    const last = rows.at(-1).rank as string;
    const integer = Number(last.slice(1, 1 + Number(last[0])));
    expect(rows.map((r: any) => r.title)).toEqual(
      Array.from({ length: n }, (_, i) => `t${i}`)
    );
    expect(integer).toBeLessThan(n);
  });
});

describe("ordering review: respace statement count", () => {
  test("rekey of n rows on a batch-only driver", async () => {
    const client = createClient({
      schema,
      driver: new BatchOnlySQLite3Driver({ dataDir: ":memory:" }),
    }) as any;
    await syncLiveSchema(client);
    const seen: string[] = [];
    const counted = client.$extends({
      name: "count",
      statement: ({ statement }: { statement: Sql }) => {
        seen.push(Sql.peek(statement).strings.join("?"));
        return statement;
      },
    });
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      counted
    ) as any;
    await db.item.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({ title: `t${i}` })),
    });
    seen.length = 0;
    await db.item.rekey();
    expect(seen.length).toBeLessThan(10);
  });
});

describe("ordering review 2", () => {
  const counting = (client: any, seen: string[]) =>
    client.$extends({
      name: "count",
      statement: ({ statement }: { statement: Sql }) => {
        seen.push(Sql.peek(statement).strings.join("?"));
        return statement;
      },
    });

  test("rekey without where rewrites only the lists the caller can see", async () => {
    const client = createClient({
      schema: { card2 },
      driver: createInMemorySQLite3Driver(),
    }) as any;
    await syncLiveSchema(client);
    for (const [owner, title] of [
      ["u1", "a"],
      ["u1", "b"],
      ["u2", "c"],
      ["u2", "d"],
    ])
      await client.card2.create({ data: { owner, title, rank: "15" } });
    const order = ordering({ card2: { key: "rank", within: ["owner"] } });
    const governed = order.methods(
      (order.keys(client) as any).$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: {
            card2: {
              read: { owner: { actor: "userId" } },
              update: { owner: { actor: "userId" } },
            },
          },
        } as any)
      )
    ) as any;
    const before = await client.card2.findMany({ where: { owner: "u2" } });
    expect(
      (
        await governed.$as({ userId: "u1" }).card2.rekey({
          orderBy: { title: "desc" },
        })
      ).count
    ).toBe(2);
    expect(await client.card2.findMany({ where: { owner: "u2" } })).toEqual(
      before
    );
    expect((await governed.$as({ userId: "u3" }).card2.rekey()).count).toBe(0);
  });

  test("respacing many lists stays under the driver's bound values", async () => {
    class Bounded extends SQLite3Driver {
      override readonly maxBindParametersPerStatement = 3;
    }
    const client = createClient({
      schema,
      driver: new Bounded({ dataDir: ":memory:" }),
    }) as any;
    await syncLiveSchema(client);
    const seen: string[] = [];
    const db = ordering({ item: { key: "rank", within: ["boardId"] } })(
      counting(client, seen)
    ) as any;
    await db.board.createMany({
      data: Array.from({ length: 7 }, (_, i) => ({ name: `b${i}` })),
    });
    for (let board = 1; board <= 7; board++)
      for (const title of ["a", "b"])
        await db.item.create({ data: { boardId: board, title, rank: "15" } });
    seen.length = 0;
    const { count } = await db.item.rekey({ orderBy: { title: "desc" } });
    expect(count).toBe(14);
    // The lists' read, then the lists three by three.
    expect(seen.filter((text) => text.startsWith("UPDATE"))).toHaveLength(3);
    for (let board = 1; board <= 7; board++)
      expect(
        titles(await db.item.findMany({ where: { boardId: board } }))
      ).toEqual(["b", "a"]);
  });

  test.each([
    "before",
    "after",
  ])("rekey invalidates the official cache's reads of the model, the cache applied %s ordering", async (place) => {
    const pending: Promise<unknown>[] = [];
    const client = (await open()) as any;
    const order = ordering({ item: { key: "rank", within: ["boardId"] } });
    const cached = (target: any) =>
      target.$extends(
        cache({
          driver: new MemoryCache(),
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        })
      );
    const db = (
      place === "before" ? order(cached(client)) : cached(order(client))
    ) as any;
    for (const title of ["a", "b", "c"])
      await db.item.create({ data: { title } });
    const read = () => db.$withCache().item.findMany();
    expect(titles(await read())).toEqual(["a", "b", "c"]);
    await Promise.all(pending.splice(0));
    await db.item.rekey({ orderBy: { title: "desc" } });
    expect(titles(await read())).toEqual(["c", "b", "a"]);
  });

  test("a key field may default to a literal: a populated table adopts it in one push", async () => {
    const before = s.model({
      id: s.int().id().increment(),
      title: s.string(),
    });
    const after = s.model({
      id: s.int().id().increment(),
      // Not an ordering key, so no `orderingKey` until the rows are rekeyed.
      rank: s.string().default(""),
      title: s.string(),
    });
    const driver = createInMemorySQLite3Driver();
    const old = createClient({ schema: { row: before }, driver }) as any;
    await syncLiveSchema(old);
    for (const title of ["y", "x"]) await old.row.create({ data: { title } });
    const client = createClient({ schema: { row: after }, driver }) as any;
    await syncLiveSchema(client);
    const db = ordering({ row: { key: "rank" } })(client) as any;
    await db.row.create({ data: { title: "z" } });
    expect(titles(await db.row.findMany())).toEqual(["y", "x", "z"]);
    await db.row.rekey({ orderBy: { title: "asc" } });
    expect(titles(await db.row.findMany())).toEqual(["x", "y", "z"]);
    // A generated default is not a literal.
    const generated = s.model({
      id: s.int().id().increment(),
      rank: s.string().default(() => "10"),
    });
    expect(() =>
      ordering({ row: { key: "rank" } })(
        createClient({ schema: { row: generated }, driver }) as any
      )
    ).toThrow("literal string");
  });

  test("a DateTime list field compares to the millisecond", async () => {
    const db = ordering({ item: { key: "rank", within: ["day"] } })(
      (await open()) as any
    ) as any;
    const early = new Date("2026-10-31T10:00:00.000Z");
    const late = new Date("2026-10-31T10:00:00.250Z");
    await db.item.create({ data: { title: "a", day: early } });
    await db.item.create({ data: { title: "b", day: late } });
    await db.item.create({ data: { title: "c", day: late } });
    await db.item.move({ where: { id: 1 }, after: { id: 2 } });
    const moved = await db.item.findUnique({ where: { id: 1 } });
    expect(moved.day.getTime()).toBe(late.getTime());
    expect(titles(await db.item.findMany({ where: { day: late } }))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });
});

const MOVE_UPDATE = /^UPDATE/;

const ticket = s.model({
  id: s.int().id().increment(),
  lane: s.string(),
  rank: s.string().schema(orderingKey),
  title: s.string(),
});

describe("ordering: what a move sends", () => {
  const openTickets = async () => {
    const client = createClient({
      schema: { ticket },
      driver: createInMemorySQLite3Driver(),
    }) as any;
    await syncLiveSchema(client);
    return client;
  };

  test("one UPDATE computes the key; a change of list one UPDATE more", async () => {
    const seen: string[] = [];
    const client = await openTickets();
    const db = ordering({ ticket: { key: "rank", within: ["lane"] } })(
      client.$extends({
        name: "count",
        statement: ({ statement }: { statement: Sql }) => {
          seen.push(Sql.peek(statement).strings.join("?"));
          return statement;
        },
      })
    ) as any;
    for (const [lane, title] of [
      ["a", "1"],
      ["a", "2"],
      ["a", "3"],
      ["b", "4"],
    ])
      await db.ticket.create({ data: { lane, title } });
    const sent = async (call: () => Promise<unknown>) => {
      seen.length = 0;
      await call();
      return seen.length;
    };
    const lanes = async () =>
      Object.fromEntries(
        await Promise.all(
          ["a", "b"].map(async (lane) => [
            lane,
            titles(await db.ticket.findMany({ where: { lane } })),
          ])
        )
      );
    // Within its list: the UPDATE computes the key from its neighbours.
    expect(
      await sent(() => db.ticket.move({ where: { id: 1 }, after: { id: 2 } }))
    ).toBe(1);
    expect(seen[0]).toMatch(MOVE_UPDATE);
    // Already there: no UPDATE matches; read, and nothing written.
    const before = await db.ticket.findUnique({ where: { id: 1 } });
    await db.ticket.move({ where: { id: 1 }, after: { id: 2 } });
    expect((await db.ticket.findUnique({ where: { id: 1 } })).rank).toBe(
      before.rank
    );
    // Into another list at an anchor: the key-only UPDATE matches no row
    // there, the second writes the key and the list.
    expect(
      await sent(() => db.ticket.move({ where: { id: 3 }, before: { id: 4 } }))
    ).toBe(2);
    // To another list's end: the move is tried first.
    expect(
      await sent(() => db.ticket.move({ where: { id: 2 }, to: { lane: "b" } }))
    ).toBe(1);
    // First of its own list.
    expect(
      await sent(() => db.ticket.move({ where: { id: 4 }, first: true }))
    ).toBe(1);
    expect(await lanes()).toEqual({ a: ["1"], b: ["4", "3", "2"] });
  });

  test("a visible anchor whose list field the caller may not read still anchors a move: its visibility is read by key alone", async () => {
    const client = await openTickets();
    const db = ordering({ ticket: { key: "rank", within: ["lane"] } })(
      client.$extends(
        permissions({
          actor: v.object({ admin: v.boolean() }),
          models: {
            ticket: {
              read: true,
              create: true,
              update: true,
              audit: { actor: { admin: true } },
              fields: { lane: { read: "audit" } },
            },
          },
        } as any)
      )
    ) as any;
    const user = db.$as({ admin: false });
    for (const title of ["1", "2", "3"])
      await user.ticket.create({ data: { lane: "a", title } });
    await user.ticket.move({
      where: { id: 1 },
      after: { id: 3 },
      select: { id: true },
    });
    expect(titles(await db.$as({ admin: true }).ticket.findMany())).toEqual([
      "2",
      "3",
      "1",
    ]);
    // A hidden anchor is still a missing one.
    await expect(
      user.ticket.move({ where: { id: 1 }, after: { id: 99 } })
    ).rejects.toThrow("move anchor");
  });

  test("a reorder within a list writes the key alone: no permission on the list field", async () => {
    const client = await openTickets();
    const order = ordering({ ticket: { key: "rank", within: ["lane"] } });
    const db = order.methods(
      (order.keys(client) as any).$extends(
        permissions({
          actor: v.object({ admin: v.boolean() }),
          models: {
            ticket: {
              read: true,
              create: true,
              update: true,
              transfer: { actor: { admin: true } },
              fields: { lane: { write: "transfer" } },
            },
          },
        } as any)
      )
    ) as any;
    const user = db.$as({ admin: false });
    for (const [lane, title] of [
      ["a", "1"],
      ["a", "2"],
      ["b", "3"],
    ])
      await user.ticket.create({ data: { lane, title } });
    await user.ticket.move({ where: { id: 1 }, after: { id: 2 } });
    expect(
      titles(await user.ticket.findMany({ where: { lane: "a" } }))
    ).toEqual(["2", "1"]);
    await expect(
      user.ticket.move({ where: { id: 1 }, after: { id: 3 } })
    ).rejects.toThrow(NotFoundError); // as update refuses: the row is not one it may write
    expect(
      titles(await user.ticket.findMany({ where: { lane: "a" } }))
    ).toEqual(["2", "1"]);
    await db.$as({ admin: true }).ticket.move({
      where: { id: 1 },
      after: { id: 3 },
    });
    expect(
      titles(await user.ticket.findMany({ where: { lane: "b" } }))
    ).toEqual(["3", "1"]);
  });
});
