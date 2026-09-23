/**
 * FC-02A — **a mutation consumes the values the row holds NOW, not the ones it
 * was observed holding.**
 *
 * A correlated arm that moves the key this row references moves this row with
 * it (`ON UPDATE CASCADE`) BEFORE the row's own statement runs, and the
 * attempt re-addresses the observation from the value the arm published
 * (`CommandExecution.run`, case "record"; `CommandAttempt.materialize`). From
 * that moment the row's CURRENT pre-write values are what
 * `CommandAttempt.read` answers — the one reader of a field's runtime value
 * (D-58) — and the row's ORIGINAL observation (`CommandAttempt.rows`) is a
 * different fact, kept for the consumers that need what was SEEN: a choice's
 * conditional skip, a `link`'s captured junction row.
 *
 * The update path consumes the current values for all three of its questions:
 * which row the statement addresses, what an arithmetic assignment computes
 * from, and which row the non-RETURNING readback names. Before this unit it
 * mixed them — the address was current, the arithmetic base and the readback
 * identity came from the original capture — so on a transport WITHOUT
 * RETURNING the statement changed the right row and then read it back at the
 * key the cascade had already left (`UPDATE did not produce the required
 * record`). MySQL is that transport natively; the qualification is
 * `tests/providers/docker/mysql2-cascaded-identity.test.ts`.
 *
 * The third route is a ROUTE control, not a falsifier: it runs the same cells
 * over the scratch-carried publication path, where a value a later statement
 * needs travels through the batch reference scratch instead of through a
 * RETURNING row. Substituting the statement's identity for the current row
 * turns nothing here red — the only arithmetic input a public payload reaches
 * today is a key, because a non-key field is never `demanded` and arithmetic
 * on a relation key field is refused at admission. The widened NON-key
 * arithmetic input has no public witness; its consumer is falsified through
 * `published-key`'s child-held batch cell, not here.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { SQLite3DriverOptions } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

const hub = s
  .model({ id: s.string().id(), cards: s.toMany(() => card) })
  .map("fc02a_hubs");
const account = s
  .model({ id: s.string().id(), name: s.string(), card: s.toOne(() => card) })
  .map("fc02a_accounts");
/** The shared primary key: `accountId` is this row's identity AND its foreign key. */
const card = s
  .model({
    accountId: s.string().id(),
    label: s.string(),
    tally: s.int(),
    hubId: s.string().nullable(),
    hub: s
      .toOne(() => hub)
      .fields("hubId")
      .references("id"),
    account: s
      .toOne(() => account)
      .fields("accountId")
      .references("id")
      .onUpdate("cascade"),
    chits: s.toMany(() => chit),
  })
  .map("fc02a_cards");
const chit = s
  .model({
    id: s.string().id(),
    cardId: s.string(),
    body: s.string(),
    card: s
      .toOne(() => card)
      .fields("cardId")
      .references("accountId")
      .onUpdate("cascade"),
  })
  .map("fc02a_chits");
const pair = s
  .model({
    id: s.string().id(),
    code: s.string(),
    slip: s.toOne(() => slip),
  })
  .unique(["id", "code"])
  .map("fc02a_pairs");
/** A COMPOUND shared edge: only one member is this row's own key. */
const slip = s
  .model({
    pairId: s.string().id(),
    pairCode: s.string().unique(),
    note: s.string(),
    pair: s
      .toOne(() => pair)
      .fields("pairId", "pairCode")
      .references("id", "code")
      .onUpdate("cascade"),
    tokens: s.toMany(() => token),
  })
  .unique(["pairId", "pairCode"])
  .map("fc02a_slips");
const token = s
  .model({
    id: s.string().id(),
    slipCode: s.string(),
    slip: s
      .toOne(() => slip)
      .fields("slipCode")
      .references("pairCode"),
  })
  .map("fc02a_tokens");
const schema = { account, card, chit, hub, pair, slip, token };

/**
 * The three transports this behavior has: RETURNING is the control, its
 * absence is the executed failure, and the batch route is where an arithmetic
 * assignment is computed from a captured value rather than from the column.
 */
const ROUTES = [
  ["live RETURNING", true, false],
  ["live non-RETURNING", false, false],
  ["batch-only", true, true],
] as const;

for (const [route, returning, batch] of ROUTES) {
  describe(`FC-02A: the cascaded current identity on the ${route} route`, () => {
    let driver: RecordingSQLiteDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world(options?: SQLite3DriverOptions) {
      driver = batch
        ? new BatchOnlyDriver(options)
        : new RecordingSQLiteDriver(options);
      driver.adapter.capabilities.supportsReturning = returning;
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.hub.create({ data: { id: "h1" } });
      await client.account.create({ data: { id: "a1", name: "One" } });
      await client.account.create({ data: { id: "a2", name: "Two" } });
      await client.card.create({
        data: { accountId: "a1", label: "before", tally: 3, hubId: "h1" },
      });
      await client.chit.create({
        data: { id: "c1", cardId: "a1", body: "before" },
      });
      await client.pair.create({ data: { id: "i1", code: "k1" } });
      await client.slip.create({
        data: { pairId: "i1", pairCode: "k1", note: "before" },
      });
      driver.reset();
      return client;
    }

    it("reads the holder back at the identity the cascade left it at", async () => {
      const client = await world();
      assert.deepEqual(
        await client.card.update({
          where: { accountId: "a1" },
          data: { label: "changed", account: { update: { id: "moved" } } },
          select: { accountId: true, label: true },
        }),
        { accountId: "moved", label: "changed" }
      );
      assert.deepEqual(await client.card.findMany(), [
        { accountId: "moved", label: "changed", tally: 3, hubId: "h1" },
      ]);
      assert.deepEqual(
        await client.account.findMany({ orderBy: { id: "asc" } }),
        [
          { id: "a2", name: "Two" },
          { id: "moved", name: "One" },
        ]
      );
    });

    it("names every member of a compound cascade at the readback", async () => {
      const client = await world();
      assert.deepEqual(
        await client.slip.update({
          where: { pairId: "i1" },
          data: { note: "after", pair: { update: { id: "i2", code: "k2" } } },
          select: { pairId: true, pairCode: true, note: true },
        }),
        { pairId: "i2", pairCode: "k2", note: "after" }
      );
      assert.deepEqual(await client.slip.findMany(), [
        { pairId: "i2", pairCode: "k2", note: "after" },
      ]);
      assert.deepEqual(await client.pair.findMany(), [
        { id: "i2", code: "k2" },
      ]);
    });

    it("computes the holder's arithmetic from the value the row holds, beside the cascade", async () => {
      // An `upsert` whose found arm takes the update: the non-key
      // `{ increment: 2 }` runs in the SAME statement as the cascade that
      // moves this row's key, and on the route without RETURNING that row
      // must still be read back at the key the cascade left it at, carrying
      // the tally it now holds.
      const client = await world();
      assert.deepEqual(
        await client.card.upsert({
          where: { accountId: "a1" },
          create: { accountId: "a1", label: "created", tally: 0 },
          update: {
            label: "counted",
            tally: { increment: 2 },
            account: { update: { id: "moved" } },
          },
          select: { accountId: true, label: true, tally: true },
        }),
        { accountId: "moved", label: "counted", tally: 5 }
      );
      assert.deepEqual(await client.card.findMany(), [
        { accountId: "moved", label: "counted", tally: 5, hubId: "h1" },
      ]);
      assert.deepEqual(
        await client.account.findMany({ orderBy: { id: "asc" } }),
        [
          { id: "a2", name: "Two" },
          { id: "moved", name: "One" },
        ]
      );
    });

    it("binds a descendant under the moved holder to the new key", async () => {
      const client = await world();
      assert.deepEqual(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            label: "parent",
            account: { update: { id: "moved" } },
            chits: {
              update: { where: { id: "c1" }, data: { body: "after" } },
              create: { id: "c2", body: "fresh" },
            },
          },
          select: { accountId: true, label: true },
        }),
        { accountId: "moved", label: "parent" }
      );
      assert.deepEqual(await client.chit.findMany({ orderBy: { id: "asc" } }), [
        { id: "c1", cardId: "moved", body: "after" },
        { id: "c2", cardId: "moved", body: "fresh" },
      ]);
    });

    it("re-addresses a NESTED holder the same way, and its descendant with it", async () => {
      const client = await world();
      await client.hub.update({
        where: { id: "h1" },
        data: {
          cards: {
            update: {
              where: { accountId: "a1" },
              data: {
                label: "nested",
                tally: { increment: 4 },
                account: { update: { id: "moved" } },
                chits: { create: { id: "c3", body: "nested" } },
              },
            },
          },
        },
      });
      assert.deepEqual(await client.card.findMany(), [
        { accountId: "moved", label: "nested", tally: 7, hubId: "h1" },
      ]);
      assert.deepEqual(await client.chit.findMany({ orderBy: { id: "asc" } }), [
        { id: "c1", cardId: "moved", body: "before" },
        { id: "c3", cardId: "moved", body: "nested" },
      ]);
    });

    it("leaves the row where it was located when the choice took its MISSING arm", async () => {
      // Reaching the missing arm of a CORRELATED parent-held `upsert` needs a
      // row whose membership names NO target, and only the shared primary key
      // makes that observable, so the reference must not be enforced: the
      // database is SUPPLIED with `foreign_keys` off (the same construction as
      // `published-key.test.ts`). The hold was stated from the FOUND arm's
      // payload and that arm never ran, so nothing cascaded and the row's own
      // statement still addresses the row it located — the current values and
      // the original observation agree, and the readback must not use the
      // key the found arm WOULD have published.
      const database = new Database(":memory:");
      database.pragma("foreign_keys = OFF");
      const client = await world({ client: database });
      await client.card.create({
        data: { accountId: "ghost", label: "ghost", tally: 1 },
      });
      assert.deepEqual(
        await client.card.update({
          where: { accountId: "ghost" },
          data: {
            label: "adopted",
            tally: { increment: 6 },
            account: {
              upsert: {
                create: { id: "fresh", name: "Fresh" },
                update: { id: "moved" },
              },
            },
          },
          select: { accountId: true, label: true, tally: true },
        }),
        { accountId: "fresh", label: "adopted", tally: 7 }
      );
      assert.deepEqual(
        await client.card.findMany({ orderBy: { accountId: "asc" } }),
        [
          { accountId: "a1", label: "before", tally: 3, hubId: "h1" },
          { accountId: "fresh", label: "adopted", tally: 7, hubId: null },
        ]
      );
      assert.deepEqual(
        await client.account.findMany({ orderBy: { id: "asc" } }),
        [
          { id: "a1", name: "One" },
          { id: "a2", name: "Two" },
          { id: "fresh", name: "Fresh" },
        ]
      );
    });

    it("takes the FOUND arm's published key when the choice found its target", async () => {
      const client = await world();
      assert.deepEqual(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            label: "upserted",
            tally: { increment: 5 },
            account: {
              upsert: {
                create: { id: "fresh", name: "Fresh" },
                update: { id: "moved" },
              },
            },
          },
          select: { accountId: true, label: true, tally: true },
        }),
        { accountId: "moved", label: "upserted", tally: 8 }
      );
      assert.deepEqual(await client.card.findMany(), [
        { accountId: "moved", label: "upserted", tally: 8, hubId: "h1" },
      ]);
      assert.deepEqual(
        await client.account.findMany({ orderBy: { id: "asc" } }),
        [
          { id: "a2", name: "Two" },
          { id: "moved", name: "One" },
        ]
      );
    });
  });
}
