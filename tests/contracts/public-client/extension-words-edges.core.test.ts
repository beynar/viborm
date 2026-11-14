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
  driver,
  extension,
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
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({ id: s.string().id(), name: s.string() });
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  ownerId: s.string(),
  deletedAt: s.dateTime().nullable(),
});
const schema = { user, post };

type Row = Record<string, unknown>;
interface Delegate {
  findMany(args?: object): Promise<Row[]>;
  create(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
}
interface Loose {
  user: Delegate;
  post: Delegate;
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

  test("on a value no producer made, each word reads nothing", () => {
    const foreign = { kind: "operation" } as never as UnitContext;
    expect(text(foreign)).toBeUndefined();
    expect(driver(foreign)).toBeUndefined();
    expect(notes(foreign)).toEqual([]);
  });
});
