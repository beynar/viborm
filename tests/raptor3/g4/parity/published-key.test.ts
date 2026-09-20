/**
 * N5 — **the shared-primary-key transition's PUBLISHED key.** A consumer
 * receives the value valid at its OWN execution point, after the effects it
 * stands behind (N1, D-51; the N3c finding, which was this unit's).
 *
 * A CORRELATED arm's target is the row its parent already points at, so when
 * that arm's own write moves the key it references the provider moves the
 * parent with it (`ON UPDATE CASCADE`) — before the parent's own statement
 * runs. The arm HOLDS that value in the parent's assignments
 * (`Assignments.hold`), the observation this operation holds of the row is
 * re-addressed from it (`CommandExecution.run`, case "record"), and every
 * consumer placed after the arm names the row by it: the record's own
 * statement, a sibling child-held lookup's membership, a descendant create's
 * foreign key, the terminal read. Every member of a compound key is published,
 * not only the ones the payload spelled.
 *
 * Placement, not verb, decides which key a nested lookup names: one placed
 * BEFORE the parent's write names the row as it is; a CHILD-HELD one, placed
 * after it, names the key that write published — the key the cascade has
 * already moved the child's foreign key onto.
 *
 * A `connect` is the control: it publishes a key the row does NOT hold yet, so
 * the record's own statement still addresses the row it located.
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

const account = s
  .model({
    id: s.string().id(),
    name: s.string(),
    card: s.toOne(() => card),
  })
  .map("n5_accounts");
/** The shared primary key: `accountId` is this row's identity AND its foreign key. */
const card = s
  .model({
    accountId: s.string().id(),
    label: s.string(),
    account: s
      .toOne(() => account)
      .fields("accountId")
      .references("id")
      .onUpdate("cascade"),
    chits: s.toMany(() => chit),
  })
  .map("n5_cards");
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
  .map("n5_chits");
const pair = s
  .model({
    id: s.string().id(),
    code: s.string(),
    slip: s.toOne(() => slip),
  })
  .unique(["id", "code"])
  .map("n5_pairs");
/** A COMPOUND shared edge: only one member is this row's own key. */
const slip = s
  .model({
    pairId: s.string().id(),
    pairCode: s.string().unique(),
    pair: s
      .toOne(() => pair)
      .fields("pairId", "pairCode")
      .references("id", "code")
      .onUpdate("cascade"),
    tokens: s.toMany(() => token),
  })
  .unique(["pairId", "pairCode"])
  .map("n5_slips");
const token = s
  .model({
    id: s.string().id(),
    slipCode: s.string(),
    slip: s
      .toOne(() => slip)
      .fields("slipCode")
      .references("pairCode"),
  })
  .map("n5_tokens");
const owner = s
  .model({
    id: s.int().id(),
    name: s.string(),
    held: s.toOne(() => piece),
  })
  .map("n5_owners");
/** The CHILD-HELD arm: its lookup is placed after the owner's own write. */
const piece = s
  .model({
    id: s.int().id(),
    label: s.string(),
    ownerId: s.int().nullable().unique(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id")
      .onUpdate("cascade"),
  })
  .map("n5_pieces");
const schema = { account, card, chit, owner, pair, piece, slip, token };

const UPDATE_ACCOUNTS = /^UPDATE "n5_accounts"/;
const SELECT_CHITS = /^SELECT .* FROM "n5_chits"/;
const UPDATE_CARDS = /^UPDATE "n5_cards"/;

for (const [route, make] of [
  [
    "live",
    (options?: SQLite3DriverOptions) => new RecordingSQLiteDriver(options),
  ],
  [
    "batch-only",
    (options?: SQLite3DriverOptions) => new BatchOnlyDriver(options),
  ],
] as const) {
  describe(`N5: the published key on the ${route} route`, () => {
    let driver: RecordingSQLiteDriver;
    const batch = route !== "live";
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world(options?: SQLite3DriverOptions) {
      driver = make(options);
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.account.create({ data: { id: "a1", name: "One" } });
      await client.account.create({ data: { id: "a2", name: "Two" } });
      await client.card.create({ data: { accountId: "a1", label: "Card" } });
      await client.chit.create({
        data: { id: "c1", cardId: "a1", body: "before" },
      });
      await client.pair.create({ data: { id: "i1", code: "k1" } });
      await client.slip.create({ data: { pairId: "i1", pairCode: "k1" } });
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.piece.create({
        data: { id: 1, label: "Piece", ownerId: 1 },
      });
      driver.reset();
      return client;
    }
    const statements = () =>
      driver.statements.map((statement) => statement.sql);
    const indexOf = (pattern: RegExp, from = 0) =>
      statements().findIndex(
        (sql, index) => index >= from && pattern.test(sql)
      );

    it("a before-child's transition publishes the key the record's own statement, its later children and the terminal read all name", async () => {
      const client = await world();
      assert.deepEqual(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: { update: { id: "moved" } },
            chits: {
              update: { where: { id: "c1" }, data: { body: "after" } },
              create: { id: "c2", body: "fresh" },
            },
          },
          select: { accountId: true },
        }),
        { accountId: "moved" }
      );
      assert.deepEqual(await client.chit.findMany({ orderBy: { id: "asc" } }), [
        { id: "c1", cardId: "moved", body: "after" },
        { id: "c2", cardId: "moved", body: "fresh" },
      ]);
      if (batch) {
        // The sibling lookup reads the key the transition moved, so it is an
        // ordered observation: it goes through the barrier, behind the batch
        // that carries the transition (N1).
        assert.ok(driver.batchCalls >= 2, `batches: ${driver.batchCalls}`);
      } else {
        const transition = indexOf(UPDATE_ACCOUNTS);
        assert.ok(transition >= 0, statements().join("\n"));
        assert.ok(
          indexOf(SELECT_CHITS, transition + 1) > transition,
          statements().join("\n")
        );
      }
    });

    it("a partial compound shared edge publishes every transitioned member, not only the row's own key", async () => {
      const client = await world();
      assert.deepEqual(
        await client.slip.update({
          where: { pairId: "i1" },
          data: {
            pair: { update: { id: "i2", code: "k2" } },
            tokens: { create: { id: "t1" } },
          },
          select: { pairId: true, pairCode: true },
        }),
        { pairId: "i2", pairCode: "k2" }
      );
      // `pairCode` is not this row's key, so only the publication carries it to
      // the descendant's foreign key.
      assert.deepEqual(await client.token.findMany(), [
        { id: "t1", slipCode: "k2" },
      ]);
    });

    it("a child-held arm placed after the parent's write names the key that write published", async () => {
      const client = await world();
      await client.owner.update({
        where: { id: 1 },
        data: {
          id: { increment: 1 },
          held: {
            upsert: {
              create: { id: 2, label: "Created" },
              update: { label: "Updated" },
            },
          },
        },
      });
      assert.deepEqual(await client.owner.findMany(), [
        { id: 2, name: "Owner" },
      ]);
      // The upsert took its UPDATE arm: its membership correlated on the key
      // the parent's own write published, which the cascade already moved the
      // child's foreign key onto.
      assert.deepEqual(await client.piece.findMany(), [
        { id: 1, label: "Updated", ownerId: 2 },
      ]);
    });

    it("a correlated arm that moves nothing leaves the row at the key it was located by", async () => {
      const client = await world();
      assert.deepEqual(
        await client.card.update({
          where: { accountId: "a1" },
          data: {
            account: { update: { name: "Renamed" } },
            chits: { create: { id: "c3", body: "same key" } },
          },
          select: { accountId: true },
        }),
        { accountId: "a1" }
      );
      assert.deepEqual(await client.chit.findMany({ where: { id: "c3" } }), [
        { id: "c3", cardId: "a1", body: "same key" },
      ]);
    });

    it("a correlated arm that took its MISSING arm moved nothing, so the row is still at the key it was located by", async () => {
      // Reaching the missing arm of a CORRELATED parent-held `upsert` needs a
      // row whose membership names NO target, and only the shared primary key
      // makes that observable: `accountId` is this row's identity AND its
      // foreign key, so re-addressing the observation by a key the row does
      // not hold moves the record's own `WHERE` off the row. The reference
      // must therefore not be enforced — a provider that has no foreign keys
      // (PlanetScale), or a schema pushed without them; here the database is
      // SUPPLIED with `foreign_keys` off, which is what SQLite is until a
      // caller turns it on (`SQLite3Driver.initClient` does, for the ones it
      // opens itself).
      const database = new Database(":memory:");
      database.pragma("foreign_keys = OFF");
      const client = await world({ client: database });
      await client.card.create({
        data: { accountId: "ghost", label: "Ghost" },
      });
      assert.deepEqual(
        await client.card.update({
          where: { accountId: "ghost" },
          data: {
            account: {
              upsert: {
                create: { id: "fresh", name: "Fresh" },
                update: { id: "moved" },
              },
            },
          },
          select: { accountId: true },
        }),
        { accountId: "fresh" }
      );
      // The hold was stated from the FOUND arm's payload, and that arm never
      // ran: nothing cascaded, so the card's own statement still addresses the
      // row it located and points it at the row the missing arm created.
      assert.deepEqual(
        await client.card.findMany({ orderBy: { accountId: "asc" } }),
        [
          { accountId: "a1", label: "Card" },
          { accountId: "fresh", label: "Ghost" },
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

    it("a connect publishes a key the row does not hold yet, so the record's own statement still addresses the row it located", async () => {
      const client = await world();
      assert.deepEqual(
        await client.card.update({
          where: { accountId: "a1" },
          data: { account: { connect: { id: "a2" } } },
          select: { accountId: true },
        }),
        { accountId: "a2" }
      );
      assert.ok(indexOf(UPDATE_CARDS) >= 0, statements().join("\n"));
      assert.deepEqual(await client.card.findMany(), [
        { accountId: "a2", label: "Card" },
      ]);
    });
  });
}
