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
import { BatchOnlyDriver, NoIndexBatchOnlyDriver } from "./batch-only-drivers";

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
    slug: s.string().unique().nullable(),
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

const DELETE_STATEMENT = /^DELETE FROM "n2_/;
const UPDATE_PROFILES = /^UPDATE "n2_profiles"/;

for (const [route, make] of [
  ["live", () => new RecordingSQLiteDriver()],
  ["batch-only", () => new BatchOnlyDriver()],
  ["batch-only without a statement index", () => new NoIndexBatchOnlyDriver()],
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
      assert.deepEqual(updated, {
        id: "po1",
        title: "Touched",
        slug: null,
        userId: null,
      });
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

    it("a lax delete of an occupied slot whose member was re-parented after the plan-time read converges to a no-op (N3, D-32)", async () => {
      // Only the batch-only route can observe a member between its plan-time
      // read and its batch; the live route serialises both in one transaction.
      if (route === "live") return;
      const client = await world();
      await client.user.create({ data: { id: "u2", name: "Other" } });
      await client.profile.create({ data: { id: "pr1", userId: "u1" } });
      (driver as BatchOnlyDriver).plant = (database) => {
        database
          .prepare('UPDATE "n2_profiles" SET "userId" = ? WHERE "id" = ?')
          .run("u2", "pr1");
      };
      const updated = await client.user.update({
        where: { id: "u1" },
        data: { name: "Renamed", profile: { delete: true } },
      });
      assert.deepEqual(updated, { id: "u1", name: "Renamed" });
      // The premise aborted the first batch, the operation re-planned once
      // against the slot as the race left it (empty), and deleted nothing.
      assert.deepEqual(await client.profile.findMany(), [
        { id: "pr1", userId: "u2" },
      ]);
      assert.ok(driver.batchCalls >= 2, `batches: ${driver.batchCalls}`);
    });

    it("the strict form keeps its identity: a captured member re-parented while another row takes its selector refuses and deletes nothing (D-34)", async () => {
      if (route === "live") return;
      const client = await world();
      await client.user.create({ data: { id: "u2", name: "Other" } });
      await client.post.create({
        data: { id: "pa", title: "A", slug: "x", userId: "u1" },
      });
      await client.post.create({
        data: { id: "pb", title: "B", userId: "u1" },
      });
      (driver as BatchOnlyDriver).plant = (database) => {
        database
          .prepare('UPDATE "n2_posts" SET "userId" = ? WHERE "id" = ?')
          .run("u2", "pa");
        database
          .prepare('UPDATE "n2_posts" SET "slug" = ? WHERE "id" = ?')
          .run(null, "pa");
        database
          .prepare('UPDATE "n2_posts" SET "slug" = ? WHERE "id" = ?')
          .run("x", "pb");
      };
      await assert.rejects(
        async () => {
          await client.user.update({
            where: { id: "u1" },
            data: { posts: { delete: [{ slug: "x" }] } },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message ===
            "Cannot delete relation 'posts': target record was not found for this parent." &&
          error.meta.raceable === undefined
      );
      assert.equal(driver.batchCalls, 1, `batches: ${driver.batchCalls}`);
      assert.deepEqual(
        (await client.post.findMany({ orderBy: { id: "asc" } })).map((post) => [
          post.id,
          post.userId,
          post.slug,
        ]),
        [
          ["pa", "u2", null],
          ["pb", "u1", "x"],
          ["po1", null, null],
        ]
      );
    });

    it("a premise placed after a write keeps its uncertainty on a transport that reports no statement index: no recovery, the batch rolled back (N3)", async () => {
      if (route !== "batch-only without a statement index") return;
      const client = await world();
      await client.post.create({
        data: { id: "p1", title: "Held", userId: "u1" },
      });
      await client.post.create({
        data: { id: "p3", title: "Gone", userId: null },
      });
      (driver as BatchOnlyDriver).plant = (database) => {
        database.prepare('DELETE FROM "n2_posts" WHERE "id" = ?').run("p3");
      };
      await assert.rejects(async () => {
        await client.user.update({
          where: { id: "u1" },
          data: {
            name: "Renamed",
            posts: { disconnect: [{ id: "p1" }], connect: [{ id: "p3" }] },
          },
        });
      });
      assert.equal(driver.batchCalls, 1, `batches: ${driver.batchCalls}`);
      assert.deepEqual(await client.user.findMany(), [
        { id: "u1", name: "Owner" },
      ]);
      assert.deepEqual(
        (await client.post.findMany({ where: { id: "p1" } })).map(
          (post) => post.userId
        ),
        ["u1"]
      );
    });

    it("a raceable premise ahead of a write, with a later premise behind that write, keeps its uncertainty on a transport that reports no statement index: the claim is bounded by the last premise, no recovery (N3)", async () => {
      // Measured order: P(user) P(profile member) W(users) P(post) W(posts)
      // W(delete profile) read. The plant re-parented the member, so the
      // batch aborts at the profile premise and the re-probe attributes it.
      // Read as "nothing but premises ahead of it", the claim would re-plan
      // and converge in two batches; bounded by the LAST premise, which
      // stands behind a write, the rejection keeps its uncertainty and the
      // transport's rollback is all that happened.
      if (route !== "batch-only without a statement index") return;
      const client = await world();
      await client.user.create({ data: { id: "u2", name: "Other" } });
      await client.profile.create({ data: { id: "pr1", userId: "u1" } });
      await client.post.create({
        data: { id: "p3", title: "Free", userId: null },
      });
      (driver as BatchOnlyDriver).plant = (database) => {
        database
          .prepare('UPDATE "n2_profiles" SET "userId" = ? WHERE "id" = ?')
          .run("u2", "pr1");
      };
      await assert.rejects(
        async () => {
          await client.user.update({
            where: { id: "u1" },
            data: {
              name: "Renamed",
              profile: { delete: true },
              posts: { connect: [{ id: "p3" }] },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message ===
            "Cannot delete relation 'profile': a member was removed after the plan-time read; retry to converge."
      );
      assert.equal(driver.batchCalls, 1, `batches: ${driver.batchCalls}`);
      assert.deepEqual(await client.user.findMany({ orderBy: { id: "asc" } }), [
        { id: "u1", name: "Owner" },
        { id: "u2", name: "Other" },
      ]);
      assert.deepEqual(await client.profile.findMany(), [
        { id: "pr1", userId: "u2" },
      ]);
      assert.deepEqual(
        (await client.post.findMany({ where: { id: "p3" } })).map(
          (post) => post.userId
        ),
        [null]
      );
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
