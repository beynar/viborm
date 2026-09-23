/**
 * D-50 — the exact identity scratch on a PostgreSQL-family batch-only transport.
 *
 * A generated increment key has to reach the statements that depend on it
 * inside ONE native batch. PostgreSQL's session-global `lastval()` is not an
 * exact identity (another generated column or a trigger moves it), so the
 * dialect stores the key from the INSERT's own RETURNING, inside a
 * data-modifying CTE whose outer INSERT writes the batch reference
 * (`batchRefs.storeReturning`), and every later statement reads the reference
 * back with the key's own width. Before D-50 every such shape on this
 * transport hit the registered refusal "G1 atomic output requires exact
 * identity scratch or segmented RETURNING".
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const owner = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
    children: s.toMany(() => child),
  })
  .map("d50_owners");
const child = s
  .model({
    id: s.string().id(),
    ownerId: s.int(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map("d50_children");
const schema = { owner, child };

/** Records what each native batch carries, in order. */
class RecordingBatchOnlyPGliteDriver extends BatchOnlyPGliteDriver {
  readonly batches: string[][] = [];
  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => query.sql));
    return super.executeBatch<T>(client, queries);
  }
}

const IDENTITY_SCRATCH_STORE =
  /WITH "__viborm_inserted" AS \(INSERT INTO "public"\."d50_owners" .* RETURNING "id"\) INSERT INTO "__viborm_batch_refs"/;
const IDENTITY_SCRATCH_READ =
  /CAST\(\(SELECT "ref_value" FROM "__viborm_batch_refs" WHERE .*\) AS INTEGER\)/;

const NO_LASTVAL = /lastval\(\)/;

describe("D-50: the exact identity scratch on a PostgreSQL batch-only transport", () => {
  // One PGlite for the file: a whole Postgres compiled to Wasm costs ~1.3 GiB.
  const driver = new RecordingBatchOnlyPGliteDriver();
  const client = createClient({ schema, driver });
  beforeAll(async () => {
    await syncLiveSchema(client);
  });
  afterAll(async () => {
    await driver.disconnect();
  });
  beforeEach(() => {
    driver.batches.length = 0;
  });

  it("carries a generated parent key to its nested creates in one native batch, through the INSERT's own RETURNING", async () => {
    const created = await client.owner.create({
      data: {
        label: "generated",
        children: { create: [{ id: "a" }, { id: "b" }] },
      },
      select: { id: true, children: { select: { id: true, ownerId: true } } },
    });
    assert.deepEqual(created, {
      id: 1,
      children: [
        { id: "a", ownerId: 1 },
        { id: "b", ownerId: 1 },
      ],
    });
    const writes = driver.batches.filter((batch) =>
      batch.some((statement) => statement.includes("d50_"))
    );
    assert.equal(writes.length, 1, JSON.stringify(driver.batches, null, 1));
    const [batch] = writes;
    assert.ok(
      batch!.some((statement) => IDENTITY_SCRATCH_STORE.test(statement)),
      batch!.join("\n")
    );
    assert.ok(
      batch!.some(
        (statement) =>
          statement.includes('"d50_children"') &&
          IDENTITY_SCRATCH_READ.test(statement)
      ),
      batch!.join("\n")
    );
    assert.ok(!batch!.some((statement) => NO_LASTVAL.test(statement)));
  });

  it("carries the key to a nested createMany across the series' committed segments", async () => {
    const created = await client.owner.create({
      data: {
        label: "many",
        children: { createMany: { data: [{ id: "c" }, { id: "d" }] } },
      },
    });
    const rows = await client.child.findMany({
      where: { ownerId: created.id },
      orderBy: { id: "asc" },
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["c", "d"]
    );
    // The series commits member by member on this transport (its shipped
    // segmentation), so the scratch has to outlive the first native batch:
    // every member's INSERT reads the stored reference, none reads lastval().
    const members = driver.batches
      .flat()
      .filter((statement) => statement.includes('"d50_children"'));
    assert.equal(members.length, 2);
    assert.ok(
      members.every((statement) => IDENTITY_SCRATCH_READ.test(statement)),
      members.join("\n")
    );
    assert.ok(
      !driver.batches.flat().some((statement) => NO_LASTVAL.test(statement))
    );
  });
});
