/**
 * D-50 — the exact identity scratch reads a generated key back at its own width.
 *
 * A `bigint` increment key travels through the batch reference table as
 * text; the read-back names the 64-bit cast (`CastType` "bigint": BIGINT on
 * PostgreSQL, where INTEGER is 32-bit; the INTEGER and SIGNED casts SQLite and
 * MySQL already had). The dialect states the store as `storeInsertedKey`
 * (here: the INSERT, then the last insert id store); the engine queues it.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const vault = s
  .model({
    id: s.bigInt().id().increment(),
    label: s.string(),
    coins: s.toMany(() => coin),
  })
  .map("d50_vaults");
const coin = s
  .model({
    id: s.string().id(),
    vaultId: s.bigInt(),
    vault: s
      .toOne(() => vault)
      .fields("vaultId")
      .references("id"),
  })
  .map("d50_coins");
const schema = { vault, coin };

/** A native batch, no callback transaction. */
class BatchOnlyDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const SCRATCH_STORE =
  /INSERT INTO "__viborm_batch_refs" .*last_insert_rowid\(\)/;
const SCRATCH_READ_AT_WIDTH =
  /INSERT INTO "d50_coins" .*CAST\(\(SELECT "ref_value" FROM "__viborm_batch_refs" WHERE .*\) AS INTEGER\)/;

describe("D-50: a bigint increment key reads back from the scratch at its width", () => {
  let driver: BatchOnlyDriver;
  afterEach(async () => {
    await driver?.disconnect();
  });

  it("stores the key after its INSERT and reads it back as a 64-bit integer for the nested create", async () => {
    driver = new BatchOnlyDriver();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    driver.reset();
    const created = await client.vault.create({
      data: { label: "wide", coins: { create: { id: "c1" } } },
      select: { id: true, coins: { select: { id: true, vaultId: true } } },
    });
    assert.deepEqual(created, { id: 1n, coins: [{ id: "c1", vaultId: 1n }] });
    const statements = driver.statements.map((statement) => statement.sql);
    assert.ok(
      statements.some((sql) => SCRATCH_STORE.test(sql)),
      statements.join("\n")
    );
    assert.ok(
      statements.some((sql) => SCRATCH_READ_AT_WIDTH.test(sql)),
      statements.join("\n")
    );
  });
});
