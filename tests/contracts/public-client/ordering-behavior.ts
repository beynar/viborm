/**
 * viborm/ordering on one provider: appended keys on every create path, reads
 * in list order, `move` and `rekey`. Each provider file opens a client on its
 * database with `schema` pushed, and runs `describeOrdering`.
 */

import {
  ClientInitializationError,
  NotFoundError,
  ValidationError,
} from "@errors";
import { s } from "@schema";
import { Sql } from "@sql";
import { isKey, keyBetween, ordering, orderingKey } from "@src/ordering";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@validation";
import { describe, expect, test } from "vitest";

const column = s.model({
  id: s.string().id(),
  cards: s.toMany(() => card),
});

const card = s.model({
  id: s.string().id(),
  columnId: s.string().nullable(),
  rank: s.string().schema(orderingKey),
  title: s.string(),
  /** Who may see the card, where a test applies permissions. */
  owner: s.string().nullable(),
  /** The soft-delete marker, where a test applies soft delete. */
  deletedAt: s.dateTime().nullable(),
  column: s
    .toOne(() => column)
    .fields("columnId")
    .references("id"),
});

/** A table that adopts the extension: its key has no validator yet, and
 * its rows hold a backfilled constant. */
const legacy = s.model({
  id: s.string().id(),
  rank: s.string(),
  title: s.string(),
});

/** A list field that is part of the model's key, and is required: an
 * anchored move seeks through the default order. */
const slot = s
  .model({
    tenant: s.string(),
    id: s.string(),
    rank: s.string().schema(orderingKey),
  })
  .id(["tenant", "id"]);

export const schema = { column, card, legacy, slot };

type Base = {
  $extends: (...args: never[]) => unknown;
  $schema: typeof schema;
};

export function describeOrdering(
  label: string,
  open: () => Promise<{ client: Base; close?: () => Promise<void> }>,
  /** Statements one create sends: the INSERT alone, where it returns its
   * row and computes its key (MySQL reads the last key first). */
  createStatements = 1,
  /** Statements a move within a list and a plain update send: one UPDATE
   * each, where it computes the key and returns its row (MySQL reads the
   * neighbours, then locks, updates and reads the row). */
  { move = 1, update = 1 } = {}
) {
  const statements: string[] = [];
  let base_: any;
  let counted_: any;
  // One database per run, emptied before each test.
  let opened: ReturnType<typeof open> | undefined;
  const setup = async () => {
    const { client } = await (opened ??= open());
    const base = client as unknown as {
      card: { deleteMany(args?: object): Promise<unknown> };
      column: { deleteMany(args?: object): Promise<unknown> };
    };
    await base.card.deleteMany();
    await base.column.deleteMany();
    for (const name of ["legacy", "slot"] as const)
      await (
        client as unknown as Record<
          typeof name,
          { deleteMany(args?: object): Promise<unknown> }
        >
      )[name].deleteMany();
    const counted = (
      client as unknown as { $extends: (definition: object) => Base }
    ).$extends({
      name: "count-statements",
      statement: ({ statement }: { statement: Sql }) => {
        statements.push(Sql.peek(statement).strings.join("?"));
        return statement;
      },
    });
    const db = ordering({
      card: { key: "rank", within: ["columnId"] },
      legacy: { key: "rank" },
      slot: { key: "rank", within: ["tenant"] },
    })(counted as any) as any;
    base_ = client as any;
    counted_ = counted;
    await db.column.createMany({ data: [{ id: "c1" }, { id: "c2" }] });
    return db;
  };
  const titles = (rows: readonly { title: string }[]) =>
    rows.map((row) => row.title);
  const listOf = async (db: any, columnId: string | null) =>
    titles(await db.card.findMany({ where: { columnId } }));

  describe(`ordering on ${label}`, () => {
    test("a create without a key goes last of its list", async () => {
      const db = await setup();
      for (const title of ["a", "b", "c"])
        await db.card.create({ data: { id: title, columnId: "c1", title } });
      await db.card.create({ data: { id: "x", columnId: "c2", title: "x" } });
      expect(await listOf(db, "c1")).toEqual(["a", "b", "c"]);
      expect(await listOf(db, "c2")).toEqual(["x"]);
      const ranks = (await db.card.findMany()).map(
        (row: { rank: string }) => row.rank
      );
      expect(ranks.every(isKey)).toBe(true);
    });

    test("a create computes its key in its own statement (a read first on MySQL)", async () => {
      const db = await setup();
      await db.card.create({ data: { id: "a", columnId: "c1", title: "a" } });
      statements.length = 0;
      await db.card.create({ data: { id: "b", columnId: "c1", title: "b" } });
      expect(statements).toHaveLength(createStatements);
      expect(statements.join(" ")).toContain("MAX(");
      expect(await listOf(db, "c1")).toEqual(["a", "b"]);
    });

    test("a move within a list, and an update, in the statements they take", async () => {
      const db = await setup();
      for (const title of ["a", "b", "c"])
        await db.card.create({ data: { id: title, columnId: "c1", title } });
      statements.length = 0;
      await db.card.move({ where: { id: "a" }, after: { id: "b" } });
      expect(statements).toHaveLength(move);
      expect(await listOf(db, "c1")).toEqual(["b", "a", "c"]);
      statements.length = 0;
      const updated = await db.card.update({
        where: { id: "c" },
        data: { title: "c2" },
      });
      expect(statements).toHaveLength(update);
      expect(updated.title).toBe("c2");
    });

    test("a move with a key the caller computed writes it, nothing read first", async () => {
      const db = await setup();
      for (const title of ["a", "b", "c"])
        await db.card.create({ data: { id: title, columnId: "c1", title } });
      await db.card.create({ data: { id: "x", columnId: "c2", title: "x" } });
      const [a, b] = await db.card.findMany({ where: { columnId: "c1" } });
      statements.length = 0;
      const key = keyBetween(a.rank, b.rank);
      const moved = await db.card.move({ where: { id: "c" }, key });
      expect(statements).toHaveLength(update);
      expect(moved.rank).toBe(key);
      expect(await listOf(db, "c1")).toEqual(["a", "c", "b"]);
      // Into another list, with `to`.
      const [last] = await db.card.findMany({
        where: { columnId: "c2" },
        orderBy: { rank: "desc" },
        take: 1,
      });
      await db.card.move({
        where: { id: "a" },
        key: keyBetween(last.rank, null),
        to: { columnId: "c2" },
      });
      expect(await listOf(db, "c2")).toEqual(["x", "a"]);
      await expect(
        db.card.move({ where: { id: "b" }, key: "abc" })
      ).rejects.toThrow(ValidationError);
      await expect(
        db.card.move({ where: { id: "nope" }, key })
      ).rejects.toThrow(NotFoundError);
    });

    test("createMany keeps the array's order, per list", async () => {
      const db = await setup();
      await db.card.create({
        data: { id: "first", columnId: "c1", title: "first" },
      });
      await db.card.createMany({
        data: [
          { id: "m1", columnId: "c1", title: "m1" },
          { id: "n1", columnId: "c2", title: "n1" },
          { id: "m2", columnId: "c1", title: "m2" },
          { id: "n2", columnId: "c2", title: "n2" },
          { id: "m3", columnId: "c1", title: "m3" },
        ],
      });
      expect(await listOf(db, "c1")).toEqual(["first", "m1", "m2", "m3"]);
      expect(await listOf(db, "c2")).toEqual(["n1", "n2"]);
    });

    test("nested creates are appended to the parent's list, in order", async () => {
      const db = await setup();
      await db.column.create({
        data: {
          id: "c3",
          cards: {
            create: [
              { id: "p", title: "p" },
              { id: "q", title: "q" },
            ],
          },
        },
      });
      await db.column.update({
        where: { id: "c3" },
        data: { cards: { create: { id: "r", title: "r" } } },
      });
      const [found] = await db.column.findMany({
        where: { id: "c3" },
        include: { cards: true },
      });
      expect(titles(found.cards)).toEqual(["p", "q", "r"]);
    });

    test("concurrent appends to one list all land, after the list, with distinct keys", async () => {
      const db = await setup();
      await db.card.create({
        data: { id: "first", columnId: "c1", title: "first" },
      });
      await Promise.all(
        Array.from({ length: 4 }, (_, writer) =>
          (async () => {
            for (let index = 0; index < 10; index++)
              await db.card.create({
                data: {
                  id: `w${writer}-${index}`,
                  columnId: "c1",
                  title: `w${writer}-${index}`,
                },
              });
          })()
        )
      );
      const rows = await db.card.findMany({ where: { columnId: "c1" } });
      expect(rows).toHaveLength(41);
      expect(rows[0].title).toBe("first");
      expect(new Set(rows.map((row: { rank: string }) => row.rank)).size).toBe(
        41
      );
      // Each writer's own appends keep their order.
      for (let writer = 0; writer < 4; writer++) {
        const mine = titles(rows).filter((title) =>
          title.startsWith(`w${writer}-`)
        );
        expect(mine).toEqual(
          Array.from({ length: 10 }, (_, index) => `w${writer}-${index}`)
        );
      }
    });

    test("upsert's create branch and connectOrCreate's create append", async () => {
      const db = await setup();
      await db.card.create({ data: { id: "a", columnId: "c1", title: "a" } });
      await db.card.upsert({
        where: { id: "b" },
        create: { id: "b", columnId: "c1", title: "b" },
        update: { title: "b2" },
      });
      await db.card.upsert({
        where: { id: "a" },
        create: { id: "a", columnId: "c1", title: "never" },
        update: { title: "a2" },
      });
      await db.column.update({
        where: { id: "c1" },
        data: {
          cards: {
            connectOrCreate: {
              where: { id: "c" },
              create: { id: "c", title: "c" },
            },
          },
        },
      });
      expect(await listOf(db, "c1")).toEqual(["a2", "b", "c"]);
    });

    test("move is refused in an array transaction before anything runs", async () => {
      const db = await setup();
      await db.card.create({ data: { id: "a", columnId: "c1", title: "a" } });
      await db.card.create({ data: { id: "b", columnId: "c1", title: "b" } });
      statements.length = 0;
      await expect(
        db.$transaction([db.card.move({ where: { id: "a" }, last: true })])
      ).rejects.toThrow();
      expect(statements).toEqual([]);
      expect(await listOf(db, "c1")).toEqual(["a", "b"]);
    });

    test("move inside an interactive transaction runs in it", async () => {
      const db = await setup();
      await db.card.create({ data: { id: "a", columnId: "c1", title: "a" } });
      await db.card.create({ data: { id: "b", columnId: "c1", title: "b" } });
      const supports = (db.$driver as { supportsTransactions?: boolean })
        ?.supportsTransactions;
      if (supports === false) return;
      await expect(
        db.$transaction(async (tx: typeof db) => {
          await tx.card.move({ where: { id: "a" }, last: true });
          expect(
            titles(await tx.card.findMany({ where: { columnId: "c1" } }))
          ).toEqual(["b", "a"]);
          throw new Error("roll back");
        })
      ).rejects.toThrow("roll back");
      expect(await listOf(db, "c1")).toEqual(["a", "b"]);
    });

    test("a NULL list is a list", async () => {
      const db = await setup();
      await db.card.create({ data: { id: "u1", columnId: null, title: "u1" } });
      await db.card.create({ data: { id: "u2", columnId: null, title: "u2" } });
      expect(await listOf(db, null)).toEqual(["u1", "u2"]);
    });

    test("an explicit key is written as given", async () => {
      const db = await setup();
      await db.card.create({ data: { id: "a", columnId: "c1", title: "a" } });
      await db.card.create({
        data: { id: "z", columnId: "c1", title: "z", rank: "089" },
      });
      expect(await listOf(db, "c1")).toEqual(["z", "a"]);
    });

    test("a written key that is not one is refused", async () => {
      const db = await setup();
      await expect(
        db.card.create({
          data: { id: "a", columnId: "c1", title: "a", rank: "abc" },
        })
      ).rejects.toThrow(ValidationError);
      await db.card.create({ data: { id: "a", columnId: "c1", title: "a" } });
      await expect(
        db.card.update({ where: { id: "a" }, data: { rank: { set: "150" } } })
      ).rejects.toThrow(ValidationError);
      await expect(
        db.card.createMany({
          data: [{ id: "b", columnId: "c1", title: "b", rank: "x" }],
        })
      ).rejects.toThrow(ValidationError);
      await expect(
        db.card.upsert({
          where: { id: "a" },
          create: { id: "a", columnId: "c1", title: "a" },
          update: { rank: "" },
        })
      ).rejects.toThrow(ValidationError);
      await expect(
        db.column.update({
          where: { id: "c1" },
          data: { cards: { create: { id: "n", title: "n", rank: "1a" } } },
        })
      ).rejects.toThrow(ValidationError);
      await db.card.update({ where: { id: "a" }, data: { rank: "155" } });
      expect((await db.card.findUnique({ where: { id: "a" } })).rank).toBe(
        "155"
      );
    });

    test("a table adopting the extension: appends go after its backfilled rows, rekey orders them", async () => {
      const db = await setup();
      await base_.legacy.createMany({
        data: [
          { id: "c", title: "c", rank: "" },
          { id: "a", title: "a", rank: "" },
          { id: "b", title: "b", rank: "" },
        ],
      });
      await db.legacy.create({ data: { id: "n1", title: "n1" } });
      await db.legacy.create({ data: { id: "n2", title: "n2" } });
      expect(titles(await db.legacy.findMany()).slice(-2)).toEqual([
        "n1",
        "n2",
      ]);
      const { count } = await db.legacy.rekey({ orderBy: { title: "asc" } });
      expect(count).toBe(5);
      expect(titles(await db.legacy.findMany())).toEqual([
        "a",
        "b",
        "c",
        "n1",
        "n2",
      ]);
      const ranks = (await db.legacy.findMany()).map(
        (row: { rank: string }) => row.rank
      );
      expect(ranks.every(isKey)).toBe(true);
    });

    test("rekey of part of a list respaces the whole list, in its order", async () => {
      const db = await setup();
      for (const title of ["a", "b", "c", "d"])
        await db.card.create({ data: { id: title, columnId: "c1", title } });
      statements.length = 0;
      const { count } = await db.card.rekey({ where: { id: "c" } });
      expect(count).toBe(4);
      // One statement reads the lists, one respaces them.
      expect(statements).toHaveLength(2);
      expect(await listOf(db, "c1")).toEqual(["a", "b", "c", "d"]);
    });

    test("move: after, before, first, last, within a list", async () => {
      const db = await setup();
      for (const title of ["a", "b", "c", "d"])
        await db.card.create({ data: { id: title, columnId: "c1", title } });
      await db.card.move({ where: { id: "a" }, after: { id: "c" } });
      expect(await listOf(db, "c1")).toEqual(["b", "c", "a", "d"]);
      await db.card.move({ where: { id: "d" }, before: { id: "b" } });
      expect(await listOf(db, "c1")).toEqual(["d", "b", "c", "a"]);
      await db.card.move({ where: { id: "a" }, first: true });
      expect(await listOf(db, "c1")).toEqual(["a", "d", "b", "c"]);
      const moved = await db.card.move({ where: { id: "a" }, last: true });
      expect(moved.title).toBe("a");
      expect(await listOf(db, "c1")).toEqual(["d", "b", "c", "a"]);
    });

    test("move: to another list, at an anchor or at an end", async () => {
      const db = await setup();
      for (const title of ["a", "b"])
        await db.card.create({ data: { id: title, columnId: "c1", title } });
      for (const title of ["x", "y"])
        await db.card.create({ data: { id: title, columnId: "c2", title } });
      await db.card.move({ where: { id: "a" }, after: { id: "x" } });
      expect(await listOf(db, "c2")).toEqual(["x", "a", "y"]);
      await db.card.move({ where: { id: "y" }, to: { columnId: "c1" } });
      expect(await listOf(db, "c1")).toEqual(["b", "y"]);
      await db.card.move({
        where: { id: "x" },
        to: { columnId: "c1" },
        first: true,
      });
      expect(await listOf(db, "c1")).toEqual(["x", "b", "y"]);
      expect(await listOf(db, "c2")).toEqual(["a"]);
    });

    test("move to where the row already is writes nothing", async () => {
      const db = await setup();
      for (const title of ["a", "b", "c"])
        await db.card.create({ data: { id: title, columnId: "c1", title } });
      const before = (await db.card.findUnique({ where: { id: "b" } })).rank;
      await db.card.move({ where: { id: "b" }, after: { id: "a" } });
      expect((await db.card.findUnique({ where: { id: "b" } })).rank).toBe(
        before
      );
    });

    test("move refuses a missing row or anchor, itself, and no placement", async () => {
      const db = await setup();
      await db.card.create({ data: { id: "a", columnId: "c1", title: "a" } });
      await expect(
        db.card.move({ where: { id: "nope" }, first: true })
      ).rejects.toThrow(NotFoundError);
      await expect(
        db.card.move({ where: { id: "a" }, after: { id: "nope" } })
      ).rejects.toThrow("move anchor");
      await expect(
        db.card.move({ where: { id: "a" }, after: { id: "a" } })
      ).rejects.toThrow(ValidationError);
      await expect(db.card.move({ where: { id: "a" } })).rejects.toThrow(
        ValidationError
      );
      await expect(
        db.card.move({ where: { id: "a" }, first: true, last: true })
      ).rejects.toThrow(ValidationError);
    });

    // The one-statement move reads its anchor and neighbours from the
    // table: under rows that can hide a row of the model, the move reads
    // them through the caller's view (the read path) instead, so a hidden
    // anchor is refused as a missing one, nothing is written, and the key
    // it writes depends on visible rows alone.
    test("a hidden anchor is a missing one, under permissions or soft delete, applied before or after ordering", async () => {
      const db = await setup();
      for (const [id, owner] of [
        ["a", "u1"],
        ["b", "u1"],
        ["h", "u2"],
        ["t", "u1"],
      ] as const)
        await db.card.create({
          data: { id, columnId: "c1", title: id, owner },
        });
      await base_.card.update({
        where: { id: "t" },
        data: { deletedAt: new Date("2026-01-01T00:00:00.000Z") },
      });
      const ranks = async () =>
        (await base_.card.findMany({ select: { id: true, rank: true } })).map(
          (row: { id: string; rank: string }) => `${row.id}:${row.rank}`
        );
      const order = ordering({ card: { key: "rank", within: ["columnId"] } });
      const policy = permissions({
        actor: v.object({ userId: v.string() }),
        models: {
          card: {
            read: { owner: { actor: "userId" } },
            update: { owner: { actor: "userId" } },
          },
        },
      } as any);
      const tombs = softDelete({
        models: { card: { deletedAt: "deletedAt" } },
      });
      // The read path: the anchor (its list may be NULL), its window, the
      // UPDATE; MySQL takes it ungoverned too.
      const governedMove = move === 1 ? 3 : move;
      const viaPolicy = [
        policy(order(counted_) as any),
        order(policy(counted_) as any),
      ].map((chain: any) => chain.$as({ userId: "u1" }));
      const viaTombs = [
        tombs(order(counted_) as any),
        order(tombs(counted_) as any),
      ];
      for (const governed of [...viaPolicy, ...viaTombs] as any[]) {
        const before = await ranks();
        for (const hidden of ["nope", viaPolicy.includes(governed) ? "h" : "t"])
          await expect(
            governed.card.move({ where: { id: "a" }, after: { id: hidden } })
          ).rejects.toThrow("move anchor");
        expect(await ranks()).toEqual(before);
        statements.length = 0;
        await governed.card.move({ where: { id: "b" }, before: { id: "a" } });
        expect(statements).toHaveLength(governedMove);
        await governed.card.move({ where: { id: "a" }, before: { id: "b" } });
      }
      // Soft delete's `deleted: "with"` shows the tombstone: it anchors.
      await (viaTombs[0] as any).card.move({
        where: { id: "a" },
        after: { id: "t" },
        deleted: "with",
      });
      expect(await listOf(db, "c1")).toEqual(["b", "h", "t", "a"]);
    });

    test("a rows extension declared through verbs alone governs move too", async () => {
      const db = await setup();
      for (const [id, owner] of [
        ["a", "u1"],
        ["h", "u2"],
      ] as const)
        await db.card.create({
          data: { id, columnId: "c1", title: id, owner },
        });
      const governed = (
        ordering({ card: { key: "rank", within: ["columnId"] } })(
          (counted_ as any).$extends({
            name: "test.owner",
            rows: {
              control: "owner",
              default: "mine",
              models: {},
              verbs: {
                card: {
                  predicates: { mine: { owner: "u1" } },
                  read: "mine",
                  update: "mine",
                },
              },
            },
          })
        ) as any
      ).card;
      expect(
        (await governed.findMany()).map((row: { id: string }) => row.id)
      ).toEqual(["a"]);

      for (const hidden of ["h", "nope"])
        await expect(
          governed.move({ where: { id: "a" }, after: { id: hidden } })
        ).rejects.toThrow("move anchor");
    });

    test("a move into a list whose members are all hidden keys as into an empty one", async () => {
      const db = await setup();
      for (const [id, columnId] of [
        ["a", "c1"],
        ["b", "c1"],
        ["t", "c2"],
      ] as const)
        await db.card.create({ data: { id, columnId, title: id } });
      await base_.card.update({
        where: { id: "t" },
        data: { deletedAt: new Date("2026-01-01T00:00:00.000Z") },
      });
      const governed = (
        softDelete({ models: { card: { deletedAt: "deletedAt" } } })(
          ordering({ card: { key: "rank", within: ["columnId"] } })(
            counted_ as any
          ) as any
        ) as any
      ).card;
      await base_.column.create({ data: { id: "c3" } });
      const into = async (id: string, columnId: string) =>
        (await governed.move({ where: { id }, first: true, to: { columnId } }))
          .rank as string;
      // Each from no visible member: the same integer part, whatever the
      // hidden members' keys (the random fraction differs). Read from the
      // table, the first would go below the hidden member's key ("0…").
      const hidden = await into("a", "c2");
      const empty = await into("b", "c3");
      expect(hidden.slice(0, 2)).toBe(empty.slice(0, 2));
    });

    test("ties are respaced when a move needs a gap between them", async () => {
      const db = await setup();
      for (const title of ["a", "b", "c"])
        await db.card.create({
          data: { id: title, columnId: "c1", title, rank: "15" },
        });
      await db.card.create({ data: { id: "d", columnId: "c1", title: "d" } });
      // a, b, c tie on "15" (ordered by id); d is after them.
      await db.card.move({ where: { id: "d" }, after: { id: "a" } });
      expect(await listOf(db, "c1")).toEqual(["a", "d", "b", "c"]);
    });

    test("many moves into one gap stay ordered and keys stay bounded", async () => {
      const db = await setup();
      for (const title of ["a", "b"])
        await db.card.create({ data: { id: title, columnId: "c1", title } });
      for (let index = 0; index < 150; index++) {
        await db.card.create({
          data: { id: `m${index}`, columnId: "c1", title: `m${index}` },
        });
        await db.card.move({ where: { id: `m${index}` }, after: { id: "a" } });
      }
      const list = await listOf(db, "c1");
      expect(list[0]).toBe("a");
      expect(list[1]).toBe("m149");
      expect(list.at(-1)).toBe("b");
      const ranks = (await db.card.findMany({ where: { columnId: "c1" } })).map(
        (row: { rank: string }) => row.rank
      );
      expect(ranks.every(isKey)).toBe(true);
    });

    test("rekey inside an interactive transaction runs in it", async () => {
      const db = await setup();
      const supports = (db.$driver as { supportsTransactions?: boolean })
        ?.supportsTransactions;
      if (supports === false) return;
      for (const title of ["b", "a"])
        await db.card.create({
          data: { id: title, columnId: "c1", title, rank: "15" },
        });
      await expect(
        db.$transaction(async (tx: typeof db) => {
          await tx.card.rekey({
            where: { columnId: "c1" },
            orderBy: { title: "desc" },
          });
          throw new Error("roll back");
        })
      ).rejects.toThrow("roll back");
      const ranks = (await db.card.findMany({ where: { columnId: "c1" } })).map(
        (row: { rank: string }) => row.rank
      );
      expect(ranks).toEqual(["15", "15"]);
      await db.$transaction(async (tx: typeof db) => {
        await tx.card.rekey({
          where: { columnId: "c1" },
          orderBy: { title: "desc" },
        });
      });
      expect(await listOf(db, "c1")).toEqual(["b", "a"]);
    });

    test("rekey gives a list fresh keys in its order, or in another", async () => {
      const db = await setup();
      for (const title of ["c", "a", "b"])
        await db.card.create({
          data: { id: title, columnId: "c1", title, rank: "15" },
        });
      const { count } = await db.card.rekey({
        where: { columnId: "c1" },
        orderBy: { title: "desc" },
      });
      expect(count).toBe(3);
      expect(await listOf(db, "c1")).toEqual(["c", "b", "a"]);
      const ranks = (await db.card.findMany({ where: { columnId: "c1" } })).map(
        (row: { rank: string }) => row.rank
      );
      expect(new Set(ranks).size).toBe(3);
    });

    test("random moves keep every list in the order a model of it predicts", async () => {
      const db = await setup();
      // A seeded sequence: the same moves on every run and provider.
      let seed = 127;
      const random = (below: number) => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed % below;
      };
      const lists: Record<string, string[]> = { c1: [], c2: [] };
      for (let index = 0; index < 12; index++) {
        const columnId = index % 2 === 0 ? "c1" : "c2";
        const id = `r${index}`;
        await db.card.create({ data: { id, columnId, title: id } });
        lists[columnId]!.push(id);
      }
      const where = (id: string) =>
        Object.keys(lists).find((list) => lists[list]!.includes(id))!;
      for (let step = 0; step < 200; step++) {
        const ids = Object.values(lists).flat();
        const id = ids[random(ids.length)]!;
        const from = where(id);
        const kind = random(6);
        lists[from] = lists[from]!.filter((other) => other !== id);
        if (kind < 4) {
          const others = ids.filter((other) => other !== id);
          const anchor = others[random(others.length)]!;
          const target = where(anchor);
          const at = lists[target]!.indexOf(anchor) + (kind < 2 ? 1 : 0);
          lists[target]!.splice(at, 0, id);
          await db.card.move({
            where: { id },
            ...(kind < 2
              ? { after: { id: anchor } }
              : { before: { id: anchor } }),
          });
        } else {
          const target = random(3) === 0 ? (from === "c1" ? "c2" : "c1") : from;
          const first = kind === 4;
          if (first) lists[target]!.unshift(id);
          else lists[target]!.push(id);
          await db.card.move({
            where: { id },
            ...(first ? { first: true } : { last: true }),
            ...(target === from ? {} : { to: { columnId: target } }),
          });
        }
        if (step % 25 === 24 || step === 199)
          for (const list of Object.keys(lists))
            expect(
              (await db.card.findMany({ where: { columnId: list } })).map(
                (row: { id: string }) => row.id
              )
            ).toEqual(lists[list]);
      }
      const ranks = (await db.card.findMany()).map(
        (row: { rank: string }) => row.rank
      );
      expect(ranks.every(isKey)).toBe(true);
    });

    test("rekey by another order keeps the current order among equals", async () => {
      const db = await setup();
      for (const [id, title] of [
        ["a", "x"],
        ["d", "y"],
        ["c", "y"],
        ["b", "y"],
      ])
        await db.card.create({ data: { id, columnId: "c1", title } });
      await db.card.rekey({
        where: { columnId: "c1" },
        orderBy: { title: "asc" },
      });
      expect(
        (await db.card.findMany({ where: { columnId: "c1" } })).map(
          (row: { id: string }) => row.id
        )
      ).toEqual(["a", "d", "c", "b"]);
    });

    test("a written key of 10^8 or more is refused: appends stay possible", async () => {
      const db = await setup();
      await expect(
        db.card.create({
          data: { id: "a", columnId: "c1", title: "a", rank: "9999999999" },
        })
      ).rejects.toThrow(ValidationError);
      await db.card.create({
        data: { id: "a", columnId: "c1", title: "a", rank: "899999999" },
      });
      await db.card.create({ data: { id: "b", columnId: "c1", title: "b" } });
      expect(await listOf(db, "c1")).toEqual(["a", "b"]);
    });

    test("a list field in the model's key: anchored moves and respacing", async () => {
      const db = await setup();
      for (const id of ["a", "b", "c"])
        await db.slot.create({ data: { tenant: "t", id, rank: "15" } });
      await db.slot.create({ data: { tenant: "u", id: "a" } });
      const ids = async (tenant: string) =>
        (await db.slot.findMany({ where: { tenant } })).map(
          (row: { id: string }) => row.id
        );
      // Tied: the move respaces the list first.
      await db.slot.move({
        where: { tenant_id: { tenant: "t", id: "c" } },
        after: { tenant_id: { tenant: "t", id: "a" } },
      });
      expect(await ids("t")).toEqual(["a", "c", "b"]);
      await db.slot.move({
        where: { tenant_id: { tenant: "t", id: "a" } },
        before: { tenant_id: { tenant: "t", id: "b" } },
      });
      expect(await ids("t")).toEqual(["c", "a", "b"]);
      expect((await db.slot.rekey({ orderBy: { id: "desc" } })).count).toBe(4);
      expect(await ids("t")).toEqual(["c", "b", "a"]);
      expect(await ids("u")).toEqual(["a"]);
    });
  });
}

export function describeOrderingAdmission(
  open: () => Promise<{ client: Base }>
) {
  describe("ordering: configuration", () => {
    test.each([
      ["an unknown model", { nope: { key: "rank" } }],
      ["an unknown key field", { card: { key: "nope" } }],
      ["a key that is not a string", { card: { key: "id" } }],
      [
        "a key in its list's fields",
        { card: { key: "rank", within: ["rank"] } },
      ],
      ["an unknown list field", { card: { key: "rank", within: ["nope"] } }],
      [
        "a list field twice",
        { card: { key: "rank", within: ["columnId", "columnId"] } },
      ],
    ])("refuses %s", async (_, config) => {
      const { client } = await open();
      expect(() => ordering(config as any)(client as any)).toThrow(
        ClientInitializationError
      );
    });
  });
}
