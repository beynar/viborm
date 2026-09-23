/**
 * N3 — a captured series member's presence is asserted where the set is
 * captured, before any write of the unit, so a member the race removed after
 * the plan-time read rejects at a premise and the operation re-plans once
 * against the set the race left (D-32). A junction set is captured member by
 * member (a row-held set is one correlated statement and needs no capture).
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { BatchOnlyDriver, NoIndexBatchOnlyDriver } from "./batch-only-drivers";

const owner = s
  .model({
    id: s.int().id(),
    name: s.string(),
    tags: s
      .toMany(() => tag)
      .through("n3_owner_tags")
      .source("owner_ref")
      .target("tag_ref"),
  })
  .map("n3_owners");
const tag = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    owners: s.toMany(() => owner),
  })
  .map("n3_tags");
const schema = { owner, tag };

for (const [route, make] of [
  ["batch-only", () => new BatchOnlyDriver()],
  ["batch-only without a statement index", () => new NoIndexBatchOnlyDriver()],
] as const) {
  describe(`N3: the series member premise at capture, ${route}`, () => {
    let driver: BatchOnlyDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.owner.create({ data: { id: 1, name: "Owner" } });
      await client.tag.create({ data: { id: 7, code: "kept" } });
      await client.tag.create({ data: { id: 8, code: "gone" } });
      await client.owner.update({
        where: { id: 1 },
        data: { tags: { connect: [{ id: 7 }, { id: 8 }] } },
      });
      driver.reset();
      return client;
    }

    it("deletes every captured member of the junction set", async () => {
      const client = await world();
      await client.owner.update({
        where: { id: 1 },
        data: { tags: { deleteMany: {} } },
      });
      assert.deepEqual(await client.tag.findMany(), []);
    });

    it("does not delete a member removed from the set after the plan-time read; the operation re-plans once and converges", async () => {
      const client = await world();
      driver.plant = (database) => {
        database
          .prepare(
            'DELETE FROM "n3_owner_tags" WHERE "owner_ref" = ? AND "tag_ref" = ?'
          )
          .run(1, 8);
      };
      await client.owner.update({
        where: { id: 1 },
        data: { tags: { deleteMany: {} } },
      });
      assert.deepEqual(
        (await client.tag.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        [8]
      );
      assert.ok(driver.batchCalls >= 2, `batches: ${driver.batchCalls}`);
    });
  });
}
