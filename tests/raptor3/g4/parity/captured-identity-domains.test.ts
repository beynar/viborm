/**
 * N5 — a value this engine DECODED is re-bound as an operand, and the wire
 * form it crosses on is the one the admission boundary owns.
 *
 * An identity captured from a row (`schema.identity` over a decoded row) flows
 * back into `UPDATE … WHERE ("id" = ? OR "id" = ?)`, into a membership
 * correlation and into the premises that protect them. The DECODED form of an
 * instant is a `Date`, and no provider binds one ("SQLite3 can only bind
 * numbers, strings, bigints, buffers, and null"), so the captured routes
 * answered a `QueryError` for a `dateTime` or `date` key while the same row
 * was perfectly addressable — `Queries.scalarValue` re-states the ISO spelling
 * `validation/primitives/iso.ts` produces from a `Date`.
 *
 * The other identity domains are the control, and they are MEASURED rather
 * than assumed: `bigint`, `decimal` and `time` decode to values a provider
 * already binds, and `blob`, `json`, `point` and `vector` can be neither a key
 * nor a unique (the schema refuses both), so no identity ever carries one.
 *
 * The last groups pin the LIMIT of that sentence, which the cells above cannot
 * see because every key they write is itself a `Date`, so the payload's
 * spelling and the capture's are the same one by construction. A payload may
 * also arrive as a valid ISO STRING, which the admission boundary keeps
 * unchanged (`ok(value)`, `validation/primitives/iso.ts:94`) and which the
 * SQLite adapter stores byte for byte in a TEXT `dateTime` column
 * (`sqlite-adapter.ts:288-296`).
 *
 * FC-02B repaired that: the codec ALREADY separates an INTERNAL read from a
 * PUBLIC one — `shared/decimal.ts`'s `decodeDecimalScalar` keeps the codec's
 * physical form internally and materializes the `Decimal` publicly — and the
 * `datetime` arm now takes the same seam. An internal read of a TEXT-stored
 * `dateTime` keeps the PROVIDER's own spelling, so the captured identity binds
 * the stored bytes back (`encodePhysicalDateTime(iso, "text")` is the
 * identity) and addresses its row; a public read still materializes the
 * `Date`. Two spellings of ONE instant stay two addresses, because each
 * capture carries the bytes its own row holds. So the cells that recorded the
 * residual (`g4/release/n5/note.md` §6) now pin the repair, and the numeric
 * storage forms, `date`, `bigint`, `decimal` and `time` are the controls that
 * measure it changed nothing for them.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s, TYPES } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

/** The transport with no RETURNING: the shape that CAPTURES the rows it writes. */
class CapturingSQLiteDriver extends RecordingSQLiteDriver {
  constructor() {
    super();
    this.adapter.capabilities.supportsReturning = false;
  }
}

const instant = s
  .model({ id: s.dateTime().id(), tag: s.string(), n: s.int() })
  .map("n5cid_instants");
const day = s
  .model({ id: s.date().id(), tag: s.string(), n: s.int() })
  .map("n5cid_days");
const count = s
  .model({ id: s.bigInt().id(), tag: s.string(), n: s.int() })
  .map("n5cid_counts");
const amount = s
  .model({
    id: s.decimal({ precision: 10, scale: 2 }).id(),
    tag: s.string(),
    n: s.int(),
  })
  .map("n5cid_amounts");
const clock = s
  .model({ id: s.time().id(), tag: s.string(), n: s.int() })
  .map("n5cid_clocks");
/** The NUMERIC storage controls: the physical value is a number, not a spelling. */
const tick = s
  .model({
    id: s.dateTime(TYPES.SQLITE.DATETIME.INTEGER).id(),
    tag: s.string(),
    n: s.int(),
  })
  .map("n5cid_ticks");
const julian = s
  .model({
    id: s.dateTime(TYPES.SQLITE.DATETIME.REAL).id(),
    tag: s.string(),
    n: s.int(),
  })
  .map("n5cid_julians");
/** A COMPOUND identity one of whose members is the TEXT `dateTime`. */
const shift = s
  .model({ at: s.dateTime(), code: s.string(), tag: s.string(), n: s.int() })
  .id(["at", "code"])
  .map("n5cid_shifts");
/** A row whose identity OMITS the `dateTime`: the column is an ordinary one. */
const mark = s
  .model({
    id: s.string().id(),
    at: s.dateTime(),
    tag: s.string(),
    n: s.int(),
  })
  .map("n5cid_marks");
/** The D1 shape: a to-many read through a `dateTime` referenced key. */
const slot = s
  .model({
    at: s.dateTime().id(),
    label: s.string(),
    notes: s.toMany(() => note).name("n5cidSlot"),
  })
  .map("n5cid_slots");
const note = s
  .model({
    id: s.string().id(),
    slotAt: s.dateTime().nullable(),
    slot: s
      .toOne(() => slot)
      .fields("slotAt")
      .references("at")
      .name("n5cidSlot"),
  })
  .map("n5cid_notes");
const schema = {
  amount,
  clock,
  count,
  day,
  instant,
  julian,
  mark,
  note,
  shift,
  slot,
  tick,
};

const FIRST = new Date("2020-01-01T00:00:00.000Z");
const SECOND = new Date("2021-01-01T00:00:00.000Z");

/** Every key domain an identity can carry, and the two rows it captures. */
const domains = {
  instant: [FIRST, SECOND],
  day: [FIRST, SECOND],
  count: [10n, 20n],
  amount: ["10.5", "20.25"],
  clock: ["01:02:03", "04:05:06"],
  tick: [FIRST, SECOND],
  julian: [FIRST, SECOND],
} as const;

/** The one instant `2020-03-01T10:00:00Z`, in three valid ISO spellings. */
const CANONICAL = "2020-03-01T10:00:00.000Z";
const NO_MILLISECONDS = "2020-03-01T10:00:00Z";
const OFFSET = "2020-03-01T12:00:00+02:00";
const INSTANT = Date.parse(CANONICAL);

type ModelClient = {
  create: (args: unknown) => Promise<unknown>;
  findMany: (args?: unknown) => Promise<Record<string, unknown>[]>;
  updateMany: (args: unknown) => Promise<Record<string, unknown>[]>;
};

describe("N5: a captured identity is re-bound through the admitted wire form", () => {
  let driver: RecordingSQLiteDriver | undefined;
  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  const capturing = async (): Promise<Record<string, ModelClient>> => {
    driver = new CapturingSQLiteDriver();
    const client = createClient({ schema, driver }) as never as Record<
      string,
      ModelClient
    >;
    await syncLiveSchema(client as never);
    return client;
  };

  for (const [model, keys] of Object.entries(domains))
    it(`captures and re-binds a ${model} key on a transport without RETURNING`, async () => {
      const client = await capturing();
      for (const id of keys)
        await client[model]!.create({ data: { id, tag: "t", n: 0 } });

      // The captured route: no RETURNING, so the members are read first and
      // the write addresses them by the identity that read answered.
      const updated = await client[model]!.updateMany({
        where: { tag: "t" },
        data: { n: 1 },
        select: { id: true },
      });
      assert.equal(updated.length, 2);
      assert.deepEqual(
        (await client[model]!.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.n
        ),
        [1, 1]
      );
    });

  // FC-02B: each of these spellings is stored byte for byte, and the capture
  // now carries the STORED bytes rather than re-spelling the instant, so each
  // row is addressable through the captured route. The public result is still
  // the `Date` of that instant.
  for (const spelling of [FIRST, CANONICAL, NO_MILLISECONDS, OFFSET])
    it(`re-binds a TEXT dateTime key the payload spelled ${spelling instanceof Date ? "as a Date payload" : spelling}`, async () => {
      const expected = new Date(spelling).getTime();
      const client = await capturing();
      await client.instant!.create({ data: { id: spelling, tag: "t", n: 0 } });
      const updated = await client.instant!.updateMany({
        where: { tag: "t" },
        data: { n: 1 },
        select: { id: true },
      });
      assert.equal(updated.length, 1);
      // Public output is the DECODED instant, not the stored spelling.
      assert.ok(updated[0]!.id instanceof Date);
      assert.equal((updated[0]!.id as Date).getTime(), expected);
      const rows = await client.instant!.findMany();
      assert.deepEqual(
        rows.map((row) => row.n),
        [1]
      );
      assert.ok(rows[0]!.id instanceof Date);
      // The stored bytes were not rewritten: the exact spelling still addresses
      // the row, and only it does.
      assert.equal(
        (await client.instant!.findMany({ where: { id: spelling } })).length,
        1
      );
    });

  it("FC-02B: two spellings of ONE instant stay two addresses, each captured by its own bytes", async () => {
    const client = await capturing();
    await client.instant!.create({ data: { id: CANONICAL, tag: "a", n: 0 } });
    await client.instant!.create({ data: { id: OFFSET, tag: "b", n: 0 } });

    // Capturing ONE of them addresses only it: the capture carries that row's
    // bytes, so the sibling that names the same instant is never conflated
    // with it.
    const one = await client.instant!.updateMany({
      where: { tag: "a" },
      data: { n: 1 },
      select: { id: true },
    });
    assert.equal(one.length, 1);
    assert.deepEqual(
      (await client.instant!.findMany({ orderBy: { tag: "asc" } })).map(
        (row) => [row.tag, row.n]
      ),
      [
        ["a", 1],
        ["b", 0],
      ]
    );

    // Capturing BOTH at once addresses both, each by its own spelling, and the
    // complement premise that protects a whole captured set still holds.
    const both = await client.instant!.updateMany({
      where: { n: { lt: 9 } },
      data: { n: 2 },
      select: { id: true },
    });
    assert.equal(both.length, 2);
    const rows = await client.instant!.findMany({ orderBy: { tag: "asc" } });
    assert.deepEqual(
      rows.map((row) => row.n),
      [2, 2]
    );
    // Both rows decode to the SAME public instant while remaining two rows.
    assert.deepEqual(
      rows.map((row) => (row.id as Date).getTime()),
      [INSTANT, INSTANT]
    );
  });

  it("FC-02B: a COMPOUND identity whose dateTime member is a non-canonical spelling", async () => {
    const client = await capturing();
    await client.shift!.create({
      data: { at: NO_MILLISECONDS, code: "c1", tag: "t", n: 0 },
    });
    await client.shift!.create({
      data: { at: OFFSET, code: "c2", tag: "t", n: 0 },
    });
    const updated = await client.shift!.updateMany({
      where: { tag: "t" },
      data: { n: 1 },
      select: { at: true, code: true },
    });
    assert.equal(updated.length, 2);
    assert.deepEqual(
      (await client.shift!.findMany({ orderBy: { code: "asc" } })).map(
        (row) => row.n
      ),
      [1, 1]
    );
    assert.deepEqual(
      (await client.shift!.findMany({ orderBy: { code: "asc" } })).map((row) =>
        (row.at as Date).getTime()
      ),
      [INSTANT, INSTANT]
    );
  });

  it("FC-02B: an identity that OMITS the dateTime leaves the column an ordinary one", async () => {
    const client = await capturing();
    await client.mark!.create({
      data: { id: "m1", at: OFFSET, tag: "t", n: 0 },
    });
    const updated = await client.mark!.updateMany({
      where: { tag: "t" },
      data: { n: 1 },
      select: { id: true, at: true },
    });
    assert.equal(updated.length, 1);
    assert.ok(updated[0]!.at instanceof Date);
    assert.equal((updated[0]!.at as Date).getTime(), INSTANT);
    // The mutation rewrote nothing but `n`: the stored spelling still answers.
    assert.equal(
      (await client.mark!.findMany({ where: { at: OFFSET } })).length,
      1
    );
  });

  it("FC-02B: a captured non-canonical key is the REFERENCE VALUE a nested create writes", async () => {
    driver = new CapturingSQLiteDriver();
    const client = createClient({ schema, driver }) as never as {
      slot: {
        create: (args: unknown) => Promise<unknown>;
        update: (args: unknown) => Promise<{ label: string }>;
        findMany: (
          args?: unknown
        ) => Promise<{ at: Date; notes: { id: string }[] }[]>;
      };
    };
    await syncLiveSchema(client as never);
    await client.slot.create({ data: { at: NO_MILLISECONDS, label: "L" } });

    // The parent row is captured (no RETURNING), and the child's foreign key is
    // the value that capture carries — the second consumer of the internal
    // decode, beside the address itself.
    const updated = await client.slot.update({
      where: { at: NO_MILLISECONDS },
      data: { label: "L2", notes: { create: { id: "n1" } } },
    });
    assert.equal(updated.label, "L2");
    const rows = await client.slot.findMany({ include: { notes: true } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.at.getTime(), INSTANT);
    assert.deepEqual(
      rows[0]!.notes.map((row) => row.id),
      ["n1"]
    );
  });

  for (const spelling of [CANONICAL, NO_MILLISECONDS, OFFSET])
    it(`reads a to-many through a captured dateTime key spelled ${spelling} on a batch-only RETURNING transport`, async () => {
      driver = new BatchOnlyDriver();
      const client = createClient({ schema, driver }) as never as {
        note: { create: (args: unknown) => Promise<unknown> };
        slot: {
          create: (args: unknown) => Promise<unknown>;
          delete: (args: unknown) => Promise<{
            at: Date;
            label: string;
            notes: { id: string }[];
          }>;
          findMany: (args?: unknown) => Promise<unknown[]>;
        };
      };
      await syncLiveSchema(client as never);
      await client.slot.create({ data: { at: spelling, label: "L" } });
      await client.note.create({ data: { id: "n1", slotAt: spelling } });

      // The root's own identity is decoded from the deleted row and the
      // included collection correlates on it — the D1-shaped route N4's review
      // measured.
      const deleted = await client.slot.delete({
        where: { at: spelling },
        include: { notes: true },
      });
      assert.equal(deleted.label, "L");
      assert.equal(deleted.at.getTime(), INSTANT);
      assert.deepEqual(
        deleted.notes.map((row) => row.id),
        ["n1"]
      );
      assert.deepEqual(await client.slot.findMany({}), []);
    });
});
