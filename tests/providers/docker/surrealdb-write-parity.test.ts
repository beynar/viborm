/**
 * The same public writes on SurrealDB and on PGlite, compared whole: what each
 * answers and what each then holds. What differs by design is stated by its own
 * test at the end. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { DbNull, JsonNull, s } from "@schema";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";
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

  describe("what differs by design", () => {
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
    it.each([
      [
        "a statement refused",
        { connect: undefined, create: [{ id: "new" }, { id: "dup" }] },
      ],
      [
        "a check of the engine's",
        { connect: { id: "missing" }, create: undefined },
      ],
    ])("no savepoints: after %s, a caught failure still ends the transaction", async (_title, children) => {
      await within(async (db) => {
        await db.child.create({ data: { id: "dup" } });
        let failure: unknown;
        const committed = db.$transaction(async (tx: any) => {
          await tx.parent.create({ data: { id: "before", name: "before" } });
          await tx.parent
            .create({ data: { id: "failed", name: "failed", children } })
            .catch((error: unknown) => {
              failure = error;
            });
          await tx.parent.create({ data: { id: "after", name: "after" } });
        });
        await expect(committed).rejects.toMatchObject({ code: "V5001" });
        expect(failure).toBeInstanceOf(Error);
        expect(await rows(db, "parent")).toEqual([]);
        expect(await rows(db, "child")).toEqual([
          { id: "dup", parentId: null },
        ]);
      });
    });
    it("no savepoints: a skipped row keeps the operation going only if it wrote nothing", async () => {
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
      const db: any = createClient({
        schema: { parent, child },
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(db);
        await db.child.create({ data: { id: "dup" } });
        const skipped = await db.child
          .createMany({
            data: [
              { id: "dup", parent: { connect: { id: "absent" } } },
              { id: "fresh" },
            ],
            skipDuplicates: true,
            select: { id: true },
          })
          .catch((error: unknown) => error);
        expect(skipped).toBeInstanceOf(Error);
        const written = db.child.createMany({
          data: [
            { id: "dup", parent: { create: { id: "new" } } },
            { id: "other" },
          ],
          skipDuplicates: true,
        });
        await expect(written).rejects.toMatchObject({ code: "V5001" });
        expect(await rows(db, "parent")).toEqual([]);
        expect((await rows(db, "child")).map((row: any) => row.id)).toEqual([
          "dup",
        ]);
      } finally {
        await db.$disconnect();
      }
    });
    it("no savepoints: a failure caught as the callback's last act refuses at commit", async () => {
      await within(async (db) => {
        const committed = db.$transaction(async (tx: any) => {
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
        });
        await expect(committed).rejects.toBeInstanceOf(Error);
        expect(await rows(db, "parent")).toEqual([]);
      });
    });
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
