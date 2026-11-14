/**
 * Words of the extension vocabulary on the cases their common use does not
 * meet: a test of an argument's value read per mode (`in`, `equals`,
 * `exists`), `keep()` decided by an argument with two values, an entry
 * given lazily beside one written out, an argument placed on some
 * operations only, and the unit words on a unit that lacks what they read.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { QueryError } from "@errors";
import { s } from "@schema";
import {
  arg,
  args,
  check,
  defaults,
  driver,
  extension,
  fields,
  gate,
  keep,
  lazy,
  notes,
  nothing,
  now,
  oneOf,
  parameters,
  rule,
  run,
  sql,
  statement,
  text,
  type UnitContext,
  unit,
  unless,
  when,
} from "@src/index";
import { on } from "@src/on";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({ id: s.string().id(), name: s.string() });
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
  deletedAt: s.dateTime().nullable(),
});
const node = s.model({
  id: s.string().id(),
  title: s.string(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => node)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => node).name("tree"),
});
const doc = s.model({
  id: s.string().id(),
  data: s.json(),
  blob: s.blob(),
});
const schema = { user, post, node, doc };

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
}
interface Loose {
  user: Delegate;
  post: Delegate;
  node: Delegate & { update(args: object): Promise<Row> };
  doc: Delegate;
  $extends(definition: unknown): Loose;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function seeded(): Promise<Loose> {
  const client = createClient({
    schema,
    dataDir: ":memory:",
  }) as never as Loose;
  opened.push(client);
  await syncLiveSchema(client as never);
  await client.user.create({ data: { id: "u1", name: "Ann" } });
  await client.post.create({ data: { id: "p1", title: "a", ownerId: "u1" } });
  await client.post.create({ data: { id: "p2", title: "b", ownerId: "u2" } });
  return client;
}

const ids = (rows: readonly Row[]) => rows.map((row) => row.id);

describe("a test of the argument that decides a layer's mode", () => {
  test("in, equals and exists are each read per mode", async () => {
    const db = (await seeded()).$extends(
      extension(
        "views",
        args({ view: oneOf("all", "mine", "none").default("all") }),
        rule({
          post: {
            root: [
              when(arg("view"), { in: ["mine"] }, { ownerId: "u1" }),
              when(arg("view"), { equals: "none" }, nothing),
              // Every mode has a value: never applied.
              unless(arg("view"), { exists: true }, nothing),
              // A test the mode cannot hold: never applied either.
              when(arg("view"), { has: "all" }, nothing),
            ],
          },
        })
      )
    );
    expect(ids(await db.post.findMany({}))).toEqual(["p1", "p2"]);
    expect(ids(await db.post.findMany({ view: "mine" }))).toEqual(["p1"]);
    expect(ids(await db.post.findMany({ view: "none" }))).toEqual([]);
  });
});

describe("keep() decided by an argument", () => {
  test("with two values, the one keep() is not written for removes the row", async () => {
    const base = await seeded();
    const db = base.$extends(
      extension(
        "trash",
        args({ trash: oneOf("keep", "remove").default("keep") }),
        rule({
          post: {
            delete: {
              instead: keep(when(arg("trash"), "keep", { deletedAt: now })),
            },
          },
        })
      )
    );
    await db.post.delete({ where: { id: "p1" } });
    await db.post.delete({ where: { id: "p2" }, trash: "remove" });
    const left = await base.post.findMany({});
    expect(ids(left)).toEqual(["p1"]);
    expect(left[0]?.deletedAt).toBeInstanceOf(Date);
  });

  test("keep() writing constants only leaves the instant alone", async () => {
    const base = await seeded();
    const db = base.$extends(
      extension(
        "archive",
        rule({ post: { delete: { instead: keep({ title: "archived" }) } } })
      )
    );
    await db.post.delete({ where: { id: "p1" } });
    expect(await base.post.findMany({ where: { id: "p1" } })).toMatchObject([
      { title: "archived", deletedAt: null },
    ]);
  });
});

describe("an entry given lazily beside one written out", () => {
  test("each model is judged by its own entry", async () => {
    const db = (await seeded()).$extends(
      extension(
        "mixed",
        rule({
          post: lazy(() => ({ root: { ownerId: "u1" } })),
          user: { create: { check: check({ name: { not: "" } }) } },
        })
      )
    );
    expect(ids(await db.post.findMany({}))).toEqual(["p1"]);
    await expect(
      db.user.create({ data: { id: "u3", name: "" } })
    ).rejects.toThrow();
    expect(
      (await db.user.create({ data: { id: "u3", name: "Cy" } })).name
    ).toBe("Cy");
  });
});

describe("fields gated by one predicate", () => {
  test("are shown and hidden together, row by row", async () => {
    const mine = { ownerId: arg("me") };
    const db = (await seeded()).$extends(
      extension(
        "private",
        args({ me: oneOf("u1", "u2") }),
        rule({
          post: {
            read: { fields: { title: gate(mine), deletedAt: gate(mine) } },
          },
        })
      )
    );
    const rows = await db.post.findMany({ me: "u1", orderBy: { id: "asc" } });
    // A hidden field is absent from its row.
    expect(
      rows.map((row) => [row.id, "title" in row, "deletedAt" in row])
    ).toEqual([
      ["p1", true, true],
      ["p2", false, false],
    ]);
  });
});

describe("an acyclic relation beside a check", () => {
  test("a write of another field passes; a write that closes a loop is refused", async () => {
    const base = await seeded();
    await base.node.create({ data: { id: "a", title: "a", parentId: null } });
    await base.node.create({ data: { id: "b", title: "b", parentId: "a" } });
    await base.node.create({ data: { id: "c", title: "c", parentId: null } });
    const db = base.$extends(
      extension(
        "tree",
        rule({
          node: {
            update: { check: check({ title: { not: "" } }) },
            acyclic: ["parent"],
          },
        })
      )
    );
    expect(
      (await db.node.update({ where: { id: "a" }, data: { title: "root" } }))
        .title
    ).toBe("root");
    await expect(
      db.node.update({ where: { id: "a" }, data: { parentId: "b" } })
    ).rejects.toThrow();
    expect(
      (await db.node.update({ where: { id: "c" }, data: { parentId: "b" } }))
        .parentId
    ).toBe("b");
  });
});

describe("a computed field reads the row as it was fetched", () => {
  test("an edit of the row before the field is read changes nothing it computes", async () => {
    const base = await seeded();
    await base.doc.create({
      data: {
        id: "d1",
        data: { tags: ["a"], meta: { size: 1 } },
        blob: new Uint8Array([1, 2, 3]),
      },
    });
    const db = base.$extends(
      extension(
        "summary",
        fields({
          doc: {
            summary: {
              needs: { data: true, blob: true },
              compute: (row: Row) => {
                const data = row.data as {
                  tags: string[];
                  meta: { size: number };
                };
                const blob = row.blob as Uint8Array;
                return `${data.tags.join(",")}/${data.meta.size}/${[...blob].join(",")}`;
              },
            },
          },
        } as never)
      )
    );
    const [row] = await db.doc.findMany({});
    const data = row!.data as { tags: string[]; meta: { size: number } };
    data.tags.push("b");
    data.meta.size = 9;
    (row!.blob as Uint8Array)[0] = 7;
    expect(row!.summary).toBe("a/1/1,2,3");
  });
});

describe("default data", () => {
  test("an argument's value beside a constant, a model of constants only, and a call that passes no argument", async () => {
    const db = (await seeded()).$extends(
      extension(
        "stamps",
        args({ owner: oneOf("u1", "u2") }),
        defaults({
          post: { create: { ownerId: arg("owner"), title: "untitled" } },
          user: { create: { name: "anon" } },
        })
      )
    );
    expect(
      await db.post.create({ data: { id: "p5" }, owner: "u2" })
    ).toMatchObject({ title: "untitled", ownerId: "u2" });
    // No argument: the field naming it is not written; the caller writes it.
    expect(
      await db.post.create({ data: { id: "p6", ownerId: "u1" } })
    ).toMatchObject({ title: "untitled", ownerId: "u1" });
    expect(await db.user.create({ data: { id: "u5" } })).toMatchObject({
      name: "anon",
    });
  });
});

describe("on() with no hook", () => {
  test("applies, and every write runs as it would", async () => {
    const db = (await seeded()).$extends(on({} as never));
    expect(
      (await db.post.create({ data: { id: "p3", title: "c", ownerId: "u1" } }))
        .id
    ).toBe("p3");
    expect(ids(await db.post.findMany({}))).toEqual(["p1", "p2", "p3"]);
  });
});

describe("an argument placed on some operations", () => {
  test("an operation it is not placed on runs without it", async () => {
    const db = (await seeded()).$extends(
      extension(
        "views",
        args({ view: oneOf("all", "mine").on("findMany") }),
        rule({
          post: { root: [when(arg("view"), "mine", { ownerId: "u1" })] },
        })
      )
    );
    expect(ids(await db.post.findMany({ view: "mine" }))).toEqual(["p1"]);
    expect(
      (await db.post.create({ data: { id: "p3", title: "c", ownerId: "u3" } }))
        .id
    ).toBe("p3");
  });
});

describe("unit words on a unit that lacks what they read", () => {
  test("an operation unit has no parameters and runs no SQL; a statement unit holds no notes", async () => {
    const seen: Record<string, unknown> = {};
    const db = (await seeded()).$extends(
      extension(
        "reader",
        unit(async (u, next) => {
          if (u.kind === "operation") {
            seen.parameters = parameters(u);
            seen.run = await run(u, sql`SELECT 1`).catch(
              (error: unknown) => error
            );
          }
          if (u.kind === "statement") {
            seen.notes = notes(u);
            seen.statement = statement(u);
          }
          return next();
        })
      )
    );
    await db.post.findMany({});
    expect(seen.parameters).toBeUndefined();
    expect(seen.run).toBeInstanceOf(QueryError);
    expect((seen.run as Error).message).toContain(
      "run() needs the transaction unit"
    );
    expect(seen.notes).toEqual([]);
    // Only a part that rewrites statements is handed the statement.
    expect(seen.statement).toBeUndefined();
  });

  test("a transaction unit that runs SQL and refuses before next() rolls the transaction back", async () => {
    const refusal = new Error("refused before the body");
    const ran: unknown[] = [];
    const base = await seeded();
    const db = base.$extends(
      extension(
        "gate",
        unit(
          async (u) => {
            // Opens the transaction, runs twice in it, then refuses.
            ran.push(await run(u, sql`SELECT 1 AS one`));
            ran.push(await run(u, sql`SELECT 2 AS two`));
            throw refusal;
          },
          ["transaction"]
        )
      )
    ) as Loose & {
      $transaction(body: (tx: Loose) => Promise<unknown>): Promise<unknown>;
    };
    const failure = await db
      .$transaction((tx) =>
        tx.post.create({ data: { id: "p9", title: "z", ownerId: "u1" } })
      )
      .catch((error: unknown) => error);
    expect(failure).toBe(refusal);
    expect(ran).toEqual([[{ one: 1 }], [{ two: 2 }]]);
    expect(ids(await base.post.findMany({}))).toEqual(["p1", "p2"]);
  });

  test("on a value no producer made, each word reads nothing", () => {
    const foreign = { kind: "operation" } as never as UnitContext;
    expect(text(foreign)).toBeUndefined();
    expect(driver(foreign)).toBeUndefined();
    expect(notes(foreign)).toEqual([]);
  });
});
