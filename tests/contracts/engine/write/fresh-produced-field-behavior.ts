import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE F — **a referenced column the DATABASE produces, published to the consumers
 * that demand it** (limitation-lift plan §4.3, §6 F).
 *
 * Measured at `5bf1893f`, at construction, on every substrate:
 *
 *   UnsupportedOperationError: query-engine-v2 create cannot resolve referenced field
 *   'serial' for relation 'crates': it is neither this record's primary key nor a
 *   knowable value in its own create data.
 *
 * THE POPULATION, measured rather than assumed. `autoGenerate` is the only generation
 * knob this schema language has, and `uuid`/`ulid`/`cuid`/`nanoid`/`now`/`updatedAt` all
 * carry an application default FACTORY the parse boundary materializes into the create
 * data (`assertApplicationGeneratedValues` refuses an omitted one outright). So the
 * database produces exactly one thing: an absent `increment` column — int or bigint by
 * construction, which is also why the published value's TEXT/parameter round trip is
 * exact. When that column is the record's single primary key the engine has published it
 * since N4-U4; when it is any OTHER referenced column the engine refused. That gap is
 * this file's subject, and the schema below is the first witness in the estate to carry
 * the shape: `depot.serial`, a NON-primary-key `.unique().increment()` that three
 * different seams reference.
 *
 * WHAT IS NOT LIFTED, and is asserted here so the split is not read as an accident: an
 * omitted NULLABLE unique (`depot.slot`) is an explicit `null` in the parsed create data,
 * a value no row holds. The 2026-08-06 maintainer ruling keeps that refusal, and the
 * message below is the same one the produced column used to raise.
 *
 * THE THREE SUBSTRATE ANSWERS, one mechanism each:
 *
 *  · **RETURNING in a transaction** — the column joins the INSERT's own RETURNING list.
 *    No extra statement, no extra round trip, and the consumer's destination cast is
 *    untouched because it lives at the consuming column, not at the projection.
 *  · **No RETURNING, in a transaction** (mysql2) — the INSERT keeps its shape and ONE
 *    focused read publishes every demanded field of that record by the created-row
 *    selector the compiler already owns. `insertId` may NAME the row for that read; it is
 *    never substituted for the column's value.
 *  · **A batch substrate** — refused, in its own sentence. A batch step's rows are not
 *    addressable and the reference scratch carries `insertId` alone, so this is a
 *    substrate fact and not "no row holds this value".
 *
 * The live assertions below are wrong-row assertions, not value comparisons: a decoy row
 * is seeded first so the sequence has already moved, and a child that borrowed a stale,
 * re-derived, or previous-statement value lands on the decoy.
 *
 * TWO SCHEMAS, because the DDL of the lifted shape is not portable and pretending it is
 * would make this file unrunnable on the provider that matters most. Measured from the
 * migration drivers:
 *
 *  · A non-primary `.increment()` column is PostgreSQL `SERIAL`/`BIGSERIAL` and MySQL
 *    `INT AUTO_INCREMENT` with an inline `UNIQUE` — legal on both, one auto column per
 *    table on MySQL. That is {@link producedFieldSchema}, and MySQL is the ONLY live
 *    exercise of F3's focused read.
 *  · A record carrying a generated primary key AND another produced column needs TWO
 *    auto-increment columns in one table. PostgreSQL takes it; MySQL rejects the DDL
 *    outright (`ER_WRONG_AUTO_KEY`: one auto column per table, and it must be a key).
 *    That is {@link twoSequenceSchema}, registered separately and pushed only where it
 *    is representable.
 *  · SQLite is absent from both: its migration driver emits
 *    `INTEGER PRIMARY KEY AUTOINCREMENT` for ANY auto-increment column, so a non-primary
 *    one collides with the table's own primary key and a `bigInt` one is refused. The
 *    engine's F2 path is live there — SQLite declares `supportsReturning` — but no
 *    schema this migration estate can push reaches it.
 */
export const producedFieldSchema = (() => {
  const depot = s
    .model({
      id: s.string().id(),
      name: s.string(),
      /** THE SHAPE: a database-produced column that is NOT the primary key. */
      serial: s.int().unique().increment(),
      /** The KEEP row: omitted nullable unique — an explicit `null`, naming no row. */
      slot: s.string().unique().nullable(),
      crates: s.oneToMany(() => crate),
      bins: s.oneToMany(() => bin),
      latches: s.oneToMany(() => latch),
      seal: s.oneToOne(() => seal).optional(),
    })
    .map("pkgf_depots");

  /** The KEEP consumer: it references the nullable unique, not the produced column. */
  const latch = s
    .model({
      id: s.string().id(),
      depotSlot: s.string().nullable(),
      depot: s
        .manyToOne(() => depot)
        .fields("depotSlot")
        .references("slot")
        .optional()
        .name("latches"),
    })
    .map("pkgf_latches");

  const crate = s
    .model({
      id: s.string().id(),
      depotSerial: s.int().nullable(),
      depot: s
        .manyToOne(() => depot)
        .fields("depotSerial")
        .references("serial")
        .optional(),
    })
    .map("pkgf_crates");

  /** A SECOND consumer of the same produced column — the double-registration probe. */
  const bin = s
    .model({
      id: s.string().id(),
      depotSerial: s.int().nullable(),
      depot: s
        .manyToOne(() => depot)
        .fields("depotSerial")
        .references("serial")
        .optional()
        .name("bins"),
    })
    .map("pkgf_bins");

  /** A shared primary key whose value is the parent's produced NON-primary column. */
  const seal = s
    .model({
      depotSerial: s.int().id(),
      note: s.string(),
      depot: s
        .oneToOne(() => depot)
        .fields("depotSerial")
        .references("serial"),
    })
    .map("pkgf_seals");

  return { depot, crate, bin, latch, seal };
})();

hydrateSchemaNames(producedFieldSchema);

/**
 * The TWO-SEQUENCE half: every model here needs two auto-increment columns in one table,
 * which is PostgreSQL-only DDL. Kept out of {@link producedFieldSchema} so the MySQL leg
 * — the only live exercise of F3's focused read — can push its schema at all.
 */
export const twoSequenceSchema = (() => {
  /** The generated-identity twin: a produced PK and a produced non-PK on ONE record,
   *  each with its own consumer, so demand for one cannot publish the other. */
  const hub = s
    .model({
      id: s.int().id().increment(),
      code: s.bigInt().unique().increment(),
      spans: s.oneToMany(() => span),
      marks: s.oneToMany(() => mark),
    })
    .map("pkgf_hubs");

  const span = s
    .model({
      id: s.string().id(),
      hubId: s.int().nullable(),
      hub: s
        .manyToOne(() => hub)
        .fields("hubId")
        .references("id")
        .optional(),
    })
    .map("pkgf_spans");

  const mark = s
    .model({
      id: s.string().id(),
      hubCode: s.bigInt().nullable(),
      hub: s
        .manyToOne(() => hub)
        .fields("hubCode")
        .references("code")
        .optional()
        .name("marks"),
    })
    .map("pkgf_marks");

  /**
   * THE CHANNEL-COLLISION shape. `key` is the generated primary key, so it publishes on
   * the historical `id` output; `id` is a produced NON-primary column that is literally
   * called `id`. One output name for two values is a silent wrong answer, so the produced
   * channel is namespaced. Structural only: this witness needs the compiled shape, not a
   * row, and no live leg pushes it.
   */
  const knob = s
    .model({
      key: s.int().id().increment(),
      id: s.int().unique().increment(),
      byKey: s.oneToMany(() => tab),
      byId: s.oneToMany(() => cog),
    })
    .map("pkgf_knobs");

  const tab = s
    .model({
      id: s.string().id(),
      knobKey: s.int().nullable(),
      knob: s
        .manyToOne(() => knob)
        .fields("knobKey")
        .references("key")
        .optional()
        .name("byKey"),
    })
    .map("pkgf_tabs");

  const cog = s
    .model({
      id: s.string().id(),
      knobId: s.int().nullable(),
      knob: s
        .manyToOne(() => knob)
        .fields("knobId")
        .references("id")
        .optional()
        .name("byId"),
    })
    .map("pkgf_cogs");

  return { hub, span, mark, knob, tab, cog };
})();

hydrateSchemaNames(twoSequenceSchema);

async function reset(client: any): Promise<void> {
  await client.crate.deleteMany({});
  await client.bin.deleteMany({});
  await client.latch.deleteMany({});
  await client.seal.deleteMany({});
  await client.depot.deleteMany({});
}

/**
 * Seed a decoy so the sequences have already advanced. Every assertion below then reads
 * "the child points at the row THIS statement made", not "the child points at some row".
 */
async function seedDecoy(client: any): Promise<number> {
  const decoy = await client.depot.create({ data: { id: "decoy", name: "d" } });
  await client.crate.create({
    data: { id: "c-decoy", depotSerial: decoy.serial },
  });
  return decoy.serial as number;
}

export function registerProducedFieldBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`F — a produced non-primary referenced column (${name})`, () => {
    test("a nested create leaf reads the column the parent's INSERT produced", async () => {
      const client = await connect();
      await reset(client);
      const decoySerial = await seedDecoy(client);

      const depot = await client.depot.create({
        data: { id: "d1", name: "D", crates: { create: { id: "c1" } } },
      });

      expect(depot.serial).not.toBe(decoySerial);
      const crate = await client.crate.findUnique({ where: { id: "c1" } });
      expect(crate?.depotSerial).toBe(depot.serial);
    });

    test("TWO consumers spend ONE published value", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);

      const depot = await client.depot.create({
        data: {
          id: "d2",
          name: "D",
          crates: { create: { id: "c2" } },
          bins: { create: { id: "b2" } },
        },
      });

      const crate = await client.crate.findUnique({ where: { id: "c2" } });
      const bin = await client.bin.findUnique({ where: { id: "b2" } });
      expect(crate?.depotSerial).toBe(depot.serial);
      expect(bin?.depotSerial).toBe(depot.serial);
    });

    test("a BEFORE-parent target publishes its produced column to the record that references it", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);

      const crate = await client.crate.create({
        data: { id: "c3", depot: { create: { id: "d3", name: "D" } } },
      });
      const depot = await client.depot.findUnique({ where: { id: "d3" } });
      expect(crate.depotSerial).toBe(depot?.serial);
    });

    test("the same value at an UPDATE root's before-root target", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);

      await client.crate.create({ data: { id: "c4" } });
      const updated = await client.crate.update({
        where: { id: "c4" },
        data: { depot: { create: { id: "d4", name: "D" } } },
      });
      const depot = await client.depot.findUnique({ where: { id: "d4" } });
      expect(updated.depotSerial).toBe(depot?.serial);
    });

    test("a SHARED primary key takes the parent's produced column", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);

      const seal = await client.seal.create({
        data: { note: "n", depot: { create: { id: "d5", name: "D" } } },
      });
      const depot = await client.depot.findUnique({ where: { id: "d5" } });
      expect(seal.depotSerial).toBe(depot?.serial);
    });

    test("KEEP: an omitted nullable unique still names no row, verbatim", async () => {
      const client = await connect();
      await reset(client);
      // `slot` is omitted, and nullable — so the parse boundary supplies an explicit
      // NULL. A foreign key equal to NULL references nothing and no round trip produces
      // a value for it, which is the maintainer's 2026-08-06 ruling. Same site, same
      // sentence, one column over from the produced one that now publishes.
      await expect(
        client.depot.create({
          data: { id: "d9", name: "D", latches: { create: { id: "l9" } } },
        })
      ).rejects.toThrow(
        "query-engine-v2 create cannot resolve the parent id for relation 'latches': referenced field 'slot' is neither this record's primary key nor a knowable value in its own create data."
      );
    });
  });
}

/**
 * The {@link twoSequenceSchema} half, registered on its own because only PostgreSQL can
 * host the table. One record, two live sequences, one consumer of each — so a consumer
 * that read the WRONG channel would still get a plausible integer, which is exactly the
 * confusion the namespaced produced channel exists to prevent.
 */
export function registerTwoSequenceBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`F — a produced PK beside a produced non-PK (${name})`, () => {
    test("they are two channels, not one", async () => {
      const client = await connect();
      await client.span.deleteMany({});
      await client.mark.deleteMany({});
      await client.hub.deleteMany({});
      await client.hub.create({ data: {} });
      await client.hub.create({ data: {} });

      const hub = await client.hub.create({
        data: {
          spans: { create: { id: "s1" } },
          marks: { create: { id: "m1" } },
        },
      });
      const span = await client.span.findUnique({ where: { id: "s1" } });
      const mark = await client.mark.findUnique({ where: { id: "m1" } });
      expect(span?.hubId).toBe(hub.id);
      expect(mark?.hubCode).toBe(hub.code);
    });
  });
}
