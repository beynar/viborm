/**
 * The same public writes on SurrealDB and on PGlite, compared whole: what each
 * answers and what each then holds. What differs by design is stated by its own
 * test at the end. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { DbNull, JsonNull, s } from "@schema";
import { sql } from "@sql";
import { defineExtension } from "@src/index";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it, vi } from "vitest";
import {
  caught,
  compare,
  family,
  rows,
  simple,
} from "./surrealdb-parity-fixture";

describe.skipIf(!surrealUrl)("SurrealDB writes against SQL", () => {
  describe("fk-key-actions", () => {
    it.each([
      "cascade",
      "restrict",
      "setNull",
    ] as const)("onUpdate %s with onDelete cascade", async (action) =>
      compare(family(action, "cascade"), async (db) => {
        await db.parent.create({
          data: { id: "a", name: "A", children: { create: { id: "c" } } },
        });
        const result = await caught(() =>
          db.parent.update({ where: { id: "a" }, data: { id: "b" } })
        );
        return {
          result,
          parents: await rows(db, "parent"),
          children: await rows(db, "child"),
        };
      }));
  });

  describe("singular-key-loss", () => {
    it("key move preserves a singular junction membership", async () => {
      const book = s.model({
        id: s.string().id(),
        shelf: s.toOne(() => shelf),
      });
      const shelf = s.model({
        id: s.string().id(),
        items: s.toMany({ book: () => book }).through({
          book: { table: "shelf_book", source: "shelf", target: "book" },
        }),
      });
      await compare({ shelf, book }, async (db) => {
        await db.book.create({ data: { id: "b" } });
        await db.shelf.create({
          data: {
            id: "old",
            items: { connect: { type: "book", where: { id: "b" } } },
          },
        });
        const result = await caught(() =>
          db.shelf.update({ where: { id: "old" }, data: { id: "new" } })
        );
        return {
          result,
          shelves: await db.shelf.findMany({ include: { items: true } }),
          books: await db.book.findMany({ include: { shelf: true } }),
        };
      });
    });
  });

  describe("key-moves", () => {
    it("moving a key with an unchanged unique column", async () =>
      compare(simple(), async (db) => {
        await db.user.create({ data: { id: "a", email: "taken", n: 1 } });
        const result = await caught(() =>
          db.user.update({ where: { id: "a" }, data: { id: "b" } })
        );
        return { result, rows: await rows(db) };
      }));
    it("setting a key to itself", async () =>
      compare(simple(), async (db) => {
        await db.user.create({ data: { id: "a", email: "taken" } });
        const result = await caught(() =>
          db.user.update({
            where: { id: "a" },
            data: { id: "a", name: "updated" },
          })
        );
        return { result, rows: await rows(db) };
      }));
    it("compound primary key move", async () => {
      const item = s
        .model({ a: s.string(), b: s.int(), name: s.string() })
        .id(["a", "b"]);
      await compare({ item }, async (db) => {
        await db.item.create({ data: { a: "a", b: 1, name: "row" } });
        const result = await caught(() =>
          db.item.update({ where: { a_b: { a: "a", b: 1 } }, data: { b: 2 } })
        );
        return {
          result,
          rows: await db.item.findMany({
            orderBy: [{ a: "asc" }, { b: "asc" }],
          }),
        };
      });
    });
    it("updateMany key collision rolls back all moves", async () => {
      const item = s.model({ id: s.string().id(), n: s.int() });
      await compare({ item }, async (db) => {
        await db.item.createMany({
          data: [
            { id: "a", n: 1 },
            { id: "b", n: 2 },
          ],
        });
        const result = await caught(() =>
          db.item.updateMany({ data: { id: "c" } })
        );
        return { result, rows: await rows(db, "item") };
      });
    });
  });

  describe("integer-overflow", () => {
    it("integer division", async () =>
      compare(simple(), async (db) => {
        await db.user.create({ data: { id: "a", email: "a", n: 7 } });
        const result = await caught(() =>
          db.user.update({ where: { id: "a" }, data: { n: { divide: 2 } } })
        );
        return { result, rows: await rows(db) };
      }));
    it("integer division by zero", async () =>
      compare(simple(), async (db) => {
        await db.user.create({ data: { id: "a", email: "a", n: 7 } });
        const result = await caught(() =>
          db.user.update({ where: { id: "a" }, data: { n: { divide: 0 } } })
        );
        return { result, rows: await rows(db) };
      }));
    it("integer overflow", async () =>
      compare(simple(), async (db) => {
        await db.user.create({
          data: { id: "a", email: "a", n: 2_147_483_647 },
        });
        const result = await caught(() =>
          db.user.update({ where: { id: "a" }, data: { n: { increment: 1 } } })
        );
        return { result, rows: await rows(db) };
      }));
  });

  describe("decimal-error-mapping", () => {
    it("decimal half ties and increment scale", async () => {
      const item = s.model({
        id: s.string().id(),
        amount: s.decimal({ precision: 6, scale: 2 }),
      });
      await compare({ item }, async (db) => {
        await db.item.create({ data: { id: "a", amount: "1.00" } });
        const divide = await caught(() =>
          db.item.update({
            where: { id: "a" },
            data: { amount: { divide: "8" } },
          })
        );
        return { divide, rows: await rows(db, "item") };
      });
    });
    it("decimal overflow error mapping", async () => {
      const item = s.model({
        id: s.string().id(),
        amount: s.decimal({ precision: 4, scale: 2 }),
      });
      await compare({ item }, async (db) => {
        await db.item.create({ data: { id: "a", amount: "99.99" } });
        const result = await caught(() =>
          db.item.update({
            where: { id: "a" },
            data: { amount: { increment: "1.00" } },
          })
        );
        return { result, rows: await rows(db, "item") };
      });
    });
  });

  describe("connect-or-create", () => {
    it("nested skipDuplicates rejects foreign key violation", async () => {
      const owner = s.model({
        id: s.string().id(),
        children: s.toMany(() => child),
      });
      const other = s.model({
        id: s.string().id(),
        children: s.toMany(() => child),
      });
      const child = s.model({
        id: s.string().id(),
        ownerId: s.string(),
        owner: s
          .toOne(() => owner)
          .fields("ownerId")
          .references("id"),
        otherId: s.string(),
        other: s
          .toOne(() => other)
          .fields("otherId")
          .references("id"),
      });
      await compare({ owner, child, other }, async (db) => {
        const result = await caught(() =>
          db.owner.create({
            data: {
              id: "a",
              children: {
                createMany: {
                  data: [{ id: "c", otherId: "missing" }],
                  skipDuplicates: true,
                },
              },
            },
          })
        );
        return {
          result,
          owners: await rows(db, "owner"),
          children: await rows(db, "child"),
        };
      });
    });
    it("connectOrCreate with a different unique conflict", async () => {
      const user = s.model({
        id: s.string().id(),
        email: s.string().unique(),
        children: s.toMany(() => child),
      });
      const child = s.model({
        id: s.string().id(),
        ownerId: s.string(),
        owner: s
          .toOne(() => user)
          .fields("ownerId")
          .references("id"),
      });
      await compare({ user, child }, async (db) => {
        await db.user.create({ data: { id: "a", email: "taken" } });
        const result = await caught(() =>
          db.child.create({
            data: {
              id: "c",
              owner: {
                connectOrCreate: {
                  where: { id: "b" },
                  create: { id: "b", email: "taken" },
                },
              },
            },
          })
        );
        return {
          result,
          users: await rows(db),
          children: await rows(db, "child"),
        };
      });
    });
  });

  describe("additional passing coverage", () => {
    it("PK upsert conflicting on a different unique index", async () =>
      compare(simple(), async (db) => {
        await db.user.create({ data: { id: "a", email: "taken", n: 1 } });
        const result = await caught(() =>
          db.user.upsert({
            where: { id: "b" },
            create: { id: "b", email: "taken", n: 2 },
            update: { n: 99 },
          })
        );
        return { result, rows: await rows(db) };
      }));
    it("createMany skipDuplicates within batch", async () =>
      compare(simple(), async (db) => {
        const result = await caught(() =>
          db.user.createMany({
            data: [
              { id: "a", email: "a" },
              { id: "b", email: "a" },
              { id: "a", email: "c" },
              { id: "d", email: "d" },
            ],
            skipDuplicates: true,
          })
        );
        return { result, rows: await rows(db) };
      }));
    it("record keys and strings round trip", async () =>
      compare(simple(), async (db) => {
        const ids = ["a'b", 'a"b', "a`b", "a[b]", "a b", "é雪", "a\\b"];
        const result = await caught(() =>
          db.user.createMany({
            data: ids.map((id: string) => ({ id, email: id, name: id })),
          })
        );
        return {
          result,
          rows: (await rows(db)).sort((a: any, b: any) =>
            a.id.localeCompare(b.id)
          ),
        };
      }));
    it("unique-target upsert refuses other-index conflict", async () =>
      compare(simple(), async (db) => {
        await db.user.create({ data: { id: "a", email: "a" } });
        const result = await caught(() =>
          db.user.upsert({
            where: { email: "b" },
            create: { id: "a", email: "b" },
            update: { name: "changed" },
          })
        );
        return { result, rows: await rows(db) };
      }));
    it("bulk write limits", async () =>
      compare(simple(), async (db) => {
        await db.user.createMany({
          data: ["a", "b", "c"].map((id) => ({ id, email: id, n: 1 })),
        });
        const update = await caught(() =>
          db.user.updateMany({ data: { n: 2 }, limit: 1 })
        );
        const middle = await rows(db);
        const del = await caught(() => db.user.deleteMany({ limit: 1 }));
        return { update, middle, del, rows: await rows(db) };
      }));
    it("concurrent increments from eight clients", async () =>
      compare(simple(), async (db, fork) => {
        await db.user.create({ data: { id: "a", email: "a", n: 0 } });
        const clients = Array.from({ length: 8 }, fork);
        await Promise.all(clients.map((c) => c.user.findMany()));
        const results = await Promise.all(
          clients.map((c) =>
            caught(() =>
              c.user.update({
                where: { id: "a" },
                data: { n: { increment: 1 } },
                select: { id: true },
              })
            )
          )
        );
        return { results, rows: await rows(db) };
      }));
    it("key-only upsert ignores conflicting create fields on update arm", async () =>
      compare(simple(), async (db) => {
        await db.user.createMany({
          data: [
            { id: "a", email: "a" },
            { id: "b", email: "b" },
          ],
        });
        const result = await caught(() =>
          db.user.upsert({
            where: { id: "a" },
            create: { id: "a", email: "b" },
            update: { n: 3 },
          })
        );
        return { result, rows: await rows(db) };
      }));
    it("JSON null versus database null after writes", async () => {
      const item = s.model({
        id: s.string().id(),
        payload: s.json().nullable(),
      });
      await compare({ item }, async (db) => {
        await db.item.createMany({
          data: [
            { id: "db", payload: DbNull },
            { id: "json", payload: JsonNull },
          ],
        });
        const by = async (value: unknown) =>
          db.item.findMany({
            where: { payload: { equals: value } },
            select: { id: true },
            orderBy: { id: "asc" },
          });
        const before = { db: await by(DbNull), json: await by(JsonNull) };
        await db.item.update({
          where: { id: "db" },
          data: { payload: JsonNull },
        });
        await db.item.update({
          where: { id: "json" },
          data: { payload: DbNull },
        });
        return {
          before,
          after: { db: await by(DbNull), json: await by(JsonNull) },
        };
      });
    });
    it("generated integer keys", async () => {
      const item = s.model({ id: s.int().id().increment(), name: s.string() });
      await compare({ item }, async (db) => {
        const one = await caught(() => db.item.create({ data: { name: "a" } }));
        const many = await caught(() =>
          db.item.createMany({ data: [{ name: "b" }, { name: "c" }] })
        );
        return { one, many, rows: await rows(db, "item") };
      });
    });
    it("deletion cascades through a chain and handles self references", async () => {
      const root = s.model({ id: s.string().id(), mids: s.toMany(() => mid) });
      const mid = s.model({
        id: s.string().id(),
        rootId: s.string(),
        root: s
          .toOne(() => root)
          .fields("rootId")
          .references("id")
          .onDelete("cascade"),
        leaves: s.toMany(() => leaf),
      });
      const leaf = s.model({
        id: s.string().id(),
        midId: s.string(),
        mid: s
          .toOne(() => mid)
          .fields("midId")
          .references("id")
          .onDelete("cascade"),
      });
      await compare({ root, mid, leaf }, async (db) => {
        await db.root.create({
          data: {
            id: "a",
            mids: { create: { id: "m", leaves: { create: { id: "l" } } } },
          },
        });
        const result = await caught(() =>
          db.root.delete({ where: { id: "a" } })
        );
        return {
          result,
          roots: await rows(db, "root"),
          mids: await rows(db, "mid"),
          leaves: await rows(db, "leaf"),
        };
      });
    });
    it("declared junction repeated through writes and disconnect", async () => {
      const link = s
        .model({
          roomId: s.string(),
          guestId: s.string(),
          note: s.string().default("new"),
          room: s
            .toOne(() => room)
            .fields("roomId")
            .references("id")
            .onDelete("cascade"),
          guest: s
            .toOne(() => guest)
            .fields("guestId")
            .references("id")
            .onDelete("cascade"),
        })
        .id(["roomId", "guestId"]);
      const room = s.model({
        id: s.string().id(),
        guests: s
          .toMany(() => guest)
          .through(() => link)
          .source("room")
          .target("guest"),
      });
      const guest = s.model({
        id: s.string().id(),
        rooms: s.toMany(() => room),
      });
      await compare({ room, guest, link }, async (db) => {
        await db.guest.create({ data: { id: "g" } });
        const create = await caught(() =>
          db.room.create({
            data: {
              id: "r",
              guests: { connect: { id: "g", $through: { note: "first" } } },
            },
          })
        );
        const update = await caught(() =>
          db.room.update({
            where: { id: "r" },
            data: {
              guests: { connect: { id: "g", $through: { note: "second" } } },
            },
          })
        );
        const links = await db.link.findMany();
        const disconnect = await caught(() =>
          db.room.update({
            where: { id: "r" },
            data: { guests: { disconnect: { id: "g" } } },
          })
        );
        return {
          create,
          update,
          links,
          disconnect,
          left: await db.link.findMany(),
        };
      });
    });
    it.each([
      "cascade",
      "restrict",
      "setNull",
    ] as const)("self reference deleteMany with %s", async (action) => {
      const node = s.model({
        id: s.string().id(),
        parentId: s.string().nullable(),
        parent: s
          .toOne(() => node)
          .name("tree")
          .fields("parentId")
          .references("id")
          .onDelete(action),
        children: s.toMany(() => node).name("tree"),
      });
      await compare({ node }, async (db) => {
        await db.node.create({
          data: { id: "root", children: { create: { id: "leaf" } } },
        });
        const result = await caught(() => db.node.deleteMany({}));
        return { result, rows: await rows(db, "node") };
      });
    });
  });

  describe("a bulk write's relations", () => {
    const shape = () => {
      const parent = s.model({
        id: s.string().id(),
        children: s.toMany(() => child),
      });
      const child = s.model({
        id: s.string().id(),
        qty: s.int(),
        parentId: s.string().nullable(),
        parent: s
          .toOne(() => parent)
          .fields("parentId")
          .references("id"),
      });
      return { parent, child };
    };
    it("createMany answers its rows, in the order it names them", async () => {
      await compare(shape(), async (db) => {
        await db.parent.create({ data: { id: "p" } });
        const created = await caught(() =>
          db.child.createMany({
            data: [
              { id: "z", qty: 1, parent: { connect: { id: "p" } } },
              { id: "a", qty: 2, parent: { connect: { id: "p" } } },
              { id: "m", qty: 3 },
            ],
            select: { id: true, qty: true, parentId: true },
          })
        );
        return { created, rows: await rows(db, "child") };
      });
    });
    it("updateMany answers its rows", async () => {
      await compare(shape(), async (db) => {
        await db.parent.create({ data: { id: "p" } });
        await db.child.createMany({
          data: [
            { id: "a", qty: 1 },
            { id: "b", qty: 2 },
          ],
        });
        const updated = await caught(() =>
          db.child.updateMany({
            where: { qty: { gt: 0 } },
            data: { parent: { connect: { id: "p" } }, qty: 9 },
            select: { id: true, parentId: true },
          })
        );
        return { updated, rows: await rows(db, "child") };
      });
    });
    it("a compound key reads back too", async () => {
      const item = s
        .model({ a: s.string(), b: s.int(), name: s.string() })
        .id(["a", "b"]);
      await compare({ item }, async (db) => {
        const created = await caught(() =>
          db.item.createMany({
            data: [
              { a: "x", b: 2, name: "n" },
              { a: "x", b: 1, name: "m" },
            ],
            select: { b: true, name: true },
          })
        );
        return { created };
      });
    });
  });

  describe("key moves beyond the reported", () => {
    it.each([
      "cascade",
      "restrict",
      "setNull",
      "noAction",
      undefined,
    ] as const)("onUpdate %s, held and unheld", async (action) => {
      const parent = s.model({
        id: s.string().id(),
        children: s.toMany(() => child),
      });
      const relation = s
        .toOne(() => parent)
        .fields("parentId")
        .references("id");
      const child = s.model({
        id: s.string().id(),
        parentId: s.string().nullable(),
        parent: action ? relation.onUpdate(action) : relation,
      });
      await compare({ parent, child }, async (db) => {
        await db.parent.create({
          data: { id: "held", children: { create: { id: "c" } } },
        });
        await db.parent.create({ data: { id: "free" } });
        const held = await caught(() =>
          db.parent.update({ where: { id: "held" }, data: { id: "held2" } })
        );
        const free = await caught(() =>
          db.parent.update({ where: { id: "free" }, data: { id: "free2" } })
        );
        return {
          held,
          free,
          parents: await rows(db, "parent"),
          children: await rows(db, "child"),
        };
      });
    });
    it("unique fields of every kind hold while the row moves", async () => {
      const item = s
        .model({
          id: s.string().id(),
          a: s.string(),
          b: s.int().unique(),
          c: s.bigInt().unique(),
          d: s.string().nullable().unique(),
          e: s.boolean().nullable(),
          f: s.string(),
        })
        .unique(["a", "e"])
        .unique(["f", "b"], { name: "fb" });
      await compare({ item }, async (db) => {
        await db.item.create({
          data: { id: "x", a: "a", b: 1, c: 2n, d: "d", e: true, f: "f" },
        });
        await db.item.create({
          data: { id: "y", a: "b", b: 2, c: 3n, f: "g" },
        });
        const moved = await caught(() =>
          db.item.update({ where: { id: "x" }, data: { id: "z" } })
        );
        const stated = await caught(() =>
          db.item.update({
            where: { id: "z" },
            data: { id: "w", a: "new", b: 9 },
          })
        );
        const taken = await caught(() =>
          db.item.update({ where: { id: "w" }, data: { id: "v", b: 2 } })
        );
        return { moved, stated, taken, rows: await rows(db, "item") };
      });
    });
    it("a unique field the row can move past: its own link stays refused by name", async () => {
      const owner = s.model({
        id: s.string().id(),
        profile: s.toOne(() => profile),
      });
      const profile = s.model({
        id: s.string().id(),
        ownerId: s.string().unique(),
        owner: s
          .toOne(() => owner)
          .fields("ownerId")
          .references("id"),
      });
      const db: any = createClient({
        schema: { owner, profile },
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(db);
        await db.owner.create({
          data: { id: "o", profile: { create: { id: "p" } } },
        });
        await expect(
          db.profile.update({ where: { id: "p" }, data: { id: "q" } })
        ).rejects.toThrow("has no value to stand in");
        expect(await db.profile.findMany()).toEqual([
          { id: "p", ownerId: "o" },
        ]);
      } finally {
        await db.$disconnect();
      }
    });
    it("a link row whose own key holds the moved one refuses by name", async () => {
      const link = s
        .model({
          roomId: s.string(),
          guestId: s.string(),
          room: s
            .toOne(() => room)
            .fields("roomId")
            .references("id")
            .onUpdate("cascade")
            .onDelete("cascade"),
          guest: s
            .toOne(() => guest)
            .fields("guestId")
            .references("id")
            .onUpdate("cascade")
            .onDelete("cascade"),
        })
        .id(["roomId", "guestId"]);
      const room = s.model({
        id: s.string().id(),
        guests: s
          .toMany(() => guest)
          .through(() => link)
          .source("room")
          .target("guest"),
      });
      const guest = s.model({
        id: s.string().id(),
        rooms: s.toMany(() => room),
      });
      const db: any = createClient({
        schema: { room, guest, link },
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(db);
        await db.room.create({
          data: { id: "r", guests: { create: { id: "g" } } },
        });
        await expect(
          db.guest.update({ where: { id: "g" }, data: { id: "h" } })
        ).rejects.toThrow("a key that holds it");
        expect(await db.link.findMany()).toEqual([
          { roomId: "r", guestId: "g" },
        ]);
      } finally {
        await db.$disconnect();
      }
    });
    it("a link row with a key of its own follows", async () => {
      const link = s
        .model({
          id: s.string().id(),
          roomId: s.string(),
          guestId: s.string(),
          room: s
            .toOne(() => room)
            .fields("roomId")
            .references("id")
            .onUpdate("cascade")
            .onDelete("cascade"),
          guest: s
            .toOne(() => guest)
            .fields("guestId")
            .references("id")
            .onUpdate("cascade")
            .onDelete("cascade"),
        })
        .unique(["roomId", "guestId"]);
      const room = s.model({
        id: s.string().id(),
        links: s.toMany(() => link),
        guests: s
          .toMany(() => guest)
          .through(() => link)
          .source("room")
          .target("guest"),
      });
      const guest = s.model({
        id: s.string().id(),
        links: s.toMany(() => link),
        rooms: s.toMany(() => room),
      });
      await compare({ room, guest, link }, async (db) => {
        await db.room.create({ data: { id: "r" } });
        await db.guest.create({ data: { id: "g" } });
        await db.link.create({ data: { id: "l", roomId: "r", guestId: "g" } });
        const moved = await caught(() =>
          db.guest.update({ where: { id: "g" }, data: { id: "h" } })
        );
        return {
          moved,
          links: await db.link.findMany(),
          rooms: await db.room.findMany({ include: { guests: true } }),
        };
      });
    });
    it("many-to-many edges follow both ways", async () => {
      const post = s.model({ id: s.string().id(), tags: s.toMany(() => tag) });
      const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
      await compare({ post, tag }, async (db) => {
        await db.post.create({
          data: { id: "p", tags: { create: [{ id: "t1" }, { id: "t2" }] } },
        });
        const post2 = await caught(() =>
          db.post.update({ where: { id: "p" }, data: { id: "p2" } })
        );
        const tag2 = await caught(() =>
          db.tag.update({ where: { id: "t1" }, data: { id: "t9" } })
        );
        return {
          post2,
          tag2,
          posts: await db.post.findMany({
            include: { tags: { orderBy: { id: "asc" } } },
          }),
        };
      });
    });
  });

  describe("a reference to a unique field", () => {
    it.each([
      "cascade",
      "setNull",
      "restrict",
    ] as const)("onDelete %s", async (action) => {
      const parent = s.model({
        id: s.string().id(),
        slug: s.string().unique(),
        children: s.toMany(() => child),
      });
      const child = s.model({
        id: s.string().id(),
        parentSlug: s.string().nullable(),
        parent: s
          .toOne(() => parent)
          .fields("parentSlug")
          .references("slug")
          .onDelete(action),
      });
      await compare({ parent, child }, async (db) => {
        await db.parent.create({
          data: { id: "a", slug: "a", children: { create: { id: "c" } } },
        });
        const result = await caught(() =>
          db.parent.delete({ where: { id: "a" } })
        );
        return {
          result,
          parents: await rows(db, "parent"),
          children: await rows(db, "child"),
        };
      });
    });
    it.each([
      "cascade",
      "setNull",
      "restrict",
    ] as const)("onUpdate %s", async (action) => {
      const parent = s.model({
        id: s.string().id(),
        slug: s.string().unique(),
        children: s.toMany(() => child),
      });
      const child = s.model({
        id: s.string().id(),
        parentSlug: s.string().nullable(),
        parent: s
          .toOne(() => parent)
          .fields("parentSlug")
          .references("slug")
          .onUpdate(action),
      });
      await compare({ parent, child }, async (db) => {
        await db.parent.create({
          data: { id: "a", slug: "a", children: { create: { id: "c" } } },
        });
        const result = await caught(() =>
          db.parent.update({ where: { id: "a" }, data: { slug: "b" } })
        );
        return {
          result,
          parents: await rows(db, "parent"),
          children: await rows(db, "child"),
        };
      });
    });
    it("a key move refuses by name: its action is an event the old row would fire", async () => {
      const parent = s.model({
        id: s.string().id(),
        slug: s.string().unique(),
        children: s.toMany(() => child),
      });
      const child = s.model({
        id: s.string().id(),
        parentSlug: s.string().nullable(),
        parent: s
          .toOne(() => parent)
          .fields("parentSlug")
          .references("slug"),
      });
      const db: any = createClient({
        schema: { parent, child },
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(db);
        await db.parent.create({
          data: { id: "a", slug: "a", children: { create: { id: "c" } } },
        });
        await expect(
          db.parent.update({ where: { id: "a" }, data: { id: "b" } })
        ).rejects.toThrow("references by another field");
        expect(await rows(db, "child")).toEqual([{ id: "c", parentSlug: "a" }]);
      } finally {
        await db.$disconnect();
      }
    });
    it("an unset value is no reference", async () => {
      const parent = s.model({
        id: s.string().id(),
        slug: s.string().nullable().unique(),
        children: s.toMany(() => child),
      });
      const child = s.model({
        id: s.string().id(),
        parentSlug: s.string().nullable(),
        parent: s
          .toOne(() => parent)
          .fields("parentSlug")
          .references("slug")
          .onDelete("cascade"),
      });
      await compare({ parent, child }, async (db) => {
        await db.parent.create({ data: { id: "a" } });
        await db.child.create({ data: { id: "c" } });
        const result = await caught(() =>
          db.parent.delete({ where: { id: "a" } })
        );
        return { result, children: await rows(db, "child") };
      });
    });
  });

  describe("a create that loses its race", () => {
    /** Another client writes the row just before this one's first `INSERT IGNORE`. */
    const racing = async (
      scenario: (db: any) => Promise<unknown>,
      winner: (db: any) => Promise<unknown>,
      schema: any
    ) => {
      const driver = createSurrealTestDriver() as unknown as {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
      const db: any = createClient({ schema, driver: driver as never });
      await syncLiveSchema(db);
      const other: any = createClient({
        schema,
        driver: createSurrealTestDriver(),
      });
      let raced = false;
      const execute = driver.execute;
      driver.execute = async function (this: unknown, ...args: unknown[]) {
        if (!raced && String(args[1]).startsWith("INSERT IGNORE")) {
          raced = true;
          await winner(other);
        }
        return await execute.apply(this, args);
      };
      try {
        return await scenario(db);
      } finally {
        await db.$disconnect();
        await other.$disconnect();
      }
    };
    it("connectOrCreate takes the winner's row", async () => {
      const { user, child } = (() => {
        const user = s.model({
          id: s.string().id(),
          email: s.string().unique(),
          children: s.toMany(() => child),
        });
        const child = s.model({
          id: s.string().id(),
          ownerId: s.string(),
          owner: s
            .toOne(() => user)
            .fields("ownerId")
            .references("id"),
        });
        return { user, child };
      })();
      const answer = await racing(
        async (db) => {
          await db.child.create({
            data: {
              id: "c",
              owner: {
                connectOrCreate: {
                  where: { id: "b" },
                  create: { id: "b", email: "mine" },
                },
              },
            },
          });
          return {
            users: await db.user.findMany(),
            children: await db.child.findMany(),
          };
        },
        (other) => other.user.create({ data: { id: "b", email: "theirs" } }),
        { user, child }
      );
      expect(answer).toEqual({
        users: [{ id: "b", email: "theirs" }],
        children: [{ id: "c", ownerId: "b" }],
      });
    });
  });

  describe("what a write leaves out of sight", () => {
    const task = () =>
      s.model({
        id: s.string().id(),
        status: s.string(),
        owner: s.string(),
      });
    it("a created row a caller may not read carries no evidence", async () => {
      await compare({ task: task() }, async (db) => {
        const governed = db.$extends({
          name: "evidence",
          rows: {
            default: "on",
            models: { task: { on: {} } },
            verbs: {
              task: {
                predicates: {
                  seen: { status: "open" },
                  own: { owner: "ann" },
                },
                read: "seen",
                place: "own",
                evidence: { as: "$access", names: ["seen", "own"] },
              },
            },
          },
        });
        const created = await caught(() =>
          governed.task.create({
            data: { id: "a", status: "closed", owner: "ann" },
            select: { id: true, $access: true },
          })
        );
        expect(created).toEqual({
          answer: { id: "a", $access: { seen: false, own: false } },
        });
        return { created, rows: await rows(db, "task") };
      });
    });
  });

  describe("what a foreign key does when it is no field", () => {
    const seats = (action: "cascade" | "restrict" | "noAction") => {
      const seat = s
        .model({
          roomId: s.string(),
          guestId: s.string(),
          room: s
            .toOne(() => room)
            .fields("roomId")
            .references("id")
            .onDelete(action),
          guest: s
            .toOne(() => guest)
            .fields("guestId")
            .references("id")
            .onDelete(action),
        })
        .id(["roomId", "guestId"]);
      const room = s.model({
        id: s.string().id(),
        guests: s
          .toMany(() => guest)
          .through(() => seat)
          .source("room")
          .target("guest"),
      });
      const guest = s.model({
        id: s.string().id(),
        rooms: s.toMany(() => room),
      });
      return { seat, room, guest };
    };
    it.each([
      "cascade",
      "restrict",
      "noAction",
    ] as const)("a part of the row's own key, onDelete %s", async (action) => {
      await compare(seats(action), async (db) => {
        await db.room.create({
          data: { id: "r", guests: { create: { id: "g" } } },
        });
        const result = await caught(() =>
          db.room.delete({ where: { id: "r" } })
        );
        return { result, seats: await db.seat.findMany() };
      });
    });
    it("a generated junction, onDelete cascade", async () => {
      const post = s.model({
        id: s.string().id(),
        tags: s.toMany(() => tag),
      });
      const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
      await compare({ post, tag }, async (db) => {
        await db.post.create({
          data: { id: "p", tags: { create: { id: "t" } } },
        });
        const result = await caught(() =>
          db.tag.delete({ where: { id: "t" } })
        );
        return {
          result,
          posts: await db.post.findMany({ include: { tags: true } }),
        };
      });
    });
    it("a unique over a part of the key holds", async () => {
      const member = s
        .model({ org: s.string(), rank: s.int(), email: s.string() })
        .id(["org", "rank"])
        .unique(["org", "email"]);
      await compare({ member }, async (db) => {
        await db.member.create({ data: { org: "a", rank: 1, email: "x" } });
        const taken = await caught(() =>
          db.member.create({ data: { org: "a", rank: 2, email: "x" } })
        );
        const other = await caught(() =>
          db.member.create({ data: { org: "b", rank: 1, email: "x" } })
        );
        return { taken, other };
      });
    });
  });

  describe("a statement reads a snapshot of what it writes", () => {
    const tree = () => {
      const node = s.model({
        id: s.string().id(),
        flag: s.boolean(),
        parentId: s.string().nullable(),
        parent: s
          .toOne(() => node)
          .name("tree")
          .fields("parentId")
          .references("id")
          .onDelete("setNull"),
        children: s.toMany(() => node).name("tree"),
      });
      return { node };
    };
    const chain = async (db: any) => {
      await db.node.create({ data: { id: "a", flag: false } });
      await db.node.create({ data: { id: "b", flag: false, parentId: "a" } });
      await db.node.create({ data: { id: "c", flag: false, parentId: "b" } });
      await db.node.create({ data: { id: "d", flag: false, parentId: "c" } });
    };
    it("updateMany whose filter reads rows it writes", async () =>
      compare(tree(), async (db) => {
        await chain(db);
        const result = await db.node.updateMany({
          where: { parent: { is: { flag: false } } },
          data: { flag: true },
        });
        return { result, rows: await rows(db, "node") };
      }));
    it("updateMany filtering on the rows' children", async () =>
      compare(tree(), async (db) => {
        await chain(db);
        const result = await db.node.updateMany({
          where: { children: { some: { flag: false } } },
          data: { flag: true },
        });
        return { result, rows: await rows(db, "node") };
      }));
    it("deleteMany whose filter reads rows it deletes", async () =>
      compare(tree(), async (db) => {
        await chain(db);
        const result = await db.node.deleteMany({
          where: { children: { some: { flag: false } } },
        });
        return { result, rows: await rows(db, "node") };
      }));
    it("a nested updateMany whose filter reads its siblings", async () =>
      compare(tree(), async (db) => {
        await db.node.create({ data: { id: "p", flag: false } });
        await db.node.create({ data: { id: "x", flag: false, parentId: "p" } });
        await db.node.create({ data: { id: "y", flag: false, parentId: "p" } });
        await db.node.update({
          where: { id: "p" },
          data: {
            children: {
              updateMany: {
                where: {
                  parent: { is: { children: { some: { flag: false } } } },
                },
                data: { flag: true },
              },
            },
          },
        });
        return rows(db, "node");
      }));
  });

  describe("transactions going back", () => {
    const committing = async (work: () => Promise<unknown>) => ({
      answer: await work(),
    });
    const within = async (scenario: (db: any) => Promise<void>) => {
      const db: any = createClient({
        schema: family("cascade", "cascade"),
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(db);
        await scenario(db);
      } finally {
        await db.$disconnect();
      }
    };
    const failing = {
      "a statement refused": { create: [{ id: "new" }, { id: "dup" }] },
      "a check of the engine's": { connect: { id: "missing" } },
    };
    it.each(
      Object.entries(failing)
    )("a caught failure leaves the rest to commit, after %s", async (_title, children) =>
      compare(family("cascade", "cascade"), async (db) => {
        await db.child.create({ data: { id: "dup" } });
        let failure: unknown;
        const committed = await committing(() =>
          db.$transaction(async (tx: any) => {
            await tx.parent.create({ data: { id: "before", name: "before" } });
            failure = await caught(() =>
              tx.parent.create({
                data: { id: "failed", name: "failed", children },
              })
            );
            await tx.parent.create({ data: { id: "after", name: "after" } });
            return tx.parent.findMany({ orderBy: { id: "asc" } });
          })
        );
        return {
          committed,
          failure,
          parents: await rows(db, "parent"),
          children: await rows(db, "child"),
        };
      }));
    it("a failure caught as the callback's last act commits the rest", async () =>
      compare(family("cascade", "cascade"), async (db) => {
        const committed = await committing(() =>
          db.$transaction(async (tx: any) => {
            await tx.parent.create({ data: { id: "before", name: "before" } });
            await tx.parent
              .create({
                data: {
                  id: "failed",
                  name: "failed",
                  children: { connect: { id: "missing" } },
                },
              })
              .catch(() => undefined);
          })
        );
        return { committed, parents: await rows(db, "parent") };
      }));
    it("a nested scope takes back only its own writes, at each depth", async () =>
      compare(family("cascade", "cascade"), async (db) => {
        const seen = await committing(() =>
          db.$transaction(async (tx: any) => {
            await tx.parent.create({ data: { id: "a", name: "outer" } });
            const inner = await caught(() =>
              tx.$transaction(async (t2: any) => {
                await t2.parent.create({ data: { id: "b", name: "kept" } });
                const deepest = await caught(() =>
                  t2.$transaction(async (t3: any) => {
                    await t3.parent.create({ data: { id: "c", name: "gone" } });
                    throw new TypeError("deepest");
                  })
                );
                return {
                  deepest,
                  rows: await t2.parent.findMany({ orderBy: { id: "asc" } }),
                };
              })
            );
            const outer = await caught(() =>
              tx.$transaction(async (t2: any) => {
                await t2.parent.create({ data: { id: "d", name: "gone" } });
                await t2.parent.update({
                  where: { id: "a" },
                  data: { name: "gone" },
                });
                throw new TypeError("outer");
              })
            );
            await tx.parent.update({
              where: { id: "b" },
              data: { name: "changed" },
            });
            return {
              inner,
              outer,
              rows: await tx.parent.findMany({ orderBy: { id: "asc" } }),
            };
          })
        );
        return { seen, parents: await rows(db, "parent") };
      }));
    it("a scope whose only statement failed part-way leaves the rest to commit", async () =>
      compare(simple(), async (db) => {
        await db.user.create({ data: { id: "held", email: "held" } });
        const answer = await committing(() =>
          db.$transaction(async (tx: any) => {
            await tx.user.create({ data: { id: "a", email: "a" } });
            const scope = await caught(() =>
              tx.$transaction((t2: any) =>
                t2.user.create({ data: { id: "dup", email: "held" } })
              )
            );
            await tx.user.create({ data: { id: "b", email: "b" } });
            return scope;
          })
        );
        return { answer, users: await rows(db, "user") };
      }));
    it("a statement that fails with no scope around it fails the transaction", async () =>
      compare(simple(), async (db) => {
        await db.user.create({ data: { id: "held", email: "held" } });
        let next: unknown;
        const committed = await caught(() =>
          db.$transaction(async (tx: any) => {
            await tx.user.create({ data: { id: "a", email: "a" } });
            await tx.$executeRaw(sql`not a statement`).catch(() => null);
            next = await caught(() =>
              tx.user.create({ data: { id: "b", email: "b" } })
            );
          })
        );
        expect(committed).toMatchObject({ code: "V2001" });
        expect(next).toMatchObject({ code: "V5001" });
        return { committed, next, users: await rows(db, "user") };
      }));
    it("a scope that catches its own failure is refused when it ends", async () =>
      compare(simple(), async (db) => {
        const committed = await caught(() =>
          db.$transaction(async (tx: any) => {
            await tx.user.create({ data: { id: "a", email: "a" } });
            const scope = await caught(() =>
              tx.$transaction(async (t2: any) => {
                await t2.user.create({ data: { id: "b", email: "b" } });
                await t2.$executeRaw(sql`not a statement`).catch(() => null);
              })
            );
            await tx.user.create({ data: { id: "c", email: "c" } });
            return scope;
          })
        );
        expect(committed).toMatchObject({ answer: { code: "V2001" } });
        return { committed, users: await rows(db, "user") };
      }));
    it("a skipped row takes back what it wrote, and the others stay", async () => {
      const parent = s.model({
        id: s.string().id(),
        children: s.toMany(() => child),
      });
      const child = s.model({
        id: s.string().id(),
        parentId: s.string().nullable(),
        parent: s
          .toOne(() => parent)
          .fields("parentId")
          .references("id"),
      });
      await compare({ parent, child }, async (db) => {
        await db.child.create({ data: { id: "dup" } });
        const created = await committing(() =>
          db.child.createMany({
            data: [
              { id: "dup", parent: { create: { id: "new" } } },
              { id: "other", parent: { create: { id: "kept" } } },
            ],
            skipDuplicates: true,
          })
        );
        return {
          created,
          parents: await rows(db, "parent"),
          children: await rows(db, "child"),
        };
      });
    });
    it("generated values hold across going back", async () => {
      const row = s.model({
        id: s.int().id().increment(),
        name: s.string().unique(),
        at: s.dateTime().now(),
        changed: s.dateTime().updatedAt(),
      });
      await compare({ row }, async (db) => {
        const answers = await committing(() =>
          db.$transaction(async (tx: any) => {
            const first = await tx.row.create({ data: { name: "a" } });
            await tx
              .$transaction(async (t2: any) => {
                await t2.row.create({ data: { name: "gone" } });
                throw new TypeError("scope");
              })
              .catch(() => undefined);
            const after = await tx.row.findUnique({ where: { id: first.id } });
            await tx.row.create({ data: { name: "b" } });
            return JSON.stringify(after) === JSON.stringify(first);
          })
        );
        return {
          answers,
          names: (await db.row.findMany({ orderBy: { name: "asc" } })).map(
            (r: any) => r.name
          ),
        };
      });
    });
    it("a key moved before a scope fails stays moved", async () =>
      compare(family("cascade", "cascade"), async (db) => {
        await db.parent.create({
          data: { id: "a", name: "a", children: { create: { id: "c" } } },
        });
        const answer = await committing(() =>
          db.$transaction(async (tx: any) => {
            await tx.parent.update({ where: { id: "a" }, data: { id: "b" } });
            await tx
              .$transaction(async (t2: any) => {
                await t2.parent.update({
                  where: { id: "b" },
                  data: { id: "gone" },
                });
                throw new TypeError("scope");
              })
              .catch(() => undefined);
            return tx.parent.findMany();
          })
        );
        return {
          answer,
          parents: await rows(db, "parent"),
          children: await rows(db, "child"),
        };
      }));
    it("rows written side by side hold across going back", async () =>
      compare(simple(), async (db) => {
        const answer = await committing(() =>
          db.$transaction(async (tx: any) => {
            await Promise.all(
              ["a", "b", "c"].map((id) =>
                tx.user.create({ data: { id, email: id } })
              )
            );
            await tx
              .$transaction(async (t2: any) => {
                await t2.user.create({ data: { id: "d", email: "d" } });
                throw new TypeError("scope");
              })
              .catch(() => undefined);
            return tx.user.count();
          })
        );
        return { answer, users: await rows(db, "user") };
      }));
    it("a skipped row that wrote nothing costs no replay", async () => {
      const child = s.model({
        id: s.string().id(),
        parentId: s.string().nullable(),
        parent: s
          .toOne(() => parent)
          .fields("parentId")
          .references("id"),
      });
      const parent = s.model({
        id: s.string().id(),
        children: s.toMany(() => child),
      });
      const driver = createSurrealTestDriver();
      const db: any = createClient({ schema: { parent, child }, driver });
      try {
        await syncLiveSchema(db);
        await db.parent.createMany({
          data: [{ id: "a" }, { id: "b" }, { id: "c" }],
        });
        const client = await (driver as any).initClient();
        const begin = vi.spyOn(client, "beginTransaction");
        await db.parent.createMany({
          data: ["a", "b", "c"].map((id) => ({
            id,
            children: { create: { id: `child-${id}` } },
          })),
          skipDuplicates: true,
        });
        expect(begin).toHaveBeenCalledTimes(1);
        expect(await db.child.count()).toBe(0);
      } finally {
        await db.$disconnect();
      }
    });
    it("a raw INSERT IGNORE that failed part-way goes back like any write", async () => {
      await within(async (db) => {
        await db.$transaction(async (tx: any) => {
          await tx
            .$transaction((t2: any) =>
              t2.$executeRaw(
                sql.raw(
                  "INSERT IGNORE INTO parent [{ id: 'ok', name: 'ok' }, { id: 'bad', name: 1 }]"
                )
              )
            )
            .catch(() => undefined);
        });
        expect(await rows(db, "parent")).toEqual([]);
      });
    });
    it("a raw SELECT that writes goes back like any write", async () => {
      await within(async (db) => {
        await db.$transaction(async (tx: any) => {
          await tx
            .$transaction(async (t2: any) => {
              await t2.$executeRaw(
                sql.raw("SELECT * FROM (CREATE parent:raw SET name = 'raw')")
              );
              throw new TypeError("scope");
            })
            .catch(() => undefined);
        });
        expect(await rows(db, "parent")).toEqual([]);
      });
    });
    it("a callback whose reads changed under it is refused, whole", async () => {
      await within(async (db) => {
        await db.parent.create({ data: { id: "a", name: "a" } });
        const committed = db.$transaction(async (tx: any) => {
          const seen = await tx.parent.findUnique({ where: { id: "a" } });
          await tx.parent.create({ data: { id: "b", name: seen.name } });
          await db.parent.update({ where: { id: "a" }, data: { name: "z" } });
          await tx
            .$transaction(async (t2: any) => {
              await t2.parent.create({ data: { id: "c", name: "c" } });
              throw new TypeError("scope");
            })
            .catch(() => undefined);
          await tx.parent.create({ data: { id: "d", name: "d" } });
        });
        await expect(committed).rejects.toMatchObject({ code: "V5001" });
        expect((await rows(db, "parent")).map((r: any) => r.id)).toEqual(["a"]);
      });
    });
    describe("rerunsOnConflict", () => {
      const item = s.model({ id: s.string().id(), n: s.int() });
      const meeting = async (
        rerunsOnConflict: number | undefined,
        schema: Record<string, unknown> = { item }
      ) => {
        const driver = () => createSurrealTestDriver({ rerunsOnConflict });
        const clients: any[] = [
          createClient({ schema, driver: driver() } as any),
        ];
        await syncLiveSchema(clients[0]);
        for (let index = 1; index < 8; index++)
          clients.push(createClient({ schema, driver: driver() } as any));
        await clients[0].item.create({ data: { id: "a", n: 0 } });
        await Promise.all(clients.map((db) => db.item.findMany()));
        let runs = 0;
        let first = 0;
        let release = () => undefined as void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const results = await Promise.all(
          clients.map(async (db) => {
            try {
              return await db.$transaction(async (tx: any) => {
                runs += 1;
                const { n } = await tx.item.update({
                  where: { id: "a" },
                  data: { n: { increment: 1 } },
                });
                if (++first === clients.length) release();
                await barrier;
                return n;
              });
            } catch (error) {
              return (error as { code?: string }).code;
            }
          })
        );
        const [row] = await clients[0].item.findMany();
        await Promise.all(clients.map((db) => db.$disconnect()));
        return { results, runs, n: row.n };
      };
      it("gives writers who read each other the values PostgreSQL would", async () => {
        const { results, runs, n } = await meeting(8);
        expect(n).toBe(8);
        expect([...results].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(runs).toBeGreaterThan(8);
      });
      it("is off unless asked for", async () => {
        const { results, runs, n } = await meeting(undefined);
        expect(runs).toBe(8);
        expect(results.filter((result) => result === "V5001").length).toBe(
          8 - n
        );
      });
      it("gives up when its runs are spent, with nothing half done", async () => {
        const { results, runs, n } = await meeting(1);
        expect(runs).toBeLessThanOrEqual(16);
        expect(results.filter((result) => result === "V5001").length).toBe(
          8 - n
        );
      });
      const counter = async (extend: (db: any) => any = (db) => db) => {
        const root: any = createClient({
          schema: { item },
          driver: createSurrealTestDriver({ rerunsOnConflict: 1 }),
        });
        await syncLiveSchema(root);
        await root.item.create({ data: { id: "a", n: 0 } });
        return { root, db: extend(root) };
      };
      const interfere = (db: any) =>
        db.item.update({ where: { id: "a" }, data: { n: { increment: 10 } } });
      it("runs again over a conflict that came up going back", async () => {
        const { root, db } = await counter();
        let runs = 0;
        const answer = await db.$transaction(async (tx: any) => {
          runs += 1;
          const { n } = await tx.item.findUnique({ where: { id: "a" } });
          if (runs === 1) await interfere(root);
          await tx
            .$transaction(async (t2: any) => {
              await t2.item.create({ data: { id: "gone", n: 0 } });
              throw new TypeError("scope");
            })
            .catch(() => undefined);
          await tx.item.count();
          return n;
        });
        expect(answer).toBe(10);
        expect(runs).toBe(2);
        expect(await root.item.count()).toBe(1);
        await root.$disconnect();
      });
      it("runs again over a conflict that came up at commit", async () => {
        const { root, db } = await counter();
        let runs = 0;
        const answer = await db.$transaction(async (tx: any) => {
          runs += 1;
          const { n } = await tx.item.update({
            where: { id: "a" },
            data: { n: { increment: 1 } },
          });
          if (runs === 1) await interfere(root);
          return n;
        });
        expect(answer).toBe(11);
        expect(runs).toBe(2);
        await root.$disconnect();
      });
      it("does not run a callback twice under an extension that collects its writes", async () => {
        const { root, db } = await counter((client) =>
          client.$extends(
            defineExtension()({
              name: "observer",
              observe: (_unit: unknown, proceed: () => unknown) => proceed(),
            } as any)
          )
        );
        let runs = 0;
        await expect(
          db.$transaction(async (tx: any) => {
            runs += 1;
            await tx.item.update({
              where: { id: "a" },
              data: { n: { increment: 1 } },
            });
            await interfere(root);
          })
        ).rejects.toMatchObject({ code: "V5001" });
        expect(runs).toBe(1);
        await root.$disconnect();
      });
      it("does not run a callback again over the callback's own failure", async () => {
        const db: any = createClient({
          schema: { item },
          driver: createSurrealTestDriver({ rerunsOnConflict: 5 }),
        });
        await syncLiveSchema(db);
        let runs = 0;
        await expect(
          db.$transaction(() => {
            runs += 1;
            throw new TypeError("mine");
          })
        ).rejects.toBeInstanceOf(TypeError);
        expect(runs).toBe(1);
        await db.$disconnect();
      });
      it("leaves an engine's own transaction to its one recovery", async () => {
        const driver = createSurrealTestDriver({ rerunsOnConflict: 5 });
        const db: any = createClient({ schema: { item }, driver });
        await syncLiveSchema(db);
        await db.item.create({ data: { id: "a", n: 0 } });
        const bump = "UPDATE item:a SET n += 1";
        let calls = 0;
        await expect(
          driver.withTransaction(
            async (tx: any) => {
              calls += 1;
              await tx._executeRaw(bump, []);
              await interfere(db);
            },
            undefined,
            { operation: "create" }
          )
        ).rejects.toMatchObject({ code: "V5001" });
        expect(calls).toBe(1);
        await db.$disconnect();
      });
    });
    it("writers that met commit without running a callback twice, when nothing they saw changed", async () => {
      const item = s.model({ id: s.string().id(), n: s.int() });
      const clients: any[] = [
        createClient({ schema: { item }, driver: createSurrealTestDriver() }),
      ];
      try {
        await syncLiveSchema(clients[0]);
        for (let index = 1; index < 8; index++)
          clients.push(
            createClient({
              schema: { item },
              driver: createSurrealTestDriver(),
            })
          );
        await clients[0].item.create({ data: { id: "a", n: 0 } });
        await Promise.all(clients.map((db) => db.item.findMany()));
        let entered = 0;
        let runs = 0;
        let release = () => undefined as void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const results = await Promise.all(
          clients.map((db, index) =>
            db.$transaction(async (tx: any) => {
              runs += 1;
              await tx.item.updateMany({
                where: { id: "a" },
                data: { n: index + 1 },
              });
              if (++entered === clients.length) release();
              await barrier;
              return "committed";
            })
          )
        );
        expect(results).toEqual(new Array(8).fill("committed"));
        expect(runs).toBe(8);
      } finally {
        await Promise.all(clients.map((db) => db.$disconnect()));
      }
    });
  });

  describe("what differs by design", () => {
    it("optimism: of callbacks that meet, the rest refuse rather than wait, and none half commits", async () => {
      const item = s.model({ id: s.string().id(), n: s.int() });
      const audit = s.model({ id: s.string().id() });
      const clients: any[] = [
        createClient({
          schema: { item, audit },
          driver: createSurrealTestDriver(),
        }),
      ];
      try {
        await syncLiveSchema(clients[0]);
        for (let index = 1; index < 8; index++)
          clients.push(
            createClient({
              schema: { item, audit },
              driver: createSurrealTestDriver(),
            })
          );
        await clients[0].item.create({ data: { id: "a", n: 0 } });
        await Promise.all(clients.map((db) => db.item.findMany()));
        let entered = 0;
        let release = () => undefined as void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const results = await Promise.all(
          clients.map(async (db, index) => {
            try {
              await db.$transaction(async (tx: any) => {
                if (++entered === clients.length) release();
                await barrier;
                await tx.audit.create({ data: { id: String(index) } });
                await tx.item.update({
                  where: { id: "a" },
                  data: { n: { increment: 1 } },
                });
              });
              return "committed";
            } catch (error) {
              return (error as { code?: string }).code;
            }
          })
        );
        const committed = results.filter(
          (result) => result === "committed"
        ).length;
        expect(committed).toBeGreaterThan(0);
        expect(
          results
            .filter((result) => result !== "committed")
            .every((result) => result === "V5001")
        ).toBe(true);
        expect(await clients[0].item.findMany()).toEqual([
          { id: "a", n: committed },
        ]);
        expect(await clients[0].audit.count()).toBe(committed);
      } finally {
        await Promise.all(clients.map((db) => db.$disconnect()));
      }
    });
    it("snapshot isolation: a delete and an insert that meet both commit, leaving an orphan", async () => {
      const family_ = family("cascade", "restrict");
      const first: any = createClient({
        schema: family_,
        driver: createSurrealTestDriver(),
      });
      const second: any = createClient({
        schema: family_,
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(first);
        await first.parent.create({ data: { id: "p", name: "p" } });
        await second.parent.findMany();
        let met = () => undefined as void;
        const both = new Promise<void>((resolve) => {
          met = resolve;
        });
        let entered = 0;
        const meet = async () => {
          if (++entered === 2) met();
          await both;
        };
        await Promise.all([
          first.$transaction(async (tx: any) => {
            await tx.parent.delete({ where: { id: "p" } });
            await meet();
          }),
          second.$transaction(async (tx: any) => {
            await tx.child.create({
              data: { id: "c", parent: { connect: { id: "p" } } },
            });
            await meet();
          }),
        ]);
        expect(await rows(first, "parent")).toEqual([]);
        expect(await rows(first, "child")).toEqual([
          { id: "c", parentId: "p" },
        ]);
      } finally {
        await Promise.all([first.$disconnect(), second.$disconnect()]);
      }
    });
    it("a JSON key named __proto__ is stored, and the SDK's answer loses it", async () => {
      const item = s.model({ id: s.string().id(), payload: s.json() });
      const db: any = createClient({
        schema: { item },
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(db);
        await db.item.create({
          data: {
            id: "a",
            payload: JSON.parse('{"__proto__":{"x":1},"safe":2}'),
          },
        });
        const [keys] = await db.$driver.client.query(
          "RETURN object::keys((SELECT VALUE payload FROM item)[0]);"
        );
        expect(keys).toContain("__proto__");
        expect(
          (await db.item.findUnique({ where: { id: "a" } })).payload
        ).toEqual({ safe: 2 });
      } finally {
        await db.$disconnect();
      }
    });
  });
});
