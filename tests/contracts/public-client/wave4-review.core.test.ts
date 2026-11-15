/**
 * Review of the fourth wave (2026-11-15, `dcc705544..3057e4595`): the
 * permissions compiler, the rule base, `ordering` and the cache's types,
 * written with less code by four agents.
 *
 * - `ordering`: `move({ where, after: null })` (no anchor, a value the
 *   types refuse and the runtime takes) placed the row LAST of its list on
 *   dcc705544; since 47a3f4067 it places it FIRST. Red on the head.
 * - The rest pins what held, each as on dcc705544: `as` modes read from a
 *   list (names an `Object` or an `Array` has), an action graph with a
 *   cycle, soft delete's four methods given nothing, `$through` refused
 *   under a rule that hides links at root only or at related only.
 *
 * Runs on SQLite, in memory.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { extension, rule } from "@src/index";
import { ordering } from "@src/ordering";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterEach, describe, expect, test } from "vitest";

type Row = Record<string, unknown>;
interface Loose {
  [model: string]: any;
  $extends(definition: unknown): Loose;
  $as(actor: object, scopes?: readonly string[]): Loose;
  $disconnect(): Promise<void>;
}

const RESTRICTED = /Cannot (read|filter|write) \$through of relation/;

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

async function open(schema: object): Promise<Loose> {
  const client = createClient({
    schema: schema as never,
    dataDir: ":memory:",
  }) as unknown as Loose;
  opened.push(client);
  await syncLiveSchema(client as never);
  return client;
}

describe("ordering: move with after: null (47a3f4067)", () => {
  const card = s.model({
    id: s.int().id(),
    columnId: s.int(),
    rank: s.string().default(""),
  });

  const listed = async (base: Loose) =>
    (
      (await base.card.findMany({
        orderBy: [{ rank: "asc" }, { id: "asc" }],
      })) as Row[]
    ).map((row) => row.id);

  test("the row goes where dcc705544 put it (last of its list), never first", async () => {
    const base = await open({ card });
    await base.card.createMany({
      data: [
        { id: 1, columnId: 1, rank: "10" },
        { id: 2, columnId: 1, rank: "11" },
        { id: 3, columnId: 1, rank: "12" },
      ],
    });
    const db = base.$extends(
      ordering({ models: { card: { key: "rank", within: ["columnId"] } } })
    );
    // A drop "after nothing", written without the types' help.
    await db.card.move({ where: { id: 2 }, after: null });
    expect(await listed(base)).toEqual([1, 3, 2]);
  });

  test("first: true still places it first (the same on both trees)", async () => {
    const base = await open({ card });
    await base.card.createMany({
      data: [
        { id: 1, columnId: 1, rank: "10" },
        { id: 2, columnId: 1, rank: "11" },
        { id: 3, columnId: 1, rank: "12" },
      ],
    });
    const db = base.$extends(
      ordering({ models: { card: { key: "rank", within: ["columnId"] } } })
    );
    await db.card.move({ where: { id: 3 }, first: true });
    expect(await listed(base)).toEqual([3, 1, 2]);
  });
});

describe("what held (as on dcc705544)", () => {
  const post = s.model({
    id: s.int().id(),
    authorId: s.int(),
    status: s.string(),
    deletedAt: s.dateTime().nullable(),
  });
  const Actor = v.object({ userId: v.number() });

  const seeded = async () => {
    const base = await open({ post });
    await base.post.createMany({
      data: [
        { id: 1, authorId: 1, status: "public" },
        { id: 2, authorId: 2, status: "draft" },
        { id: 3, authorId: 1, status: "draft" },
      ],
    });
    return base;
  };
  const ids = async (call: Promise<Row[]>) =>
    (await call).map((row) => row.id).sort();

  test("an `as` mode is one of the model's actions or domains, whatever an Object or an Array holds", async () => {
    const base = await seeded();
    const call = base
      .$extends(
        permissions({
          actor: Actor,
          models: {
            post: {
              read: { status: "public" },
              update: { authorId: { actor: "userId" } },
              domains: { mine: { authorId: { actor: "userId" } } },
            },
          },
        } as never)
      )
      .$as({ userId: 1 });
    expect(await ids(call.post.findMany({ as: "update" }))).toEqual([1, 3]);
    expect(await ids(call.post.findMany({ as: "mine" }))).toEqual([1, 3]);
    for (const mode of ["constructor", "length", "toString", "__proto__"])
      await expect(call.post.findMany({ as: mode })).rejects.toThrow(
        "Validation failed for post.findMany"
      );
  });

  test("an action graph with a cycle grants each action the other's rows", async () => {
    const base = await seeded();
    const call = base
      .$extends(
        permissions({
          actor: Actor,
          models: {
            post: {
              actions: { read: ["update"], update: ["read"] },
              read: { status: "public" },
              update: { authorId: { actor: "userId" } },
            },
          },
        } as never)
      )
      .$as({ userId: 1 });
    expect(await ids(call.post.findMany({}))).toEqual([1, 3]);
    expect(await ids(call.post.findMany({ as: "update" }))).toEqual([1, 3]);
  });

  test("soft delete's methods given nothing: restoreMany restores every tombstone, restore and purge want a where", async () => {
    const base = await open({ post });
    const at = new Date("2026-01-01T00:00:00Z");
    await base.post.createMany({
      data: [
        { id: 1, authorId: 1, status: "a" },
        { id: 2, authorId: 1, status: "b", deletedAt: at },
        { id: 3, authorId: 1, status: "c", deletedAt: at },
      ],
    });
    const db = base.$extends(
      softDelete({ models: { post: { deletedAt: "deletedAt" } } } as never)
    );
    await expect(db.post.restore()).rejects.toThrow("where");
    await expect(db.post.purge()).rejects.toThrow("where");
    await expect(
      db.post.restore({ where: { id: 2 }, data: { status: "x" } })
    ).resolves.toMatchObject({ id: 2, status: "b", deletedAt: null });
    await expect(db.post.restoreMany()).resolves.toEqual({ count: 1 });
    await expect(db.post.purgeMany()).resolves.toEqual({ count: 0 });
  });

  describe("$through under a rule that hides links", () => {
    const team = s.model({
      id: s.string().id(),
      parents: s
        .toMany(() => team)
        .name("graph")
        .through(() => link)
        .source("child")
        .target("parent"),
      children: s.toMany(() => team).name("graph"),
    });
    const link = s
      .model({
        childId: s.string(),
        parentId: s.string(),
        note: s.string().default("linked"),
        child: s
          .toOne(() => team)
          .fields("childId")
          .references("id"),
        parent: s
          .toOne(() => team)
          .fields("parentId")
          .references("id"),
      })
      .id(["childId", "parentId"]);

    for (const [name, entry] of [
      ["root only", { root: { note: "visible" } }],
      ["related only", { related: { note: "visible" } }],
    ] as const)
      test(`${name}: reading, filtering and writing $through are refused`, async () => {
        const base = await open({ team, link });
        await base.team.createMany({ data: [{ id: "a" }, { id: "b" }] });
        await base.team.update({
          where: { id: "a" },
          data: { parents: { connect: { id: "b" } } },
        });
        const db = base.$extends(extension("hide", rule({ link: entry })));
        await expect(
          db.team.findMany({
            select: { id: true, parents: { select: { $through: true } } },
          })
        ).rejects.toThrow(RESTRICTED);
        await expect(
          db.team.findMany({
            where: { parents: { some: { $through: { note: "linked" } } } },
          })
        ).rejects.toThrow(RESTRICTED);
        await expect(
          db.team.update({
            where: { id: "a" },
            data: {
              parents: { connect: { id: "b", $through: { note: "x" } } },
            },
          })
        ).rejects.toThrow(RESTRICTED);
      });
  });
});
