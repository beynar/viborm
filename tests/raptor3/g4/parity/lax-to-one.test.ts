/**
 * N2 (the nesting-and-refusals plan §2) — DESIGN §5.3's truth table for a
 * to-one edge: `disconnect: true` and `delete: true` are LAX — an empty slot
 * is a no-op, on both sides of the edge and on both routes — while an
 * explicit selector is STRICT and a missing target is the correlated
 * refusal. The emission decides `required` where the payload's form is
 * known; a deletion whose selection bound no row emits nothing, and a lax
 * removal names no target.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { NestedWriteError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
    profile: s.toOne(() => profile),
  })
  .map("n2_users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    userId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
  })
  .map("n2_posts");
const profile = s
  .model({
    id: s.string().id(),
    userId: s.string().unique().nullable(),
    owner: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
  })
  .map("n2_profiles");
const schema = { user, post, profile };

/** A native batch, no callback transaction. */
class BatchOnlyDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const DELETE_STATEMENT = /^DELETE FROM "n2_/;
const UPDATE_PROFILES = /^UPDATE "n2_profiles"/;

for (const [route, make] of [
  ["live", () => new RecordingSQLiteDriver()],
  ["batch-only", () => new BatchOnlyDriver()],
] as const) {
  describe(`N2: the lax to-one no-op on the ${route} route`, () => {
    let driver: RecordingSQLiteDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.user.create({ data: { id: "u1", name: "Owner" } });
      await client.post.create({ data: { id: "po1", title: "Orphan" } });
      driver.reset();
      return client;
    }

    it("disconnect: true on the FK-holder side with nothing connected is a no-op", async () => {
      const client = await world();
      const updated = await client.post.update({
        where: { id: "po1" },
        data: { title: "Touched", author: { disconnect: true } },
      });
      assert.deepEqual(updated, { id: "po1", title: "Touched", userId: null });
    });

    it("disconnect: true on the inverse side with no related row is a no-op, through a set-based clear", async () => {
      const client = await world();
      const updated = await client.user.update({
        where: { id: "u1" },
        data: { name: "Renamed", profile: { disconnect: true } },
      });
      assert.deepEqual(updated, { id: "u1", name: "Renamed" });
      const statements = driver.statements.map((statement) => statement.sql);
      assert.ok(!statements.some((sql) => DELETE_STATEMENT.test(sql)));
      // The clear names the membership, never a located target's identity.
      const clear = statements.find((sql) => UPDATE_PROFILES.test(sql));
      assert.ok(clear === undefined || !clear.includes('"id" ='), clear);
    });

    it("delete: true on the inverse side with no related row is a no-op (DESIGN §5.3; Prisma would throw)", async () => {
      const client = await world();
      const updated = await client.user.update({
        where: { id: "u1" },
        data: { name: "Renamed", profile: { delete: true } },
      });
      assert.deepEqual(updated, { id: "u1", name: "Renamed" });
      assert.ok(
        !driver.statements.some((statement) =>
          DELETE_STATEMENT.test(statement.sql)
        )
      );
      assert.deepEqual(await client.user.findMany(), [
        { id: "u1", name: "Renamed" },
      ]);
    });

    it("delete: true deletes the related row when the slot is occupied", async () => {
      const client = await world();
      await client.profile.create({ data: { id: "pr1", userId: "u1" } });
      await client.user.update({
        where: { id: "u1" },
        data: { profile: { delete: true } },
      });
      assert.deepEqual(await client.profile.findMany(), []);
    });

    it("an explicit selector stays strict: a to-many delete of a missing member refuses", async () => {
      // Admission allows only `true` / `false` for a to-one `delete`; the
      // explicit selector form lives on the to-many edge and is unchanged.
      const client = await world();
      await assert.rejects(
        async () => {
          await client.user.update({
            where: { id: "u1" },
            data: { posts: { delete: { id: "missing" } } },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message ===
            "Cannot delete relation 'posts': target record was not found for this parent."
      );
    });
  });
}
