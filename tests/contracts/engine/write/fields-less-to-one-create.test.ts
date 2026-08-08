import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { UnsupportedOperationError, ValidationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * E4-U1 — **the relation type outside the create dispatch.**
 *
 * `CreateOperation.interpretRelation` used to end its child-held branch with a
 * type-NAME predicate — `oneToMany || oneToOne` — and refuse everything else:
 *
 *   UnsupportedOperationError: query-engine-v2 create supports only child-held
 *   one-to-many / one-to-one relations; relation 'tag' is 'manyToOne'.
 *
 * Measured at f410d6c on the schema below, 0 statements, for all three kinds the parse
 * admits (`create`, `connect`, `connectOrCreate`). The shape it refused is a `manyToOne`
 * declared WITHOUT `.fields()` — the inverse side spelled with the many-side helper,
 * its foreign key resolved from the target's own back-reference. `getFkDirection`
 * answers `holdsFK === false` for it, so it is a child-held edge in every way that
 * matters to the create tree, and the SAME relation on the SAME schema has always
 * constructed under `update` (`UpdateOperation`'s sibling gate asks
 * `isToOne || type === "oneToMany"`). It was a capability gap, not a decision.
 *
 * The absorption DELETES the predicate rather than adding a third name to it, because
 * the union it tested is closed and every other member leaves earlier:
 *
 *   · `manyToMany` returns at the top of `interpretRelation` (the junction branch);
 *   · `holdsFK` returns one line above (the parent-held branch);
 *   · an edge with NO inverse to resolve never arrives at all — `getFkDirection`
 *     raises its own typed "Cannot determine FK fields for relation '…'. Define the
 *     inverse relation with .fields([...]) …" before a direction exists. This file
 *     pins that, so "the union is closed" is a measurement and not an argument.
 *
 * **The two M8 gates the plan put in front of this widening are CLOSED by the D-wave,
 * and are probed here rather than re-decided:**
 *
 *   · D5's arity twin in `CreateOperation.interpretChildHeld` (`isToOne && kinds.length
 *     > 1`) answers a multi-kind payload on the fields-less edge. It reads
 *     `relationInfo.isToOne`, never a type name, so it covered this spelling the moment
 *     the widening let a payload reach it. Its own permanent witness is
 *     `child-held-to-one-multi-kind.test.ts`; the probe here proves the composition.
 *   · D5's scanner alignment (`findInverseRelationState` ⟷ `getInverseRelationMap`)
 *     is what makes a name-mismatched sole back-reference resolve the same way on both
 *     sides. The parse OMITS the engine-owned foreign key, so the spelled-FK
 *     silent-overwrite hazard the plan flagged is answered at the parse boundary with
 *     `ValidationError: Unknown key: <fk>` — no second engine guard ships beside the
 *     widening (one guard per invariant).
 *
 * **No occupied-slot guard ships either.** The parent this dispatch builds is FRESH, so
 * its to-one slot starts empty and each admitted kind is a pure add against it — the
 * same fresh-parent elision the many-to-many branch cites one screen above. The
 * occupied question belongs to the UPDATE root, whose slot may already hold a row (M10).
 *
 * **The carve-out that ships:** a fields-less `manyToOne` whose resolved edge references
 * a COMPOUND key still meets `CreateOperation.edgeParentId`'s arity refusal on the adopt
 * kinds. That is E4-U2's site, not this one, and it is pinned below so the widening
 * cannot be read as having lifted it.
 */

// =============================================================================
// SCHEMA
// =============================================================================

/**
 * `desk.tag` is the shape: `manyToOne` with no `.fields()`. `tag.desk` (the sole to-one
 * back-reference from `tag` to `desk`) carries the columns, so the resolved edge is
 * `tag.deskId → desk.id` — child-held, and NOT unique, which is why this leg is the one
 * that could hold two rows before D5. `desk.tags` / `tag.desks` exist only to satisfy
 * the inverse-pairing rules (R003/R004) for that spelling.
 *
 * `desk.pins` is the to-many control on the same parent: it must keep composing several
 * kinds after the widening.
 */
const desk = s
  .model({
    id: s.int().id(),
    label: s.string(),
    tag: s.manyToOne(() => tag).optional(),
    tags: s.oneToMany(() => tag),
    pins: s.oneToMany(() => pin),
  })
  .map("e4u1_desks");

const tag = s
  .model({
    id: s.int().id(),
    code: s.string(),
    deskId: s.int().nullable(),
    desk: s
      .manyToOne(() => desk)
      .fields("deskId")
      .references("id")
      .optional(),
    desks: s.oneToMany(() => desk),
  })
  .map("e4u1_tags");

const pin = s
  .model({
    id: s.int().id(),
    body: s.string(),
    deskId: s.int().nullable(),
    desk: s
      .manyToOne(() => desk)
      .fields("deskId")
      .references("id")
      .optional(),
  })
  .map("e4u1_pins");

/**
 * The COMPOUND twin of `desk.tag`: same fields-less `manyToOne` spelling, but the
 * resolved edge references a two-column unique. `edgeParentId` (E4-U2's site) still
 * refuses the adopt kinds on it.
 */
const bay = s
  .model({
    id: s.int().id(),
    region: s.string(),
    zone: s.string(),
    slot: s.manyToOne(() => slot).optional(),
    slots: s.oneToMany(() => slot),
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
      .manyToOne(() => bay)
      .fields("bayRegion", "bayZone")
      .references("region", "zone")
      .optional(),
    bays: s.oneToMany(() => bay),
  })
  .map("e4u1_slots");

/**
 * The no-inverse edge: `crate.holder` is a `manyToOne` with no `.fields()`, and `holder`
 * carries no to-one relation back to `crate` — only the to-many. `getFkDirection` has
 * nothing to resolve, and says so, BEFORE the deleted predicate would have been asked.
 */
const crate = s
  .model({
    id: s.int().id(),
    name: s.string(),
    holder: s.manyToOne(() => holder).optional(),
  })
  .map("e4u1_crates");

const holder = s
  .model({
    id: s.int().id(),
    name: s.string(),
    crates: s.oneToMany(() => crate),
  })
  .map("e4u1_holders");

/**
 * D5's scanner-alignment schema, on the create root: `author.books` carries
 * `.name("writer")`, and `book.author` — the only relation on `book` pointing back at
 * `author` — carries no name. Both scanners now read a sole back-reference as THE edge.
 */
const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    books: s.oneToMany(() => book).name("writer"),
  })
  .map("e4u1_authors");

const book = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s
      .manyToOne(() => author)
      .fields("authorId")
      .references("id")
      .optional(),
  })
  .map("e4u1_books");

const schema = { desk, tag, pin, bay, slot, crate, holder, author, book };

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
  describe(`E4-U1 fields-less manyToOne under a create root (${substrate.name})`, () => {
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
// THE TWO M8 GATES — probed, not re-decided
// =============================================================================

describe("E4-U1 the gates the D-wave closed", () => {
  test("a multi-kind payload on the widened edge meets D5's arity twin", async () => {
    const client = await setup(new PGliteDriver({ client: new PGlite() }));
    try {
      await client.tag.create({ data: { id: 11, code: "free" } });
      await expect(
        client.desk.create({
          data: {
            id: 4,
            label: "d",
            tag: { create: { id: 13, code: "x" }, connect: { id: 11 } },
          },
        })
      ).rejects.toThrow(UnsupportedOperationError);
      await expect(
        client.desk.create({
          data: {
            id: 4,
            label: "d",
            tag: { create: { id: 13, code: "x" }, connect: { id: 11 } },
          },
        })
      ).rejects.toThrow(
        "query-engine-v2 create supports one operation on the to-one relation 'tag'; it has connect, create."
      );
      // A construction refusal: neither arm ran, and the free row stayed free.
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

      // The name-mismatched sole back-reference resolves the same way on both scanners:
      // `author.books` is named, `book.author` is not, and the edge still works.
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
  test("a no-inverse edge dies at getFkDirection, before the deleted predicate", async () => {
    const client = await setup(new PGliteDriver({ client: new PGlite() }));
    try {
      await expect(
        client.crate.create({
          data: { id: 1, name: "c", holder: { create: { id: 1, name: "h" } } },
        })
      ).rejects.toThrow(
        "Cannot determine FK fields for relation 'holder'. Define the inverse relation with .fields([...]) or use explicit FK fields."
      );
      await expect(client.holder.findMany()).resolves.toEqual([]);
    } finally {
      await client.$disconnect();
    }
  }, 30_000);

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
