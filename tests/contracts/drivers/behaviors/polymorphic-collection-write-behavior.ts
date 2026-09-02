/**
 * Direct polymorphic COLLECTION writes, against a real database.
 *
 * Sibling of `polymorphic-collection-read-behavior.ts`, which owns the read half
 * and deliberately keeps SEEDING RAW — raw seeding is the stronger read-side
 * control precisely because it cannot be co-broken by a write regression. This
 * file is where the writes are exercised, and it ends with ONE crossover case so
 * the two halves are known to agree without either one weakening the other.
 *
 * Everything asserted here is DATABASE STATE — the member tables and the target
 * rows — never a statement count. What a provider actually stores is the only
 * thing a provider contract can be about.
 *
 * The fixture is modelled on `polymorphic-member-junction-behavior.ts`:
 *
 *  - a COMPOUND owner key `(tenantId, code)`, so no single-column shortcut can
 *    pass for a member tuple;
 *  - a COMPOUND target key `(region, isbn)` on the variant whose inverse is
 *    SINGULAR, which is what puts a real UNIQUE over the complete target side —
 *    the constraint the slot-replacement protocol arbitrates on, and the one
 *    piece of this design that only a real database can prove;
 *  - a GENERATED target key on the variant whose inverse is PLURAL;
 *  - a variant with NO inverse at all, which is what `set` must still clear;
 *  - explicit `.through()` mappings, so the mapped-table path is not a special
 *    case nobody runs.
 */

import { s } from "@schema";
import { sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
import {
  type BehaviorDatabaseSource,
  useBehaviorDatabase,
} from "@tests/fixtures/drivers/pglite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const collectionWriteSchema = (() => {
  const book = s
    .model({
      region: s.string(),
      isbn: s.string(),
      title: s.string(),
      // SINGULAR inverse — at most one shelf holds a given book.
      shelf: s.toOne(() => shelf),
    })
    .id(["region", "isbn"])
    .map("cwb_books");

  const clip = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      // PLURAL inverse — an ordinary membership.
      shelves: s.toMany(() => shelf),
    })
    .map("cwb_clips");

  const note = s
    .model({ id: s.string().id(), body: s.string() })
    .map("cwb_notes");

  const shelf = s
    .model({
      tenantId: s.string(),
      code: s.string(),
      label: s.string(),
      items: s
        .toMany(
          { book: () => book, clip: () => clip, note: () => note },
          {
            values: {
              book: "cwb.book.v1",
              clip: "cwb.clip.v1",
              note: "cwb.note.v1",
            },
          }
        )
        .through({
          book: { table: "cwb_shelf_books", source: "holder", target: "entry" },
          clip: { table: "cwb_shelf_clips", source: "holder", target: "entry" },
          note: { table: "cwb_shelf_notes", source: "holder", target: "entry" },
        }),
    })
    .id(["tenantId", "code"])
    .map("cwb_shelves");

  return { book, clip, note, shelf };
})();

export type PolymorphicCollectionWriteBehaviorOptions = {
  readonly name: string;
} & BehaviorDatabaseSource;

export function runPolymorphicCollectionWriteBehavior(
  options: PolymorphicCollectionWriteBehaviorOptions
): void {
  describe(`${options.name} polymorphic collection writes`, () => {
    const openDatabase = useBehaviorDatabase(collectionWriteSchema, options);
    let database: Awaited<ReturnType<typeof openDatabase>> | undefined;

    beforeEach(async () => {
      database = await openDatabase();
    });

    afterEach(async () => {
      await database?.dispose();
      database = undefined;
    });

    function requireDatabase() {
      if (!database) throw new Error("Behavior database is not initialized");
      return database;
    }

    /**
     * Every membership in one member table, rendered OWNER-FIRST as one tuple.
     *
     * The owner/target split comes from the `.through()` tokens this fixture
     * chose (`holder` / `entry`) rather than from column ORDER, which is the
     * topology owner's canonical `sourceIsFirst` decision and legitimately puts
     * the target side first for some tables. Pinning that order here would make
     * every assertion a second, weaker pin on it.
     */
    async function members(table: string): Promise<string[]> {
      const { client } = requireDatabase();
      // The identifier is rendered by THIS PROVIDER'S adapter, never by a
      // literal `"` — MySQL reads a double-quoted name as a string literal and
      // rejects the statement outright (errno 1064). `identifiers.table` is the
      // renderer for a persistent table: it quotes for the dialect AND applies
      // the adapter's namespace, which a suite sharing one database instance
      // needs, because its tables live in a private schema rather than in
      // `public`.
      const tableRef = client.$driver.adapter.identifiers.table;
      const rows = await client.$queryRaw<Record<string, unknown>>(
        sql`SELECT * FROM ${tableRef(table)}`
      );
      return rows
        .map((row) => {
          const names = Object.keys(row);
          const ordered = [
            ...names.filter((name) => name.startsWith("holder")),
            ...names.filter((name) => name.startsWith("entry")),
          ];
          return ordered.map((name) => String(row[name])).join("/");
        })
        .sort();
    }

    const bookMembers = () => members("cwb_shelf_books");
    const clipMembers = () => members("cwb_shelf_clips");
    const noteMembers = () => members("cwb_shelf_notes");

    /** Two shelves and one target of each variant. */
    async function seed() {
      const { client } = requireDatabase();
      await client.shelf.create({
        data: { tenantId: "t1", code: "left", label: "Left" },
      });
      await client.shelf.create({
        data: { tenantId: "t1", code: "right", label: "Right" },
      });
      await client.book.create({
        data: { region: "eu", isbn: "111", title: "Book one" },
      });
      await client.clip.create({ data: { label: "Clip one" } });
      await client.note.create({ data: { id: "n1", body: "Note one" } });
    }

    const shelfWhere = (code: string) => ({
      tenantId_code: { tenantId: "t1", code },
    });

    /** The generated key of the seeded clip — read back, never assumed. */
    async function seededClipId(): Promise<number> {
      const { client } = requireDatabase();
      const clips = await client.clip.findMany({});
      const id = clips[0]?.id;
      if (id === undefined) throw new Error("expected a seeded clip");
      return id;
    }

    test("a fresh owner writes memberships across several variants at once", async () => {
      const { client } = requireDatabase();
      await client.book.create({
        data: { region: "eu", isbn: "999", title: "Existing" },
      });

      await client.shelf.create({
        data: {
          tenantId: "t1",
          code: "mixed",
          label: "Mixed",
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "999" } },
              },
            ],
            create: [
              { type: "note", data: { id: "fresh", body: "fresh note" } },
              { type: "clip", data: { label: "fresh clip" } },
            ],
          },
        },
      });

      // The owner key is COMPOUND and it is the key this create just wrote, so
      // every member row proves the whole tuple travelled.
      expect(await bookMembers()).toEqual(["t1/mixed/eu/999"]);
      expect(await noteMembers()).toEqual(["t1/mixed/fresh"]);
      // The clip's key is DB-GENERATED, so its membership proves the produced
      // identity reached the member row on this provider.
      expect(await clipMembers()).toHaveLength(1);
    });

    test("connect is idempotent for the same owner and target", async () => {
      const { client } = requireDatabase();
      await seed();
      const clipId = await seededClipId();

      for (const _ of [0, 1]) {
        await client.shelf.update({
          where: shelfWhere("left"),
          data: {
            items: { connect: [{ type: "clip", where: { id: clipId } }] },
          },
        });
      }
      expect(await clipMembers()).toEqual([`t1/left/${clipId}`]);
    });

    test("a plural member admits SEVERAL owners for one target", async () => {
      const { client } = requireDatabase();
      await seed();
      const clipId = await seededClipId();

      for (const code of ["left", "right"]) {
        await client.shelf.update({
          where: shelfWhere(code),
          data: {
            items: { connect: [{ type: "clip", where: { id: clipId } }] },
          },
        });
      }
      expect(await clipMembers()).toEqual([
        `t1/left/${clipId}`,
        `t1/right/${clipId}`,
      ]);
    });

    test("a SINGULAR member replaces its slot instead of doubling it", async () => {
      const { client } = requireDatabase();
      await seed();
      const connectBook = (code: string) =>
        client.shelf.update({
          where: shelfWhere(code),
          data: {
            items: {
              connect: [
                {
                  type: "book",
                  where: { region_isbn: { region: "eu", isbn: "111" } },
                },
              ],
            },
          },
        });

      await connectBook("left");
      expect(await bookMembers()).toEqual(["t1/left/eu/111"]);
      // EXACT RECONNECT — idempotent, and the row must still be there.
      await connectBook("left");
      expect(await bookMembers()).toEqual(["t1/left/eu/111"]);
      // A DIFFERENT owner is not a duplicate: the slot is vacated and taken. On
      // a provider whose junction insert skipped duplicates UNTARGETED this would
      // silently report success having changed nothing, which is the exact
      // regression this row exists to catch.
      await connectBook("right");
      expect(await bookMembers()).toEqual(["t1/right/eu/111"]);
    });

    test("connectOrCreate finds, then creates, without doubling either", async () => {
      const { client } = requireDatabase();
      await seed();

      // FOUND ARM on the SINGULAR member — the arm that routes through the slot
      // transfer rather than a bare insert, and the one arm a provider can get
      // wrong quietly: its `create` payload names a title nothing may write, so
      // a probe that fell through to the missing arm relabels the row instead of
      // failing, and only reading the target back catches it.
      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: {
            connectOrCreate: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
                create: {
                  region: "eu",
                  isbn: "111",
                  title: "must never be written",
                },
              },
            ],
          },
        },
      });
      expect(await bookMembers()).toEqual(["t1/left/eu/111"]);
      const found = await client.book.findMany({});
      expect(found.map((book) => book.title).sort()).toEqual(["Book one"]);

      // MISSING ARM on the same compound-keyed variant: one new target, one new
      // member tuple carrying the complete compound key.
      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: {
            connectOrCreate: [
              {
                type: "book",
                where: { region_isbn: { region: "us", isbn: "333" } },
                create: { region: "us", isbn: "333", title: "Book three" },
              },
            ],
          },
        },
      });
      expect(await bookMembers()).toEqual(["t1/left/eu/111", "t1/left/us/333"]);
      const both = await client.book.findMany({});
      expect(both.map((book) => book.title).sort()).toEqual([
        "Book one",
        "Book three",
      ]);
    });

    test("`set` clears every configured variant once, then refills", async () => {
      const { client } = requireDatabase();
      await seed();
      const clipId = await seededClipId();

      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: {
            connect: [
              { type: "clip", where: { id: clipId } },
              { type: "note", where: { id: "n1" } },
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
            ],
          },
        },
      });

      await client.shelf.update({
        where: shelfWhere("left"),
        data: { items: { set: [{ type: "note", where: { id: "n1" } }] } },
      });

      expect(await noteMembers()).toEqual(["t1/left/n1"]);
      // The two UNMENTIONED variants are emptied too.
      expect(await clipMembers()).toEqual([]);
      expect(await bookMembers()).toEqual([]);
      // And nothing was deleted: `set` is a membership verb.
      expect(await client.note.findMany({})).toHaveLength(1);
      expect(await client.book.findMany({})).toHaveLength(1);
    });

    test("`set` of an already-owned SINGULAR target keeps the row", async () => {
      const { client } = requireDatabase();
      await seed();
      const bookItem = {
        type: "book" as const,
        where: { region_isbn: { region: "eu", isbn: "111" } },
      };
      await client.shelf.update({
        where: shelfWhere("left"),
        data: { items: { connect: [bookItem] } },
      });
      // The relation-wide clear removes it FIRST, so an idempotent-reconnect
      // shortcut here would lose the row this call is asking to keep.
      await client.shelf.update({
        where: shelfWhere("left"),
        data: { items: { set: [bookItem] } },
      });
      expect(await bookMembers()).toEqual(["t1/left/eu/111"]);
    });

    test("`set: []` empties every variant and deletes no target", async () => {
      const { client } = requireDatabase();
      await seed();
      await client.shelf.update({
        where: shelfWhere("left"),
        data: { items: { connect: [{ type: "note", where: { id: "n1" } }] } },
      });
      await client.shelf.update({
        where: shelfWhere("left"),
        data: { items: { set: [] } },
      });
      expect(await noteMembers()).toEqual([]);
      expect(await client.note.findMany({})).toHaveLength(1);
    });

    test("disconnect removes this owner's membership and nothing else", async () => {
      const { client } = requireDatabase();
      await seed();
      for (const code of ["left", "right"]) {
        await client.shelf.update({
          where: shelfWhere(code),
          data: { items: { connect: [{ type: "note", where: { id: "n1" } }] } },
        });
      }
      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: { disconnect: [{ type: "note", where: { id: "n1" } }] },
        },
      });
      expect(await noteMembers()).toEqual(["t1/right/n1"]);
      expect(await client.note.findMany({})).toHaveLength(1);
    });

    test("update and updateMany reach only the connected targets", async () => {
      const { client } = requireDatabase();
      await seed();
      await client.book.create({
        data: { region: "eu", isbn: "222", title: "Decoy" },
      });
      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
            ],
          },
        },
      });

      // An UNOWNED decoy of the same variant is unreachable.
      await expect(
        client.shelf.update({
          where: shelfWhere("left"),
          data: {
            items: {
              update: [
                {
                  type: "book",
                  where: { region_isbn: { region: "eu", isbn: "222" } },
                  data: { title: "hijacked" },
                },
              ],
            },
          },
        })
      ).rejects.toThrow();

      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: { updateMany: [{ type: "book", data: { title: "Scoped" } }] },
        },
      });
      const titles = (await client.book.findMany({}))
        .map((row) => row.title)
        .sort();
      expect(titles).toEqual(["Decoy", "Scoped"]);
    });

    test("upsert creates then updates, scoped to this owner's membership", async () => {
      const { client } = requireDatabase();
      await seed();
      const upsert = (body: string) =>
        client.shelf.update({
          where: shelfWhere("left"),
          data: {
            items: {
              upsert: [
                {
                  type: "note",
                  where: { id: "u1" },
                  create: { id: "u1", body },
                  update: { body },
                },
              ],
            },
          },
        });

      await upsert("created");
      expect(await noteMembers()).toEqual(["t1/left/u1"]);
      await upsert("updated");
      expect(await noteMembers()).toEqual(["t1/left/u1"]);
      const rows = await client.note.findMany({
        where: { id: { equals: "u1" } },
      });
      expect(rows[0]?.body).toBe("updated");
    });

    test("createMany writes one bulk group per variant", async () => {
      const { client } = requireDatabase();
      await seed();
      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: {
            createMany: [
              {
                type: "note",
                data: [
                  { id: "b1", body: "one" },
                  { id: "b2", body: "two" },
                ],
              },
              { type: "clip", data: [{ label: "bulk clip" }] },
            ],
          },
        },
      });
      expect(await noteMembers()).toEqual(["t1/left/b1", "t1/left/b2"]);
      expect(await clipMembers()).toHaveLength(1);
    });

    test("duplicate singular createMany targets transfer once", async () => {
      const { client } = requireDatabase();
      await seed();

      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
            ],
          },
        },
      });

      await client.shelf.update({
        where: shelfWhere("right"),
        data: {
          items: {
            createMany: [
              {
                type: "book",
                data: [
                  { region: "eu", isbn: "111", title: "Book one" },
                  { region: "eu", isbn: "111", title: "Book one" },
                ],
                skipDuplicates: true,
              },
            ],
          },
        },
      });

      expect(await bookMembers()).toEqual(["t1/right/eu/111"]);
    });

    test("delete and deleteMany are membership-scoped and cascade the membership", async () => {
      const { client } = requireDatabase();
      await seed();
      await client.shelf.update({
        where: shelfWhere("left"),
        data: { items: { connect: [{ type: "note", where: { id: "n1" } }] } },
      });
      await client.shelf.update({
        where: shelfWhere("left"),
        data: { items: { delete: [{ type: "note", where: { id: "n1" } }] } },
      });
      // The member table's dual FKs carry `onDelete: cascade` on both sides, so
      // deleting the TARGET removes the membership — the same semantics an
      // ordinary junction `delete` has, stated as a provider fact.
      expect(await client.note.findMany({})).toEqual([]);
      expect(await noteMembers()).toEqual([]);
    });

    /**
     * THE SINGULAR INVERSE (plan §9.4), written from the VARIANT end.
     *
     * `book.shelf` is a fields-less optional `manyToOne` bound to a member whose
     * `inverseCardinality` is `"one"`, so the member table carries a UNIQUE over
     * the complete BOOK side — the one piece of this design only a real database
     * can prove. Every row asserts BOTH views of the same member table: the raw
     * membership tuple and the owner's DIRECT collection read.
     */
    const directItems = async (code: string) => {
      const { client } = requireDatabase();
      const shelf = await client.shelf.findUnique({
        where: shelfWhere(code),
        include: { items: true },
      });
      return (shelf?.items ?? [])
        .map((item) => {
          if (item.type === "book")
            return `book:${item.data.region}/${item.data.isbn}`;
          if (item.type === "clip") return `clip:${item.data.id}`;
          return `note:${item.data.id}`;
        })
        .sort();
    };

    const bookWhere = { region_isbn: { region: "eu", isbn: "111" } };

    test("a singular inverse connect TRANSFERS the slot rather than inserting beside it", async () => {
      const { client } = requireDatabase();
      await seed();
      await client.book.update({
        where: bookWhere,
        data: { shelf: { connect: shelfWhere("left") } },
      });
      expect(await bookMembers()).toEqual(["t1/left/eu/111"]);
      expect(await directItems("left")).toEqual(["book:eu/111"]);

      // The target-side UNIQUE is what makes this a REPLACEMENT: a bare insert
      // would violate it, and an untargeted duplicate skip would silently
      // change nothing.
      await client.book.update({
        where: bookWhere,
        data: { shelf: { connect: shelfWhere("right") } },
      });
      expect(await bookMembers()).toEqual(["t1/right/eu/111"]);
      expect(await directItems("left")).toEqual([]);
      expect(await directItems("right")).toEqual(["book:eu/111"]);
    });

    test("a singular inverse disconnect deletes THE junction row, and delete deletes the OWNER", async () => {
      const { client } = requireDatabase();
      await seed();
      await client.book.update({
        where: bookWhere,
        data: { shelf: { connect: shelfWhere("left") } },
      });

      await client.book.update({
        where: bookWhere,
        data: { shelf: { disconnect: true } },
      });
      expect(await bookMembers()).toEqual([]);
      expect(await directItems("left")).toEqual([]);
      // Neither row died — `disconnect` removes membership only.
      expect(await client.book.findMany({})).toHaveLength(1);
      expect(await client.shelf.findMany({})).toHaveLength(2);

      await client.book.update({
        where: bookWhere,
        data: { shelf: { connect: shelfWhere("left") } },
      });
      await client.shelf.update({
        where: shelfWhere("left"),
        data: { items: { connect: [{ type: "note", where: { id: "n1" } }] } },
      });
      await client.book.update({
        where: bookWhere,
        data: { shelf: { delete: true } },
      });
      // The OWNER went, the variant target stayed, and the owner's other
      // memberships went with it by the member tables' own source-side cascade.
      const shelves = await client.shelf.findMany({ select: { code: true } });
      expect(shelves.map((row) => row.code)).toEqual(["right"]);
      expect(await client.book.findMany({})).toHaveLength(1);
      expect(await bookMembers()).toEqual([]);
      expect(await noteMembers()).toEqual([]);
      expect(await client.note.findMany({})).toHaveLength(1);
    });

    test("a singular inverse composes vacate, supply and a modify of the SUPPLIED owner", async () => {
      const { client } = requireDatabase();
      await seed();
      await client.book.update({
        where: bookWhere,
        data: { shelf: { connect: shelfWhere("left") } },
      });

      // `RELATION_MUTATION_KEYS` lists `update` before `connect`; the lowering
      // reads `(vacate, supplier, modify)` instead, so the modify lands on the
      // INCOMING owner.
      await client.book.update({
        where: bookWhere,
        data: {
          shelf: {
            disconnect: true,
            connect: shelfWhere("right"),
            update: { label: "Supplied" },
          },
        },
      });
      expect(await bookMembers()).toEqual(["t1/right/eu/111"]);
      const shelves = await client.shelf.findMany({
        select: { code: true, label: true },
      });
      expect(shelves.map((row) => `${row.code}:${row.label}`).sort()).toEqual([
        "left:Left",
        "right:Supplied",
      ]);
      expect(await directItems("right")).toEqual(["book:eu/111"]);
    });

    test("a singular inverse upsert takes both arms through the membership", async () => {
      const { client } = requireDatabase();
      await seed();
      await client.book.update({
        where: bookWhere,
        data: {
          shelf: {
            upsert: {
              create: { tenantId: "t1", code: "made", label: "Made" },
              update: { label: "unused" },
            },
          },
        },
      });
      expect(await bookMembers()).toEqual(["t1/made/eu/111"]);
      expect(await directItems("made")).toEqual(["book:eu/111"]);

      await client.book.update({
        where: bookWhere,
        data: {
          shelf: {
            upsert: {
              create: { tenantId: "t1", code: "other", label: "Other" },
              update: { label: "Kept" },
            },
          },
        },
      });
      const made = await client.shelf.findUnique({ where: shelfWhere("made") });
      expect(made?.label).toBe("Kept");
      expect(await client.shelf.findMany({})).toHaveLength(3);
      expect(await bookMembers()).toEqual(["t1/made/eu/111"]);
    });

    test("WRITE-THEN-READ crossover: the read half sees what the write half wrote", async () => {
      // The read contract seeds RAW on purpose, so nothing there can be
      // co-broken by a write regression. This is the one place the two halves
      // are checked to AGREE, which is a different claim from either of them.
      const { client } = requireDatabase();
      await seed();
      await client.shelf.update({
        where: shelfWhere("left"),
        data: {
          items: {
            connect: [
              { type: "note", where: { id: "n1" } },
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
            ],
          },
        },
      });

      const shelves = await client.shelf.findMany({
        where: { tenantId: { equals: "t1" }, code: { equals: "left" } },
        include: { items: true },
      });
      const items = shelves[0]?.items ?? [];
      expect(items.map((item) => item.type).sort()).toEqual(["book", "note"]);
      // …and the count filter agrees with the membership rows.
      const counted = await client.shelf.findMany({
        where: { items: { some: { type: "book" } } },
        select: { code: true },
      });
      expect(counted.map((row) => row.code)).toEqual(["left"]);
    });
  });
}

export const polymorphicCollectionWriteContract = defineContract({
  id: "drivers.polymorphic-collection-write",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "ddl"],
  register: runPolymorphicCollectionWriteBehavior,
});
