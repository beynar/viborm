import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { ValidationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * A fields-less `toOne` is child-held topology: the target's physical
 * back-reference owns its membership. Fresh create supports the same single
 * operations as other child-held to-one relations. Validation owns operation
 * arity and omission of the engine-supplied FK. Compound referenced identities
 * remain an explicit adopt limitation.
 */

// =============================================================================
// SCHEMA
// =============================================================================

/**
 * `desk.tag` is the shape: a `toOne` with no `.fields()`. `tag.desk` — the paired
 * to-one back-reference — carries the columns, so the resolved edge is
 * `tag.deskId → desk.id`, child-held. The extra `desk.tags` / `tag.desks` pair is
 * GONE: it existed only to satisfy the old inverse-pairing ladder for the
 * `manyToOne` spelling, and two unnamed pairs between the same models are now
 * ambiguous (R009). Two paired to-one slots derive the unique the edge implies
 * (§9.4), which is why every desk below claims its own tag.
 *
 * `desk.pins` is the to-many control on the same parent: it must keep composing several
 * kinds.
 */
const desk = s
  .model({
    id: s.int().id(),
    label: s.string(),
    tag: s.toOne(() => tag),
    pins: s.toMany(() => pin),
  })
  .map("e4u1_desks");

const tag = s
  .model({
    id: s.int().id(),
    code: s.string(),
    deskId: s.int().nullable(),
    desk: s
      .toOne(() => desk)
      .fields("deskId")
      .references("id"),
  })
  .map("e4u1_tags");

const pin = s
  .model({
    id: s.int().id(),
    body: s.string(),
    deskId: s.int().nullable(),
    desk: s
      .toOne(() => desk)
      .fields("deskId")
      .references("id"),
  })
  .map("e4u1_pins");

/**
 * The COMPOUND twin of `desk.tag`: the same fields-less `toOne` spelling, but the
 * resolved edge references a two-column unique. `edgeParentId` (E4-U2's site) still
 * refuses the adopt kinds on it.
 */
const bay = s
  .model({
    id: s.int().id(),
    region: s.string(),
    zone: s.string(),
    slot: s.toOne(() => slot),
  })
  .map("e4u1_bays")
  .unique(["region", "zone"]);

const slot = s
  .model({
    id: s.int().id(),
    name: s.string(),
    bayRegion: s.string().nullable(),
    bayZone: s.string().nullable(),
    bay: s
      .toOne(() => bay)
      .fields("bayRegion", "bayZone")
      .references("region", "zone"),
  })
  .map("e4u1_slots");

/**
 * The OWNERLESS edge, kept OUT of the client schema below: `crate.holder` and
 * `holder.crates` pair, but neither completes `.fields(...).references(...)`, so
 * no row stores the membership. The engine used to meet this at bind time; §9.4
 * makes an ownerless ordinary relation a definition error, so it never reaches a
 * client at all — which is what "what still refuses" asserts now.
 */
const crate = s
  .model({
    id: s.int().id(),
    name: s.string(),
    holder: s.toOne(() => holder),
  })
  .map("e4u1_crates");

const holder = s
  .model({
    id: s.int().id(),
    name: s.string(),
    crates: s.toMany(() => crate),
  })
  .map("e4u1_holders");

/**
 * The named pair: `author.books` and `book.author` both claim `"writer"`. It was
 * one-sided until the exact-label partition made a one-sided name a mismatch
 * (R010); §9.1 copies the name to the resolved partner rather than dropping it.
 */
const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    books: s.toMany(() => book).name("writer"),
  })
  .map("e4u1_authors");

const book = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id")
      .name("writer"),
  })
  .map("e4u1_books");

const schema = { desk, tag, pin, bay, slot, author, book };

async function setup(driver: PGliteDriver) {
  const client = createClient({ schema, driver });
  await push(client, { force: true });
  return client;
}

const substrates = [
  {
    name: "transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
  },
  {
    name: "atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  },
] as const;

// =============================================================================
// THE ABSORPTION — every admitted kind, both substrates, with decoys
// =============================================================================

for (const substrate of substrates) {
  describe(`E4-U1 fields-less toOne under a create root (${substrate.name})`, () => {
    test("create / connect / connectOrCreate each write exactly their own row", async () => {
      const client = await setup(substrate.make());
      try {
        // DECOYS, seeded first: rows that share the child table and the FK column but
        // must be untouched by any of the three kinds. `decoy-taken` already points at
        // a DIFFERENT desk, which is the row a cross-matched correlation would steal.
        await client.desk.create({ data: { id: 90, label: "other" } });
        await client.tag.create({ data: { id: 900, code: "decoy-free" } });
        await client.tag.create({
          data: { id: 901, code: "decoy-taken", desk: { connect: { id: 90 } } },
        });
        await client.tag.create({ data: { id: 11, code: "adoptable" } });

        // 1. create — the child INSERTs after the parent with the parent's fresh id.
        await client.desk.create({
          data: {
            id: 1,
            label: "a",
            tag: { create: { id: 10, code: "made" } },
          },
        });
        // 2. connect — the existing row is re-pointed at the fresh parent.
        await client.desk.create({
          data: { id: 2, label: "b", tag: { connect: { id: 11 } } },
        });
        // 3. connectOrCreate, create branch — nothing matches, so a row is minted.
        await client.desk.create({
          data: {
            id: 3,
            label: "c",
            tag: {
              connectOrCreate: {
                where: { id: 12 },
                create: { id: 12, code: "coc-made" },
              },
            },
          },
        });
        // 4. connectOrCreate, found branch — the free decoy is adopted, not duplicated.
        await client.desk.create({
          data: {
            id: 4,
            label: "d",
            tag: {
              connectOrCreate: {
                where: { id: 900 },
                create: { id: 900, code: "never-minted" },
              },
            },
          },
        });

        // EXACTLY these rows exist, and each carries exactly the parent that claimed it.
        await expect(
          client.tag.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual([
          { id: 10, code: "made", deskId: 1 },
          { id: 11, code: "adoptable", deskId: 2 },
          { id: 12, code: "coc-made", deskId: 3 },
          { id: 900, code: "decoy-free", deskId: 4 },
          // The taken decoy never moved: no kind above named it.
          { id: 901, code: "decoy-taken", deskId: 90 },
        ]);
        // And the found branch minted nothing — `never-minted` is not a row.
        await expect(
          client.tag.findMany({ where: { code: "never-minted" } })
        ).resolves.toEqual([]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);

    test("the to-many control on the same parent still composes several kinds", async () => {
      const client = await setup(substrate.make());
      try {
        await client.pin.create({ data: { id: 80, body: "adopted" } });
        await client.desk.create({
          data: {
            id: 8,
            label: "h",
            pins: { create: { id: 81, body: "made" }, connect: { id: 80 } },
          },
        });
        await expect(
          client.pin.findMany({ where: { deskId: 8 }, orderBy: { id: "asc" } })
        ).resolves.toMatchObject([{ id: 80 }, { id: 81 }]);
      } finally {
        await client.$disconnect();
      }
    }, 30_000);
  });
}

// =============================================================================
// VALIDATION BOUNDARIES
// =============================================================================

describe("fields-less to-one validation", () => {
  test("a multi-kind payload fails at the to-one schema boundary", async () => {
    const client = await setup(new PGliteDriver({ client: new PGlite() }));
    try {
      await client.tag.create({ data: { id: 11, code: "free" } });
      await expect(
        client.desk.create({
          data: {
            id: 4,
            label: "d",
            tag: {
              create: { id: 13, code: "x" },
              // @ts-expect-error - to-one payloads accept one active operation
              connect: { id: 11 },
            },
          },
        })
      ).rejects.toThrow(ValidationError);
      await expect(
        client.desk.create({
          data: {
            id: 4,
            label: "d",
            tag: {
              create: { id: 13, code: "x" },
              // @ts-expect-error - to-one payloads accept one active operation
              connect: { id: 11 },
            },
          },
        })
      ).rejects.toThrow(
        "Unsupported to-one operation combination: create, connect"
      );
      // Validation refuses both arms, and the free row stays free.
      await expect(
        client.desk.findUnique({ where: { id: 4 } })
      ).resolves.toBeNull();
      await expect(
        client.tag.findUnique({ where: { id: 11 } })
      ).resolves.toMatchObject({ deskId: null });
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

  test("the engine-owned foreign key is refused by the PARSE, per the aligned scanners", async () => {
    const client = await setup(new PGliteDriver({ client: new PGlite() }));
    try {
      // On the fields-less edge the engine owns `deskId`, so the nested create schema
      // omits it — spelling it is a parse error, never a silent overwrite of the
      // correlation the engine folds in. (The GENERATED input type still admits the
      // key; the runtime refusal is the one that holds today, and narrowing the type
      // is unit TH's business, not this wave's.)
      await expect(
        client.desk.create({
          data: {
            id: 5,
            label: "e",
            tag: { create: { id: 14, code: "x", deskId: 999 } },
          },
        })
      ).rejects.toThrow(ValidationError);

      // The same refusal on the NAMED pair: `author.books` and `book.author` both
      // claim "writer", the edge works, and its owned key is still not spellable.
      await client.author.create({
        data: { id: 1, name: "w", books: { create: { id: 1, title: "t" } } },
      });
      await expect(
        client.book.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ authorId: 1 });
      await expect(
        client.author.create({
          data: {
            id: 2,
            name: "w2",
            books: { create: { id: 2, title: "t2", authorId: 99 } },
          },
        })
      ).rejects.toThrow(ValidationError);
    } finally {
      await client.$disconnect();
    }
  }, 30_000);
});

// =============================================================================
// THE BOUNDARIES THE WIDENING DID NOT MOVE
// =============================================================================

describe("E4-U1 what still refuses", () => {
  test("an ownerless edge never reaches a client", () => {
    expect(() =>
      createClient({
        schema: { crate, holder },
        driver: new PGliteDriver({ client: new PGlite() }),
      })
    ).toThrow("[FK004]");
  });

  // DELIBERATE RETARGET (E4 merge): this test pinned "the compound fields-less edge
  // keeps E4-U2's arity refusal on the adopt kinds" — true at U1's commit, where it
  // proved U1's ordering (the carve-out held until the per-field source existed).
  // U2 then built exactly that source, and the adopt kinds on this edge became
  // expressible: the refusal it pinned is DISCHARGED, so the pin becomes the state
  // witness the discharge owes. The per-field decoy coverage for the mechanism lives
  // in compound-relation-adoption-behavior.ts; this witness pins the fields-less spelling.
  test("the COMPOUND fields-less edge rides E4-U2's per-field source on the adopt kinds", async () => {
    const client = await setup(new PGliteDriver({ client: new PGlite() }));
    try {
      await client.bay.create({
        data: {
          id: 1,
          region: "eu",
          zone: "z",
          slot: {
            connectOrCreate: {
              where: { id: 200 },
              create: { id: 200, name: "s" },
            },
          },
        },
      });
      // Each FK column carries its OWN referenced value — a single-value collapse
      // would write "eu" into both.
      await expect(client.slot.findMany()).resolves.toEqual([
        { id: 200, name: "s", bayRegion: "eu", bayZone: "z" },
      ]);

      // The kinds that never ask `edgeParentId` for a single parent value — `create`
      // writes every FK column per-field through `childFkAssign` — already work on the
      // same compound edge, which is why the refusal is about the SOURCE and not about
      // compound keys as such.
      await client.bay.create({
        data: {
          id: 2,
          region: "eu",
          zone: "y",
          slot: { create: { id: 201, name: "s2" } },
        },
      });
      await expect(
        client.slot.findUnique({ where: { id: 201 } })
      ).resolves.toMatchObject({ bayRegion: "eu", bayZone: "y" });
    } finally {
      await client.$disconnect();
    }
  }, 30_000);
});
