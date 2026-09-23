/**
 * FC-01 — a FRESH member subtree receives its ordinary physical placement.
 *
 * A selected series expands its members from the ADMITTED payload while the
 * operation runs: each member is a newly constructed subtree that has not
 * executed, so the dependency pass places its ordered observations (N1, D-51)
 * exactly where it places them under a single-record verb. The boundary is the
 * occurrence's own execution position — an ancestor already dispatching its
 * children is not rescheduled underneath itself — and not an operation-global
 * "members have been expanded" veto, which refused under `updateMany` the same
 * payload `update` executes.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { NestedWriteError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";
import { BatchOnlyDriver } from "./batch-only-drivers";

const org = s
  .model({
    id: s.string().id(),
    label: s.string(),
    staff: s.toMany(() => user).name("fmpStaff"),
  })
  .map("fmp_orgs");
const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    orgId: s.string().nullable(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id")
      .name("fmpStaff"),
    posts: s.toMany(() => post).name("fmpAuthor"),
    edited: s.toMany(() => post).name("fmpEditor"),
  })
  .map("fmp_users");
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
      .name("fmpAuthor"),
    editorId: s.string().nullable(),
    editor: s
      .toOne(() => user)
      .fields("editorId")
      .references("id")
      .name("fmpEditor"),
    tags: s
      .toMany(() => tag)
      .through("fmp_post_tags")
      .source("post_ref")
      .target("tag_ref"),
  })
  .map("fmp_posts");
const tag = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    posts: s.toMany(() => post),
  })
  .map("fmp_tags");
const container = s
  .model({
    id: s.int().id(),
    label: s.string(),
    nodes: s.toMany(() => node),
  })
  .map("fmp_containers");
const node = s
  .model({
    id: s.int().id(),
    label: s.string(),
    containerId: s.int().nullable(),
    container: s
      .toOne(() => container)
      .fields("containerId")
      .references("id"),
  })
  .map("fmp_nodes");
const schema = { org, user, post, tag, container, node };

for (const [route, make] of [
  ["live", () => new RecordingSQLiteDriver()],
  ["batch-only", () => new BatchOnlyDriver()],
] as const) {
  describe(`FC-01: fresh member placement on the ${route} route`, () => {
    let driver: RecordingSQLiteDriver;
    afterEach(async () => {
      await driver?.disconnect();
    });

    async function world() {
      driver = make();
      const client = createClient({ schema, driver });
      await syncLiveSchema(client);
      await client.org.create({ data: { id: "o1", label: "Org" } });
      await client.user.create({
        data: { id: "u1", name: "Owner", orgId: "o1" },
      });
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
        data: {
          id: "p2",
          title: "Two",
          slug: "b",
          userId: "u2",
          editorId: "u2",
        },
      });
      await client.tag.create({ data: { id: 7, code: "seven" } });
      await client.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: 7 }] } },
      });
      await client.container.create({ data: { id: 10, label: "ten" } });
      await client.container.create({ data: { id: 20, label: "twenty" } });
      await client.node.create({
        data: { id: 1, label: "one", containerId: 10 },
      });
      driver.reset();
      return client;
    }
    const posts = async (client: Awaited<ReturnType<typeof world>>) =>
      (await client.post.findMany({ orderBy: { id: "asc" } })).map((row) => [
        row.id,
        row.slug,
      ]);
    const tags = async (client: Awaited<ReturnType<typeof world>>) =>
      (await client.tag.findMany({ orderBy: { id: "asc" } })).map(
        (row) => row.id
      );

    it("the review case: a member's later lookup observes the member's own earlier write under root updateMany", async () => {
      const client = await world();
      const result = await client.user.updateMany({
        where: { id: "u1" },
        data: {
          posts: { update: { where: { id: "p1" }, data: { slug: "x" } } },
          edited: { delete: [{ slug: "x" }] },
        },
      });
      assert.deepEqual(result, { count: 1 });
      assert.deepEqual(await posts(client), [["p2", "b"]]);
    });

    it("a nested selected series places its members' observations: the same payload under a nested updateMany", async () => {
      const client = await world();
      await client.org.update({
        where: { id: "o1" },
        data: {
          label: "Renamed",
          staff: {
            updateMany: {
              where: { id: "u1" },
              data: {
                posts: { update: { where: { id: "p1" }, data: { slug: "x" } } },
                edited: { delete: [{ slug: "x" }] },
              },
            },
          },
        },
      });
      assert.deepEqual(await posts(client), [["p2", "b"]]);
      assert.deepEqual(await client.org.findMany(), [
        { id: "o1", label: "Renamed" },
      ]);
    });

    it("two sequential series each place their own members: the second expansion does not inherit the first's", async () => {
      const client = await world();
      await client.user.update({ where: { id: "u2" }, data: { orgId: "o1" } });
      driver.reset();
      await client.org.update({
        where: { id: "o1" },
        data: {
          staff: {
            updateMany: [
              {
                where: { id: "u1" },
                data: {
                  posts: {
                    update: { where: { id: "p1" }, data: { slug: "x" } },
                  },
                  edited: { delete: [{ slug: "x" }] },
                },
              },
              {
                where: { id: "u2" },
                data: {
                  posts: {
                    update: { where: { id: "p2" }, data: { slug: "y" } },
                  },
                  edited: { delete: [{ slug: "y" }] },
                },
              },
            ],
          },
        },
      });
      assert.deepEqual(await posts(client), []);
    });

    it("a member's parent-held choice moves behind the member's own write: its subtree observes the membership that write moved", async () => {
      // The member's own UPDATE moves node 1 into container 20, and the
      // choice's subtree reads node 1's membership of the container it
      // addresses — so the whole choice runs at its consumer's execution
      // point, behind that write.
      const client = await world();
      const result = await client.node.updateMany({
        where: { id: 1 },
        data: {
          containerId: 20,
          container: {
            update: {
              label: "moved",
              nodes: {
                update: { where: { id: 1 }, data: { label: "after" } },
              },
            },
          },
        },
      });
      assert.deepEqual(result, { count: 1 });
      assert.deepEqual(await client.node.findMany(), [
        { id: 1, label: "after", containerId: 20 },
      ]);
      assert.deepEqual(
        (await client.container.findMany({ orderBy: { id: "asc" } })).map(
          (row) => [row.id, row.label]
        ),
        [
          [10, "ten"],
          [20, "moved"],
        ]
      );
    });

    it("a member's dependent capture moves behind the choice's MISSING arm: the deleteMany removes the tag the connectOrCreate created", async () => {
      const client = await world();
      await client.post.updateMany({
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
      assert.deepEqual(await tags(client), [7]);
      assert.deepEqual(
        (
          await client.post.findMany({
            where: { id: "p1" },
            include: { tags: { orderBy: { id: "asc" } } },
          })
        ).map((row) => row.tags.map((member) => member.id)),
        [[7]]
      );
    });

    it("the opposite arm of the same choice: the FOUND arm connects the existing tag, and the same capture still removes it", async () => {
      const client = await world();
      await client.tag.create({ data: { id: 9, code: "nine" } });
      driver.reset();
      await client.post.updateMany({
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
      assert.deepEqual(await tags(client), [7]);
      assert.deepEqual(
        (
          await client.post.findMany({
            where: { id: "p1" },
            include: { tags: { orderBy: { id: "asc" } } },
          })
        ).map((row) => row.tags.map((member) => member.id)),
        [[7]]
      );
    });

    it("a deeper expansion inside a running member: the inner series' own members are placed while the outer member executes", async () => {
      const client = await world();
      const result = await client.org.updateMany({
        where: { id: "o1" },
        data: {
          staff: {
            updateMany: {
              where: { id: "u1" },
              data: {
                posts: { update: { where: { id: "p1" }, data: { slug: "x" } } },
                edited: { delete: [{ slug: "x" }] },
              },
            },
          },
        },
      });
      assert.deepEqual(result, { count: 1 });
      assert.deepEqual(await posts(client), [["p2", "b"]]);
    });

    it("a read the member's own write consumes keeps the inherited refusal, and nothing commits", async () => {
      const client = await world();
      await assert.rejects(
        async () => {
          await client.post.updateMany({
            where: { id: "p1" },
            data: { author: { delete: true, connect: { id: "u2" } } },
          });
        },
        (error: unknown) =>
          error instanceof NestedWriteError &&
          error.message ===
            "Nested operation 'connect' on relation 'author' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
      );
      assert.deepEqual(await posts(client), [
        ["p1", "a"],
        ["p2", "b"],
      ]);
      assert.deepEqual(
        (await client.user.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        ),
        ["u1", "u2"]
      );
    });
  });
}
