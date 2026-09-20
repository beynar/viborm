/**
 * N4 row 16 (the refusals plan §4, D-52) — WHICH shape still reaches
 * "G1 atomic output requires exact identity scratch or segmented RETURNING"
 * on a PostgreSQL batch-only transport, measured.
 *
 * The ruling widened the D-50 scratch on the premise that the refusal fires
 * for "a produced field that is not one increment key", so that carrying any
 * RETURNING column at its DECLARED type would close it. Both halves of that
 * premise are measured here:
 *
 *  - A produced field that is not a key never reaches this owner at all. The
 *    create's parent-id resolver refuses first, in its own registered
 *    sentence: a referenced field that is "neither this record's primary key
 *    nor a knowable value in its own create data". A key field that is not
 *    generated is never absent from an admitted payload, so it is never
 *    produced. One produced field is therefore always one increment key,
 *    which D-50 already carries.
 *  - What DOES reach it is MORE THAN ONE produced field: a composite primary
 *    key whose parts are both generated. One INSERT then has two values to
 *    store, and the CTE store writes ONE reference per statement — so the
 *    open shape is a multi-column store, not a width rule. Widening the read
 *    to the declared type alone would not answer it.
 *
 * These cells pin that boundary: the D-50 shape carried, the composite shape
 * refused. Whoever executes the multi-column store re-expresses the second
 * cell, naming the ruling that changed the answer.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const pair = s
  .model({
    first: s.int().increment(),
    second: s.int().increment(),
    label: s.string(),
    children: s.toMany(() => pairChild).name("n4oPair"),
  })
  .map("n4o_pairs")
  .id(["first", "second"]);
const pairChild = s
  .model({
    id: s.string().id(),
    ownerFirst: s.int(),
    ownerSecond: s.int(),
    owner: s
      .toOne(() => pair)
      .fields("ownerFirst", "ownerSecond")
      .references("first", "second")
      .name("n4oPair"),
  })
  .map("n4o_pair_children");
const single = s
  .model({
    id: s.int().id().increment(),
    label: s.string(),
    children: s.toMany(() => singleChild).name("n4oSingle"),
  })
  .map("n4o_singles");
const singleChild = s
  .model({
    id: s.string().id(),
    ownerId: s.int(),
    owner: s
      .toOne(() => single)
      .fields("ownerId")
      .references("id")
      .name("n4oSingle"),
  })
  .map("n4o_single_children");
const coded = s
  .model({
    id: s.int().id().increment(),
    code: s.string().unique().nullable(),
    label: s.string(),
    children: s.toMany(() => codedChild).name("n4oCode"),
  })
  .map("n4o_codes");
const codedChild = s
  .model({
    id: s.string().id(),
    ownerCode: s.string().nullable(),
    owner: s
      .toOne(() => coded)
      .fields("ownerCode")
      .references("code")
      .name("n4oCode"),
  })
  .map("n4o_code_children");
const schema = { pair, pairChild, single, singleChild, coded, codedChild };

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

const CTE_STORE =
  /WITH "__viborm_inserted" AS \(INSERT INTO .* RETURNING "id"\) INSERT INTO "__viborm_batch_refs"/;

describe("N4-16: what still reaches the atomic-output refusal on PostgreSQL", () => {
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

  it("ONE generated increment key rides the CTE store (D-50), unchanged", async () => {
    const created = await client.single.create({
      data: { label: "one", children: { create: [{ id: "a" }] } },
      select: { id: true, children: { select: { id: true, ownerId: true } } },
    });
    assert.deepEqual(created, {
      id: 1,
      children: [{ id: "a", ownerId: 1 }],
    });
    assert.ok(
      driver.batches.flat().some((statement) => CTE_STORE.test(statement)),
      JSON.stringify(driver.batches, null, 1)
    );
  });

  it("TWO produced key parts still reach the registered refusal: one statement, one reference", async () => {
    await assert.rejects(
      async () => {
        await client.pair.create({
          data: { label: "two", children: { create: [{ id: "b" }] } },
        });
      },
      (error: unknown) =>
        (error as Error).message ===
        "Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING"
    );
  });

  it("a produced field that is not a key never reaches this owner", async () => {
    // The parent-id resolver's own registered sentence, raised first: this is
    // why "a produced field that is not one increment key" is not the shape
    // that reaches the atomic-output guard.
    await assert.rejects(
      async () => {
        await client.coded.create({
          data: { label: "not a key", children: { create: [{ id: "c" }] } },
        });
      },
      (error: unknown) =>
        (error as Error).message ===
        "query-engine-v2 create cannot resolve the parent id for relation 'children': referenced field 'code' is neither this record's primary key nor a knowable value in its own create data."
    );
  });
});
