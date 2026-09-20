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
 * The last group pins the LIMIT of that sentence, which the cells above cannot
 * see because every key they write is itself a `Date`, so the payload's
 * spelling and the capture's are the same one by construction. A payload may
 * also arrive as a valid ISO STRING, which the admission boundary keeps
 * unchanged (`ok(value)`, `validation/primitives/iso.ts:94`) and which the
 * SQLite adapter stores byte for byte in a TEXT `dateTime` column
 * (`sqlite-adapter.ts:288-296`) — while a capture of that row decodes to a
 * `Date` and re-binds `Date.prototype.toISOString`'s spelling. So a key the
 * payload wrote without milliseconds, or with a UTC offset, is stored as bytes
 * no capture reproduces, and the captured route answers the registered
 * cardinality refusal instead of the row. That is a RESIDUAL, recorded in
 * `g4/release/n5/note.md` §6: the spelling has exactly one owner and this
 * engine re-uses it rather than adding a second, so the cells below pin what is
 * measured rather than a repair.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

/** The cardinality sentence a stale capture answers with. */
const STALE_CAPTURE =
  /selected-row cardinality changed during its locked mutation/;

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
const schema = { amount, clock, count, day, instant, note, slot };

const FIRST = new Date("2020-01-01T00:00:00.000Z");
const SECOND = new Date("2021-01-01T00:00:00.000Z");

/** Every key domain an identity can carry, and the two rows it captures. */
const domains = {
  instant: [FIRST, SECOND],
  day: [FIRST, SECOND],
  count: [10n, 20n],
  amount: ["10.5", "20.25"],
  clock: ["01:02:03", "04:05:06"],
} as const;

describe("N5: a captured identity is re-bound through the admitted wire form", () => {
  let driver: RecordingSQLiteDriver | undefined;
  afterEach(async () => {
    await driver?.disconnect();
    driver = undefined;
  });

  for (const [model, keys] of Object.entries(domains))
    it(`captures and re-binds a ${model} key on a transport without RETURNING`, async () => {
      driver = new CapturingSQLiteDriver();
      const client = createClient({ schema, driver }) as never as Record<
        string,
        {
          create: (args: unknown) => Promise<unknown>;
          findMany: (args?: unknown) => Promise<{ n: number }[]>;
          updateMany: (args: unknown) => Promise<unknown[]>;
        }
      >;
      await syncLiveSchema(client as never);
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

  for (const [spelling, addressable] of [
    ["2020-03-01T10:00:00.000Z", true],
    ["2020-03-01T10:00:00Z", false],
    ["2020-03-01T10:00:00+02:00", false],
  ] as const)
    it(`${addressable ? "re-binds" : "cannot re-bind"} a TEXT dateTime key the payload spelled ${spelling}`, async () => {
      driver = new CapturingSQLiteDriver();
      const client = createClient({ schema, driver }) as never as {
        instant: {
          create: (args: unknown) => Promise<unknown>;
          findMany: (args?: unknown) => Promise<{ n: number }[]>;
          updateMany: (args: unknown) => Promise<unknown[]>;
        };
      };
      await syncLiveSchema(client as never);
      await client.instant.create({ data: { id: spelling, tag: "t", n: 0 } });
      const update = () =>
        client.instant.updateMany({
          where: { tag: "t" },
          data: { n: 1 },
          select: { id: true },
        });
      if (!addressable) {
        await assert.rejects(update, STALE_CAPTURE);
        return;
      }
      assert.equal((await update()).length, 1);
      assert.deepEqual(
        (await client.instant.findMany()).map((row) => row.n),
        [1]
      );
    });

  it("reads a to-many through a captured dateTime key on a batch-only RETURNING transport", async () => {
    driver = new BatchOnlyDriver();
    const client = createClient({ schema, driver }) as never as {
      note: { create: (args: unknown) => Promise<unknown> };
      slot: {
        create: (args: unknown) => Promise<unknown>;
        delete: (args: unknown) => Promise<{
          label: string;
          notes: { id: string }[];
        }>;
        findMany: (args?: unknown) => Promise<unknown[]>;
      };
    };
    await syncLiveSchema(client as never);
    await client.slot.create({ data: { at: FIRST, label: "L" } });
    await client.note.create({ data: { id: "n1", slotAt: FIRST } });

    // The root's own identity is decoded from the deleted row and the included
    // collection correlates on it — the D1-shaped route N4's review measured.
    const deleted = await client.slot.delete({
      where: { at: FIRST },
      include: { notes: true },
    });
    assert.equal(deleted.label, "L");
    assert.deepEqual(
      deleted.notes.map((row) => row.id),
      ["n1"]
    );
    assert.deepEqual(await client.slot.findMany({}), []);
  });
});
