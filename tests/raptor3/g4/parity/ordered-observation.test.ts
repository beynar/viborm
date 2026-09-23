/**
 * N1 (the nesting-and-refusals plan §1, D-51) — a nested lookup whose answer
 * an earlier write of the same operation can change is an ORDERED
 * OBSERVATION: it is taken at its consumer's execution point, after that
 * write. The dependency pass keeps computing the overlap fact and spends it on
 * placement instead of a refusal. On the live route the read runs in order; on
 * the batch route it reads through the barrier that submits the queued unit
 * with its premises and reads in the same native batch, the consumer's own
 * write following in the next — D-51's succession of statements. The one
 * shape no order satisfies — a read the parent's own write consumes — keeps
 * the inherited refusal, and the array route keeps refusing a member that
 * needs a dynamic read (D-46).
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
    posts: s.toMany(() => post).name("n1Author"),
    edited: s.toMany(() => post).name("n1Editor"),
  })
  .map("n1_users");
const container = s
  .model({
    id: s.int().id(),
    nodes: s.toMany(() => node),
  })
  .map("n1_containers");
const node = s
  .model({
    id: s.int().id(),
    label: s.string(),
    containerId: s.int().nullable(),
    container: s
      .toOne(() => container)
      .fields("containerId")
      .references("id"),
    ownerId: s.string().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id")
      .name("n1Owner"),
  })
  .map("n1_nodes");
const thing = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    firsts: s.toMany(() => owner).name("n1First"),
    seconds: s.toMany(() => owner).name("n1Second"),
  })
  .map("n1_things");
const owner = s
  .model({
    id: s.string().id(),
    name: s.string(),
    firstId: s.int().nullable(),
    first: s
      .toOne(() => thing)
      .fields("firstId")
      .references("id")
      .name("n1First"),
    secondId: s.int().nullable(),
    second: s
      .toOne(() => thing)
      .fields("secondId")
      .references("id")
      .name("n1Second"),
    nodes: s.toMany(() => node).name("n1Owner"),
  })
  .map("n1_owners");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    slug: s.string().unique().nullable(),
    userId: s.string().nullable(),
    author: s
      .toOne(() => user)
      .fields("userId")
      .references("id")
      .name("n1Author"),
    editorId: s.string().nullable(),
    editor: s
      .toOne(() => user)
      .fields("editorId")
      .references("id")
      .name("n1Editor"),
    tags: s
      .toMany(() => tag)
      .through("n1_post_tags")
      .source("post_ref")
      .target("tag_ref"),
  })
  .map("n1_posts");
const tag = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    posts: s.toMany(() => post),
  })
  .map("n1_tags");
const schema = { user, post, tag, container, node, thing, owner };

const UPDATE_POSTS = /^UPDATE "n1_posts"/;
const SELECT_POSTS = /^SELECT .* FROM "n1_posts"/;
const INSERT_TAGS = /^INSERT INTO "n1_tags"/;
const SELECT_TAGS = /^SELECT .* FROM "n1_tags"/;
const MOVE_NODE = /^UPDATE "n1_nodes" SET "containerId"/;
const SELECT_CONTAINERS = /^SELECT .* FROM "n1_containers"/;

for (const [route, make] of [
  ["live", () => new RecordingSQLiteDriver()],
  ["batch-only", () => new BatchOnlyDriver()],
  ["batch-only without a statement index", () => new NoIndexBatchOnlyDriver()],
] as const) {
  describe(`N1: the ordered observation on the ${route} route`, () => {
    let driver: RecordingSQLiteDriver;
    const batch = route !== "live";
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.user.create({ data: { id: "u1", name: "Owner" } });
      await client.user.create({ data: { id: "u2", name: "Other" } });
      await client.post.create({
        data: {
          id: "p1",
          title: "One",
          slug: "a",
          userId: "u1",
          editorId: "u1",
        },
      });
      await client.post.create({
        data: { id: "p2", title: "Two", userId: "u1", editorId: "u1" },
      });
      await client.tag.create({ data: { id: 7, code: "seven" } });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: 7 }] } },
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

    it("a later member's lookup observes an earlier member's write: the delete finds the row the update just renamed", async () => {
      // Relations run in declaration order (`posts`, then `edited`); inside one
      // relation the verbs run in the body's canonical order, where `delete`
      // precedes `update` — so the dependent read lives on the second relation.
      const client = await world();
      await client.user.update({
        where: { id: "u1" },
        data: {
          posts: { update: { where: { id: "p1" }, data: { slug: "x" } } },
          edited: { delete: [{ slug: "x" }] },
        },
      });
      assert.deepEqual(
        (await client.post.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["p2"]
      );
      if (batch) {
        // The barrier: the update's batch carries the observation, the
        // deletion follows in the next.
        assert.ok(driver.batchCalls >= 2, `batches: ${driver.batchCalls}`);
      } else {
        const write = indexOf(UPDATE_POSTS);
        assert.ok(write >= 0, statements().join("\n"));
        const observation = indexOf(SELECT_POSTS, write + 1);
        assert.ok(observation > write, statements().join("\n"));
      }
    });

    it("an absent target behind the barrier is the correlated refusal, and nothing of the unit commits", async () => {
      const client = await world();
      await assert.rejects(
        async () => {
          await client.user.update({
            where: { id: "u1" },
            data: {
              name: "Renamed",
              posts: { update: { where: { id: "p1" }, data: { slug: "x" } } },
              edited: { delete: [{ slug: "y" }] },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message ===
            "Cannot delete relation 'edited': target record was not found for this parent."
      );
      assert.deepEqual(await client.user.findMany({ where: { id: "u1" } }), [
        { id: "u1", name: "Owner" },
      ]);
      assert.deepEqual(
        (await client.post.findMany({ orderBy: { id: "asc" } })).map((row) => [
          row.id,
          row.slug,
        ]),
        [
          ["p1", "a"],
          ["p2", null],
        ]
      );
      if (batch)
        assert.equal(driver.batchCalls, 1, `batches: ${driver.batchCalls}`);
    });

    it("a parent-held lookup ordered behind a sibling's create of its target executes: both keys land on the parent", async () => {
      const client = await world();
      const updated = await client.post.update({
        where: { id: "p2" },
        data: {
          author: { create: { id: "u9", name: "Nine" } },
          editor: { connect: { id: "u9" } },
        },
      });
      assert.deepEqual(updated, {
        id: "p2",
        title: "Two",
        slug: null,
        userId: "u9",
        editorId: "u9",
      });
      if (batch)
        assert.ok(driver.batchCalls >= 2, `batches: ${driver.batchCalls}`);
    });

    it("a read the parent's own write consumes keeps the inherited refusal (the retired engine's parent-held answer)", async () => {
      const client = await world();
      await assert.rejects(
        async () => {
          await client.post.update({
            where: { id: "p1" },
            data: { author: { delete: true, connect: { id: "u2" } } },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message ===
            "Nested operation 'connect' on relation 'author' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
      );
      assert.deepEqual(
        (await client.post.findMany({ where: { id: "p1" } })).map(
          (row) => row.userId
        ),
        ["u1"]
      );
      assert.equal(driver.batchCalls, 0);
    });

    it("a dependent junction capture moves behind the write it depends on: deleteMany removes the tag the connectOrCreate just made", async () => {
      // The collection order runs `connectOrCreate` before `deleteMany` (and
      // `create` last), so the capture's answer depends on the create arm.
      const client = await world();
      await client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: 9 },
              create: { id: 9, code: "nine" },
            },
            deleteMany: { code: "nine" },
          },
        },
      });
      assert.deepEqual(
        (await client.tag.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        [7],
        statements().join("\n")
      );
      assert.deepEqual(
        (
          await client.post.findMany({
            where: { id: "p1" },
            include: { tags: { orderBy: { id: "asc" } } },
          })
        ).map((row) => row.tags.map((member) => member.id)),
        [[7]]
      );
      if (batch) {
        assert.ok(driver.batchCalls >= 2, `batches: ${driver.batchCalls}`);
      } else {
        const write = indexOf(INSERT_TAGS);
        assert.ok(write >= 0, statements().join("\n"));
        assert.ok(
          indexOf(SELECT_TAGS, write + 1) > write,
          statements().join("\n")
        );
      }
    });

    it("a disjoint capture keeps its place ahead of the effects", async () => {
      const client = await world();
      await client.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: 9 },
              create: { id: 9, code: "nine" },
            },
            deleteMany: { id: 7 },
          },
        },
      });
      assert.deepEqual(
        (await client.tag.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        [9]
      );
      if (!batch) {
        const observation = indexOf(SELECT_TAGS);
        const write = indexOf(INSERT_TAGS);
        assert.ok(
          observation >= 0 && write > observation,
          statements().join("\n")
        );
      }
    });

    it("two consumers of one target across a write take two observations", async () => {
      const client = await world();
      await client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            disconnect: [{ slug: "a" }],
            update: { where: { id: "p2" }, data: { slug: "b" } },
          },
          edited: { delete: [{ slug: "b" }] },
        },
      });
      // The disconnect observed p1 before the update (nothing earlier could
      // change it); the delete observed p2 after it.
      assert.deepEqual(
        (await client.post.findMany({ orderBy: { id: "asc" } })).map((row) => [
          row.id,
          row.userId,
          row.slug,
        ]),
        [["p1", null, "a"]]
      );
    });

    it("a parent-held choice whose subtree reads what the parent's own write changes moves behind that write", async () => {
      // The nested `container.update` names the container the node will
      // reference after its own write (the post-write assignment, 20); its
      // inner `nodes.update` observes node 1's membership, which that same
      // write moves — so the whole choice runs behind the parent's UPDATE.
      const client = await world();
      await client.container.create({ data: { id: 10 } });
      await client.container.create({ data: { id: 20 } });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10 },
      });
      driver.reset();
      const updated = await client.node.update({
        where: { id: 1 },
        data: {
          containerId: 20,
          container: {
            update: {
              nodes: { update: { where: { id: 1 }, data: { label: "after" } } },
            },
          },
        },
      });
      assert.deepEqual(updated, {
        id: 1,
        label: "after",
        containerId: 20,
        ownerId: null,
      });
      if (!batch) {
        const write = indexOf(MOVE_NODE);
        assert.ok(write >= 0, statements().join("\n"));
        assert.ok(
          indexOf(SELECT_CONTAINERS, write + 1) > write,
          statements().join("\n")
        );
      }
    });

    it("a set whose retained member a sibling produced keeps that member and clears the rest", async () => {
      // `connectOrCreate` runs before `set` in the collection order; the
      // set's target lookup depends on the create arm, lands ahead of the
      // set's own clear, and the clear keeps the row it names.
      const client = await world();
      await client.user.update({
        where: { id: "u1" },
        data: {
          posts: {
            set: [{ id: "p9" }],
            connectOrCreate: [
              { where: { id: "p9" }, create: { id: "p9", title: "Nine" } },
            ],
          },
        },
      });
      assert.deepEqual(
        (await client.post.findMany({ orderBy: { id: "asc" } })).map((row) => [
          row.id,
          row.userId,
        ]),
        [
          ["p1", null],
          ["p2", null],
          ["p9", "u1"],
        ]
      );
    });

    it("a junction membership read observes the earlier link or removal of the same junction", async () => {
      // `disconnect` runs first: the deleteMany's capture, an ordered
      // observation of the junction, finds no member and deletes no row.
      const client = await world();
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { disconnect: [{ id: 7 }], deleteMany: { id: 7 } } },
      });
      assert.deepEqual(
        (await client.tag.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        [7]
      );
      // `set` runs before `deleteMany`: the capture observes the new member
      // and deletes it.
      await client.tag.create({ data: { id: 8, code: "eight" } });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { set: [{ id: 8 }], deleteMany: { id: 8 } } },
      });
      assert.deepEqual(
        (await client.tag.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        [7]
      );
    });

    it("a found requirement rides the observation's batch: the parent's own disconnect empties the slot the upsert addresses, and nothing commits", async () => {
      // `post.editor.disconnect` (the parent's own write) empties the slot;
      // `user.edited.upsert` … no — the upsert here lives on the node
      // self-membership: the node disconnects its container while updating
      // a node of that container by identity; the membership requirement
      // is asserted inside the batch behind the parent's write, so the
      // refusal leaves nothing durable on either route.
      const client = await world();
      await client.container.create({ data: { id: 10 } });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10 },
      });
      driver.reset();
      await assert.rejects(
        async () => {
          await client.container.update({
            where: { id: 10 },
            data: {
              nodes: {
                disconnect: [{ id: 1 }],
                upsert: {
                  where: { id: 1 },
                  create: { id: 2, label: "must not create" },
                  update: { label: "must not update" },
                },
              },
            },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message ===
            "Cannot upsert relation 'nodes': target record was not found for this parent."
      );
      assert.deepEqual(await client.node.findMany(), [
        { id: 1, label: "one", containerId: 10, ownerId: null },
      ]);
      if (batch)
        assert.equal(driver.batchCalls, 1, `batches: ${driver.batchCalls}`);
    });

    it("a sibling behind a moved parent-held choice is still analysed: its own dependent read observes on every route", async () => {
      // The `container` choice moves behind the root's write (the cell
      // above); the `owner` create declared after it must still be analysed —
      // its `second.connect` observes its `first.create` — so the batch route
      // reads it through the barrier like the live route reads it in order.
      const client = await world();
      await client.container.create({ data: { id: 10 } });
      await client.container.create({ data: { id: 20 } });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10 },
      });
      driver.reset();
      const updated = await client.node.update({
        where: { id: 1 },
        data: {
          containerId: 20,
          container: {
            update: {
              nodes: { update: { where: { id: 1 }, data: { label: "after" } } },
            },
          },
          owner: {
            create: {
              id: "o9",
              name: "Nine",
              first: { create: { id: 5, code: "X" } },
              second: { connect: { code: "X" } },
            },
          },
        },
      });
      assert.deepEqual(updated, {
        id: 1,
        label: "after",
        containerId: 20,
        ownerId: "o9",
      });
      assert.deepEqual(await client.owner.findMany(), [
        { id: "o9", name: "Nine", firstId: 5, secondId: 5 },
      ]);
    });

    it("the array route keeps refusing a member that needs a dynamic read (D-46)", async () => {
      if (!batch) return;
      const client = await world();
      await assert.rejects(
        async () => {
          await client.$transaction([
            client.user.update({
              where: { id: "u1" },
              data: {
                posts: { update: { where: { id: "p1" }, data: { slug: "x" } } },
                edited: { delete: [{ slug: "x" }] },
              },
            }),
          ]);
        },
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("does not support callback transactions")
      );
      assert.deepEqual(
        (await client.post.findMany({ orderBy: { id: "asc" } })).map((row) => [
          row.id,
          row.slug,
        ]),
        [
          ["p1", "a"],
          ["p2", null],
        ]
      );
    });
  });
}
