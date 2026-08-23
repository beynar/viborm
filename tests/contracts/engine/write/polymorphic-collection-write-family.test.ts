import { s } from "@schema";
import {
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE D's §13.4 MATRIX — the direct polymorphic collection write family, run
 * on BOTH substrates the estate ships.
 *
 * Every row asserts DATABASE STATE, never a statement count. A statement count
 * would pin the current lowering and would go green for a plan that emitted the
 * right SQL in the wrong order; the member tables are the only witness that
 * says what actually happened.
 *
 * The two substrates are the interactive transaction (`PGliteDriver`) and the
 * native atomic batch (`BatchOnlyPGliteDriver`), because the transfer protocol
 * §1.6 enforces its premises DIFFERENTLY on each — a row lock on one, in-batch
 * assertions plus the target-side UNIQUE on the other — and a matrix that ran
 * only the transaction leg would prove nothing about the half of the design that
 * exists for the batch leg.
 *
 * FIXTURE SHAPE, and why each part is load-bearing:
 *
 *  - `shelf` has a COMPOUND owner key `(tenantId, code)`, so every member tuple
 *    is compound on the owner side and a single-column shortcut cannot pass;
 *  - `book` has a COMPOUND target key `(region, isbn)` AND a SINGULAR inverse
 *    (`book.shelf`), which is what puts a UNIQUE over the complete target side —
 *    the constraint the transfer protocol arbitrates on;
 *  - `video` has a GENERATED key and a PLURAL inverse, so the plain
 *    membership-insert path is exercised beside the transfer;
 *  - `note` declares NO inverse at all, which is the variant that proves the
 *    clear-all barrier covers configured variants a payload never mentions;
 *  - one variant uses an explicit `.through()`, so the mapped-table path is not
 *    a special case nobody runs.
 */
const collectionWriteSchema = (() => {
  const book = s
    .model({
      region: s.string(),
      isbn: s.string(),
      // A second addressable key lets the duplicate-connect witness prove that
      // coalescing follows the resolved compound target, not selector syntax.
      title: s.string().unique(),
      // SINGULAR inverse: at most one shelf may hold a given book, which is the
      // target-side UNIQUE the transfer arbitrates on.
      shelf: s.toOne(() => shelf),
    })
    .id(["region", "isbn"])
    .map("pcw_books");

  const video = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      // PLURAL inverse: an ordinary membership, many shelves per video.
      shelves: s.toMany(() => shelf),
    })
    .map("pcw_videos");

  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
    })
    .map("pcw_notes");

  const warehouse = s
    .model({
      id: s.string().id(),
      label: s.string(),
      shelves: s.toMany(() => shelf),
    })
    .map("pcw_warehouses");

  const shelf = s
    .model({
      tenantId: s.string(),
      code: s.string(),
      label: s.string(),
      warehouseId: s.string().nullable(),
      warehouse: s
        .toOne(() => warehouse)
        .fields("warehouseId")
        .references("id"),
      items: s
        .toMany(
          { book: () => book, video: () => video, note: () => note },
          {
            values: {
              book: "pcw.book.v1",
              video: "pcw.video.v1",
              note: "pcw.note.v1",
            },
          }
        )
        // EXPLICIT `.through()` for every variant — the map must be total, and
        // naming the tables here is also what lets the assertions below read the
        // member rows directly instead of trusting a generated name.
        .through({
          book: { table: "pcw_shelf_books", source: "holder", target: "entry" },
          video: {
            table: "pcw_shelf_videos",
            source: "holder",
            target: "entry",
          },
          note: { table: "pcw_shelf_notes", source: "holder", target: "entry" },
        }),
    })
    .id(["tenantId", "code"])
    .map("pcw_shelves");

  return { book, video, note, warehouse, shelf };
})();

type Family = PGliteSchemaFamily<typeof collectionWriteSchema>;

/**
 * Every membership row in one member table, rendered OWNER-FIRST as one tuple.
 *
 * The columns are read from `information_schema` rather than named here: what
 * these rows measure is WHICH memberships exist, and hard-coding the member
 * table's column spelling would turn every assertion into a second, weaker pin on
 * the naming convention Package B already owns.
 *
 * The owner/target split comes from the `.through()` tokens THIS fixture chose
 * (`holder` / `entry`), so the rendering is stable under the topology owner's
 * canonical `sourceIsFirst` column order — which legitimately puts the target
 * side first for some tables and would otherwise make these expectations a pin
 * on that ordering rather than on the memberships.
 */
async function members(family: Family, table: string): Promise<string[]> {
  const columns = await family.client.$queryRawUnsafe<{
    column_name: string;
  }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`
  );
  const names = columns.map((column) => column.column_name);
  const ordered = [
    ...names.filter((name) => name.startsWith("holder")),
    ...names.filter((name) => name.startsWith("entry")),
  ];
  if (ordered.length !== names.length) {
    throw new Error(
      `member table '${table}' has columns outside the holder/entry tokens: ${names.join(", ")}`
    );
  }
  const rows = await family.client.$queryRawUnsafe<Record<string, unknown>>(
    `SELECT ${ordered.map((name) => `"${name}"`).join(", ")} FROM "${table}"`
  );
  return rows
    .map((row) => ordered.map((name) => String(row[name])).join("/"))
    .sort();
}

const bookMembers = (family: Family) => members(family, "pcw_shelf_books");
const videoMembers = (family: Family) => members(family, "pcw_shelf_videos");
const noteMembers = (family: Family) => members(family, "pcw_shelf_notes");

async function bookTitles(family: Family): Promise<string[]> {
  const rows = await family.client.$queryRawUnsafe<{ title: string }>(
    'SELECT "title" FROM "pcw_books" ORDER BY "title"'
  );
  return rows.map((row) => row.title);
}

async function noteIds(family: Family): Promise<string[]> {
  const rows = await family.client.$queryRawUnsafe<{ id: string }>(
    'SELECT "id" FROM "pcw_notes" ORDER BY "id"'
  );
  return rows.map((row) => row.id);
}

/** The two shelves and the three targets every scenario starts from. */
async function seed(family: Family): Promise<void> {
  await family.client.warehouse.create({
    data: { id: "w1", label: "Warehouse" },
  });
  await family.client.shelf.create({
    data: {
      tenantId: "t1",
      code: "left",
      label: "Left",
      warehouseId: "w1",
    },
  });
  await family.client.shelf.create({
    data: {
      tenantId: "t1",
      code: "right",
      label: "Right",
      warehouseId: "w1",
    },
  });
  await family.client.book.create({
    data: { region: "eu", isbn: "111", title: "Book one" },
  });
  await family.client.book.create({
    data: { region: "eu", isbn: "222", title: "Book two" },
  });
  await family.client.video.create({ data: { title: "Video one" } });
  await family.client.note.create({ data: { id: "n1", body: "Note one" } });
}

for (const mode of ["transaction", "atomicBatch"] as const) {
  describe(`polymorphic collection write family (${mode})`, () => {
    const getFamily = usePGliteSchemaFamily(collectionWriteSchema, mode);

    test("mixed-variant create + connect in ONE owner create", async () => {
      const family = getFamily();
      await family.reset();
      await family.client.book.create({
        data: { region: "eu", isbn: "999", title: "Existing" },
      });

      await family.client.shelf.create({
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
              { type: "video", data: { title: "fresh video" } },
            ],
          },
        },
      });

      // THREE member tables, one owner create, one owner-row publication.
      expect(await bookMembers(family)).toEqual(["t1/mixed/eu/999"]);
      expect(await noteMembers(family)).toEqual(["t1/mixed/fresh"]);
      // The video's key is DB-generated, so the membership proves the produced
      // identity travelled from the child INSERT into the member row.
      expect(await videoMembers(family)).toHaveLength(1);
    });

    test("duplicate connect of the SAME target is idempotent", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connect: [
              { type: "video", where: { id: 1 } },
              { type: "video", where: { id: 1 } },
            ],
          },
        },
      });
      expect(await videoMembers(family)).toEqual(["t1/left/1"]);

      // …and again in a second call, which is the reconnect a caller actually
      // writes. One row, no error.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { connect: [{ type: "video", where: { id: 1 } }] } },
      });
      expect(await videoMembers(family)).toEqual(["t1/left/1"]);
    });

    test("SINGULAR member: exact reconnect is idempotent, an occupied slot TRANSFERS", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      const connectBook = (code: string, duplicate = false) =>
        family.client.shelf.update({
          where: { tenantId_code: { tenantId: "t1", code } },
          data: {
            items: {
              connect: [
                {
                  type: "book" as const,
                  where: { region_isbn: { region: "eu", isbn: "111" } },
                },
                ...(duplicate
                  ? [
                      {
                        type: "book" as const,
                        where: {
                          region_isbn: { region: "eu", isbn: "111" },
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        });

      await connectBook("left");
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);

      // EXACT RECONNECT — the same owner, the same target. Idempotent, and the
      // row must survive: `preserveExact` returns no write at all here.
      await connectBook("left");
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);

      // Two input slots name the SAME target. They must coalesce to ONE slot
      // transition: both planning captures see `left`, but only one may vacate
      // it before `right` is inserted. The transaction substrate catches the
      // old second-vacate failure through its affectedRows(1) postcondition.
      await connectBook("right", true);
      expect(await bookMembers(family)).toEqual(["t1/right/eu/111"]);

      // These selectors are syntactically different but resolve to the same
      // complete compound row key. Coalescing selector text instead of the
      // captured target tuple would run the transfer twice here.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
              { type: "book", where: { title: "Book one" } },
            ],
          },
        },
      });
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);

      // The parser preserves input order, so these two book entries become
      // separate junction leaves around the video entry. They still resolve to
      // the same book slot and must share one transfer decision across leaves.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "right" } },
        data: {
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
              { type: "video", where: { id: 1 } },
              { type: "book", where: { title: "Book one" } },
            ],
          },
        },
      });
      expect(await bookMembers(family)).toEqual(["t1/right/eu/111"]);
      expect(await videoMembers(family)).toEqual(["t1/right/1"]);

      // `set` lowers its entries through the same leaves after its clear-all
      // barrier. The first book transfer vacates `right`; the second must see
      // the collection-wide resolved target and emit no second vacate.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            set: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
              { type: "video", where: { id: 1 } },
              { type: "book", where: { title: "Book one" } },
            ],
          },
        },
      });
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);
      expect(await videoMembers(family)).toEqual(["t1/left/1", "t1/right/1"]);
    });

    test("connectOrCreate takes its FOUND arm, then its MISSING arm, per variant", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      // FOUND ARM, on the SINGULAR member. This is the row that makes the verb
      // more than a spelling of `connect`: the found arm reaches
      // `membershipAddWrites`, so on a singular member it goes through the
      // TRANSFER — and a found arm that wrote its `create` payload anyway would
      // be invisible to a membership-only assertion. The titles are therefore
      // asserted too: the `create` bag here names a title nothing may ever
      // write, so if the probe took the missing arm the row would be relabelled.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
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
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);

      // MISSING ARM, across two variants at once, on a COMPOUND target key the
      // payload spells in full: the target row is created and the member tuple
      // carries the complete compound key, not a truncated one.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connectOrCreate: [
              {
                type: "book",
                where: { region_isbn: { region: "us", isbn: "333" } },
                create: { region: "us", isbn: "333", title: "Book three" },
              },
              {
                type: "note",
                where: { id: "n2" },
                create: { id: "n2", body: "fresh note" },
              },
            ],
          },
        },
      });
      expect(await bookMembers(family)).toEqual([
        "t1/left/eu/111",
        "t1/left/us/333",
      ]);
      expect(await noteMembers(family)).toEqual(["t1/left/n2"]);
      // Exactly ONE new target per missing arm — never a second row for the
      // found one.
      expect(await bookTitles(family)).toEqual([
        "Book one",
        "Book three",
        "Book two",
      ]);
      expect(await noteIds(family)).toEqual(["n1", "n2"]);
    });

    test("connectOrCreate FOUND duplicates coalesce one singular transfer", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      // Put the singular book in `left` first. Both book entries below find
      // this same row, so their planning captures see the same occupied slot.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
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

      // Repeating one selector is the public shape the own-write ledger admits:
      // both probes capture the same occupied slot, but only one transfer may
      // vacate it. The impossible create titles prove that neither found arm
      // falls through to its MISSING branch.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "right" } },
        data: {
          items: {
            connectOrCreate: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
                create: {
                  region: "eu",
                  isbn: "111",
                  title: "must never create from compound selector",
                },
              },
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
                create: {
                  region: "eu",
                  isbn: "111",
                  title: "must never create from repeated selector",
                },
              },
            ],
          },
        },
      });

      expect(await bookMembers(family)).toEqual(["t1/right/eu/111"]);
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);
    });

    test("connectOrCreate MISSING duplicates keep the first target and membership", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      // Every probe sees the repeated selector missing, but the first create arm
      // owns both the target and its singular membership; the second may not
      // repeat either effect.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "right" } },
        data: {
          items: {
            connectOrCreate: [
              {
                type: "book",
                where: { region_isbn: { region: "us", isbn: "333" } },
                create: { region: "us", isbn: "333", title: "Book three" },
              },
              {
                type: "book",
                where: { region_isbn: { region: "us", isbn: "333" } },
                create: {
                  region: "us",
                  isbn: "333",
                  title: "must never use second create",
                },
              },
            ],
          },
        },
      });

      expect(await bookMembers(family)).toEqual(["t1/right/us/333"]);
      expect(await bookTitles(family)).toEqual([
        "Book one",
        "Book three",
        "Book two",
      ]);
    });

    test("SINGULAR member: `set` of an already-owned target clears then REINSERTS", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      const bookWhere = {
        type: "book" as const,
        where: { region_isbn: { region: "eu", isbn: "111" } },
      };
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { connect: [bookWhere] } },
      });
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);

      // The relation-wide clear removes this owner's row FIRST, so the
      // idempotent-reconnect shortcut must NOT fire — `reinsertAfterOwnerClear`
      // is the whole difference, and without it the row would be lost.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { set: [bookWhere] } },
      });
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);
    });

    test("`set` clears UNMENTIONED variants exactly once and deletes no target", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connect: [
              { type: "video", where: { id: 1 } },
              { type: "note", where: { id: "n1" } },
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
            ],
          },
        },
      });
      expect(await videoMembers(family)).toHaveLength(1);
      expect(await noteMembers(family)).toHaveLength(1);
      expect(await bookMembers(family)).toHaveLength(1);

      // `set` names ONE variant. The other two member tables are configured
      // variants this payload never mentions, and they must be emptied too.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: { set: [{ type: "video", where: { id: 1 } }] },
        },
      });
      expect(await videoMembers(family)).toEqual(["t1/left/1"]);
      expect(await noteMembers(family)).toEqual([]);
      expect(await bookMembers(family)).toEqual([]);
      // No TARGET row was harmed: `set` is a membership verb.
      expect(await noteIds(family)).toEqual(["n1"]);
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);
    });

    test("`set: []` clears every variant and deletes no target", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connect: [
              { type: "video", where: { id: 1 } },
              { type: "note", where: { id: "n1" } },
            ],
          },
        },
      });
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { set: [] } },
      });

      expect(await videoMembers(family)).toEqual([]);
      expect(await noteMembers(family)).toEqual([]);
      expect(await noteIds(family)).toEqual(["n1"]);
    });

    test("`set` on ONE owner leaves another owner's memberships alone", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "right" } },
        data: { items: { connect: [{ type: "video", where: { id: 1 } }] } },
      });
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { set: [] } },
      });
      // The clear is scoped to the owner it was spelled on, which is what makes
      // the barrier safe to hoist ahead of every leaf's writes.
      expect(await videoMembers(family)).toEqual(["t1/right/1"]);
    });

    test("disconnect removes MEMBERSHIP only, and only this owner's", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      for (const code of ["left", "right"]) {
        await family.client.shelf.update({
          where: { tenantId_code: { tenantId: "t1", code } },
          data: { items: { connect: [{ type: "video", where: { id: 1 } }] } },
        });
      }
      expect(await videoMembers(family)).toEqual(["t1/left/1", "t1/right/1"]);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { disconnect: [{ type: "video", where: { id: 1 } }] } },
      });
      expect(await videoMembers(family)).toEqual(["t1/right/1"]);
      // The target row survives — this is a membership verb, not a delete.
      const videos = await family.client.video.findMany({});
      expect(videos).toHaveLength(1);
    });

    test("update cannot reach an UNOWNED decoy of the same variant", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
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

      // `eu/222` is a book of the SAME variant that this shelf does not hold.
      await expect(
        family.client.shelf.update({
          where: { tenantId_code: { tenantId: "t1", code: "left" } },
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
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);

      // The OWNED one updates.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            update: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
                data: { title: "Renamed" },
              },
            ],
          },
        },
      });
      expect(await bookTitles(family)).toEqual(["Book two", "Renamed"]);
    });

    test("updateMany and deleteMany are membership-scoped per variant", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
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

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            updateMany: [{ type: "book", data: { title: "Scoped" } }],
          },
        },
      });
      // Only the CONNECTED book moved, even though the filter named none.
      expect(await bookTitles(family)).toEqual(["Book two", "Scoped"]);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { deleteMany: [{ type: "book", where: {} }] } },
      });
      expect(await bookTitles(family)).toEqual(["Book two"]);
      expect(await bookMembers(family)).toEqual([]);
    });

    test("upsert takes its missing arm, then its found arm, per variant", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      const upsertNote = (body: string) =>
        family.client.shelf.update({
          where: { tenantId_code: { tenantId: "t1", code: "left" } },
          data: {
            items: {
              upsert: [
                {
                  type: "note",
                  where: { id: "upserted" },
                  create: { id: "upserted", body },
                  update: { body },
                },
              ],
            },
          },
        });

      await upsertNote("created");
      expect(await noteMembers(family)).toEqual(["t1/left/upserted"]);
      const created = await family.client.note.findMany({
        where: { id: { equals: "upserted" } },
      });
      expect(created[0]?.body).toBe("created");

      await upsertNote("updated");
      expect(await noteMembers(family)).toEqual(["t1/left/upserted"]);
      const updated = await family.client.note.findMany({
        where: { id: { equals: "upserted" } },
      });
      expect(updated[0]?.body).toBe("updated");
    });

    test("createMany groups write per variant, and an empty group writes nothing", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            createMany: [
              {
                type: "note",
                data: [
                  { id: "b1", body: "bulk one" },
                  { id: "b2", body: "bulk two" },
                ],
              },
              { type: "video", data: [] },
            ],
          },
        },
      });
      expect(await noteMembers(family)).toEqual(["t1/left/b1", "t1/left/b2"]);
      expect(await videoMembers(family)).toEqual([]);
    });

    test("createMany skipDuplicates coalesces an existing singular target transition", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
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

      // `connect` is ordered before `createMany` in one collection program. Its
      // transfer moves the target from left to right; both skipped createMany
      // rows then name that same key. They retain their child INSERTs, but neither
      // may repeat the transfer captured before any writes ran.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "right" } },
        data: {
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
            ],
            createMany: [
              {
                type: "book",
                skipDuplicates: true,
                data: [
                  { region: "eu", isbn: "111", title: "Book one" },
                  { region: "eu", isbn: "111", title: "Book one" },
                ],
              },
            ],
          },
        },
      });

      expect(await bookMembers(family)).toEqual(["t1/right/eu/111"]);
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);
    });

    test("createMany skipDuplicates joins a later same-key row after an alternate conflict", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      // A1 skips because `Book one` owns the alternate unique title while A1's
      // `(eu, 999)` key is absent. B separates A1 from A2 into distinct direct
      // collection leaves. A2 then creates that same key, so its membership must
      // be the direct exact-key no-op insert, not a suppressed transfer.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "right" } },
        data: {
          items: {
            createMany: [
              {
                type: "book",
                skipDuplicates: true,
                data: [{ region: "eu", isbn: "999", title: "Book one" }],
              },
              {
                type: "video",
                data: [{ id: 2, title: "Video two" }],
              },
              {
                type: "book",
                skipDuplicates: true,
                data: [{ region: "eu", isbn: "999", title: "Book three" }],
              },
            ],
          },
        },
      });

      expect(await bookMembers(family)).toEqual(["t1/right/eu/999"]);
      expect(await videoMembers(family)).toEqual(["t1/right/2"]);
      expect(await bookTitles(family)).toEqual([
        "Book one",
        "Book three",
        "Book two",
      ]);
    });

    test("delete is membership-scoped and cascades every owner's membership", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      for (const code of ["left", "right"]) {
        await family.client.shelf.update({
          where: { tenantId_code: { tenantId: "t1", code } },
          data: { items: { connect: [{ type: "note", where: { id: "n1" } }] } },
        });
      }
      expect(await noteMembers(family)).toHaveLength(2);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { delete: [{ type: "note", where: { id: "n1" } }] } },
      });
      // DOCUMENTED CASCADE: the member table's dual FKs carry `onDelete:
      // cascade` on both sides, so deleting the TARGET removes every owner's
      // membership — the same semantics an ordinary junction `delete` has.
      expect(await noteIds(family)).toEqual([]);
      expect(await noteMembers(family)).toEqual([]);
    });
  });

  /**
   * §9.5 — THE PLURAL INVERSE, on the same physical member table, from the other
   * end.
   *
   * `video.shelves` is a polymorphic-bound `manyToMany`: the binder supplies the
   * SAME `ResolvedJunctionTopology` in reverse orientation (the variant row is
   * the relation source, the polymorphic owner model the relation target), and
   * `RelationJunctionPart` / `JunctionStatements` own every verb unchanged. No
   * engine code exists for this view; what needs proving is that the ORIENTATION
   * lands where §9.5 says it does, and every row below proves it through the
   * DIRECT collection read as well as the raw member table — the same table, both
   * views, one answer.
   *
   * Both halves are compound-oriented by construction: the owner key is
   * `(tenantId, code)`, so a member tuple that lost a key member, or swapped the
   * sides, cannot round-trip.
   */
  describe(`plural collection inverse (${mode})`, () => {
    const getFamily = usePGliteSchemaFamily(collectionWriteSchema, mode);

    /**
     * The DIRECT view of one shelf's collection — the §12 land-gate control.
     *
     * Rendered by TARGET IDENTITY only (the compound book key in full), so the
     * row measures which memberships the direct read sees and not which columns
     * the projection happened to return.
     */
    const directItems = async (family: Family, code: string) => {
      const shelf = await family.client.shelf.findUnique({
        where: { tenantId_code: { tenantId: "t1", code } },
        include: { items: true },
      });
      return (shelf?.items ?? [])
        .map((item) => {
          if (item.type === "book")
            return `book:${item.data.region}/${item.data.isbn}`;
          if (item.type === "video") return `video:${item.data.id}`;
          return `note:${item.data.id}`;
        })
        .sort();
    };

    test("connect/create/connectOrCreate supply the OWNER in reversed orientation", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: {
            // The variant row is the SOURCE here, so every one of these names an
            // OWNER — a shelf — and the tuple that lands must still be owner-first.
            connect: [{ tenantId_code: { tenantId: "t1", code: "left" } }],
            create: [{ tenantId: "t1", code: "fresh", label: "Fresh" }],
            connectOrCreate: [
              {
                where: { tenantId_code: { tenantId: "t1", code: "made" } },
                create: { tenantId: "t1", code: "made", label: "Made" },
              },
            ],
          },
        },
      });

      expect(await videoMembers(family)).toEqual([
        "t1/fresh/1",
        "t1/left/1",
        "t1/made/1",
      ]);
      // CONSEQUENCE 4, and the compound-owner control: the owner created FROM the
      // inverse published its COMPLETE row key — both members — into the member
      // insert. A half-published key would leave `t1/fresh` unrepresentable.
      expect(await directItems(family, "fresh")).toEqual(["video:1"]);
      expect(await directItems(family, "left")).toEqual(["video:1"]);
      // …and no other member table was touched.
      expect(await bookMembers(family)).toEqual([]);
      expect(await noteMembers(family)).toEqual([]);
    });

    test("CONSEQUENCE 1 — inverse `set` replaces only THIS target's owner memberships", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      await family.client.video.create({ data: { id: 2, title: "Video two" } });

      // Both videos on `left`, plus a book and a note on `left` — everything the
      // clear must NOT reach.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connect: [
              { type: "video", where: { id: 1 } },
              { type: "video", where: { id: 2 } },
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
              { type: "note", where: { id: "n1" } },
            ],
          },
        },
      });

      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: {
            set: [{ tenantId_code: { tenantId: "t1", code: "right" } }],
          },
        },
      });

      // Video 1 moved; video 2's membership on the SAME table and the SAME owner
      // is untouched, which is the whole claim: the clear is scoped to the fixed
      // variant target, not to the owner and not to the table.
      expect(await videoMembers(family)).toEqual(["t1/left/2", "t1/right/1"]);
      // Another VARIANT's memberships on the same owner are equally untouched.
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);
      expect(await noteMembers(family)).toEqual(["t1/left/n1"]);
      // DIRECT-VIEW control on both owners.
      expect(await directItems(family, "right")).toEqual(["video:1"]);
      expect((await directItems(family, "left")).sort()).toEqual([
        "book:eu/111",
        "note:n1",
        "video:2",
      ]);
    });

    test("CONSEQUENCE 2 — inverse `disconnect` removes only the member row", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: {
            connect: [
              { tenantId_code: { tenantId: "t1", code: "left" } },
              { tenantId_code: { tenantId: "t1", code: "right" } },
            ],
          },
        },
      });
      expect(await videoMembers(family)).toEqual(["t1/left/1", "t1/right/1"]);

      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: {
            disconnect: [{ tenantId_code: { tenantId: "t1", code: "left" } }],
          },
        },
      });

      expect(await videoMembers(family)).toEqual(["t1/right/1"]);
      // NEITHER row died: the owner shelf and the fixed variant target both survive.
      const shelves = await family.client.shelf.findMany({
        orderBy: { code: "asc" },
      });
      expect(shelves.map((shelf) => shelf.code)).toEqual(["left", "right"]);
      expect(
        await family.client.video.findUnique({ where: { id: 1 } })
      ).not.toBe(null);
      expect(await directItems(family, "left")).toEqual([]);
    });

    test("CONSEQUENCE 3 — inverse `delete`/`deleteMany` delete OWNERS and cascade THEIR memberships across variants", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      // `left` holds all three variants; `right` holds the video only.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connect: [
              { type: "video", where: { id: 1 } },
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
              { type: "note", where: { id: "n1" } },
            ],
          },
        },
      });
      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: {
            connect: [{ tenantId_code: { tenantId: "t1", code: "right" } }],
          },
        },
      });

      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: {
            delete: [{ tenantId_code: { tenantId: "t1", code: "left" } }],
          },
        },
      });

      // The OWNER row went, and its source FK cascaded EVERY variant's membership
      // on it — including the book and the note the payload never mentioned.
      const shelves = await family.client.shelf.findMany();
      expect(shelves.map((shelf) => shelf.code)).toEqual(["right"]);
      expect(await bookMembers(family)).toEqual([]);
      expect(await noteMembers(family)).toEqual([]);
      expect(await videoMembers(family)).toEqual(["t1/right/1"]);
      // …and the FIXED VARIANT TARGET is untouched, as are the other variants' rows.
      expect(
        await family.client.video.findUnique({ where: { id: 1 } })
      ).not.toBe(null);
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);
      expect(await noteIds(family)).toEqual(["n1"]);

      // `deleteMany` is the same claim through the filtered spelling.
      await family.client.video.update({
        where: { id: 1 },
        data: { shelves: { deleteMany: [{ code: { equals: "right" } }] } },
      });
      expect(await family.client.shelf.findMany()).toEqual([]);
      expect(await videoMembers(family)).toEqual([]);
      expect(
        await family.client.video.findUnique({ where: { id: 1 } })
      ).not.toBe(null);
    });

    test("update/updateMany/upsert reach only the owner this target is linked to", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: {
            connect: [{ tenantId_code: { tenantId: "t1", code: "left" } }],
          },
        },
      });

      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: {
            update: [
              {
                where: { tenantId_code: { tenantId: "t1", code: "left" } },
                data: { label: "Relabelled" },
              },
            ],
          },
        },
      });
      const labels = async () =>
        (await family.client.shelf.findMany({ orderBy: { code: "asc" } })).map(
          (shelf) => `${shelf.code}:${shelf.label}`
        );
      expect(await labels()).toEqual(["left:Relabelled", "right:Right"]);

      // THE DECOY. `right` exists and matches the filter, but this target holds no
      // membership on it, so a membership-scoped updateMany cannot reach it.
      await family.client.video.update({
        where: { id: 1 },
        data: {
          shelves: { updateMany: [{ where: {}, data: { label: "Swept" } }] },
        },
      });
      expect(await labels()).toEqual(["left:Swept", "right:Right"]);
    });

    test("CONSEQUENCE 5 — the direct and inverse views of one member table are ONE own-write scope", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: { items: { connect: [{ type: "video", where: { id: 1 } }] } },
      });

      // Both directions in ONE operation, over the SAME physical member table:
      // the outer arm is the DIRECT collection (owner-oriented, correlating on
      // `left`), and the nested arm reached through it is the INVERSE
      // (variant-oriented, linking `right`). If the two views produced different
      // membership scopes the analyzer would schedule them as disjoint; the
      // orientation-erased scope (`RelationMembership`'s `sourceIsFirst` is
      // deliberately excluded from equality) is what makes them one, and the
      // observable consequence is that BOTH memberships survive the operation.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            update: [
              {
                type: "video",
                where: { id: 1 },
                data: {
                  shelves: {
                    connect: [
                      { tenantId_code: { tenantId: "t1", code: "right" } },
                    ],
                  },
                },
              },
            ],
          },
        },
      });

      expect(await videoMembers(family)).toEqual(["t1/left/1", "t1/right/1"]);
      expect(await directItems(family, "left")).toEqual(["video:1"]);
      expect(await directItems(family, "right")).toEqual(["video:1"]);
    });
  });

  /**
   * §9.4 — THE SINGULAR INVERSE, on the same physical member table, from the
   * variant end.
   *
   * `book.shelf` is a fields-less optional `manyToOne` bound to a member whose
   * `inverseCardinality` is `"one"`: at most one shelf may hold a given book, and
   * the member table carries a UNIQUE over the complete BOOK side to enforce it.
   * The write families are the ordinary to-one ones; the LOWERING is
   * `RelationJunctionToOnePart`'s.
   *
   * Both orientations are compound here — the owner key is `(tenantId, code)` and
   * the target key `(region, isbn)` — so a tuple that lost a member, or swapped
   * the sides, cannot round-trip. Every row asserts the DIRECT collection view of
   * the same member table beside the raw membership: §12's land gate requires each
   * inverse verb to prove itself in both views.
   */
  describe(`singular collection inverse (${mode})`, () => {
    const getFamily = usePGliteSchemaFamily(collectionWriteSchema, mode);

    /** The DIRECT view of one shelf's collection, by target identity alone. */
    const directItems = async (family: Family, code: string) => {
      const shelf = await family.client.shelf.findUnique({
        where: { tenantId_code: { tenantId: "t1", code } },
        include: { items: true },
      });
      return (shelf?.items ?? [])
        .map((item) => {
          if (item.type === "book")
            return `book:${item.data.region}/${item.data.isbn}`;
          if (item.type === "video") return `video:${item.data.id}`;
          return `note:${item.data.id}`;
        })
        .sort();
    };

    /** The INVERSE view of one book's slot — one shelf or null. */
    const slotOf = async (family: Family, isbn: string) => {
      const book = await family.client.book.findUnique({
        where: { region_isbn: { region: "eu", isbn } },
        include: { shelf: true },
      });
      return book?.shelf ? `${book.shelf.tenantId}/${book.shelf.code}` : null;
    };

    const shelfLabels = async (family: Family) => {
      const rows = await family.client.$queryRawUnsafe<{
        code: string;
        label: string;
      }>('SELECT "code", "label" FROM "pcw_shelves" ORDER BY "code"');
      return rows.map((row) => `${row.code}:${row.label}`);
    };

    const singularUpdateManyMessage = (verb: string) =>
      `updateMany matched 2 rows, so it cannot apply '${verb}' to relation 'items': that target's member-junction slot can belong to only one of them — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`;

    test("root updateMany refuses one singular member across two owners before writing", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await expect(
        family.client.shelf.updateMany({
          where: { tenantId: "t1" },
          data: {
            label: "must not write",
            items: {
              connect: [
                {
                  type: "book",
                  where: { region_isbn: { region: "eu", isbn: "111" } },
                },
              ],
            },
          },
        })
      ).rejects.toThrow(singularUpdateManyMessage("connect"));

      expect(await shelfLabels(family)).toEqual(["left:Left", "right:Right"]);
      expect(await bookMembers(family)).toEqual([]);
    });

    test("nested updateMany refuses one singular member across two owners before writing", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await expect(
        family.client.warehouse.update({
          where: { id: "w1" },
          data: {
            shelves: {
              updateMany: [
                {
                  where: {},
                  data: {
                    label: "must not write",
                    items: {
                      connect: [
                        {
                          type: "book",
                          where: {
                            region_isbn: { region: "eu", isbn: "111" },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        })
      ).rejects.toThrow(singularUpdateManyMessage("connect"));

      expect(await shelfLabels(family)).toEqual(["left:Left", "right:Right"]);
      expect(await bookMembers(family)).toEqual([]);
    });

    test("one owner succeeds while plural and empty targets remain valid at N > 1", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await expect(
        family.client.shelf.updateMany({
          where: { code: "left" },
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
        })
      ).resolves.toEqual({ count: 1 });
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);

      await expect(
        family.client.shelf.updateMany({
          where: { tenantId: "t1" },
          data: {
            items: {
              connect: [{ type: "video", where: { id: 1 } }],
            },
          },
        })
      ).resolves.toEqual({ count: 2 });
      expect(await videoMembers(family)).toEqual(["t1/left/1", "t1/right/1"]);

      await expect(
        family.client.shelf.updateMany({
          where: { tenantId: "t1" },
          data: {
            items: { connect: [], connectOrCreate: [], set: [] },
          },
        })
      ).resolves.toEqual({ count: 2 });
    });

    test("non-empty set and connectOrCreate reach the same root membership guard", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await expect(
        family.client.shelf.updateMany({
          where: { tenantId: "t1" },
          data: {
            label: "must not write",
            items: {
              set: [
                {
                  type: "book",
                  where: { region_isbn: { region: "eu", isbn: "111" } },
                },
              ],
            },
          },
        })
      ).rejects.toThrow(singularUpdateManyMessage("set"));

      await expect(
        family.client.shelf.updateMany({
          where: { tenantId: "t1" },
          data: {
            label: "must not write",
            items: {
              connectOrCreate: [
                {
                  type: "book",
                  where: { region_isbn: { region: "eu", isbn: "111" } },
                  create: {
                    region: "eu",
                    isbn: "111",
                    title: "must not create",
                  },
                },
              ],
            },
          },
        })
      ).rejects.toThrow(singularUpdateManyMessage("connectOrCreate"));

      expect(await shelfLabels(family)).toEqual(["left:Left", "right:Right"]);
      expect(await bookMembers(family)).toEqual([]);
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);
    });

    test("connect supplies the owner, and a second connect TRANSFERS the slot", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            connect: { tenantId_code: { tenantId: "t1", code: "left" } },
          },
        },
      });
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);
      expect(await directItems(family, "left")).toEqual(["book:eu/111"]);
      expect(await slotOf(family, "111")).toBe("t1/left");

      // THE SLOT REPLACEMENT. A singular member table holds at most one owner per
      // book, so this is not an insert: the transfer captures `left`, vacates it,
      // and inserts `right`. A bare idempotent insert would violate the target-side
      // UNIQUE, and an UNTARGETED duplicate skip would silently change nothing.
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            connect: { tenantId_code: { tenantId: "t1", code: "right" } },
          },
        },
      });
      expect(await bookMembers(family)).toEqual(["t1/right/eu/111"]);
      expect(await directItems(family, "left")).toEqual([]);
      expect(await directItems(family, "right")).toEqual(["book:eu/111"]);
      expect(await slotOf(family, "111")).toBe("t1/right");
    });

    test("reconnecting the SAME owner is idempotent", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      const connectLeft = () =>
        family.client.book.update({
          where: { region_isbn: { region: "eu", isbn: "111" } },
          data: {
            shelf: {
              connect: { tenantId_code: { tenantId: "t1", code: "left" } },
            },
          },
        });
      await connectLeft();
      await connectLeft();
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);
      expect(await directItems(family, "left")).toEqual(["book:eu/111"]);
    });

    test("`disconnect: true` deletes THE junction row, with no selector", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "222" } },
              },
            ],
          },
        },
      });

      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: { shelf: { disconnect: true } },
      });

      // ONE member row went. The SIBLING book's membership on the same owner and
      // the same table is untouched — the delete is scoped by the variant side,
      // which is the only side a singular slot can name.
      expect(await bookMembers(family)).toEqual(["t1/left/eu/222"]);
      expect(await directItems(family, "left")).toEqual(["book:eu/222"]);
      expect(await slotOf(family, "111")).toBeNull();
      // Neither row died: `disconnect` removes membership, never records.
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);
      expect(await shelfLabels(family)).toEqual(["left:Left", "right:Right"]);

      // …and it is idempotent on an already-empty slot.
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: { shelf: { disconnect: true } },
      });
      expect(await bookMembers(family)).toEqual(["t1/left/eu/222"]);
    });

    test("`delete: true` removes the SINGLE connected owner, never the variant target", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      // `left` holds this book, the sibling book, and a note; `right` holds the
      // other book. Everything the deletion must and must not reach.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "111" } },
              },
              { type: "note", where: { id: "n1" } },
            ],
          },
        },
      });
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "right" } },
        data: {
          items: {
            connect: [
              {
                type: "book",
                where: { region_isbn: { region: "eu", isbn: "222" } },
              },
            ],
          },
        },
      });

      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: { shelf: { delete: true } },
      });

      // ONE owner row died — the one this book's membership named. The OTHER
      // shelf is untouched, which is what "the single captured owner" means and
      // what a connected-set sweep would not guarantee.
      expect(await shelfLabels(family)).toEqual(["right:Right"]);
      // The VARIANT target survives: an inverse `delete` deletes the owner.
      expect(await bookTitles(family)).toEqual(["Book one", "Book two"]);
      // The dead owner's OTHER memberships went with it, by the member tables'
      // own source-side cascade — not by anything this lowering emitted.
      expect(await bookMembers(family)).toEqual(["t1/right/eu/222"]);
      expect(await noteMembers(family)).toEqual([]);
      expect(await noteIds(family)).toEqual(["n1"]);
      expect(await directItems(family, "right")).toEqual(["book:eu/222"]);
      expect(await slotOf(family, "111")).toBeNull();
    });

    test("`delete: true` on an EMPTY slot writes nothing", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: { shelf: { delete: true } },
      });
      expect(await shelfLabels(family)).toEqual(["left:Left", "right:Right"]);
      expect(await bookMembers(family)).toEqual([]);
    });

    test("correlated `update` modifies the connected owner and nothing else", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            connect: { tenantId_code: { tenantId: "t1", code: "left" } },
          },
        },
      });

      // No `where` is spellable on a to-one modify: the membership IS the locator.
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: { shelf: { update: { label: "Relabelled" } } },
      });
      expect(await shelfLabels(family)).toEqual([
        "left:Relabelled",
        "right:Right",
      ]);
      // The membership is untouched by a modify.
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);
      expect(await directItems(family, "left")).toEqual(["book:eu/111"]);
    });

    test("`upsert` takes its found arm through the membership, its missing arm by creating", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      // MISSING — the slot is empty, so the create arm runs and links.
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            upsert: {
              create: { tenantId: "t1", code: "made", label: "Made" },
              update: { label: "unused" },
            },
          },
        },
      });
      expect(await shelfLabels(family)).toEqual([
        "left:Left",
        "made:Made",
        "right:Right",
      ]);
      expect(await bookMembers(family)).toEqual(["t1/made/eu/111"]);
      expect(await directItems(family, "made")).toEqual(["book:eu/111"]);

      // FOUND — the same payload now updates the connected owner instead.
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            upsert: {
              create: { tenantId: "t1", code: "other", label: "Other" },
              update: { label: "Kept" },
            },
          },
        },
      });
      expect(await shelfLabels(family)).toEqual([
        "left:Left",
        "made:Kept",
        "right:Right",
      ]);
      expect(await bookMembers(family)).toEqual(["t1/made/eu/111"]);
    });

    test("`connectOrCreate` adopts an existing owner and creates a missing one", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            connectOrCreate: {
              where: { tenantId_code: { tenantId: "t1", code: "left" } },
              create: { tenantId: "t1", code: "left", label: "Ignored" },
            },
          },
        },
      });
      expect(await shelfLabels(family)).toEqual(["left:Left", "right:Right"]);
      expect(await bookMembers(family)).toEqual(["t1/left/eu/111"]);

      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "222" } },
        data: {
          shelf: {
            connectOrCreate: {
              where: { tenantId_code: { tenantId: "t1", code: "grown" } },
              create: { tenantId: "t1", code: "grown", label: "Grown" },
            },
          },
        },
      });
      expect(await shelfLabels(family)).toEqual([
        "grown:Grown",
        "left:Left",
        "right:Right",
      ]);
      expect(await bookMembers(family)).toEqual([
        "t1/grown/eu/222",
        "t1/left/eu/111",
      ]);
      expect(await directItems(family, "grown")).toEqual(["book:eu/222"]);
    });

    test("a CREATE root supplies the slot for a variant row that does not exist yet", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);

      await family.client.book.create({
        data: {
          region: "eu",
          isbn: "333",
          title: "Book three",
          shelf: {
            connect: { tenantId_code: { tenantId: "t1", code: "left" } },
          },
        },
      });
      expect(await bookMembers(family)).toEqual(["t1/left/eu/333"]);
      expect(await directItems(family, "left")).toEqual(["book:eu/333"]);

      // …and a fresh owner from a fresh variant: two compound row keys, both
      // published in full into the ONE member tuple.
      await family.client.book.create({
        data: {
          region: "eu",
          isbn: "444",
          title: "Book four",
          shelf: {
            create: { tenantId: "t1", code: "born", label: "Born" },
          },
        },
      });
      expect(await bookMembers(family)).toEqual([
        "t1/born/eu/444",
        "t1/left/eu/333",
      ]);
      expect(await directItems(family, "born")).toEqual(["book:eu/444"]);
    });

    test("COMPOSITION — vacate, then supply, then modify THE SUPPLIED owner", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            connect: { tenantId_code: { tenantId: "t1", code: "left" } },
          },
        },
      });

      // The payload lists `update` before `connect` in `RELATION_MUTATION_KEYS`
      // order (3rd vs 9th). The lowering reads `(vacate, supplier, modify)` from
      // the composition owner instead, so the modify lands on the INCOMING owner.
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            disconnect: true,
            connect: { tenantId_code: { tenantId: "t1", code: "right" } },
            update: { label: "Supplied" },
          },
        },
      });

      expect(await bookMembers(family)).toEqual(["t1/right/eu/111"]);
      expect(await shelfLabels(family)).toEqual([
        "left:Left",
        "right:Supplied",
      ]);
      expect(await directItems(family, "left")).toEqual([]);
      expect(await directItems(family, "right")).toEqual(["book:eu/111"]);
    });

    test("COMPOSITION ORDER — a PRODUCING supplier's modify reaches a row only supply can name", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            connect: { tenantId_code: { tenantId: "t1", code: "left" } },
          },
        },
      });

      // THE ORDER PIN. `create` produces the owner, so the modify has no
      // selector to take and becomes a membership-capture continuation: it reads
      // the singular member AFTER the supplier wrote it. Lower the modify first —
      // which is exactly what the parsed key order does — and the capture sees an
      // empty slot and silently writes nothing.
      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          shelf: {
            disconnect: true,
            create: { tenantId: "t1", code: "fresh", label: "Before" },
            update: { label: "After" },
          },
        },
      });

      expect(await shelfLabels(family)).toEqual([
        "fresh:After",
        "left:Left",
        "right:Right",
      ]);
      expect(await bookMembers(family)).toEqual(["t1/fresh/eu/111"]);
      expect(await directItems(family, "fresh")).toEqual(["book:eu/111"]);
      expect(await directItems(family, "left")).toEqual([]);
    });

    test("a SECOND occupant is rejected with no partial effect", async () => {
      const family = getFamily();
      await family.reset();
      await seed(family);
      // The DIRECT view puts book 111 on `left`; the inverse now tries to give
      // `right` the same book while ALSO renaming it. The slot transfer is the
      // sanctioned route, so the rename must land with it — and the direct
      // collection must not end up holding the book twice.
      await family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
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

      await family.client.book.update({
        where: { region_isbn: { region: "eu", isbn: "111" } },
        data: {
          title: "Moved",
          shelf: {
            connect: { tenantId_code: { tenantId: "t1", code: "right" } },
          },
        },
      });

      expect(await bookMembers(family)).toEqual(["t1/right/eu/111"]);
      expect(await bookTitles(family)).toEqual(["Book two", "Moved"]);
      expect(await directItems(family, "left")).toEqual([]);
      expect(await directItems(family, "right")).toEqual(["book:eu/111"]);
    });
  });
}

/**
 * MOUNT 3 — a collection nested under a JUNCTION TARGET's create.
 *
 * The other two mounts (a create root, a located record) are exercised by every
 * row above. This one is the depth seam: `buildJunctionTargetRelationParts`
 * walks `relationMutationPrograms`, which is deliberately a POSITIVE filter now,
 * so the collection arm is invisible to that walk and had to be visited
 * explicitly. An unvisited arm here is not an error — it is a silent drop, which
 * is the exact class this estate keeps recording, so it gets its own witness.
 */
const nestedCollectionSchema = (() => {
  const note = s
    .model({ id: s.string().id(), body: s.string() })
    .map("ncw_notes");
  const memo = s
    .model({ id: s.string().id(), text: s.string() })
    .map("ncw_memos");
  const crate = s
    .model({
      id: s.string().id(),
      label: s.string(),
      tags: s.toMany(() => tag),
      items: s.toMany(
        { note: () => note, memo: () => memo },
        { values: { note: "ncw.note.v1", memo: "ncw.memo.v1" } }
      ),
    })
    .map("ncw_crates");
  const tag = s
    .model({
      id: s.string().id(),
      // An ORDINARY junction whose target owns a collection — the only route to
      // the depth seam, and it needs a single-column target key so the fold
      // takes its inline path rather than delegating the whole record.
      crates: s.toMany(() => crate),
    })
    .map("ncw_tags");
  return { note, memo, crate, tag };
})();

describe("a collection nested under a junction target's create", () => {
  const getFamily = usePGliteSchemaFamily(
    nestedCollectionSchema,
    "transaction"
  );

  test("the depth seam builds the coordinator instead of dropping the arm", async () => {
    const family = getFamily();
    await family.reset();
    await family.client.note.create({ data: { id: "n1", body: "seed" } });

    await family.client.tag.create({
      data: {
        id: "t1",
        crates: {
          create: [
            {
              id: "c1",
              label: "Crate one",
              items: {
                connect: [{ type: "note", where: { id: "n1" } }],
                create: [{ type: "memo", data: { id: "m1", text: "fresh" } }],
              },
            },
          ],
        },
      },
    });

    const noteRows = await family.client.$queryRawUnsafe<
      Record<string, unknown>
    >('SELECT * FROM "ncw_crates_items_note"');
    const memoRows = await family.client.$queryRawUnsafe<
      Record<string, unknown>
    >('SELECT * FROM "ncw_crates_items_memo"');
    // BOTH member tables were written, correlated on the crate the junction
    // create just made — not on the tag, and not on nothing.
    expect(noteRows).toHaveLength(1);
    expect(memoRows).toHaveLength(1);
    expect(Object.values(noteRows[0] ?? {})).toContain("c1");
    expect(Object.values(memoRows[0] ?? {})).toContain("c1");
  });
});

/**
 * THE ORIENTATION CONTROL, on a fixture whose two sides are STRUCTURALLY
 * INTERCHANGEABLE — one scalar `int` key each.
 *
 * The compound fixture above already refuses a swapped orientation, but it
 * refuses it at the side-value seam ("Compound junction side requires one value
 * for every referenced field") because the two key shapes cannot be mistaken for
 * one another. That is a weaker control than it looks: it would stay red for a
 * plan that had the orientation right and the arity wrong.
 *
 * Here neither side can be told from the other by shape, so the ONLY thing that
 * separates a correct owner-oriented bind from the traversal's own
 * variant-oriented one is the ANSWER: `membershipOwners` selects
 * `membership.source`'s columns filtered by `membership.target`, so the wrong
 * orientation asks "which SLIPS sit on this crate" — many rows on a healthy
 * schema — and the singular transfer's `LIMIT 2` multi-owner detector is what
 * reports it.
 */
const scalarInverseSchema = (() => {
  const slip = s
    .model({
      id: s.int().id(),
      note: s.string(),
      // SINGULAR inverse, single-column on BOTH sides.
      crate: s.toOne(() => crate),
    })
    .map("siw_slips");
  const crate = s
    .model({
      id: s.int().id(),
      label: s.string(),
      items: s
        .toMany({ slip: () => slip }, { values: { slip: "siw.slip.v1" } })
        .through({
          slip: { table: "siw_crate_slips", source: "holder", target: "entry" },
        }),
    })
    .map("siw_crates");
  return { slip, crate };
})();

/** The member tuples of the scalar fixture, owner-first, exactly as above. */
async function crateMembers(
  family: PGliteSchemaFamily<typeof scalarInverseSchema>
): Promise<string[]> {
  const columns = await family.client.$queryRawUnsafe<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'siw_crate_slips' ORDER BY ordinal_position"
  );
  const names = columns.map((column) => column.column_name);
  const ordered = [
    ...names.filter((name) => name.startsWith("holder")),
    ...names.filter((name) => name.startsWith("entry")),
  ];
  const rows = await family.client.$queryRawUnsafe<Record<string, unknown>>(
    `SELECT ${ordered.map((name) => `"${name}"`).join(", ")} FROM "siw_crate_slips"`
  );
  return rows
    .map((row) => ordered.map((name) => String(row[name])).join("/"))
    .sort();
}

describe("a singular inverse whose two sides are the same shape", () => {
  const getFamily = usePGliteSchemaFamily(scalarInverseSchema, "transaction");

  test("a crate already holding several slips still takes ONE more by transfer", async () => {
    const family = getFamily();
    await family.reset();
    await family.client.crate.create({ data: { id: 1, label: "One" } });
    await family.client.crate.create({ data: { id: 2, label: "Two" } });
    for (const id of [1, 10, 11]) {
      await family.client.slip.create({ data: { id, note: `slip ${id}` } });
    }

    // Crate 1 holds TWO slips, and slip 1's id COLLIDES with crate 1's. That
    // collision is the point: an owner-oriented capture asks "who holds slip 1"
    // — nobody — while the traversal's own variant-oriented bind would read the
    // same value as a CRATE id and ask "which slips sit on crate 1", see two,
    // and trip the transfer's `LIMIT 2` multi-owner detector. On this fixture
    // that detector is the SOLE thing separating the two orientations: neither
    // side can be told from the other by shape.
    await family.client.crate.update({
      where: { id: 1 },
      data: {
        items: {
          connect: [
            { type: "slip", where: { id: 10 } },
            { type: "slip", where: { id: 11 } },
          ],
        },
      },
    });

    await family.client.slip.update({
      where: { id: 1 },
      data: { crate: { connect: { id: 2 } } },
    });
    expect(await crateMembers(family)).toEqual(["1/10", "1/11", "2/1"]);

    // …and moving one of crate 1's slips to crate 2 is still a slot
    // replacement, not a second membership.
    await family.client.slip.update({
      where: { id: 10 },
      data: { crate: { connect: { id: 2 } } },
    });
    expect(await crateMembers(family)).toEqual(["1/11", "2/1", "2/10"]);
  });
});

const producedOwnerClearSchema = (() => {
  const station = s
    .model({
      id: s.string().id(),
      label: s.string(),
      badge: s.toOne(() => badge),
    })
    .map("poc_stations");
  const note = s
    .model({ id: s.string().id(), body: s.string() })
    .map("poc_notes");
  const badge = s
    .model({
      id: s.int().id().increment(),
      label: s.string(),
      stationId: s.string().nullable().unique(),
      station: s
        .toOne(() => station)
        .fields("stationId")
        .references("id"),
      items: s.toMany(
        { note: () => note },
        { values: { note: "poc.note.v1" } }
      ),
    })
    .map("poc_badges");
  return { station, note, badge };
})();

describe("a produced collection owner whose split precedes its clear", () => {
  const getFamily = usePGliteSchemaFamily(
    producedOwnerClearSchema,
    "atomicBatch"
  );

  test("a produced owner split entirely before its clear succeeds in batch", async () => {
    const family = getFamily();
    await family.reset();
    await family.client.station.create({
      data: { id: "s1", label: "Station" },
    });
    await family.client.note.create({
      data: { id: "n1", body: "Note" },
    });

    // `create` publishes the badge's database-assigned id. Its composed `update`
    // is a post-supply continuation, so the executor commits the supplier before
    // compiling the collection clear. The only split is therefore BEFORE the
    // first clear; refusing this shape would restore the old produced-owner proxy.
    await family.client.station.update({
      where: { id: "s1" },
      data: {
        badge: {
          create: { label: "Generated" },
          update: {
            items: { set: [{ type: "note", where: { id: "n1" } }] },
          },
        },
      },
    });

    await expect(
      family.client.badge.findUnique({
        where: { id: 1 },
        include: { items: true, station: true },
      })
    ).resolves.toMatchObject({
      id: 1,
      label: "Generated",
      stationId: "s1",
      station: { id: "s1" },
      items: [{ type: "note", data: { id: "n1", body: "Note" } }],
    });
  });
});

describe("polymorphic collection `set` refuses before the clear on a splittable batch", () => {
  const getFamily = usePGliteSchemaFamily(collectionWriteSchema, "atomicBatch");
  const getTransactionFamily = usePGliteSchemaFamily(
    collectionWriteSchema,
    "transaction"
  );

  // PLURAL INVERSE, on the batch substrate (plan §9.5). The `@ts-expect-error`
  // that used to sit on `shelves` died with the grammar flip — an unused
  // directive is a build error, so this pin could not be left stale.
  //
  // The shape is the one the fence used to stand in front of: an inverse
  // `upsert` under a CREATE root, reaching the OWNER in reversed orientation on a
  // driver that may legally split the batch.
  test("an inverse upsert under a create root supplies the owner and links it", async () => {
    const family = getFamily();
    await family.reset();

    await family.client.video.create({
      data: {
        id: 7,
        title: "producer",
        shelves: {
          upsert: [
            {
              where: { tenantId_code: { tenantId: "t1", code: "gen" } },
              create: { tenantId: "t1", code: "gen", label: "Generated" },
              update: { label: "Generated" },
            },
          ],
        },
      },
    });

    // DATABASE STATE, and specifically the DIRECT view of the same member table:
    // the owner exists, and the membership tuple is owner-first even though the
    // program was written from the variant side.
    const shelves = await family.client.$queryRawUnsafe<
      Record<string, unknown>
    >('SELECT "tenantId", "code", "label" FROM "pcw_shelves"');
    expect(shelves).toEqual([
      { tenantId: "t1", code: "gen", label: "Generated" },
    ]);
    const members = await family.client.$queryRawUnsafe<
      Record<string, unknown>
    >('SELECT * FROM "pcw_shelf_videos"');
    expect(members).toHaveLength(1);
    expect(Object.values(members[0] ?? {})).toEqual(
      expect.arrayContaining(["t1", "gen", 7])
    );
  });

  test("a generated target after the clear refuses with prior state intact", async () => {
    const family = getFamily();
    await family.reset();
    await seed(family);
    await family.client.shelf.update({
      where: { tenantId_code: { tenantId: "t1", code: "left" } },
      data: { items: { connect: [{ type: "video", where: { id: 1 } }] } },
    });

    await expect(
      family.client.shelf.update({
        where: { tenantId_code: { tenantId: "t1", code: "left" } },
        data: {
          items: {
            set: [],
            create: [{ type: "video", data: { title: "must not survive" } }],
          },
        },
      })
    ).rejects.toThrow(
      "Polymorphic collection 'items' set requires one atomic unit; this driver would commit the clear separately from the refill."
    );
    expect(await videoMembers(family)).toEqual(["t1/left/1"]);
    expect(await family.client.video.findMany({})).toHaveLength(1);
  });

  test("the same generated target set succeeds in one transaction", async () => {
    const family = getTransactionFamily();
    await family.reset();
    await seed(family);
    await family.client.shelf.update({
      where: { tenantId_code: { tenantId: "t1", code: "left" } },
      data: {
        items: {
          set: [],
          create: [{ type: "video", data: { title: "transaction child" } }],
        },
      },
    });

    expect(await videoMembers(family)).toHaveLength(1);
    expect(await family.client.video.findMany({})).toHaveLength(2);
  });

  test("explicit target identity keeps the batch indivisible", async () => {
    const family = getFamily();
    await family.reset();
    await seed(family);

    await family.client.shelf.update({
      where: { tenantId_code: { tenantId: "t1", code: "left" } },
      data: {
        items: {
          set: [],
          create: [{ type: "note", data: { id: "n2", body: "explicit" } }],
        },
      },
    });

    expect(await noteMembers(family)).toEqual(["t1/left/n2"]);
  });

  test("a generated nested target without a clear remains a batch control", async () => {
    const family = getFamily();
    await family.reset();
    await seed(family);

    await family.client.shelf.update({
      where: { tenantId_code: { tenantId: "t1", code: "left" } },
      data: {
        items: {
          create: [{ type: "video", data: { title: "no clear" } }],
        },
      },
    });

    expect(await videoMembers(family)).toHaveLength(1);
  });
});
