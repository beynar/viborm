import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

/**
 * U-E6.0 — **the destination cast of a relation key.**
 *
 * Measured at 8c2908d, live, through the public client:
 *
 *   QueryError: Query execution failed  (code V2001)
 *
 * on all three dialects, for the same payload — a create root whose primary key is a
 * `dateTime`, adopting a child through the parent-held seam. What the two substrates
 * were actually handed:
 *
 *   FOUND  UPDATE "e60_entries" SET "atRef" = CAST(? AS TEXT) WHERE "id" = ?
 *   ABSENT INSERT INTO "e60_entries" ("id","body","atRef") VALUES (?, ?, CAST(? AS TEXT))
 *
 * and the servers' own words:
 *
 *   PostgreSQL 42804  column "atRef" is of type timestamp with time zone
 *                     but expression is of type text
 *   MySQL ER_TRUNCATED_WRONG_VALUE
 *                     Incorrect datetime value: '2020-01-01T00:00:00.000Z'
 *                     for column 'atRef' at row 1
 *
 * TWO defects in one lowering:
 *
 *  1. **The cast.** `getScalarCastType` answered `text` for every temporal type, a
 *     domain no temporal column has except on SQLite. PostgreSQL will not assign a
 *     `text` expression to a `timestamptz` column.
 *  2. **The spelling.** `referenceSql` bound the raw ISO-8601 string, `Z` and all,
 *     while every other datetime write in the engine goes through
 *     `adapter.literals.dateTime` — which strips the `Z` MySQL's `DATETIME` rejects.
 *     Measured separately on 8.4.10: `CAST(? AS CHAR)` with the NAIVE spelling is
 *     accepted, and `CAST(? AS DATETIME(3))` with the ISO one is not. The cast was
 *     never MySQL's problem; the spelling was.
 *
 * Both are the same rule, the one the decimal branch of `referenceSql` has enforced
 * since W6: **a foreign key is written exactly the way its own column is written.**
 *
 * They are TWO fixes and not one because they cover DIFFERENT witnesses, and the split
 * is not by dialect — it is by whether the key's value exists when the statement is
 * built. Measured by reverting each half alone against the live servers:
 *
 *   revert the cast  -> the UPDATE root's `connect` alone fails: the parent is LOCATED,
 *                       so its key reaches `referenceSql` as a `Ref` the concrete branch
 *                       cannot spell, and `SET "atRef" = CAST($1 AS TEXT)` is emitted
 *                       again. 42804 on PostgreSQL 16.14 and on PGlite, both substrates;
 *                       every concrete witness stays GREEN.
 *   revert the        -> the three CONCRETE witnesses fail — fresh-parent adopt, created
 *   spelling            child, connectOrCreate — on Docker MySQL only (errno 1292,
 *                       SQLSTATE 22007). PostgreSQL takes the ISO spelling into a
 *                       `timestamptz` happily, so no local substrate sees this half.
 *
 * That is why the MySQL leg below is load-bearing rather than decoration, and why the
 * UPDATE-root witness is not a fourth spelling of the first three.
 *
 * The witnesses are the reparent (FOUND) and the fresh child (ABSENT) at the
 * parent-held seam, on a `dateTime` referenced key, with the already-working
 * referenced types kept beside them as CONTROLS — `int` (still cast to INTEGER) and
 * `string` (still cast to TEXT). The controls are what keeps the fix from being "drop
 * the cast": the two types whose cast is right still wear it.
 *
 * Every witness runs after a DECOY world — a second slot holding its own entry — so a
 * reparent that moved a row it was not asked to move is observable as a changed decoy.
 */
export const destinationCastSchema = (() => {
  // The defect's own shape: the parent's identity is a `dateTime`, so the child's
  // foreign key column is `timestamptz` / `DATETIME(3)` / TEXT.
  const slot = s
    .model({
      at: s.dateTime().id(),
      label: s.string(),
      entries: s.toMany(() => entry),
    })
    .map("e60_slots");

  const entry = s
    .model({
      id: s.string().id(),
      body: s.string(),
      atRef: s.dateTime(),
      slot: s
        .toOne(() => slot)
        .fields("atRef")
        .references("at"),
    })
    .map("e60_entries");

  // CONTROL 1 — an `int` referenced key. Its destination cast is INTEGER and stays.
  const counter = s
    .model({
      seq: s.int().id(),
      label: s.string(),
      ticks: s.toMany(() => tick),
    })
    .map("e60_counters");

  const tick = s
    .model({
      id: s.string().id(),
      body: s.string(),
      seqRef: s.int(),
      counter: s
        .toOne(() => counter)
        .fields("seqRef")
        .references("seq"),
    })
    .map("e60_ticks");

  // CONTROL 2 — a `string` referenced key. Its destination cast is TEXT and stays.
  const folder = s
    .model({
      name: s.string().id(),
      label: s.string(),
      files: s.toMany(() => file),
    })
    .map("e60_folders");

  const file = s
    .model({
      id: s.string().id(),
      body: s.string(),
      nameRef: s.string(),
      folder: s
        .toOne(() => folder)
        .fields("nameRef")
        .references("name"),
    })
    .map("e60_files");

  return { slot, entry, counter, tick, folder, file };
})();

hydrateSchemaNames(destinationCastSchema);

/** The three moments the defect reproduced at, and one that never did. */
export const DECOY_AT = new Date("2019-03-03T03:03:03.000Z");
export const OLD_AT = new Date("2020-01-01T00:00:00.000Z");
export const FOUND_AT = new Date("2021-05-05T05:05:05.000Z");
export const ABSENT_AT = new Date("2022-06-06T06:06:06.000Z");

async function reset(client: any): Promise<void> {
  await client.entry.deleteMany({});
  await client.slot.deleteMany({});
  await client.tick.deleteMany({});
  await client.counter.deleteMany({});
  await client.file.deleteMany({});
  await client.folder.deleteMany({});
}

/** A complete, already-linked world beside every witness: its own slot, its own entry,
 *  its own counter/tick and folder/file. A write that reparents a row it was not asked
 *  to move lands here and is read back as a changed decoy. */
async function seedDecoy(client: any): Promise<void> {
  await client.slot.create({ data: { at: DECOY_AT, label: "decoy" } });
  await client.entry.create({
    data: { id: "e-decoy", body: "decoy", atRef: DECOY_AT },
  });
  await client.counter.create({ data: { seq: 900, label: "decoy" } });
  await client.tick.create({
    data: { id: "t-decoy", body: "decoy", seqRef: 900 },
  });
  await client.folder.create({ data: { name: "decoy", label: "decoy" } });
  await client.file.create({
    data: { id: "f-decoy", body: "decoy", nameRef: "decoy" },
  });
}

const isoOf = (value: unknown): string =>
  new Date(value as string).toISOString();

export function registerDestinationCastBehavior(
  name: string,
  connect: () => Promise<any>,
  register: (label: string, body: () => void) => void = describe
): void {
  register(`U-E6.0 the relation key's destination cast (${name})`, () => {
    test("dateTime FOUND: the adopt seam reparents the located child", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.slot.create({ data: { at: OLD_AT, label: "old" } });
      await client.entry.create({
        data: { id: "e-1", body: "held", atRef: OLD_AT },
      });

      await client.slot.create({
        data: {
          at: FOUND_AT,
          label: "fresh",
          entries: {
            // `update: {}` on purpose: the foreign key is not spelled anywhere in the
            // payload, so what fails (or works) is the reparent write's own lowering.
            upsert: {
              where: { id: "e-1" },
              create: { id: "e-1", body: "never" },
              update: {},
            },
          },
        },
      });

      const moved = await client.entry.findUnique({ where: { id: "e-1" } });
      expect(moved.body).toBe("held");
      expect(isoOf(moved.atRef)).toBe(FOUND_AT.toISOString());
      // The decoy still points at its own slot.
      const decoy = await client.entry.findUnique({ where: { id: "e-decoy" } });
      expect(isoOf(decoy.atRef)).toBe(DECOY_AT.toISOString());
    }, 120_000);

    test("dateTime ABSENT: the created child carries the fresh parent's key", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);

      await client.slot.create({
        data: {
          at: ABSENT_AT,
          label: "maker",
          entries: {
            upsert: {
              where: { id: "e-new" },
              create: { id: "e-new", body: "made" },
              update: {},
            },
          },
        },
      });

      const made = await client.entry.findUnique({ where: { id: "e-new" } });
      expect(made.body).toBe("made");
      expect(isoOf(made.atRef)).toBe(ABSENT_AT.toISOString());
      const decoy = await client.entry.findUnique({ where: { id: "e-decoy" } });
      expect(isoOf(decoy.atRef)).toBe(DECOY_AT.toISOString());
    }, 120_000);

    test("dateTime through connectOrCreate: the same seam, the same key", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.slot.create({ data: { at: OLD_AT, label: "old" } });
      await client.entry.create({
        data: { id: "e-2", body: "held", atRef: OLD_AT },
      });

      await client.slot.create({
        data: {
          at: FOUND_AT,
          label: "adopter",
          entries: {
            connectOrCreate: {
              where: { id: "e-2" },
              create: { id: "e-2", body: "never" },
            },
          },
        },
      });

      const moved = await client.entry.findUnique({ where: { id: "e-2" } });
      expect(moved.body).toBe("held");
      expect(isoOf(moved.atRef)).toBe(FOUND_AT.toISOString());
      const decoy = await client.entry.findUnique({ where: { id: "e-decoy" } });
      expect(isoOf(decoy.atRef)).toBe(DECOY_AT.toISOString());
    }, 120_000);

    test("dateTime at an UPDATE root: connect writes the located parent's key", async () => {
      // The other seam that lowers a relation key through `referenceSql`: the parent is
      // located, not created, so the value is the planning read's own column.
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.slot.create({ data: { at: OLD_AT, label: "old" } });
      await client.slot.create({ data: { at: FOUND_AT, label: "target" } });
      await client.entry.create({
        data: { id: "e-3", body: "held", atRef: OLD_AT },
      });

      await client.slot.update({
        where: { at: FOUND_AT },
        data: { label: "target2", entries: { connect: { id: "e-3" } } },
      });

      const moved = await client.entry.findUnique({ where: { id: "e-3" } });
      expect(isoOf(moved.atRef)).toBe(FOUND_AT.toISOString());
      const decoy = await client.entry.findUnique({ where: { id: "e-decoy" } });
      expect(isoOf(decoy.atRef)).toBe(DECOY_AT.toISOString());
    }, 120_000);

    test("CONTROL int: the already-working referenced type is unchanged", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.counter.create({ data: { seq: 1, label: "old" } });
      await client.tick.create({
        data: { id: "t-1", body: "held", seqRef: 1 },
      });

      await client.counter.create({
        data: {
          seq: 2,
          label: "fresh",
          ticks: {
            upsert: {
              where: { id: "t-1" },
              create: { id: "t-1", body: "never" },
              update: {},
            },
          },
        },
      });

      expect(
        (await client.tick.findUnique({ where: { id: "t-1" } })).seqRef
      ).toBe(2);
      expect(
        (await client.tick.findUnique({ where: { id: "t-decoy" } })).seqRef
      ).toBe(900);
    }, 120_000);

    test("CONTROL string: the already-working referenced type is unchanged", async () => {
      const client = await connect();
      await reset(client);
      await seedDecoy(client);
      await client.folder.create({ data: { name: "old", label: "old" } });
      await client.file.create({
        data: { id: "f-1", body: "held", nameRef: "old" },
      });

      await client.folder.create({
        data: {
          name: "fresh",
          label: "fresh",
          files: {
            upsert: {
              where: { id: "f-1" },
              create: { id: "f-1", body: "never" },
              update: {},
            },
          },
        },
      });

      expect(
        (await client.file.findUnique({ where: { id: "f-1" } })).nameRef
      ).toBe("fresh");
      expect(
        (await client.file.findUnique({ where: { id: "f-decoy" } })).nameRef
      ).toBe("decoy");
    }, 120_000);
  });
}
