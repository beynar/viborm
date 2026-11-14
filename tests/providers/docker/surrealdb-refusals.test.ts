/**
 * What a refusal census found, against SQL: each scenario runs on PGlite and on
 * SurrealDB and answers the same. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import { withRows } from "@extensions/rows-runtime";
import { s } from "@schema";
import { softDelete } from "@src/soft-delete";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";
import { caught, compare, rows } from "./surrealdb-parity-fixture";

// These definitions are stated as plain objects: what reads their rows is brought here.
withRows();

const counted = () => {
  const item = s.model({ id: s.int().id(), label: s.string() });
  return { item };
};

const sharedKey = () => {
  const account = s.model({
    id: s.string().id(),
    code: s.string().unique(),
    card: s.toOne(() => card),
  });
  const card = s.model({
    accountId: s.string().id(),
    label: s.string(),
    account: s
      .toOne(() => account)
      .fields("accountId")
      .references("id"),
  });
  return { account, card };
};

const chain = () => {
  const company = s.model({
    id: s.string().id(),
    name: s.string(),
    teams: s.toMany(() => team),
  });
  const team = s.model({
    id: s.string().id(),
    companyId: s.string(),
    parentId: s.string().nullable(),
    company: s
      .toOne(() => company)
      .fields("companyId")
      .references("id"),
    parent: s
      .toOne(() => team)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => team).name("tree"),
    people: s.toMany(() => person),
  });
  const person = s.model({
    id: s.string().id(),
    teamId: s.string(),
    team: s
      .toOne(() => team)
      .fields("teamId")
      .references("id"),
    tags: s.toMany(() => tag),
  });
  const tag = s.model({
    id: s.string().id(),
    people: s.toMany(() => person),
  });
  return { company, team, person, tag };
};

const seedChain = async (db: any) => {
  await db.company.createMany({
    data: [
      { id: "c1", name: "one" },
      { id: "c2", name: "two" },
    ],
  });
  await db.team.createMany({
    data: [
      { id: "root", companyId: "c1", parentId: null },
      { id: "mid", companyId: "c1", parentId: "root" },
      { id: "leaf", companyId: "c2", parentId: "mid" },
    ],
  });
  await db.person.createMany({
    data: [
      { id: "ann", teamId: "root" },
      { id: "bob", teamId: "mid" },
      { id: "cid", teamId: "leaf" },
      { id: "dan", teamId: "leaf" },
    ],
  });
  await db.tag.create({
    data: { id: "t1", people: { connect: [{ id: "ann" }, { id: "cid" }] } },
  });
};

describe.skipIf(!surrealUrl)("SurrealDB refusals against SQL", () => {
  describe("a record's key", () => {
    it("arithmetic moves it", () =>
      compare(counted(), async (db) => {
        await db.item.create({ data: { id: 1, label: "a" } });
        const result = await caught(() =>
          db.item.update({ where: { id: 1 }, data: { id: { increment: 4 } } })
        );
        return { result, rows: await rows(db, "item") };
      }));

    it("arithmetic moves every key of a bulk write", () =>
      compare(counted(), async (db) => {
        await db.item.createMany({
          data: [
            { id: 1, label: "a" },
            { id: 2, label: "b" },
          ],
        });
        const result = await caught(() =>
          db.item.updateMany({ data: { id: { multiply: 10 } } })
        );
        return { result, rows: await rows(db, "item") };
      }));

    it("an upsert's update moves it", () =>
      compare(counted(), async (db) => {
        await db.item.create({ data: { id: 1, label: "a" } });
        const moved = await caught(() =>
          db.item.upsert({
            where: { id: 1 },
            create: { id: 1, label: "new" },
            update: { id: 7, label: "moved" },
          })
        );
        return { moved, rows: await rows(db, "item") };
      }));

    it("a nested write moves a member's key", () =>
      compare(
        (() => {
          const shelf = s.model({
            id: s.string().id(),
            books: s.toMany(() => book),
          });
          const book = s.model({
            id: s.int().id(),
            shelfId: s.string(),
            shelf: s
              .toOne(() => shelf)
              .fields("shelfId")
              .references("id"),
          });
          return { shelf, book };
        })(),
        async (db) => {
          await db.shelf.create({
            data: { id: "s", books: { create: [{ id: 1 }, { id: 2 }] } },
          });
          const one = await caught(() =>
            db.shelf.update({
              where: { id: "s" },
              data: {
                books: { update: [{ where: { id: 1 }, data: { id: 5 } }] },
              },
            })
          );
          const many = await caught(() =>
            db.shelf.update({
              where: { id: "s" },
              data: {
                books: {
                  updateMany: [{ where: { id: 2 }, data: { id: 6 } }],
                },
              },
            })
          );
          return { one, many, rows: await rows(db, "book") };
        }
      ));

    it("a connect moves a shared key", () =>
      compare(sharedKey(), async (db) => {
        await db.account.createMany({
          data: [
            { id: "a1", code: "x" },
            { id: "a2", code: "y" },
          ],
        });
        await db.card.create({ data: { accountId: "a1", label: "c" } });
        const result = await caught(() =>
          db.card.update({
            where: { accountId: "a1" },
            data: { account: { connect: { id: "a2" } } },
            select: { accountId: true },
          })
        );
        return { result, rows: await db.card.findMany() };
      }));

    it("a nested connect moves a key another record's key follows", () =>
      compare(
        (() => {
          const provider = s.model({
            id: s.string().id(),
            email: s.string().unique(),
            account: s.toOne(() => account),
          });
          const account = s.model({
            id: s.string().id(),
            providerId: s.string().unique(),
            provider: s
              .toOne(() => provider)
              .fields("providerId")
              .references("id"),
            badge: s.toOne(() => badge),
          });
          const badge = s.model({
            accountProviderId: s.string().id(),
            label: s.string(),
            account: s
              .toOne(() => account)
              .fields("accountProviderId")
              .references("providerId")
              .onUpdate("cascade"),
          });
          return { provider, account, badge };
        })(),
        async (db) => {
          await db.provider.createMany({
            data: [
              { id: "p1", email: "one" },
              { id: "p2", email: "two" },
            ],
          });
          await db.account.create({ data: { id: "a", providerId: "p1" } });
          await db.badge.create({
            data: { accountProviderId: "p1", label: "b" },
          });
          const moved = await caught(() =>
            db.account.update({
              where: { id: "a" },
              data: { providerId: "p2" },
            })
          );
          return { moved, badges: await db.badge.findMany() };
        }
      ));

    it("a connect by another unique moves a shared key", () =>
      compare(sharedKey(), async (db) => {
        await db.account.createMany({
          data: [
            { id: "a1", code: "x" },
            { id: "a2", code: "y" },
          ],
        });
        await db.card.create({ data: { accountId: "a1", label: "c" } });
        const result = await caught(() =>
          db.card.update({
            where: { accountId: "a1" },
            data: { account: { connect: { code: "y" } } },
            select: { accountId: true },
          })
        );
        return { result, rows: await db.card.findMany() };
      }));
  });

  describe("a generated column beside a record's id", () => {
    it("is written and reads back", () =>
      compare(
        {
          ticket: s.model({
            id: s.string().id(),
            serial: s.int().unique().increment(),
            label: s.string(),
          }),
        },
        async (db) => {
          const first = await db.ticket.create({
            data: { id: "a", label: "one" },
          });
          const second = await db.ticket.create({
            data: { id: "b", label: "two" },
          });
          await db.ticket.createMany({ data: [{ id: "c", label: "three" }] });
          return {
            first,
            second,
            rows: await db.ticket.findMany({ orderBy: { id: "asc" } }),
          };
        }
      ));

    it("a compound key has one generated member", () =>
      compare(
        {
          ticket: s
            .model({
              a: s.int().increment(),
              b: s.string(),
              label: s.string(),
            })
            .id(["a", "b"]),
        },
        async (db) => {
          const first = await db.ticket.create({
            data: { b: "x", label: "one" },
          });
          const second = await db.ticket.create({
            data: { b: "x", label: "two" },
          });
          return {
            first,
            second,
            rows: await db.ticket.findMany({ orderBy: { a: "asc" } }),
          };
        }
      ));
  });

  describe("filters and orders through a to-one link", () => {
    it("a to-many filter through a to-one link", () =>
      compare(chain(), async (db) => {
        await seedChain(db);
        return await db.person.findMany({
          where: {
            team: { is: { people: { some: { id: "dan" } } } },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });
      }));

    it("a recursive filter through a to-one link", () =>
      compare(chain(), async (db) => {
        await seedChain(db);
        return await db.person.findMany({
          where: {
            team: { is: { parent: { recurse: true, some: { id: "root" } } } },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });
      }));

    it("a junction filter through two to-one links", () =>
      compare(chain(), async (db) => {
        await seedChain(db);
        return await db.team.findMany({
          where: {
            company: {
              is: {
                teams: {
                  some: { people: { some: { tags: { some: { id: "t1" } } } } },
                },
              },
            },
          },
          orderBy: { id: "asc" },
          select: { id: true },
        });
      }));

    it("orders by a to-one link two levels away", () =>
      compare(chain(), async (db) => {
        await seedChain(db);
        return await db.person.findMany({
          orderBy: [{ team: { company: { name: "desc" } } }, { id: "asc" }],
          select: { id: true },
        });
      }));
  });

  describe("what an extension asks of a write", () => {
    const folders = () => {
      const folder = s
        .model({
          org: s.string(),
          code: s.string(),
          parentOrg: s.string().nullable(),
          parentCode: s.string().nullable(),
          parent: s
            .toOne(() => folder)
            .fields("parentOrg", "parentCode")
            .references("org", "code")
            .name("tree"),
          children: s.toMany(() => folder).name("tree"),
        })
        .id(["org", "code"]);
      return { folder };
    };

    it("a compound self relation stays acyclic", () =>
      compare(folders(), async (db) => {
        await db.folder.createMany({
          data: [
            { org: "o", code: "a", parentOrg: null, parentCode: null },
            { org: "o", code: "b", parentOrg: "o", parentCode: "a" },
            { org: "o", code: "c", parentOrg: "o", parentCode: "b" },
          ],
        });
        const governed = db.$extends({
          name: "tree",
          rows: {
            default: "on",
            models: { folder: { on: {} } },
            verbs: {
              folder: {
                predicates: { all: { org: "o" } },
                read: "all",
                update: "all",
                acyclic: ["parent"],
              },
            },
          },
        });
        const cycle = await caught(() =>
          governed.folder.update({
            where: { org_code: { org: "o", code: "a" } },
            data: { parentOrg: "o", parentCode: "c" },
          })
        );
        const allowed = await caught(() =>
          governed.folder.update({
            where: { org_code: { org: "o", code: "c" } },
            data: { parentOrg: "o", parentCode: "a" },
          })
        );
        return { cycle, allowed };
      }));

    it("a soft delete of several rows, some held back", () =>
      compare(
        (() => {
          const owner = s.model({
            id: s.string().id(),
            name: s.string(),
            deletedAt: s.dateTime().nullable(),
            pets: s.toMany(() => pet),
          });
          const pet = s.model({
            id: s.string().id(),
            ownerId: s.string(),
            owner: s
              .toOne(() => owner)
              .fields("ownerId")
              .references("id")
              .onDelete("restrict"),
          });
          return { owner, pet };
        })(),
        async (db) => {
          await db.owner.createMany({
            data: [
              { id: "a", name: "x" },
              { id: "b", name: "x" },
            ],
          });
          const governed: any = softDelete({
            models: { owner: { deletedAt: "deletedAt" } },
          } as never)(db);
          const free = await caught(() =>
            governed.owner.deleteMany({ where: { id: "a" } })
          );
          await db.pet.create({ data: { id: "p", ownerId: "b" } });
          const held = await caught(() =>
            governed.owner.deleteMany({ where: { name: "x" } })
          );
          return {
            free,
            held,
            rows: (await db.owner.findMany({ orderBy: { id: "asc" } })).map(
              (row: { id: string; deletedAt: unknown }) => [
                row.id,
                row.deletedAt !== null,
              ]
            ),
          };
        }
      ));
  });

  describe("what a transaction may ask for", () => {
    const item = () => ({ item: s.model({ id: s.string().id() }) });

    it("a callback past its timeout goes back", () =>
      compare(item(), async (db) => {
        const late = await caught(() =>
          db.$transaction(
            async (tx: any) => {
              await tx.item.create({ data: { id: "a" } });
              await new Promise((resolve) => setTimeout(resolve, 200));
            },
            { timeout: 20 }
          )
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { late, rows: await rows(db, "item") };
      }));

    it("any level but serializable reads a snapshot", async () => {
      const db: any = createClient({
        schema: item(),
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(db);
        for (const isolationLevel of [
          "ReadUncommitted",
          "ReadCommitted",
          "RepeatableRead",
        ])
          await db.$transaction(() => Promise.resolve(), { isolationLevel });
        await expect(
          db.$transaction(() => Promise.resolve(), {
            isolationLevel: "Serializable",
          })
        ).rejects.toThrow("reads a snapshot");
      } finally {
        await db.$disconnect();
      }
    });

    it("maxWait bounds the wait for a transaction a connection can open", async () => {
      const db: any = createClient({
        schema: item(),
        driver: createSurrealTestDriver(),
      });
      try {
        await syncLiveSchema(db);
        let release = () => undefined as void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const open = Array.from({ length: 64 }, () =>
          db.$transaction(() => held)
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await expect(
          db.$transaction(() => Promise.resolve(), { maxWait: 20 })
        ).rejects.toThrow("maxWait");
        release();
        await Promise.all(open);
        await db.$transaction(() => Promise.resolve());
      } finally {
        await db.$disconnect();
      }
    });
  });

  describe("what a relation's rows are asked", () => {
    it("clearing a required to-many is refused alike", () =>
      compare(
        (() => {
          const parent = s.model({
            id: s.string().id(),
            kids: s.toMany(() => kid),
          });
          const kid = s.model({
            id: s.string().id(),
            parentId: s.string(),
            parent: s
              .toOne(() => parent)
              .fields("parentId")
              .references("id"),
          });
          return { parent, kid };
        })(),
        async (db) => {
          await db.parent.create({
            data: { id: "p", kids: { create: { id: "k" } } },
          });
          const cleared = await caught(() =>
            db.parent.update({
              where: { id: "p" },
              data: { kids: { set: [] } },
            })
          );
          return { cleared, rows: await rows(db, "kid") };
        }
      ));
  });

  describe("relations with no field of their own", () => {
    it("a many-to-many over a unique field, not the key", () =>
      compare(
        (() => {
          const reader = s.model({
            id: s.string().id(),
            email: s.string().unique(),
            books: s.toMany(() => book),
          });
          const link = s
            .model({
              email: s.string(),
              isbn: s.string(),
              reader: s
                .toOne(() => reader)
                .fields("email")
                .references("email"),
              book: s
                .toOne(() => book)
                .fields("isbn")
                .references("isbn"),
            })
            .id(["email", "isbn"]);
          const book = s.model({
            id: s.string().id(),
            isbn: s.string().unique(),
            readers: s
              .toMany(() => reader)
              .through(() => link)
              .source("book")
              .target("reader"),
          });
          return { reader, book, link };
        })(),
        async (db) => {
          await db.reader.create({ data: { id: "r", email: "e" } });
          await db.book.create({
            data: {
              id: "b",
              isbn: "i",
              readers: { connect: { id: "r" } },
            },
          });
          const read = await db.book.findUnique({
            where: { id: "b" },
            include: { readers: true },
          });
          const filtered = await db.reader.findMany({
            where: { books: { some: { isbn: "i" } } },
            select: { id: true },
          });
          await db.book.update({
            where: { id: "b" },
            data: { readers: { set: [] } },
          });
          return { read, filtered, links: await db.link.count() };
        }
      ));
  });
});
