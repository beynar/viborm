/**
 * N5 — one captured pair is ONE slot transition.
 *
 * A singular junction member's transfer VACATES the slot the plan captured and
 * then inserts the pair the payload names. Entries that resolve to the same
 * target share that capture, so a second vacate deletes a row THIS operation
 * already removed: the direct arm read its own effect as a concurrent
 * membership change (`TransactionError … the captured owner's membership was
 * already removed; retry to converge`), while the batch arm queued a second
 * no-op DELETE and asserted nothing — the two routes did not agree on one end
 * state, which is the whole point of running the transfer on both.
 *
 * The vacate COUNT is pinned beside the end state on purpose: an end-state pin
 * alone would go green for an implementation that simply stopped asserting the
 * direct arm's `rowCount`, dropping the concurrent-removal detection that arm
 * exists for. On the batch route the envelope runs the body once outside its
 * region and again inside it, so the count is asked of each dispatched batch —
 * what a unit does, not how many units the envelope builds.
 *
 * The last world pins the KEY DOMAIN the slot is identified by. A junction
 * column carries whatever the referenced key carries, so spelling the captured
 * pair as text to recognise it again is not total: `JSON.stringify` THROWS on a
 * `bigint` (`TypeError: Do not know how to serialize a BigInt`, escaping this
 * engine's error surface entirely) and COLLIDES on a class with no `toJSON`.
 * The transition is therefore recognised by the captured VALUES themselves.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { RecordingSQLiteDriver } from "@tests/raptor3/g4/unit02/world";
import type Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { BatchOnlyDriver } from "./batch-only-drivers";

const shelf = s
  .model({
    id: s.string().id(),
    items: s
      .toMany(
        { book: () => book, note: () => note },
        { values: { book: "n5.book.v1", note: "n5.note.v1" } }
      )
      .through({
        book: { table: "n5_shelf_books", source: "holder", target: "entry" },
        note: { table: "n5_shelf_notes", source: "holder", target: "entry" },
      }),
  })
  .map("n5_shelves");
const book = s
  .model({
    id: s.string().id(),
    // A second addressable key: coalescing must follow the captured pair, not
    // the selector's text.
    title: s.string().unique(),
    // SINGULAR inverse: at most one shelf holds a given book, so a second
    // `connect` TRANSFERS the slot instead of adding a membership.
    shelf: s.toOne(() => shelf),
  })
  .map("n5_books");
const note = s
  .model({ id: s.string().id(), shelves: s.toMany(() => shelf) })
  .map("n5_notes");
const schema = { book, note, shelf };

const MEMBERSHIP_DELETE = /^DELETE FROM "n5_shelf_books"/;

/** Every dispatched batch, so the vacate count is asked of one unit at a time. */
class BatchRecordingDriver extends BatchOnlyDriver {
  readonly batches: string[][] = [];
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => query.sql));
    return super.executeBatch<T>(client, queries);
  }
}

for (const [route, make] of [
  ["interactive", () => new RecordingSQLiteDriver()],
  ["batch-only", () => new BatchRecordingDriver()],
] as const) {
  describe(`N5: the singular slot transition, ${route}`, () => {
    let driver: RecordingSQLiteDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.shelf.create({ data: { id: "left" } });
      await client.shelf.create({ data: { id: "right" } });
      await client.book.create({ data: { id: "b1", title: "Book one" } });
      await client.shelf.update({
        where: { id: "left" },
        data: { items: { connect: [{ type: "book", where: { id: "b1" } }] } },
      });
      driver.reset();
      if (driver instanceof BatchRecordingDriver) driver.batches.length = 0;
      return client;
    }

    const holder = async (client: Awaited<ReturnType<typeof world>>) =>
      (
        await client.book.findMany({
          select: { id: true, shelf: { select: { id: true } } },
        })
      ).map((row) => [row.id, row.shelf?.id]);

    /** The most times any one dispatched unit vacated the captured slot. */
    const vacates = (): number =>
      Math.max(
        0,
        ...(driver instanceof BatchRecordingDriver
          ? driver.batches.map(
              (batch) =>
                batch.filter((statement) => MEMBERSHIP_DELETE.test(statement))
                  .length
            )
          : [
              driver.statements.filter((statement) =>
                MEMBERSHIP_DELETE.test(statement.sql)
              ).length,
            ])
      );

    it("two entries naming the same target transfer the slot once", async () => {
      const client = await world();
      await client.shelf.update({
        where: { id: "right" },
        data: {
          items: {
            connect: [
              { type: "book", where: { id: "b1" } },
              { type: "book", where: { id: "b1" } },
            ],
          },
        },
      });
      assert.deepEqual(await holder(client), [["b1", "right"]]);
      assert.ok(vacates() <= 1, "the captured slot is vacated once");
    });

    it("two selectors resolving to the same row transfer the slot once", async () => {
      const client = await world();
      await client.shelf.update({
        where: { id: "right" },
        data: {
          items: {
            connect: [
              { type: "book", where: { id: "b1" } },
              { type: "book", where: { title: "Book one" } },
            ],
          },
        },
      });
      assert.deepEqual(await holder(client), [["b1", "right"]]);
      assert.ok(
        vacates() <= 1,
        "coalescing follows the captured pair, not its text"
      );
    });

    it("an exact reconnect writes no vacate and keeps the membership", async () => {
      const client = await world();
      await client.shelf.update({
        where: { id: "left" },
        data: { items: { connect: [{ type: "book", where: { id: "b1" } }] } },
      });
      assert.deepEqual(await holder(client), [["b1", "left"]]);
      assert.equal(
        vacates(),
        0,
        "the pair the payload names is the one captured"
      );
    });
  });
}

/**
 * The same world over a `bigInt` key: the domain `captured-identity-domains`
 * already establishes a capture decodes to a JS `bigint`.
 */
const bigShelf = s
  .model({
    id: s.string().id(),
    items: s
      .toMany(
        { book: () => bigBook, note: () => bigNote },
        { values: { book: "n5.bigbook.v1", note: "n5.bignote.v1" } }
      )
      .through({
        book: { table: "n5bg_shelf_books", source: "holder", target: "entry" },
        note: { table: "n5bg_shelf_notes", source: "holder", target: "entry" },
      }),
  })
  .map("n5bg_shelves");
const bigBook = s
  .model({
    id: s.bigInt().id(),
    title: s.string().unique(),
    shelf: s.toOne(() => bigShelf),
  })
  .map("n5bg_books");
const bigNote = s
  .model({ id: s.string().id(), shelves: s.toMany(() => bigShelf) })
  .map("n5bg_notes");
const bigSchema = { book: bigBook, note: bigNote, shelf: bigShelf };

const BIG_MEMBERSHIP_DELETE = /^DELETE FROM "n5bg_shelf_books"/;

for (const [route, make] of [
  ["interactive", () => new RecordingSQLiteDriver()],
  ["batch-only", () => new BatchRecordingDriver()],
] as const) {
  describe(`N5: the singular slot transition over a bigInt key, ${route}`, () => {
    let driver: RecordingSQLiteDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = make();
      const client = createClient({ schema: bigSchema, driver });
      await syncLiveSchema(client);
      await client.shelf.create({ data: { id: "left" } });
      await client.shelf.create({ data: { id: "right" } });
      await client.book.create({ data: { id: 7n, title: "Book seven" } });
      await client.shelf.update({
        where: { id: "left" },
        data: { items: { connect: [{ type: "book", where: { id: 7n } }] } },
      });
      driver.reset();
      if (driver instanceof BatchRecordingDriver) driver.batches.length = 0;
      return client;
    }

    const vacates = (): number =>
      Math.max(
        0,
        ...(driver instanceof BatchRecordingDriver
          ? driver.batches.map(
              (batch) =>
                batch.filter((statement) =>
                  BIG_MEMBERSHIP_DELETE.test(statement)
                ).length
            )
          : [
              driver.statements.filter((statement) =>
                BIG_MEMBERSHIP_DELETE.test(statement.sql)
              ).length,
            ])
      );

    it("transfers a slot captured on a bigInt key", async () => {
      const client = await world();
      await client.shelf.update({
        where: { id: "right" },
        data: { items: { connect: [{ type: "book", where: { id: 7n } }] } },
      });
      assert.deepEqual(
        (
          await client.book.findMany({
            select: { id: true, shelf: { select: { id: true } } },
          })
        ).map((row) => [row.id, row.shelf?.id]),
        [[7n, "right"]]
      );
      assert.equal(vacates(), 1, "the captured slot is vacated once");
    });

    it("two entries naming the same bigInt target transfer it once", async () => {
      const client = await world();
      await client.shelf.update({
        where: { id: "right" },
        data: {
          items: {
            connect: [
              { type: "book", where: { id: 7n } },
              { type: "book", where: { title: "Book seven" } },
            ],
          },
        },
      });
      assert.deepEqual(
        (
          await client.book.findMany({
            select: { id: true, shelf: { select: { id: true } } },
          })
        ).map((row) => [row.id, row.shelf?.id]),
        [[7n, "right"]]
      );
      assert.ok(
        vacates() <= 1,
        "coalescing follows the captured pair on every key domain"
      );
    });
  });
}
