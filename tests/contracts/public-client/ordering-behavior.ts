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
import { isKey, ordering, orderingKey } from "@src/ordering";
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
  column: s
    .toOne(() => column)
    .fields("columnId")
    .references("id"),
});

export const schema = { column, card };

type Base = {
  $extends: (...args: never[]) => unknown;
  $schema: typeof schema;
};

export function describeOrdering(
  label: string,
  open: () => Promise<{ client: Base; close?: () => Promise<void> }>,
  /** Statements one create sends: the INSERT alone, where it returns its
   * row and computes its key (MySQL reads the last key first). */
  createStatements = 1
) {
  const statements: string[] = [];
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
    const counted = (
      client as unknown as { $extends: (definition: object) => Base }
    ).$extends({
      name: "count-statements",
      statement: ({ statement }: { statement: Sql }) => {
        statements.push(Sql.peek(statement).strings.join("?"));
        return statement;
      },
    });
    const db = ordering({ card: { key: "rank", within: ["columnId"] } })(
      counted as any
    ) as any;
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
      ).rejects.toThrow(NotFoundError);
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
