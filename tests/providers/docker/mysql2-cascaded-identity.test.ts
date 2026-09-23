/**
 * FC-02A — **the cascaded current identity, on the transport that has no
 * RETURNING of its own.**
 *
 * MySQL is the only adapter in the tree that declares
 * `supportsReturning: false` (`mysql-adapter.ts`), so the engine must NAME the
 * row it just updated and read it back in a second statement. When a
 * correlated arm moved that row first (`ON UPDATE CASCADE`), the row is no
 * longer at the key the operation observed: the readback has to name the key
 * the cascade left it at. The capability-forced SQLite pins
 * (`tests/raptor3/g4/parity/cascaded-current-identity.test.ts`) prove the
 * engine's answer; this file is the same behavior on the provider that reaches
 * it natively, with no capability changed by the test.
 *
 * The suite owns five `fc02a_*` tables, creates them verbatim and drops only
 * those: the database is shared, so nothing here pushes a schema or drops
 * anything it did not create.
 *
 * NOTE: requires a running MySQL (docker). Set MYSQL_TEST_CONNECTION_STRING.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createMySQL2Driver, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

const account = s
  .model({ id: s.string().id(), name: s.string(), card: s.toOne(() => card) })
  .map("fc02a_accounts");
/** The shared primary key: `accountId` is this row's identity AND its foreign key. */
const card = s
  .model({
    accountId: s.string().id(),
    label: s.string(),
    tally: s.int(),
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
  .model({ id: s.string().id(), code: s.string(), slip: s.toOne(() => slip) })
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
  })
  .unique(["pairId", "pairCode"])
  .map("fc02a_slips");
const schema = { account, card, chit, pair, slip };

/** Children first: a table is dropped before the table it references. */
const TABLES = [
  "fc02a_chits",
  "fc02a_cards",
  "fc02a_accounts",
  "fc02a_slips",
  "fc02a_pairs",
];
const DDL = [
  "CREATE TABLE `fc02a_accounts` (`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, PRIMARY KEY (`id`))",
  "CREATE TABLE `fc02a_cards` (`accountId` VARCHAR(191) NOT NULL, `label` VARCHAR(191) NOT NULL, `tally` INT NOT NULL, PRIMARY KEY (`accountId`), CONSTRAINT `fc02a_cards_account` FOREIGN KEY (`accountId`) REFERENCES `fc02a_accounts` (`id`) ON UPDATE CASCADE ON DELETE CASCADE)",
  "CREATE TABLE `fc02a_chits` (`id` VARCHAR(191) NOT NULL, `cardId` VARCHAR(191) NOT NULL, `body` VARCHAR(191) NOT NULL, PRIMARY KEY (`id`), CONSTRAINT `fc02a_chits_card` FOREIGN KEY (`cardId`) REFERENCES `fc02a_cards` (`accountId`) ON UPDATE CASCADE ON DELETE CASCADE)",
  "CREATE TABLE `fc02a_pairs` (`id` VARCHAR(191) NOT NULL, `code` VARCHAR(191) NOT NULL, PRIMARY KEY (`id`), UNIQUE KEY `fc02a_pairs_key` (`id`, `code`))",
  "CREATE TABLE `fc02a_slips` (`pairId` VARCHAR(191) NOT NULL, `pairCode` VARCHAR(191) NOT NULL, `note` VARCHAR(191) NOT NULL, PRIMARY KEY (`pairId`), UNIQUE KEY `fc02a_slips_code` (`pairCode`), UNIQUE KEY `fc02a_slips_key` (`pairId`, `pairCode`), CONSTRAINT `fc02a_slips_pair` FOREIGN KEY (`pairId`, `pairCode`) REFERENCES `fc02a_pairs` (`id`, `code`) ON UPDATE CASCADE ON DELETE CASCADE)",
];

describeIf("FC-02A: the cascaded current identity on native MySQL", () => {
  const client = createClient({ schema, driver: createMySQL2Driver() });

  beforeAll(async () => {
    for (const table of TABLES)
      await client.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${table}\``);
    for (const statement of DDL) await client.$executeRawUnsafe(statement);
  });

  afterAll(async () => {
    for (const table of TABLES)
      await client.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${table}\``);
    await client.$disconnect();
  });

  async function world() {
    for (const table of TABLES)
      await client.$executeRawUnsafe(`DELETE FROM \`${table}\``);
    await client.account.create({ data: { id: "a1", name: "One" } });
    await client.card.create({
      data: { accountId: "a1", label: "before", tally: 3 },
    });
    await client.chit.create({
      data: { id: "c1", cardId: "a1", body: "before" },
    });
    await client.pair.create({ data: { id: "i1", code: "k1" } });
    await client.slip.create({
      data: { pairId: "i1", pairCode: "k1", note: "before" },
    });
  }

  it("reads the holder back at the identity the cascade left it at", async () => {
    await world();
    assert.deepEqual(
      await client.card.update({
        where: { accountId: "a1" },
        data: { label: "changed", account: { update: { id: "moved" } } },
        select: { accountId: true, label: true },
      }),
      { accountId: "moved", label: "changed" }
    );
    assert.deepEqual(await client.card.findMany(), [
      { accountId: "moved", label: "changed", tally: 3 },
    ]);
    assert.deepEqual(await client.account.findMany(), [
      { id: "moved", name: "One" },
    ]);
  });

  it("names every member of a compound cascade at the readback", async () => {
    await world();
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
    assert.deepEqual(await client.pair.findMany(), [{ id: "i2", code: "k2" }]);
  });

  it("binds a descendant under the moved holder to the new key", async () => {
    await world();
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

  it("leaves a holder no arm moved at the key it was located by", async () => {
    await world();
    assert.deepEqual(
      await client.card.update({
        where: { accountId: "a1" },
        data: { label: "same", account: { update: { name: "Renamed" } } },
        select: { accountId: true, label: true },
      }),
      { accountId: "a1", label: "same" }
    );
    assert.deepEqual(await client.card.findMany(), [
      { accountId: "a1", label: "same", tally: 3 },
    ]);
  });
});
